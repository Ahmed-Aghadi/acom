use super::*;
use crate::harness::{TokenSource, TokenUsage};

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS agent_token_usage(agent_id INTEGER PRIMARY KEY, ledger TEXT NOT NULL);";

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
struct Counts {
    values: [Option<u64>; 4],
    total: Option<u64>,
}

impl Counts {
    fn any(&self) -> bool {
        self.total.is_some() || self.values.iter().any(Option::is_some)
    }

    fn merge(&mut self, newer: &Self) {
        for (value, next) in self.values.iter_mut().zip(newer.values) {
            if next.is_some() {
                *value = next;
            }
        }
        if newer.total.is_some() {
            self.total = newer.total;
        }
    }

    fn add(&self, other: &Self) -> Self {
        let add = |a: Option<u64>, b: Option<u64>| match (a, b) {
            (None, None) => None,
            _ => Some(a.unwrap_or(0).saturating_add(b.unwrap_or(0))),
        };
        Self {
            values: std::array::from_fn(|i| add(self.values[i], other.values[i])),
            total: add(self.total, other.total),
        }
    }

    fn message_total(&mut self) {
        self.total = self.values.iter().try_fold(0_u64, |sum, value| {
            value.map(|value| sum.saturating_add(value))
        });
    }

    fn message_sum(messages: &BTreeMap<String, Self>) -> Self {
        let mut messages = messages.values();
        let Some(first) = messages.next() else {
            return Self::default();
        };
        messages.fold(first.clone(), |sum, next| Self {
            values: std::array::from_fn(|i| {
                sum.values[i]
                    .zip(next.values[i])
                    .map(|(a, b)| a.saturating_add(b))
            }),
            total: sum.total.zip(next.total).map(|(a, b)| a.saturating_add(b)),
        })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Turn {
    messages: BTreeMap<String, Counts>,
    active_message: Option<String>,
    usage: Counts,
    finalized: bool,
    complete: bool,
}

impl Turn {
    fn restore_message_observations(&mut self) {
        let observed = self
            .messages
            .values()
            .fold(Counts::default(), |sum, next| sum.add(next));
        for (value, observed) in self.usage.values.iter_mut().zip(observed.values) {
            if value.is_none() {
                *value = observed;
            }
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Ledger {
    previous: Counts,
    previous_partial: bool,
    session: Option<String>,
    codex: Counts,
    codex_complete: bool,
    turn: Option<Turn>,
    updated_at: Option<i64>,
}

impl Ledger {
    fn session(&mut self, session: Option<&str>) {
        let Some(session) = session else { return };
        if self.session.as_deref().is_some_and(|old| old != session) {
            self.previous = self.previous.add(&self.codex);
            self.previous_partial |= !self.codex_complete;
            self.codex = Counts::default();
            self.codex_complete = false;
        }
        self.session = Some(session.into());
    }

    fn begin(&mut self, harness: &str, session: Option<&str>) {
        self.finish(harness);
        if harness == "codex" {
            self.session(session);
        }
        self.turn = Some(Turn::default());
    }

    fn observe(&mut self, sample: TokenUsage) -> bool {
        let counts = Counts {
            values: sample.counts,
            total: sample.total,
        };
        let identity = matches!(
            sample.source,
            TokenSource::ClaudeStreamStart(_) | TokenSource::ClaudeStreamEnd
        );
        if !counts.any() && !identity {
            return false;
        }
        let turn = self.turn.get_or_insert_with(Turn::default);
        if matches!(sample.source, TokenSource::ClaudeStreamEnd) {
            return turn.active_message.take().is_some();
        }
        if let TokenSource::ClaudeStreamStart(id) = &sample.source {
            let changed = turn.active_message.as_ref() != Some(id);
            turn.active_message = Some(id.clone());
            if !counts.any() {
                return changed;
            }
        }
        match sample.source {
            TokenSource::CodexSession { finalized } => {
                if turn.finalized && !finalized {
                    return false;
                }
                if finalized {
                    turn.finalized = true;
                    turn.complete = counts.total.is_some();
                    self.codex_complete = turn.complete;
                    self.codex = counts;
                } else {
                    self.codex.merge(&counts);
                }
            }
            TokenSource::ClaudeResult { trusted } => {
                if !trusted {
                    turn.restore_message_observations();
                    for (value, next) in turn.usage.values.iter_mut().zip(counts.values) {
                        if let Some(next) = next.filter(|value| *value > 0) {
                            *value = Some(value.unwrap_or(0).max(next));
                        }
                    }
                    let observed = turn.usage.total.unwrap_or(0).max(counts.total.unwrap_or(0));
                    turn.usage.total = (observed > 0).then_some(observed).or(turn.usage.total);
                    turn.finalized = true;
                    turn.complete = false;
                    if turn.usage.any() {
                        self.updated_at = Some(now());
                    }
                    return true;
                }
                turn.usage.merge(&counts);
                if counts.total.is_none() {
                    turn.usage.message_total();
                }
                turn.finalized = true;
                turn.complete = counts.total.is_some();
            }
            source => {
                if turn.finalized {
                    return false;
                }
                let id = match source {
                    TokenSource::ClaudeMessage(id) => id,
                    TokenSource::ClaudeStreamStart(id) => id,
                    TokenSource::ClaudeStreamDelta => {
                        let Some(id) = &turn.active_message else {
                            return false;
                        };
                        id.clone()
                    }
                    _ => unreachable!(),
                };
                let message = turn.messages.entry(id).or_default();
                message.merge(&counts);
                message.message_total();
                turn.usage = Counts::message_sum(&turn.messages);
            }
        }
        self.updated_at = Some(now());
        true
    }

    fn finish(&mut self, harness: &str) {
        let Some(mut turn) = self.turn.take() else {
            return;
        };
        if harness == "codex" {
            self.codex_complete = turn.complete;
        } else {
            if !turn.complete {
                turn.restore_message_observations();
            }
            self.previous = self.previous.add(&turn.usage);
            self.previous_partial |= !turn.complete;
        }
    }

    fn counts(&self, harness: &str) -> Counts {
        let current = if harness == "codex" {
            &self.codex
        } else {
            self.turn.as_ref().map_or(&EMPTY, |turn| &turn.usage)
        };
        let mut counts = self.previous.add(current);
        if current.any() {
            for (value, current) in counts.values.iter_mut().zip(current.values) {
                if current.is_none() {
                    *value = None;
                }
            }
            if current.total.is_none() {
                counts.total = None;
            }
        }
        counts
    }

    fn state(&self, harness: &str, working: bool) -> &'static str {
        if !self.counts(harness).any() {
            return "unknown";
        }
        if let Some(turn) = &self.turn {
            if turn.finalized {
                if turn.complete && !self.previous_partial {
                    "final"
                } else {
                    "partial"
                }
            } else if working {
                "provisional"
            } else {
                "partial"
            }
        } else if self.previous_partial || (harness == "codex" && !self.codex_complete) {
            "partial"
        } else {
            "final"
        }
    }
}

const EMPTY: Counts = Counts {
    values: [None; 4],
    total: None,
};

fn load(st: &St, id: i64) -> R<(Ledger, String)> {
    let (harness, session, turns, values): (String, Option<String>, i64, [i64; 4]) = st.db.query_row(
        "SELECT harness,session_id,turns,fresh_in,cache_write,cache_read,output FROM agents WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, [row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?])),
    )?;
    let values = values.map(|value| u64::try_from(value).unwrap_or(0));
    let saved: Option<String> = st
        .db
        .query_row(
            "SELECT ledger FROM agent_token_usage WHERE agent_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let ledger = if let Some(saved) = saved {
        serde_json::from_str(&saved)
            .map_err(|error| Fail(500, format!("invalid token accounting: {error}")))?
    } else {
        // Older counters establish positive observations, not that zero was measured.
        let counts = Counts {
            values: values.map(|value| (value > 0).then_some(value)),
            total: values
                .iter()
                .any(|value| *value > 0)
                .then(|| values.iter().copied().fold(0_u64, u64::saturating_add)),
        };
        if harness == "codex" {
            Ledger {
                session,
                codex: counts,
                ..Ledger::default()
            }
        } else {
            Ledger {
                previous: counts,
                previous_partial: turns > 0 || values.iter().any(|value| *value > 0),
                ..Ledger::default()
            }
        }
    };
    Ok((ledger, harness))
}

fn save(st: &St, id: i64, harness: &str, ledger: &Ledger) -> R<()> {
    st.db.execute(
        "INSERT INTO agent_token_usage(agent_id,ledger) VALUES(?1,?2) ON CONFLICT(agent_id) DO UPDATE SET ledger=excluded.ledger WHERE ledger<>excluded.ledger",
        params![id, serde_json::to_string(ledger).unwrap()],
    )?;
    let values = ledger
        .counts(harness)
        .values
        .map(|value| value.unwrap_or(0).min(i64::MAX as u64) as i64);
    st.db.execute(
        "UPDATE agents SET fresh_in=?2,cache_write=?3,cache_read=?4,output=?5 WHERE id=?1 AND (fresh_in<>?2 OR cache_write<>?3 OR cache_read<>?4 OR output<>?5)",
        params![id,values[0],values[1],values[2],values[3]],
    )?;
    Ok(())
}

pub(crate) fn begin(st: &St, id: i64, session: Option<&str>) -> R<()> {
    let (mut ledger, harness) = load(st, id)?;
    ledger.begin(&harness, session);
    save(st, id, &harness, &ledger)
}

pub(super) fn finish(st: &St, id: i64) -> R<()> {
    let (mut ledger, harness) = load(st, id)?;
    ledger.finish(&harness);
    save(st, id, &harness, &ledger)
}

pub(super) fn session(st: &St, id: i64, session: &str) -> R<()> {
    let (mut ledger, harness) = load(st, id)?;
    if harness == "codex" {
        ledger.session(Some(session));
        save(st, id, &harness, &ledger)?;
    }
    Ok(())
}

pub(super) fn record(st: &St, id: i64, sample: TokenUsage) -> R<()> {
    let (mut ledger, harness) = load(st, id)?;
    if ledger.observe(sample) {
        save(st, id, &harness, &ledger)?;
    }
    Ok(())
}

pub(super) fn attach(st: &St, agent: &mut Value) -> R<()> {
    let id = agent["id"].as_i64().unwrap();
    let (ledger, harness) = load(st, id)?;
    let counts = ledger.counts(&harness);
    for (name, value) in ["fresh_in", "cache_write", "cache_read", "output"]
        .into_iter()
        .zip(counts.values)
    {
        agent[name] = json!(value);
    }
    agent["total_tokens"] = json!(counts.total);
    agent["token_usage_state"] = json!(ledger.state(&harness, agent["state"] == "working"));
    agent["token_usage_updated_at"] = json!(ledger.updated_at);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(source: TokenSource, values: [Option<u64>; 4]) -> TokenUsage {
        let total = values
            .iter()
            .try_fold(0_u64, |sum, value| value.map(|value| sum + value));
        TokenUsage {
            source,
            counts: values,
            total,
        }
    }

    #[test]
    fn claude_messages_deduplicate_revise_and_reconcile_the_current_turn_only() {
        let mut ledger = Ledger::default();
        ledger.begin("claude", None);
        let message = sample(
            TokenSource::ClaudeStreamStart("first".into()),
            [Some(10), Some(20), Some(30), Some(1)],
        );
        ledger.observe(message.clone());
        ledger.observe(message);
        ledger.observe(sample(
            TokenSource::ClaudeStreamDelta,
            [None, None, None, Some(7)],
        ));
        assert_eq!(ledger.counts("claude").total, Some(67));
        assert_eq!(ledger.state("claude", true), "provisional");
        ledger.observe(sample(
            TokenSource::ClaudeResult { trusted: true },
            [Some(12), Some(20), Some(30), Some(9)],
        ));
        assert_eq!(ledger.counts("claude").total, Some(71));
        ledger.observe(sample(
            TokenSource::ClaudeStreamDelta,
            [None, None, None, Some(1000)],
        ));
        ledger.finish("claude");
        assert_eq!(ledger.counts("claude").total, Some(71));
        assert_eq!(ledger.state("claude", false), "final");
        ledger.begin("claude", None);
        ledger.observe(sample(
            TokenSource::ClaudeResult { trusted: true },
            [Some(0); 4],
        ));
        ledger.finish("claude");
        assert_eq!(ledger.counts("claude").total, Some(71));
        assert_eq!(ledger.state("claude", false), "final");
    }

    #[test]
    fn interrupted_claude_usage_survives_and_untrusted_zero_cannot_erase_it() {
        let mut ledger = Ledger::default();
        ledger.begin("claude", None);
        ledger.observe(sample(
            TokenSource::ClaudeStreamStart("a".into()),
            [Some(0), Some(10), Some(20), Some(3)],
        ));
        ledger.observe(sample(
            TokenSource::ClaudeResult { trusted: false },
            [Some(0); 4],
        ));
        ledger.finish("claude");
        let saved = serde_json::to_string(&ledger).unwrap();
        let mut ledger: Ledger = serde_json::from_str(&saved).unwrap();
        assert_eq!(ledger.counts("claude").total, Some(33));
        assert_eq!(ledger.state("claude", false), "partial");
        ledger.begin("claude", None);
        ledger.observe(sample(
            TokenSource::ClaudeResult { trusted: true },
            [Some(1); 4],
        ));
        ledger.finish("claude");
        assert_eq!(ledger.counts("claude").total, Some(37));
        assert_eq!(ledger.state("claude", false), "partial");
    }

    #[test]
    fn failed_claude_results_only_contribute_positive_lower_bounds() {
        let mut ledger = Ledger::default();
        ledger.begin("claude", None);
        ledger.observe(sample(
            TokenSource::ClaudeStreamStart("a".into()),
            [Some(10), Some(20), Some(30), Some(8)],
        ));
        ledger.observe(sample(
            TokenSource::ClaudeResult { trusted: false },
            [Some(1), Some(2), Some(3), Some(4)],
        ));
        assert_eq!(ledger.counts("claude").total, Some(68));
        assert_eq!(
            ledger.counts("claude").values,
            [Some(10), Some(20), Some(30), Some(8)]
        );
        assert_eq!(ledger.state("claude", true), "partial");
        let mut unknown = Ledger::default();
        unknown.begin("claude", None);
        unknown.observe(sample(
            TokenSource::ClaudeResult { trusted: false },
            [Some(0); 4],
        ));
        assert_eq!(unknown.counts("claude").values, [None; 4]);
        assert_eq!(unknown.state("claude", false), "unknown");
        assert_eq!(unknown.updated_at, None);
        let mut missing = Ledger::default();
        missing.begin("claude", None);
        missing.observe(sample(
            TokenSource::ClaudeResult { trusted: false },
            [Some(12), None, Some(7), None],
        ));
        assert_eq!(missing.counts("claude").total, None);
        assert_eq!(
            missing.counts("claude").values,
            [Some(12), None, Some(7), None]
        );
    }

    #[test]
    fn codex_snapshots_are_absolute_and_late_side_samples_cannot_override_final() {
        let mut ledger = Ledger::default();
        ledger.begin("codex", Some("one"));
        ledger.observe(sample(
            TokenSource::CodexSession { finalized: false },
            [Some(10); 4],
        ));
        ledger.observe(sample(
            TokenSource::CodexSession { finalized: true },
            [Some(12); 4],
        ));
        ledger.observe(sample(
            TokenSource::CodexSession { finalized: false },
            [Some(8); 4],
        ));
        ledger.finish("codex");
        assert_eq!(ledger.counts("codex").total, Some(48));
        ledger.begin("codex", Some("one"));
        ledger.observe(sample(
            TokenSource::CodexSession { finalized: true },
            [Some(20); 4],
        ));
        ledger.finish("codex");
        assert_eq!(ledger.counts("codex").total, Some(80));
        ledger.begin("codex", Some("two"));
        ledger.observe(sample(
            TokenSource::CodexSession { finalized: true },
            [Some(2); 4],
        ));
        ledger.finish("codex");
        assert_eq!(ledger.counts("codex").total, Some(88));
        assert_eq!(ledger.state("codex", false), "final");
    }

    #[test]
    fn codex_final_snapshots_clear_unreported_cache_write_and_fresh_input() {
        let mut ledger = Ledger::default();
        ledger.begin("codex", Some("a"));
        ledger.observe(TokenUsage {
            source: TokenSource::CodexSession { finalized: false },
            counts: [Some(55), Some(5), Some(40), Some(9)],
            total: Some(109),
        });
        ledger.observe(TokenUsage {
            source: TokenSource::CodexSession { finalized: true },
            counts: [None, None, Some(50), Some(12)],
            total: Some(132),
        });
        assert_eq!(
            ledger.counts("codex").values,
            [None, None, Some(50), Some(12)]
        );
        assert_eq!(ledger.counts("codex").total, Some(132));
        assert_eq!(ledger.state("codex", true), "final");
    }

    #[test]
    fn codex_final_zero_total_does_not_retain_old_positive_breakdowns() {
        let mut ledger = Ledger::default();
        ledger.begin("codex", Some("a"));
        ledger.observe(sample(
            TokenSource::CodexSession { finalized: false },
            [Some(5); 4],
        ));
        ledger.observe(TokenUsage {
            source: TokenSource::CodexSession { finalized: true },
            counts: [None, None, None, Some(0)],
            total: Some(0),
        });
        assert_eq!(ledger.counts("codex").values, [None, None, None, Some(0)]);
        assert_eq!(ledger.counts("codex").total, Some(0));
        assert_eq!(ledger.state("codex", true), "final");
    }

    #[test]
    fn missing_counts_are_not_zeros_and_final_snapshots_replace_old_breakdowns() {
        let mut ledger = Ledger::default();
        ledger.begin("codex", Some("a"));
        assert_eq!(ledger.state("codex", true), "unknown");
        ledger.observe(TokenUsage {
            source: TokenSource::CodexSession { finalized: false },
            counts: [None, None, Some(2), Some(1)],
            total: Some(10),
        });
        assert!(!ledger.observe(TokenUsage {
            source: TokenSource::CodexSession { finalized: true },
            counts: [None; 4],
            total: None,
        }));
        assert_eq!(
            ledger.counts("codex").values,
            [None, None, Some(2), Some(1)]
        );
        assert_eq!(ledger.state("codex", true), "provisional");
        ledger.observe(TokenUsage {
            source: TokenSource::CodexSession { finalized: true },
            counts: [None; 4],
            total: Some(12),
        });
        assert_eq!(ledger.counts("codex").values, [None; 4]);
        assert_eq!(ledger.counts("codex").total, Some(12));
        assert_eq!(ledger.state("codex", true), "final");
    }

    #[test]
    fn a_new_incomplete_message_does_not_reuse_a_previous_turns_total_or_output() {
        let mut ledger = Ledger::default();
        ledger.begin("claude", None);
        ledger.observe(sample(
            TokenSource::ClaudeResult { trusted: true },
            [Some(1); 4],
        ));
        ledger.finish("claude");
        ledger.begin("claude", None);
        ledger.observe(sample(
            TokenSource::ClaudeStreamStart("a".into()),
            [Some(2); 4],
        ));
        ledger.observe(sample(
            TokenSource::ClaudeStreamStart("b".into()),
            [Some(3), Some(3), Some(3), None],
        ));
        assert_eq!(
            ledger.counts("claude").values,
            [Some(6), Some(6), Some(6), None]
        );
        assert_eq!(ledger.counts("claude").total, None);
        ledger.observe(sample(
            TokenSource::ClaudeStreamDelta,
            [None, None, None, Some(4)],
        ));
        assert_eq!(ledger.counts("claude").total, Some(25));
    }

    #[test]
    fn stream_identity_changes_without_usage_do_not_invent_counts() {
        let mut ledger = Ledger::default();
        ledger.begin("claude", None);
        assert!(ledger.observe(sample(
            TokenSource::ClaudeStreamStart("a".into()),
            [None; 4]
        )));
        assert_eq!(ledger.updated_at, None);
        ledger.observe(sample(TokenSource::ClaudeStreamDelta, [Some(2); 4]));
        assert_eq!(ledger.counts("claude").total, Some(8));
        assert!(ledger.observe(sample(TokenSource::ClaudeStreamEnd, [None; 4])));
        assert!(!ledger.observe(sample(TokenSource::ClaudeStreamDelta, [Some(100); 4])));
        assert_eq!(ledger.counts("claude").total, Some(8));
    }

    #[test]
    fn interrupted_incomplete_messages_retain_observed_categories_without_inventing_totals() {
        let mut ledger = Ledger::default();
        ledger.begin("claude", None);
        ledger.observe(sample(
            TokenSource::ClaudeStreamStart("a".into()),
            [Some(10), Some(20), Some(30), Some(5)],
        ));
        ledger.observe(sample(
            TokenSource::ClaudeStreamStart("b".into()),
            [Some(40), Some(0), Some(10), None],
        ));
        assert_eq!(
            ledger.counts("claude").values,
            [Some(50), Some(20), Some(40), None]
        );
        assert_eq!(ledger.counts("claude").total, None);
        ledger.finish("claude");
        assert_eq!(
            ledger.counts("claude").values,
            [Some(50), Some(20), Some(40), Some(5)]
        );
        assert_eq!(ledger.counts("claude").total, None);
        assert_eq!(ledger.state("claude", false), "partial");
    }

    #[test]
    fn durable_zero_observations_and_finalization_invalidate_without_counter_changes() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::app::SCHEMA).unwrap();
        crate::app::initialize_views(&db).unwrap();
        db.execute_batch("INSERT INTO projects(id,path,name,created_at) VALUES(1,'/synthetic','synthetic',0);
            INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at)
            VALUES(1,1,'test','test','claude','test','test','working',0,0);").unwrap();
        let st = St {
            db,
            shutting_down: false,
            waiting_updates: HashMap::new(),
            stopping_agents: HashSet::new(),
            queues: HashMap::new(),
            procs: HashMap::new(),
            reaped: HashSet::new(),
        };
        begin(&st, 1, None).unwrap();
        let revision = || {
            st.db
                .query_row(
                    "SELECT value FROM view_revisions WHERE name='agent_token_usage'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap()
        };
        let initial = revision();
        record(
            &st,
            1,
            sample(TokenSource::ClaudeStreamStart("a".into()), [Some(0); 4]),
        )
        .unwrap();
        assert!(revision() > initial);
        let live = revision();
        record(
            &st,
            1,
            sample(TokenSource::ClaudeResult { trusted: true }, [Some(0); 4]),
        )
        .unwrap();
        assert!(revision() > live);
        let mut view = json!({"id":1,"state":"working"});
        attach(&st, &mut view).unwrap();
        assert_eq!(view["total_tokens"], 0);
        assert_eq!(view["token_usage_state"], "final");
        finish(&st, 1).unwrap();
        let (ledger, _) = load(&st, 1).unwrap();
        assert!(ledger.turn.is_none());
        assert_eq!(ledger.state("claude", false), "final");
        assert_eq!(ledger.counts("claude").total, Some(0));
    }
}
