use super::*;
use crate::harness::{TokenSource, TokenUsage};

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS agent_token_usage(agent_id INTEGER PRIMARY KEY, ledger TEXT NOT NULL);";

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct LastTotal {
    pub tokens: u64,
    pub at: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldInfo {
    observed_at: Option<i64>,
    state_at: Option<i64>,
    last_known: Option<LastTotal>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    previous: Counts,
    previous_partial: bool,
    session: Option<String>,
    codex: Counts,
    codex_complete: bool,
    turn: Option<Turn>,
    updated_at: Option<i64>,
    last_total: Option<LastTotal>,
    fields: [FieldInfo; 5],
}

impl Ledger {
    fn reconcile_fields(
        &mut self,
        harness: &str,
        before: &Counts,
        previous_quality: &str,
        reported: [bool; 5],
        at: i64,
    ) {
        let counts = self.counts(harness);
        let quality = self.state(harness, true).to_owned();
        let current = [
            counts.values[0],
            counts.values[1],
            counts.values[2],
            counts.values[3],
            counts.total,
        ];
        let previous = [
            before.values[0],
            before.values[1],
            before.values[2],
            before.values[3],
            before.total,
        ];
        for (index, (value, old)) in current.into_iter().zip(previous).enumerate() {
            let field = &mut self.fields[index];
            if value != old || quality != previous_quality || reported[index] {
                field.state_at = Some(at);
            }
            if reported[index]
                && let Some(tokens) = value
            {
                field.observed_at = Some(at);
                field.last_known = Some(LastTotal {
                    tokens,
                    at: Some(at),
                });
            }
        }
        self.last_total = self.fields[4].last_known.clone();
    }

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
        let before = self.counts(harness);
        let quality = self.state(harness, true).to_owned();
        if harness == "codex" {
            self.session(session);
        }
        self.turn = Some(Turn::default());
        self.reconcile_fields(harness, &before, &quality, [false; 5], now());
    }

    fn observe(&mut self, sample: TokenUsage) -> bool {
        let harness = if matches!(sample.source, TokenSource::CodexSession { .. }) {
            "codex"
        } else {
            "claude"
        };
        let before = self.counts(harness);
        let quality = self.state(harness, true).to_owned();
        let untrusted = matches!(sample.source, TokenSource::ClaudeResult { trusted: false });
        let reported = sample
            .counts
            .map(|value| value.is_some_and(|value| !untrusted || value > 0));
        let total = if harness == "codex" {
            sample.total.is_some()
        } else {
            sample.total.is_some_and(|value| !untrusted || value > 0)
                || reported.iter().any(|value| *value)
        };
        let at = now();
        if !self.apply(sample) {
            return false;
        }
        self.reconcile_fields(
            harness,
            &before,
            &quality,
            [reported[0], reported[1], reported[2], reported[3], total],
            at,
        );
        true
    }

    fn apply(&mut self, sample: TokenUsage) -> bool {
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
        let before = self.counts(harness);
        let quality = self.state(harness, true).to_owned();
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
        self.reconcile_fields(harness, &before, &quality, [false; 5], now());
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
    let (harness, session): (String, Option<String>) = st.db.query_row(
        "SELECT harness,session_id FROM agents WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let saved: Option<String> = st
        .db
        .query_row(
            "SELECT ledger FROM agent_token_usage WHERE agent_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let ledger: Ledger = if let Some(saved) = saved {
        serde_json::from_str(&saved)
            .map_err(|error| Fail(500, format!("invalid token accounting: {error}")))?
    } else {
        Ledger {
            session,
            ..Ledger::default()
        }
    };
    Ok((ledger, harness))
}

fn save(st: &St, id: i64, ledger: &Ledger) -> R<()> {
    st.db.execute(
        "INSERT INTO agent_token_usage(agent_id,ledger) VALUES(?1,?2) ON CONFLICT(agent_id) DO UPDATE SET ledger=excluded.ledger WHERE ledger<>excluded.ledger",
        params![id, serde_json::to_string(ledger).unwrap()],
    )?;
    Ok(())
}

pub(super) fn validate_archive(db: &Connection) -> R<()> {
    let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM metric_dirty WHERE generation<1 OR recorded_generation<0 OR recorded_generation>generation OR checkpoint_generation<0 OR checkpoint_generation>generation OR queued_at<0)",[],|row|row.get(0))?;
    if invalid {
        return Err(bad("invalid archived metric capture generations"));
    }
    let mut statement = db.prepare(
        "SELECT agent_id,ledger,length(ledger) FROM agent_token_usage ORDER BY agent_id",
    )?;
    let mut stored = statement.query([])?;
    while let Some(row) = stored.next()? {
        let id: i64 = row.get(0)?;
        if row.get::<_, i64>(2)? > 16 * 1024 * 1024 {
            return Err(bad(format!(
                "archived agent {id} token ledger exceeds 16 MiB"
            )));
        }
        let ledger: Ledger = serde_json::from_str(&row.get::<_, String>(1)?)
            .map_err(|error| bad(format!("invalid archived agent {id} token ledger: {error}")))?;
        let valid_time = |at: Option<i64>| at.is_none_or(|at| at >= 0);
        if !valid_time(ledger.updated_at) || ledger.last_total != ledger.fields[4].last_known {
            return Err(bad("invalid archived token accounting timestamps or total"));
        }
        for field in &ledger.fields {
            if !valid_time(field.observed_at)
                || !valid_time(field.state_at)
                || field.last_known.as_ref().and_then(|known| known.at) != field.observed_at
                || field
                    .last_known
                    .as_ref()
                    .is_some_and(|known| known.at.is_none())
                || field
                    .observed_at
                    .zip(field.state_at)
                    .is_some_and(|(observed, state)| observed > state)
                || field.observed_at.is_some() && field.state_at.is_none()
            {
                return Err(bad("invalid archived per-field token freshness"));
            }
        }
    }
    let parse_counter = |value: Option<String>| -> R<()> {
        if let Some(value) = value {
            let parsed = value
                .parse::<u64>()
                .map_err(|_| bad("invalid archived unsigned counter"))?;
            if parsed.to_string() != value {
                return Err(bad(
                    "archived counters must be canonical unsigned decimal strings",
                ));
            }
        }
        Ok(())
    };
    let mut statement = db.prepare("SELECT value,observed_at FROM context_observations")?;
    let mut contexts = statement.query([])?;
    while let Some(row) = contexts.next()? {
        parse_counter(Some(row.get(0)?))?;
        if row.get::<_, i64>(1)? < 0 {
            return Err(bad("invalid archived context observation time"));
        }
    }
    let mut statement =
        db.prepare("SELECT baseline,latest,observed_at,quality,metric FROM counter_origins")?;
    let mut counters = statement.query([])?;
    while let Some(row) = counters.next()? {
        parse_counter(row.get(0)?)?;
        let latest: Option<String> = row.get(1)?;
        let at: Option<i64> = row.get(2)?;
        let quality: String = row.get(3)?;
        let metric: String = row.get(4)?;
        if latest.is_some() != at.is_some()
            || at.is_some_and(|at| at < 0)
            || !matches!(
                quality.as_str(),
                "unknown" | "provisional" | "partial" | "final"
            )
            || !FIELD_NAMES.contains(&metric.as_str())
        {
            return Err(bad("invalid archived counter origin metadata"));
        }
        parse_counter(latest)?;
    }
    let mut statement =
        db.prepare("SELECT id,source_instance,started_at,imported_at FROM recording_origins")?;
    let mut origins = statement.query([])?;
    while let Some(row) = origins.next()? {
        crate::workspace::validate_uuid(&row.get::<_, String>(0)?)?;
        crate::workspace::validate_uuid(&row.get::<_, String>(1)?)?;
        if row.get::<_, i64>(2)? < 0 || row.get::<_, Option<i64>>(3)?.is_some_and(|at| at < 0) {
            return Err(bad("invalid archived recording origin time"));
        }
    }
    Ok(())
}

/// Detach provider sessions without counting old absolute snapshots again or refreshing numeric evidence.
pub(super) fn seal_import(db: &Connection) -> R<()> {
    let mut after = 0;
    loop {
        let ids = rows(
            db,
            "SELECT agent_id id FROM agent_token_usage WHERE agent_id>?1 ORDER BY agent_id LIMIT 64",
            [after],
        )?;
        if ids.is_empty() {
            break;
        }
        for item in ids {
            let id = item["id"].as_i64().unwrap();
            after = id;
            let (saved,harness):(String,String)=db.query_row("SELECT u.ledger,a.harness FROM agent_token_usage u JOIN agents a ON a.id=u.agent_id WHERE u.agent_id=?",[id],|row|Ok((row.get(0)?,row.get(1)?)))?;
            let mut ledger: Ledger = serde_json::from_str(&saved)
                .map_err(|error| bad(format!("invalid archived token ledger: {error}")))?;
            ledger.finish(&harness);
            if harness == "codex" {
                let before = ledger.counts(&harness);
                let quality = ledger.state(&harness, false).to_owned();
                ledger.previous = ledger.previous.add(&ledger.codex);
                ledger.previous_partial |= ledger.codex.any() && !ledger.codex_complete;
                ledger.codex = Counts::default();
                ledger.codex_complete = true;
                ledger.reconcile_fields(&harness, &before, &quality, [false; 5], now());
            }
            ledger.session = None;
            db.execute(
                "UPDATE agent_token_usage SET ledger=?2 WHERE agent_id=?1",
                params![id, serde_json::to_string(&ledger).unwrap()],
            )?;
        }
    }
    Ok(())
}

pub(crate) fn begin(st: &St, id: i64, session: Option<&str>) -> R<()> {
    let (mut ledger, harness) = load(st, id)?;
    ledger.begin(&harness, session);
    save(st, id, &ledger)?;
    metric_history::record_counter_summaries(st, id, &observations(st, id)?, true)
}

pub(super) fn finish(st: &St, id: i64) -> R<()> {
    let (mut ledger, harness) = load(st, id)?;
    ledger.finish(&harness);
    save(st, id, &ledger)?;
    metric_history::record_counter_summaries(st, id, &observations(st, id)?, true)
}

pub(super) fn session(st: &St, id: i64, session: &str) -> R<()> {
    let (mut ledger, harness) = load(st, id)?;
    if harness == "codex" {
        ledger.session(Some(session));
        save(st, id, &ledger)?;
    }
    Ok(())
}

pub(super) fn record(st: &St, id: i64, sample: TokenUsage) -> R<()> {
    let (mut ledger, _) = load(st, id)?;
    if ledger.observe(sample) {
        save(st, id, &ledger)?;
        metric_history::record_counter_summaries(st, id, &observations(st, id)?, false)?;
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
    agent["token_usage_last_total"] = json!(ledger.last_total);
    agent["token_usage_state"] = json!(ledger.state(&harness, agent["state"] == "working"));
    agent["token_usage_updated_at"] = json!(ledger.updated_at);
    agent["context"] = json!(metric_history::context_value(st, id)?);
    let mut fields = serde_json::Map::new();
    for (name, field) in FIELD_NAMES.into_iter().zip(&ledger.fields) {
        let mut value = json!(field);
        value["awaiting_update"] = json!(
            agent["state"] == "working" && ledger.turn.as_ref().is_some_and(|turn| !turn.finalized)
        );
        fields.insert(name.into(), value);
    }
    agent["token_usage_fields"] = Value::Object(fields);
    Ok(())
}

pub(super) const FIELD_NAMES: [&str; 5] = [
    "fresh_in",
    "cache_write",
    "cache_read",
    "output",
    "total_tokens",
];

pub(super) fn observations(st: &St, id: i64) -> R<Vec<crate::metrics::Observation>> {
    use crate::metrics::{Kind, Number, Observation, Point, Quality, Series};
    let (ledger, harness) = load(st, id)?;
    let counts = ledger.counts(&harness);
    let values = [
        counts.values[0],
        counts.values[1],
        counts.values[2],
        counts.values[3],
        counts.total,
    ];
    let working: bool = st.db.query_row(
        "SELECT state='working' FROM agents WHERE id=?",
        [id],
        |row| row.get(0),
    )?;
    let quality = match ledger.state(&harness, working) {
        "final" => Quality::Final,
        "provisional" => Quality::Provisional,
        "partial" => Quality::Partial,
        _ => Quality::Unknown,
    };
    let mut result = Vec::new();
    for (index, name) in FIELD_NAMES.into_iter().enumerate() {
        let field = &ledger.fields[index];
        let Some(at) = field.state_at else { continue };
        let observed = field
            .last_known
            .as_ref()
            .filter(|last| Some(last.tokens) == values[index]);
        let value = observed.map(|last| Number::Counter(last.tokens));
        result.push(Observation {
            series: Series {
                entity: format!("agent:{id}"),
                metric: name.into(),
                kind: Kind::Counter,
            },
            point: Point {
                observed_at: at,
                value_observed_at: observed.and_then(|last| last.at),
                quality: if value.is_some() {
                    quality
                } else {
                    Quality::Unknown
                },
                value,
            },
            correction: false,
            coverage_gap: false,
        });
    }
    Ok(result)
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

    fn archive_database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::app::SCHEMA).unwrap();
        crate::app::initialize_views(&db).unwrap();
        db.execute_batch("INSERT INTO projects(id,path,name,created_at) VALUES(1,'/synthetic','synthetic',0);INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(1,1,'worker','synthetic','codex','test','medium','working',0,0);").unwrap();
        db
    }

    #[test]
    fn archive_validation_uses_ledger_types_and_canonical_durable_numbers() {
        let db = archive_database();
        let mut ledger = Ledger::default();
        ledger.begin("codex", Some("old-session"));
        ledger.observe(TokenUsage {
            source: TokenSource::CodexSession { finalized: true },
            counts: [None; 4],
            total: Some(10),
        });
        let saved = serde_json::to_string(&ledger).unwrap();
        db.execute("INSERT INTO agent_token_usage VALUES(1,?)", [&saved])
            .unwrap();
        validate_archive(&db).unwrap();
        let mut malformed: Value = serde_json::from_str(&saved).unwrap();
        malformed["unexpected"] = json!(true);
        db.execute(
            "UPDATE agent_token_usage SET ledger=?",
            [malformed.to_string()],
        )
        .unwrap();
        assert!(validate_archive(&db).is_err());
        db.execute("UPDATE agent_token_usage SET ledger=?", [&saved])
            .unwrap();
        db.execute("INSERT INTO context_observations VALUES(1,'01',10)", [])
            .unwrap();
        assert!(validate_archive(&db).is_err());
        db.execute("UPDATE context_observations SET value='0'", [])
            .unwrap();
        validate_archive(&db).unwrap();
        malformed = serde_json::from_str(&saved).unwrap();
        malformed["fields"][4]["observed_at"] = json!(-1);
        db.execute(
            "UPDATE agent_token_usage SET ledger=?",
            [malformed.to_string()],
        )
        .unwrap();
        assert!(validate_archive(&db).is_err());
    }

    #[test]
    fn import_seals_native_accounting_once_without_refreshing_numeric_observations() {
        for finalized in [false, true] {
            let db = archive_database();
            let mut ledger = Ledger::default();
            ledger.begin("codex", Some("old-session"));
            ledger.observe(TokenUsage {
                source: TokenSource::CodexSession { finalized },
                counts: [None; 4],
                total: Some(100),
            });
            for field in &mut ledger.fields {
                if let Some(known) = &mut field.last_known {
                    field.observed_at = Some(10);
                    field.state_at = Some(10);
                    known.at = Some(10);
                }
            }
            ledger.last_total = ledger.fields[4].last_known.clone();
            db.execute(
                "INSERT INTO agent_token_usage VALUES(1,?)",
                [serde_json::to_string(&ledger).unwrap()],
            )
            .unwrap();
            seal_import(&db).unwrap();
            seal_import(&db).unwrap();
            validate_archive(&db).unwrap();
            let saved: String = db
                .query_row("SELECT ledger FROM agent_token_usage", [], |row| row.get(0))
                .unwrap();
            let mut imported: Ledger = serde_json::from_str(&saved).unwrap();
            assert_eq!(imported.counts("codex").total, Some(100));
            assert_eq!(imported.fields[4].observed_at, Some(10));
            assert_eq!(imported.last_total.as_ref().unwrap().at, Some(10));
            assert!(imported.session.is_none());
            assert_eq!(
                imported.state("codex", false),
                if finalized { "final" } else { "partial" }
            );
            imported.begin("codex", Some("new-session"));
            imported.observe(TokenUsage {
                source: TokenSource::CodexSession { finalized: true },
                counts: [None; 4],
                total: Some(5),
            });
            assert_eq!(imported.counts("codex").total, Some(105));
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
    fn field_freshness_and_last_known_values_only_advance_on_numeric_source_evidence() {
        let mut ledger = Ledger::default();
        ledger.begin("claude", None);
        ledger.observe(sample(
            TokenSource::ClaudeStreamStart("first".into()),
            [Some(10), Some(20), Some(30), Some(1)],
        ));
        for field in &mut ledger.fields {
            field.observed_at = Some(10);
            field.state_at = Some(10);
            field.last_known.as_mut().unwrap().at = Some(10);
        }
        ledger.observe(sample(
            TokenSource::ClaudeStreamDelta,
            [None, None, None, Some(2)],
        ));
        for field in &ledger.fields[..3] {
            assert_eq!(field.observed_at, Some(10));
            assert_eq!(field.state_at, Some(10));
        }
        let output_at = ledger.fields[3].observed_at;
        assert!(output_at.unwrap() > 10);
        assert_eq!(ledger.fields[3].last_known.as_ref().unwrap().tokens, 2);
        assert_eq!(ledger.fields[4].last_known.as_ref().unwrap().tokens, 62);
        ledger.finish("claude");
        assert_eq!(ledger.fields[3].observed_at, output_at);
        assert_eq!(ledger.fields[0].observed_at, Some(10));
        let before = serde_json::to_value(&ledger.fields).unwrap();
        let ledger: Ledger =
            serde_json::from_str(&serde_json::to_string(&ledger).unwrap()).unwrap();
        assert_eq!(serde_json::to_value(ledger.fields).unwrap(), before);
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
