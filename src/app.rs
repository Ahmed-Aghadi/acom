// Server state and all the rules: agents, threads, messages, locks, limits.
// Everything happens under one mutex, so no two changes ever interleave.

use crate::run;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::paging::fingerprint;
pub use crate::paging::{PageQuery, bounded_record};

pub const GUIDE: &str = include_str!("guide.md");
pub const MODELS: &str = include_str!("models.md");
pub const STATES: [&str; 7] = [
    "working", "idle", "paused", "done", "closed", "crashed", "replaced",
];
pub const MARKS: [&str; 3] = ["new", "in-progress", "handled"];

/// Where acom keeps its data: `ACOM_HOME`, or `~/.acom`.
pub fn acom_home() -> PathBuf {
    match std::env::var_os("ACOM_HOME") {
        Some(h) => PathBuf::from(h),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".acom"),
    }
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[derive(Debug)]
pub struct Fail(pub u16, pub String);
pub type R<T> = Result<T, Fail>;

impl From<rusqlite::Error> for Fail {
    fn from(e: rusqlite::Error) -> Self {
        Fail(500, format!("database: {e}"))
    }
}
pub fn bad(m: impl Into<String>) -> Fail {
    Fail(400, m.into())
}
pub fn conflict(m: impl Into<String>) -> Fail {
    Fail(409, m.into())
}
pub fn not_found(m: impl Into<String>) -> Fail {
    Fail(404, m.into())
}

// ---------- settings ----------

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Limit {
    pub soft: Option<f64>,
    pub hard: Option<f64>,
}

impl Limit {
    /// "soft 6, hard 8", "soft none, hard 95%", or "no limit".
    pub fn text(&self, unit: &str) -> String {
        let v = |x: Option<f64>| x.map_or("none".to_string(), |x| format!("{x}{unit}"));
        match (self.soft, self.hard) {
            (None, None) => "no limit".into(),
            (s, h) => format!("soft {}, hard {}", v(s), v(h)),
        }
    }
}

/// One limit, checked against the value it would have after a launch or wake.
pub struct Check {
    what: String,
    value: f64,
    lim: Limit,
    unit: &'static str,
}

impl Check {
    fn over(&self, limit: Option<f64>) -> bool {
        // Counts are over once the new agent would exceed them; percentages once reached.
        limit.is_some_and(|l| {
            if self.unit.is_empty() {
                self.value > l
            } else {
                self.value >= l
            }
        })
    }
    fn line(&self, kind: &str) -> String {
        let now = if self.unit.is_empty() {
            format!("{} {}", self.value - 1.0, self.what)
        } else {
            format!("{} {:.0}{}", self.what, self.value, self.unit)
        };
        format!("{kind} limit reached: {now} ({})", self.lim.text(self.unit))
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct HarnessCfg {
    pub enabled: bool,
    pub models: Vec<String>,
    pub efforts: Vec<String>,
    pub model: String,
    pub effort: String,
    pub flags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Limits {
    pub active: Limit,
    pub active_per_harness: BTreeMap<String, Limit>,
    pub usage: BTreeMap<String, Limit>,
    pub context: Limit,
}

impl Limits {
    fn usage_limit(&self, provider: &str, window: &str) -> Option<&Limit> {
        if provider == "claude" {
            let key = match window {
                "five_hour" => "claude_five_hour",
                "seven_day" => "claude_seven_day",
                "seven_day_fable" => return self.usage.get("claude_seven_day_fable"),
                _ => return None,
            };
            // Previously saved provider-wide thresholds supply both windows until edited.
            self.usage.get(key).or_else(|| self.usage.get("claude"))
        } else {
            self.usage.get(provider)
        }
    }
}

fn window_label(window: &str) -> &str {
    match window {
        "five_hour" => "five-hour",
        "seven_day" => "weekly",
        "seven_day_fable" => "weekly Fable",
        _ => window,
    }
}

fn is_fable(model: &str) -> bool {
    model == "fable" || model.starts_with("claude-fable-")
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Settings {
    pub harnesses: BTreeMap<String, HarnessCfg>,
    pub limits: Limits,
    pub auto_resume: bool,
    pub done_closes: bool,
    #[serde(default = "default_max_lock_ttl_secs")]
    pub max_lock_ttl_secs: u32,
    #[serde(default = "poll_interval")]
    pub usage_poll_secs: u64,
    #[serde(default)]
    pub prompts: Prompts,
    #[serde(default)]
    pub allow_agent_model_change: bool,
    #[serde(default)]
    pub allow_agent_effort_change: bool,
    #[serde(default)]
    pub crash_retries: BTreeMap<String, RetryRule>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct RetryRule {
    pub harness: String,
    pub model: String,
    #[serde(default)]
    pub same_model_retries: u32,
}

/// Only documented catalog conversions; custom models retain the requested effort.
fn recovery_effort(harness: &str, model: &str, inherited: &str) -> String {
    let Some(m) = crate::harness::catalog(harness)
        .into_iter()
        .find(|m| m.id == model)
    else {
        return inherited.into();
    };
    if m.efforts.contains(&inherited) {
        inherited.into()
    } else if m.efforts.len() == 1 {
        m.efforts[0].into()
    } else if inherited == "ultra" && m.efforts.contains(&"max") {
        "max".into()
    } else {
        inherited.into()
    }
}

fn check_model(harness: &str, model: &str) -> R<()> {
    if model.trim().is_empty() || model.contains(char::is_whitespace) {
        return Err(bad(format!("{model:?} isn't a model ID")));
    }
    for h in crate::harness::KNOWN {
        if crate::harness::catalog(h)
            .into_iter()
            .any(|m| m.id == model)
            && h != harness
        {
            return Err(bad(format!("{model} belongs to {h}, not {harness}")));
        }
    }
    Ok(())
}

fn check_choice(harness: &str, model: &str, effort: &str) -> R<()> {
    check_model(harness, model)?;
    if effort.trim().is_empty() || effort.contains(char::is_whitespace) {
        return Err(bad("choose a nonempty effort level"));
    }
    if let Some(m) = crate::harness::catalog(harness)
        .into_iter()
        .find(|m| m.id == model)
        && !m.efforts.contains(&effort)
    {
        return Err(bad(format!(
            "{model} doesn't support effort {effort} (it supports {})",
            m.efforts.join(", ")
        )));
    }
    Ok(())
}

fn poll_interval() -> u64 {
    120
}

fn default_max_lock_ttl_secs() -> u32 {
    900
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct Prompts {
    pub launch: String,
    pub wake: String,
    pub resume: String,
}
impl Default for Prompts {
    fn default() -> Self {
        Self {
            launch: "Work on your task and use acom to coordinate when useful.".into(),
            wake: "You were woken because of the updates above. Carry on.".into(),
            resume: "Check what finished before the interruption and redo only what is needed. Carry on.".into(),
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        // Allow every model acom knows, and every effort any of them supports.
        let cfg = |harness: &str, model: &str, flag: &str| {
            let models = crate::harness::catalog(harness);
            let mut efforts: Vec<String> = Vec::new();
            for e in models.iter().flat_map(|m| m.efforts) {
                if !efforts.iter().any(|x| x == e) {
                    efforts.push(e.to_string());
                }
            }
            HarnessCfg {
                enabled: true,
                models: models.iter().map(|m| m.id.to_string()).collect(),
                efforts,
                model: model.into(),
                effort: "medium".into(),
                flags: vec![flag.into()],
            }
        };
        let mut harnesses = BTreeMap::new();
        harnesses.insert(
            "claude".into(),
            cfg(
                "claude",
                "claude-opus-5-5",
                "--dangerously-skip-permissions",
            ),
        );
        harnesses.insert(
            "codex".into(),
            cfg(
                "codex",
                "gpt-6-sol",
                "--dangerously-bypass-approvals-and-sandbox",
            ),
        );
        let per = |s, h| Limit {
            soft: Some(s),
            hard: Some(h),
        };
        let mut active_per_harness = BTreeMap::new();
        let mut usage = BTreeMap::new();
        for h in ["claude", "codex"] {
            active_per_harness.insert(h.to_string(), per(4.0, 6.0));
        }
        for k in [
            "claude_five_hour",
            "claude_seven_day",
            "claude_seven_day_fable",
            "codex",
        ] {
            usage.insert(k.to_string(), per(80.0, 95.0));
        }
        Settings {
            harnesses,
            limits: Limits {
                active: per(6.0, 8.0),
                active_per_harness,
                usage,
                context: per(160_000.0, 200_000.0),
            },
            auto_resume: true,
            done_closes: true,
            max_lock_ttl_secs: default_max_lock_ttl_secs(),
            usage_poll_secs: poll_interval(),
            prompts: Prompts::default(),
            allow_agent_model_change: false,
            allow_agent_effort_change: false,
            crash_retries: BTreeMap::new(),
        }
    }
}

impl Settings {
    fn check(&self) -> R<()> {
        if self.max_lock_ttl_secs == 0 {
            return Err(bad("maximum lock TTL must be a positive number of seconds"));
        }
        if !(15..=3600).contains(&self.usage_poll_secs) {
            return Err(bad("usage check interval must be 15–3600 seconds"));
        }
        if [
            &self.prompts.launch,
            &self.prompts.wake,
            &self.prompts.resume,
        ]
        .iter()
        .any(|s| s.len() > 20_000)
        {
            return Err(bad(
                "prompt guidance must be at most 20000 bytes per scenario",
            ));
        }
        for (name, h) in &self.harnesses {
            if !crate::harness::KNOWN.contains(&name.as_str()) {
                return Err(bad(format!("unknown harness {name}")));
            }
            if h.model.trim().is_empty() || h.effort.trim().is_empty() {
                return Err(bad(format!("{name}: choose a default model and effort")));
            }
            if let Some(m) = crate::harness::catalog(name)
                .into_iter()
                .find(|m| m.id == h.model)
                && !m.efforts.contains(&h.effort.as_str())
            {
                return Err(bad(format!(
                    "{name}: {} doesn't support effort {} (it supports {})",
                    h.model,
                    h.effort,
                    m.efforts.join(", ")
                )));
            }
            if !h.models.contains(&h.model) {
                return Err(bad(format!(
                    "{name}: default model {} isn't in its allowed models",
                    h.model
                )));
            }
            if !h.efforts.contains(&h.effort) {
                return Err(bad(format!(
                    "{name}: default effort {} isn't in its allowed efforts",
                    h.effort
                )));
            }
        }
        for (source, rule) in &self.crash_retries {
            if source.trim().is_empty()
                || source.contains(char::is_whitespace)
                || source == &rule.model
            {
                return Err(bad(
                    "retry rules need a source model ID and a different target model",
                ));
            }
            check_model(&rule.harness, &rule.model)?;
            let target = self
                .harnesses
                .get(&rule.harness)
                .filter(|h| h.enabled)
                .ok_or_else(|| {
                    bad(format!(
                        "retry target harness {} isn't enabled",
                        rule.harness
                    ))
                })?;
            if !target.models.contains(&rule.model) {
                return Err(bad(
                    "retry target model must be in the target harness's allowed models",
                ));
            }
        }
        let l = &self.limits;
        for k in l.active_per_harness.keys() {
            if !crate::harness::KNOWN.contains(&k.as_str()) {
                return Err(bad(format!("unknown harness {k} in limits")));
            }
        }
        for (k, lim) in &l.usage {
            if ![
                "claude",
                "claude_five_hour",
                "claude_seven_day",
                "claude_seven_day_fable",
                "codex",
            ]
            .contains(&k.as_str())
            {
                return Err(bad(format!("unknown subscription window {k}")));
            }
            if [lim.soft, lim.hard].iter().flatten().any(|v| *v > 100.0) {
                return Err(bad(format!("{k}: usage limits must be between 0 and 100%")));
            }
        }
        let mut all = vec![
            ("active agents".to_string(), &l.active),
            ("context".to_string(), &l.context),
        ];
        all.extend(
            l.active_per_harness
                .iter()
                .map(|(k, v)| (format!("{k} active agents"), v)),
        );
        all.extend(l.usage.iter().map(|(k, v)| (format!("{k} usage"), v)));
        for (name, lim) in all {
            let negative = [lim.soft, lim.hard].iter().flatten().any(|v| *v < 0.0);
            let backwards = matches!((lim.soft, lim.hard), (Some(s), Some(h)) if s > h);
            if negative || backwards {
                return Err(bad(format!(
                    "{name}: limits can't be negative, and soft can't be above hard"
                )));
            }
        }
        Ok(())
    }
}

// ---------- state ----------

pub struct Proc {
    pub pid: u32,
    pub stopping: bool,
    pub model: String,
    pub effort: String,
    pub failure: Option<String>,
}

pub struct St {
    pub db: Connection,
    pub shutting_down: bool,
    pub waiting_updates: HashSet<i64>,
    pub stopping_agents: HashSet<i64>,
    /// Lock queues by (project, lock name).
    pub queues: HashMap<(i64, String), Vec<i64>>,
    pub procs: HashMap<i64, Proc>,
    /// Reaped workers can still have buffered failure events to drain.
    pub reaped: HashSet<i64>,
    pub over_soft: HashSet<(i64, String)>,
}

pub struct App {
    pub st: Mutex<St>,
    pub cv: Condvar,
    /// Where acom keeps its data (`~/.acom`).
    pub home: PathBuf,
    pub url: String,
    pub exe: PathBuf,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS configs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, settings TEXT NOT NULL);
-- ID 1 belongs to the binary's virtual Default, not a stored config.
INSERT INTO sqlite_sequence(name,seq) SELECT 'configs',1
  WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='configs');
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  config INTEGER DEFAULT 1, custom TEXT);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY, project INTEGER NOT NULL, name TEXT NOT NULL, grp TEXT, task TEXT NOT NULL,
  harness TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
  state TEXT NOT NULL, rest TEXT NOT NULL DEFAULT 'idle', status_text TEXT, session_id TEXT,
  launched_by INTEGER NOT NULL, launched_at INTEGER NOT NULL, pid INTEGER,
  pause_reason TEXT, pause_from TEXT, paused_at INTEGER, done_req INTEGER NOT NULL DEFAULT 0,
  context INTEGER NOT NULL DEFAULT 0, context_warned INTEGER NOT NULL DEFAULT 0,
  fresh_in INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0, ended_at INTEGER, wake_queued_at INTEGER, wake_why TEXT,
  session_started INTEGER NOT NULL DEFAULT 0, seen_model TEXT, problem TEXT);
CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY, project INTEGER NOT NULL, title TEXT NOT NULL, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members (thread_id INTEGER NOT NULL, agent_id INTEGER NOT NULL, last_notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (thread_id, agent_id));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, sender INTEGER NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);
CREATE TABLE IF NOT EXISTS user_reads (thread_id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS marks (agent_id INTEGER NOT NULL, message_id INTEGER NOT NULL, mark TEXT NOT NULL, PRIMARY KEY (agent_id, message_id));
CREATE TABLE IF NOT EXISTS locks (project INTEGER NOT NULL, name TEXT NOT NULL, about TEXT NOT NULL, created_at INTEGER NOT NULL,
  holder INTEGER, acquired_at INTEGER, expires_at INTEGER, frozen INTEGER NOT NULL DEFAULT 0, frozen_left INTEGER,
  PRIMARY KEY (project, name));
CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, shown INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS notices_agent ON notices(agent_id,id);
CREATE INDEX IF NOT EXISTS notices_delivery ON notices(agent_id,shown,id);
CREATE TABLE IF NOT EXISTS update_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL UNIQUE, text TEXT);
CREATE TABLE IF NOT EXISTS usage (provider TEXT NOT NULL, win TEXT NOT NULL, used_pct REAL NOT NULL, resets_at INTEGER, at INTEGER NOT NULL, PRIMARY KEY (provider, win));
CREATE TABLE IF NOT EXISTS usage_checks (provider TEXT PRIMARY KEY, checked_at INTEGER, attempted_at INTEGER, next_check INTEGER, error TEXT, in_flight INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS agent_retries (agent_id INTEGER PRIMARY KEY, source TEXT NOT NULL, effort TEXT, tried TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, replacement INTEGER, blocked TEXT, same_model_attempts INTEGER NOT NULL DEFAULT 0, eligible_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS agent_continuations (agent_id INTEGER PRIMARY KEY, text TEXT NOT NULL, blocked TEXT, attempted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS agent_handoffs (agent_id INTEGER PRIMARY KEY, request TEXT NOT NULL, blocked TEXT, attempted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS agent_starts (agent_id INTEGER PRIMARY KEY, predecessor INTEGER NOT NULL, blocked TEXT, attempted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, project INTEGER, at INTEGER NOT NULL, actor TEXT NOT NULL, what TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thread_filters (thread_id INTEGER PRIMARY KEY, states TEXT NOT NULL, groups TEXT NOT NULL, watch TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS member_intervals (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, agent_id INTEGER NOT NULL,
  start_after INTEGER NOT NULL, end_after INTEGER);
CREATE INDEX IF NOT EXISTS intervals_member ON member_intervals(thread_id,agent_id,start_after,end_after);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, project INTEGER NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL, actor TEXT NOT NULL, agent INTEGER, thread INTEGER, lock TEXT, details TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_agent ON events(project,agent,id);
CREATE INDEX IF NOT EXISTS events_thread ON events(project,thread,id);
CREATE TABLE IF NOT EXISTS summary_cursors (agent_id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS history_origin (id INTEGER PRIMARY KEY CHECK(id=1), message_id INTEGER NOT NULL);
INSERT OR IGNORE INTO history_origin(id,message_id) SELECT 1,coalesce(max(id),0) FROM messages;
-- Existing current members are retained; earlier membership context is unknown.
INSERT INTO member_intervals(thread_id,agent_id,start_after)
  SELECT b.thread_id,b.agent_id,0 FROM members b WHERE NOT EXISTS(
    SELECT 1 FROM member_intervals i WHERE i.thread_id=b.thread_id AND i.agent_id=b.agent_id);

-- Membership intervals and their events are part of the statement that joins/leaves.
CREATE TRIGGER IF NOT EXISTS member_joined AFTER INSERT ON members BEGIN
  INSERT INTO member_intervals(thread_id,agent_id,start_after)
    VALUES(NEW.thread_id,NEW.agent_id,(SELECT coalesce(max(id),0) FROM messages WHERE thread_id=NEW.thread_id));
  INSERT INTO events(project,at,kind,actor,agent,thread,details)
    SELECT project,unixepoch(),'thread.joined','acom',NEW.agent_id,NEW.thread_id,
      json_object('reason',CASE WHEN NEW.agent_id<>0 AND EXISTS(SELECT 1 FROM thread_filters WHERE thread_id=NEW.thread_id)
                               THEN 'matched live filters' ELSE 'member added' END)
    FROM threads WHERE id=NEW.thread_id;
END;
CREATE TRIGGER IF NOT EXISTS member_left AFTER DELETE ON members BEGIN
  UPDATE member_intervals SET end_after=(SELECT coalesce(max(id),0) FROM messages WHERE thread_id=OLD.thread_id)
    WHERE thread_id=OLD.thread_id AND agent_id=OLD.agent_id AND end_after IS NULL;
  INSERT INTO events(project,at,kind,actor,agent,thread,details)
    SELECT project,unixepoch(),'thread.left','acom',OLD.agent_id,OLD.thread_id,
      json_object('reason',CASE WHEN OLD.agent_id<>0 AND EXISTS(SELECT 1 FROM thread_filters WHERE thread_id=OLD.thread_id)
                               THEN 'no longer matched live filters' ELSE 'member removed' END)
    FROM threads WHERE id=OLD.thread_id;
END;

-- Every state/group write, including recovery and startup writes, reconciles the
-- live audience in the same SQLite statement. No separate tick can lag behind it.
CREATE TRIGGER IF NOT EXISTS agent_created AFTER INSERT ON agents BEGIN
  INSERT INTO events(project,at,kind,actor,agent,details)
    VALUES(NEW.project,unixepoch(),'agent.created',CASE WHEN NEW.launched_by=0 THEN 'user' ELSE 'agent '||NEW.launched_by END,
      NEW.id,json_object('state',NEW.state,'group',NEW.grp,'harness',NEW.harness,'model',NEW.model,'effort',NEW.effort));
  INSERT OR IGNORE INTO members(thread_id,agent_id,last_notified)
    SELECT t.id,NEW.id,(SELECT coalesce(max(id),0) FROM messages WHERE thread_id=t.id)
    FROM threads t JOIN thread_filters f ON f.thread_id=t.id WHERE t.project=NEW.project
      AND EXISTS(SELECT 1 FROM json_each(f.states) WHERE value=NEW.state)
      AND (json_array_length(f.groups)=0 OR EXISTS(SELECT 1 FROM json_each(f.groups) WHERE value=NEW.grp));
END;
CREATE TRIGGER IF NOT EXISTS agent_audience AFTER UPDATE OF state,grp ON agents
WHEN OLD.state<>NEW.state OR OLD.grp IS NOT NEW.grp BEGIN
  INSERT INTO events(project,at,kind,actor,agent,details)
    SELECT NEW.project,unixepoch(),'agent.state','acom',NEW.id,json_object('from',OLD.state,'to',NEW.state)
    WHERE OLD.state<>NEW.state;
  INSERT INTO events(project,at,kind,actor,agent,details)
    SELECT NEW.project,unixepoch(),'agent.group','agent '||NEW.id,NEW.id,json_object('from',OLD.grp,'to',NEW.grp)
    WHERE OLD.grp IS NOT NEW.grp;
  DELETE FROM members WHERE agent_id=NEW.id AND thread_id IN (
    SELECT t.id FROM threads t JOIN thread_filters f ON f.thread_id=t.id WHERE t.project=NEW.project
      AND NOT (EXISTS(SELECT 1 FROM json_each(f.states) WHERE value=NEW.state)
        AND (json_array_length(f.groups)=0 OR EXISTS(SELECT 1 FROM json_each(f.groups) WHERE value=NEW.grp))));
  INSERT OR IGNORE INTO members(thread_id,agent_id,last_notified)
    SELECT t.id,NEW.id,(SELECT coalesce(max(id),0) FROM messages WHERE thread_id=t.id)
    FROM threads t JOIN thread_filters f ON f.thread_id=t.id WHERE t.project=NEW.project
      AND EXISTS(SELECT 1 FROM json_each(f.states) WHERE value=NEW.state)
      AND (json_array_length(f.groups)=0 OR EXISTS(SELECT 1 FROM json_each(f.groups) WHERE value=NEW.grp));
END;
CREATE TRIGGER IF NOT EXISTS agent_status AFTER UPDATE OF status_text ON agents
WHEN OLD.status_text IS NOT NEW.status_text BEGIN
  INSERT INTO events(project,at,kind,actor,agent,details)
    VALUES(NEW.project,unixepoch(),'agent.status','agent '||NEW.id,NEW.id,json_object('from',OLD.status_text,'to',NEW.status_text));
END;
CREATE TRIGGER IF NOT EXISTS agent_configured AFTER UPDATE OF model,effort ON agents
WHEN OLD.model<>NEW.model OR OLD.effort<>NEW.effort BEGIN
  INSERT INTO events(project,at,kind,actor,agent,details)
    VALUES(NEW.project,unixepoch(),'agent.configured','acom',NEW.id,
      json_object('from_model',OLD.model,'model',NEW.model,'from_effort',OLD.effort,'effort',NEW.effort));
END;
CREATE TRIGGER IF NOT EXISTS lock_acquired AFTER UPDATE OF holder ON locks
WHEN NEW.holder IS NOT NULL AND OLD.holder IS NOT NEW.holder BEGIN
  INSERT INTO events(project,at,kind,actor,agent,lock,details)
    VALUES(NEW.project,unixepoch(),'lock.acquired','agent '||NEW.holder,NEW.holder,NEW.name,
      json_object('expires_at',NEW.expires_at));
END;
CREATE TRIGGER IF NOT EXISTS lock_created AFTER INSERT ON locks BEGIN
  INSERT INTO events(project,at,kind,actor,agent,lock,details)
    VALUES(NEW.project,unixepoch(),'lock.created','acom',NEW.holder,NEW.name,json_object('about',NEW.about));
END;
CREATE TRIGGER IF NOT EXISTS lock_released AFTER UPDATE OF holder ON locks
WHEN OLD.holder IS NOT NULL AND OLD.holder IS NOT NEW.holder BEGIN
  INSERT INTO events(project,at,kind,actor,agent,lock,details)
    VALUES(OLD.project,unixepoch(),CASE WHEN OLD.frozen=0 AND OLD.expires_at<=unixepoch() THEN 'lock.expired' ELSE 'lock.released' END,
      'acom',OLD.holder,OLD.name,json_object('acquired_at',OLD.acquired_at,'expires_at',OLD.expires_at));
END;
CREATE TRIGGER IF NOT EXISTS lock_changed AFTER UPDATE OF expires_at,frozen,frozen_left ON locks
WHEN NEW.holder IS NOT NULL AND OLD.holder=NEW.holder
  AND (OLD.expires_at IS NOT NEW.expires_at OR OLD.frozen<>NEW.frozen OR OLD.frozen_left IS NOT NEW.frozen_left) BEGIN
  INSERT INTO events(project,at,kind,actor,agent,lock,details)
    VALUES(NEW.project,unixepoch(),CASE WHEN OLD.frozen<>NEW.frozen THEN CASE WHEN NEW.frozen=1 THEN 'lock.frozen' ELSE 'lock.unfrozen' END
      ELSE CASE WHEN NEW.expires_at<OLD.expires_at OR NEW.frozen_left<OLD.frozen_left THEN 'lock.shortened' ELSE 'lock.renewed' END END,
      'acom',NEW.holder,NEW.name,json_object('expires_at',NEW.expires_at,'frozen_left',NEW.frozen_left));
END;
CREATE TABLE IF NOT EXISTS view_revisions (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO view_revisions VALUES('epoch',0);
CREATE TABLE IF NOT EXISTS view_ids (name TEXT PRIMARY KEY, id INTEGER NOT NULL);
INSERT OR IGNORE INTO view_ids SELECT 'activity',coalesce(max(id),0) FROM activity;
INSERT OR IGNORE INTO view_ids SELECT 'messages',coalesce(max(id),0) FROM messages;
INSERT OR IGNORE INTO view_ids SELECT 'threads',coalesce(max(id),0) FROM threads;
INSERT OR IGNORE INTO view_ids SELECT 'locks',coalesce(max(rowid),0) FROM locks;
INSERT OR IGNORE INTO view_ids SELECT 'notices',coalesce(max(id),0) FROM notices;
";

// Revision counters participate in the same SQLite transaction as their rows,
// including external writes. No-op updates do not invalidate a snapshot.
fn initialize_views(db: &Connection) -> R<()> {
    for table in [
        "projects",
        "configs",
        "agents",
        "threads",
        "messages",
        "members",
        "member_intervals",
        "thread_filters",
        "user_reads",
        "marks",
        "locks",
        "activity",
        "events",
        "usage",
        "usage_checks",
        "notices",
        "agent_handoffs",
        "agent_starts",
        "agent_retries",
    ] {
        db.execute("INSERT OR IGNORE INTO view_revisions VALUES(?1,0)", [table])?;
        let columns: Vec<String> = rows(db, &format!("PRAGMA table_info({table})"), [])?
            .into_iter()
            .map(|v| v["name"].as_str().unwrap().to_string())
            .collect();
        let changed = columns
            .iter()
            .map(|column| format!("OLD.\"{column}\" IS NOT NEW.\"{column}\""))
            .collect::<Vec<_>>()
            .join(" OR ");
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            let when = if operation == "UPDATE" {
                format!("WHEN {changed}")
            } else {
                String::new()
            };
            db.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS view_{table}_{operation} AFTER {operation} ON {table} {when} BEGIN UPDATE view_revisions SET value=value+1 WHERE name='{table}'; END;"))?;
        }
    }
    for table in ["activity", "messages", "threads", "locks", "notices"] {
        db.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS view_id_{table} AFTER INSERT ON {table} BEGIN UPDATE view_ids SET id=max(id,NEW.rowid) WHERE name='{table}'; END;"))?;
    }
    db.execute(
        "UPDATE view_revisions SET value=value+1 WHERE name='epoch'",
        [],
    )?;
    Ok(())
}

/// Development schemas changed before release; don't serve a half-working old
/// database or alter its records. Starting with a separate ACOM_HOME is safe.
fn check_stored_schema(db: &Connection) -> R<()> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('agents','configs','projects'))",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(());
    }
    let autoincrement_tables: i64 = db.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('projects','configs')
         AND upper(sql) LIKE '%AUTOINCREMENT%'",
        [],
        |r| r.get(0),
    )?;
    let mut interrupted_schema = false;
    for table in ["agent_continuations", "agent_handoffs"] {
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |r| r.get(0),
        )?;
        if exists
            && db
                .prepare(&format!("SELECT attempted FROM {table} LIMIT 0"))
                .is_err()
        {
            interrupted_schema = true;
        }
    }
    if db
        .prepare(
            "SELECT a.project, a.seen_model, a.problem, t.project, l.project, x.project,
                    p.config, p.custom, c.settings, r.effort, r.same_model_attempts, r.eligible_at
                   FROM agents a, threads t, locks l, activity x, projects p, configs c, agent_retries r LIMIT 0",
        )
        .is_err()
        || autoincrement_tables != 2
        || interrupted_schema
        || db.query_row("SELECT EXISTS(SELECT 1 FROM configs WHERE id=1 OR name='Default')", [], |r| r.get::<_, bool>(0))?
    {
        return Err(bad(
            "this database uses an earlier development schema. It has not been changed. Keep it as a backup and start with a separate ACOM_HOME folder.",
        ));
    }
    Ok(())
}

/// An agent row, as the rules need it.
pub struct Agent {
    pub project: i64,
    pub name: String,
    pub grp: Option<String>,
    pub task: String,
    pub harness: String,
    pub model: String,
    pub effort: String,
    pub state: String,
    pub rest: String,
    pub session: Option<String>,
    pub launched_by: i64,
    pub pause_from: Option<String>,
    pub paused_at: Option<i64>,
    pub done_req: bool,
    pub problem: Option<String>,
}

pub fn who(id: i64) -> String {
    if id == 0 {
        "user".into()
    } else {
        format!("agent {id}")
    }
}

/// "user", "agent 3", or "user (via agent 7)" for a user command an agent ran.
pub fn actor(agent: i64, via: Option<i64>) -> String {
    match (agent, via) {
        (0, Some(v)) => format!("user (via agent {v})"),
        (a, _) => who(a),
    }
}

pub fn hhmm(t: i64) -> String {
    // Local time without pulling in a date crate.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let t = t as libc::time_t;
    unsafe { libc::localtime_r(&t, &mut tm) };
    format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
}

fn sql_val(v: rusqlite::types::Value) -> Value {
    use rusqlite::types::Value as V;
    match v {
        V::Null | V::Blob(_) => Value::Null,
        V::Integer(i) => json!(i),
        V::Real(f) => json!(f),
        V::Text(t) => json!(t),
    }
}

/// Run a query and return each row as a JSON object keyed by column name.
pub fn rows(db: &Connection, sql: &str, p: impl rusqlite::Params) -> R<Vec<Value>> {
    let mut s = db.prepare(sql)?;
    let names: Vec<String> = s.column_names().iter().map(|c| c.to_string()).collect();
    let it = s.query_map(p, |r| {
        let mut m = serde_json::Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(n.clone(), sql_val(r.get(i)?));
        }
        Ok(Value::Object(m))
    })?;
    Ok(it.collect::<Result<_, _>>()?)
}

impl St {
    /// Commit a related group of writes together, also inside an existing savepoint.
    fn atomic<T>(&mut self, change: impl FnOnce(&mut Self) -> R<T>) -> R<T> {
        self.db.execute_batch("SAVEPOINT change")?;
        let result = change(self);
        match result {
            Ok(value) => {
                if let Err(e) = self.db.execute_batch("RELEASE change") {
                    let _ = self.db.execute_batch("ROLLBACK TO change; RELEASE change");
                    return Err(e.into());
                }
                Ok(value)
            }
            Err(e) => {
                self.db
                    .execute_batch("ROLLBACK TO change; RELEASE change")?;
                Err(e)
            }
        }
    }

    pub(crate) fn event(
        &self,
        project: i64,
        agent: Option<i64>,
        thread: Option<i64>,
        kind: &str,
        actor: &str,
        details: Value,
    ) -> R<()> {
        self.db.execute(
            "INSERT INTO events(project,at,kind,actor,agent,thread,details) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![project,now(),kind,actor,agent,thread,details.to_string()],
        )?;
        Ok(())
    }

    /// A project's settings: its custom ones, or the saved config it uses.
    /// No project means the Default config.
    pub fn settings_for(&self, project: Option<i64>) -> Settings {
        let json: Option<String> = match project {
            Some(p) => self
                .db
                .query_row(
                    "SELECT coalesce(p.custom, c.settings) FROM projects p
                     LEFT JOIN configs c ON c.id=p.config AND p.config<>1 WHERE p.id=?1",
                    [p],
                    |r| r.get(0),
                )
                .ok()
                .flatten(),
            None => None,
        };
        json.and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn agent(&self, id: i64) -> R<Agent> {
        self.db
            .query_row(
                "SELECT name,grp,task,harness,model,effort,state,rest,session_id,launched_by,
                        pause_from,paused_at,done_req,project,problem FROM agents WHERE id=?1",
                [id],
                |r| {
                    Ok(Agent {
                        name: r.get(0)?,
                        grp: r.get(1)?,
                        task: r.get(2)?,
                        harness: r.get(3)?,
                        model: r.get(4)?,
                        effort: r.get(5)?,
                        state: r.get(6)?,
                        rest: r.get(7)?,
                        session: r.get(8)?,
                        launched_by: r.get(9)?,
                        pause_from: r.get(10)?,
                        paused_at: r.get(11)?,
                        done_req: r.get::<_, i64>(12)? != 0,
                        project: r.get(13)?,
                        problem: r.get(14)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| not_found(format!("no agent {id}")))
    }

    /// A project's name and folder.
    pub fn project(&self, id: i64) -> R<(String, String)> {
        self.db
            .query_row("SELECT name, path FROM projects WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?
            .ok_or_else(|| not_found(format!("no project {id}")))
    }

    pub fn set_state(&self, id: i64, state: &str) -> R<()> {
        let ended = matches!(state, "done" | "closed" | "crashed" | "replaced");
        self.db.execute(
            "UPDATE agents SET state=?2, ended_at=CASE WHEN ?3 THEN ?4 ELSE NULL END WHERE id=?1",
            params![id, state, ended, now()],
        )?;
        Ok(())
    }

    /// Record an activity line, for one project or (None) for all of them.
    pub fn log(&self, project: Option<i64>, actor: &str, what: &str) -> R<()> {
        self.db.execute(
            "INSERT INTO activity(id,project,at,actor,what) VALUES((SELECT max((SELECT id FROM view_ids WHERE name='activity'),coalesce(max(id),0))+1 FROM activity),?1,?2,?3,?4)",
            params![project, now(), actor, what],
        )?;
        Ok(())
    }

    /// Record an activity line about an agent, in its project.
    pub fn log_for(&self, agent: i64, actor: &str, what: &str) -> R<()> {
        let project = self.agent(agent)?.project;
        self.log(Some(project), actor, what)
    }

    pub fn notice(&self, agent: i64, text: &str) -> R<()> {
        self.db.execute(
            "INSERT INTO notices(id,agent_id,text,at) VALUES((SELECT max((SELECT id FROM view_ids WHERE name='notices'),coalesce(max(id),0))+1 FROM notices),?1,?2,?3)",
            params![agent, text, now()],
        )?;
        Ok(())
    }

    fn remember_crash(&self, id: i64, a: &Agent) -> R<()> {
        let source = self
            .procs
            .get(&id)
            .map(|p| p.model.as_str())
            .unwrap_or(&a.model);
        let effort = self
            .procs
            .get(&id)
            .map(|p| p.effort.as_str())
            .unwrap_or(&a.effort);
        self.db.execute(
            "INSERT INTO agent_retries(agent_id,source,tried,effort,eligible_at) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(agent_id) DO UPDATE SET
            same_model_attempts=CASE WHEN source=excluded.source THEN same_model_attempts ELSE 0 END,
            source=excluded.source,effort=excluded.effort,handled=0,blocked=NULL,eligible_at=excluded.eligible_at",
            params![
                id,
                source,
                json!([format!("{}:{source}", a.harness)]).to_string(),
                effort,
                // Round up since persisted timestamps have one-second precision:
                // even a failure at the end of a second gets a full 2s cooldown.
                now() + 3
            ],
        )?;
        Ok(())
    }

    /// Active agents in a project (or everywhere), in total and per harness.
    fn active_counts(&self, project: Option<i64>) -> R<(i64, BTreeMap<String, i64>)> {
        let mut per = BTreeMap::new();
        let mut total = 0;
        for r in rows(
            &self.db,
            "SELECT harness h, count(*) n FROM agents WHERE state IN ('working','idle') AND done_req=0
             AND (?1 IS NULL OR project=?1) GROUP BY harness",
            [project],
        )? {
            let n = r["n"].as_i64().unwrap_or(0);
            total += n;
            per.insert(r["h"].as_str().unwrap_or("").to_string(), n);
        }
        Ok((total, per))
    }

    /// Last observed usage, including expired windows until a fresh check confirms a reset.
    pub fn used_pct(&self, provider: &str) -> R<Option<f64>> {
        Ok(self.db.query_row(
            "SELECT max(used_pct) FROM usage WHERE provider=?1 AND win<>'seven_day_fable'",
            [provider],
            |r| r.get::<_, Option<f64>>(0),
        )?)
    }

    fn window_pct(&self, provider: &str, window: &str) -> R<Option<f64>> {
        Ok(self
            .db
            .query_row(
                "SELECT used_pct FROM usage WHERE provider=?1 AND win=?2",
                params![provider, window],
                |r| r.get(0),
            )
            .optional()?)
    }

    fn usage_checks(&self, limits: &Limits, provider: &str, model: Option<&str>) -> R<Vec<Check>> {
        let mut checks = Vec::new();
        if provider != "claude" {
            // Codex keeps one provider-wide threshold; stream and status window names can differ.
            if let (Some(lim), Some(value)) = (limits.usage.get(provider), self.used_pct(provider)?)
            {
                checks.push(Check {
                    what: format!("{provider} subscription usage"),
                    value,
                    lim: lim.clone(),
                    unit: "%",
                });
            }
        } else {
            for r in rows(
                &self.db,
                "SELECT win,used_pct FROM usage WHERE provider=?1",
                [provider],
            )? {
                let window = r["win"].as_str().unwrap();
                if window == "seven_day_fable" && !model.is_some_and(is_fable) {
                    continue;
                }
                if let Some(lim) = limits.usage_limit(provider, window) {
                    checks.push(Check {
                        what: format!("{provider} {} subscription usage", window_label(window)),
                        value: r["used_pct"].as_f64().unwrap(),
                        lim: lim.clone(),
                        unit: "%",
                    });
                }
            }
        }
        if provider == "claude"
            && model.is_some_and(is_fable)
            && self
                .window_pct(provider, "seven_day_fable")?
                .is_some_and(|v| v >= 100.0)
            && !checks
                .iter()
                .any(|c| c.what.contains("weekly Fable") && c.over(c.lim.hard))
        {
            checks.push(Check {
                what: "claude weekly Fable subscription exhausted".into(),
                value: 100.0,
                lim: Limit {
                    soft: None,
                    hard: Some(100.0),
                },
                unit: "%",
            });
        }
        if self.used_pct(provider)?.is_some_and(|used| used >= 100.0)
            && !checks.iter().any(|c| c.over(c.lim.hard))
        {
            checks.push(Check {
                what: format!("{provider} subscription exhausted"),
                value: 100.0,
                lim: Limit {
                    soft: None,
                    hard: Some(100.0),
                },
                unit: "%",
            });
        }
        Ok(checks)
    }

    /// A project's limits and rules, with current usage, as agents are told them.
    pub fn limits_text(&self, project: Option<i64>) -> R<String> {
        let s = self.settings_for(project);
        let l = &s.limits;
        let (total, per) = self.active_counts(project)?;
        let mut out = format!("Active agents: {total} ({})", l.active.text(""));
        for (h, lim) in &l.active_per_harness {
            out += &format!("; {h}: {} ({})", per.get(h).unwrap_or(&0), lim.text(""));
        }
        out += "\nSubscription usage:";
        for (h, window) in [
            ("claude", "five_hour"),
            ("claude", "seven_day"),
            ("claude", "seven_day_fable"),
            ("codex", ""),
        ] {
            let lim = l.usage_limit(h, window).cloned().unwrap_or(Limit {
                soft: None,
                hard: None,
            });
            let value = if window.is_empty() {
                self.used_pct(h)?
            } else {
                self.window_pct(h, window)?
            };
            let used = match value {
                Some(p) => format!("{p:.0}%"),
                None => "unknown".into(),
            };
            let label = if window.is_empty() {
                h.to_string()
            } else {
                format!("{h} {}", window_label(window))
            };
            out += &format!("\n  {label} {used} ({})", lim.text("%"));
        }
        out += &format!("\nContext per agent: {}", l.context.text(" tokens"));
        if l.context.hard.is_some() {
            out += " (the harness compacts at the hard value)";
        }
        out += &format!(
            "\nLock TTL: maximum {}s per acquisition or renewal; omitted --ttl uses this maximum. Pausing releases locks after your old worker stops; reacquire before protected work.",
            s.max_lock_ttl_secs
        );
        out += &format!(
            "\nAgent self-changes: model {}; effort {}. Configure applies next turn within the same provider; model permission also allows a new-provider replacement.",
            if s.allow_agent_model_change {
                "allowed"
            } else {
                "disabled"
            },
            if s.allow_agent_effort_change {
                "allowed"
            } else {
                "disabled"
            }
        );
        for (h, cfg) in &s.harnesses {
            out += &format!(
                "\n  {h} ({}): allowed models {}; allowed efforts {}.",
                if cfg.enabled { "enabled" } else { "disabled" },
                cfg.models.join(", "),
                cfg.efforts.join(", ")
            );
        }
        if s.crash_retries.is_empty() {
            out += "\nCrash recovery: none configured; failed agents stay crashed.";
        } else {
            out += "\nCrash recovery (2-second delay; limits apply; cycles stop). Keep supported effort; unsupported ultra becomes max; fixed-effort models use their sole catalog effort. Allowed-effort restrictions still apply:";
            for (source, rule) in &s.crash_retries {
                out += &format!(
                    "\n  {source}: {} same-model retries, then {} / {}",
                    rule.same_model_retries, rule.harness, rule.model
                );
            }
        }
        out += if s.done_closes {
            "\nWhen an agent runs `acom done` it's closed: messages wait until the user explicitly reopens it."
        } else {
            "\nWhen an agent runs `acom done` it's done: any new message in its threads wakes it again."
        };
        Ok(out)
    }

    /// The limits a new active agent of this harness in this project would be checked against.
    fn limit_checks(&self, project: i64, harness: &str) -> R<Vec<Check>> {
        let l = self.settings_for(Some(project)).limits;
        let (total, per) = self.active_counts(Some(project))?;
        let mut checks = vec![Check {
            what: "active agents".into(),
            value: (total + 1) as f64,
            lim: l.active.clone(),
            unit: "",
        }];
        if let Some(lim) = l.active_per_harness.get(harness) {
            checks.push(Check {
                what: format!("active {harness} agents"),
                value: (per.get(harness).unwrap_or(&0) + 1) as f64,
                lim: lim.clone(),
                unit: "",
            });
        }
        checks.extend(self.usage_checks(&l, harness, None)?);
        Ok(checks)
    }

    /// Why an agent of this harness in this project can't become active right now, if it can't.
    fn no_room(&self, project: i64, harness: &str) -> R<Option<String>> {
        let checks = self.limit_checks(project, harness)?;
        Ok(checks
            .iter()
            .find(|c| c.over(c.lim.hard))
            .map(|c| c.line("Hard")))
    }

    fn model_no_room(&self, project: i64, harness: &str, model: &str) -> R<Option<String>> {
        if let Some(why) = self.no_room(project, harness)? {
            return Ok(Some(why));
        }
        Ok(self
            .usage_checks(
                &self.settings_for(Some(project)).limits,
                harness,
                Some(model),
            )?
            .iter()
            .find(|c| c.over(c.lim.hard))
            .map(|c| c.line("Hard")))
    }

    // ---------- locks ----------

    fn release_lock(&mut self, project: i64, name: &str, why: Option<&str>) -> R<()> {
        let holder: Option<i64> = self.db.query_row(
            "SELECT holder FROM locks WHERE project=?1 AND name=?2",
            params![project, name],
            |r| r.get(0),
        )?;
        self.db.execute(
            "UPDATE locks SET holder=NULL, acquired_at=NULL, expires_at=NULL, frozen=0, frozen_left=NULL
             WHERE project=?1 AND name=?2",
            params![project, name],
        )?;
        if let (Some(h), Some(why)) = (holder, why) {
            self.notice(h, &format!("You no longer hold lock `{name}`: {why}. Acquire it again if you still need it."))?;
        }
        Ok(())
    }

    fn held_by(&self, agent: i64) -> R<Vec<String>> {
        let mut s = self
            .db
            .prepare("SELECT name FROM locks WHERE holder=?1 ORDER BY name")?;
        let v = s
            .query_map([agent], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(v)
    }

    pub fn release_all(&mut self, agent: i64, why: &str) -> R<()> {
        let project = self.agent(agent)?.project;
        for name in self.held_by(agent)? {
            self.release_lock(project, &name, Some(why))?;
        }
        Ok(())
    }

    /// A stopping paused worker must not overlap the next holder, even if its
    /// lease expires during cleanup. Completed pauses release all their locks.
    pub fn expire_locks(&mut self) -> R<bool> {
        let mut s = self.db.prepare(
            "SELECT project, name, holder FROM locks WHERE holder IS NOT NULL AND expires_at <= ?1
             AND NOT EXISTS(SELECT 1 FROM agents a WHERE a.id=locks.holder AND a.state='paused')",
        )?;
        let expired: Vec<(i64, String, i64)> = s
            .query_map([now()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        drop(s);
        let expired: Vec<_> = expired
            .into_iter()
            .filter(|(_, _, holder)| !self.stopping_agents.contains(holder))
            .collect();
        for (project, name, _) in &expired {
            self.release_lock(*project, name, Some("its TTL ran out"))?;
        }
        Ok(!expired.is_empty())
    }

    /// Shorten oversized or untimed leases without extending valid leases.
    fn cap_lock_ttls(&self, project: i64, max: u32) -> R<bool> {
        let deadline = now() + i64::from(max);
        let affected = rows(
            &self.db,
            "SELECT name,holder FROM locks WHERE project=?1 AND holder IS NOT NULL AND
             (expires_at IS NULL OR expires_at>?2)",
            params![project, deadline],
        )?;
        for l in &affected {
            let name = l["name"].as_str().unwrap();
            self.db.execute(
                "UPDATE locks SET expires_at=?3 WHERE project=?1 AND name=?2",
                params![project, name, deadline],
            )?;
            self.notice(
                l["holder"].as_i64().unwrap(),
                &format!(
                    "Lock `{name}` was shortened to the project's maximum TTL: {max}s remaining."
                ),
            )?;
        }
        Ok(!affected.is_empty())
    }

    // ---------- messages ----------

    /// Messages in the agent's threads it hasn't been told about yet.
    fn pending(&self, agent: i64) -> R<Vec<(i64, i64)>> {
        let mut s = self.db.prepare(
            "SELECT m.id, m.sender FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=?1
             WHERE m.id > b.last_notified AND m.sender != ?1
               AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=?1
                 AND m.id>i.start_after AND (i.end_after IS NULL OR m.id<=i.end_after)) ORDER BY m.id",
        )?;
        let v = s
            .query_map([agent], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        Ok(v)
    }

    fn mark_notified(&self, agent: i64) -> R<()> {
        self.db.execute(
            "UPDATE members SET last_notified=(SELECT coalesce(max(id),0) FROM messages WHERE thread_id=members.thread_id)
             WHERE agent_id=?1",
            [agent],
        )?;
        Ok(())
    }

    fn pending_delivery(&self, agent: i64) -> R<Option<(i64, String)>> {
        Ok(self
            .db
            .query_row(
                "SELECT id,text FROM update_deliveries WHERE agent_id=?1 AND text IS NOT NULL",
                [agent],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    /// Recover an unacknowledged wait receipt at startup, then drain fresh updates.
    /// Startup's surrounding transaction restores the receipt if spawning fails.
    pub fn take_updates(&mut self, agent: i64) -> R<String> {
        let Some((id, previous)) = self.pending_delivery(agent)? else {
            return self.take_fresh_updates(agent, 11000);
        };
        self.db
            .execute("UPDATE update_deliveries SET text=NULL WHERE id=?1", [id])?;
        let previous = format!(
            "[acom] Recovered delivery #{id} (same batch; ignore if already received).\n{previous}"
        );
        let remaining = 14900usize.saturating_sub(json!({"text":previous}).to_string().len());
        let fresh = self.take_fresh_updates(agent, remaining)?;
        Ok([previous, fresh]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"))
    }

    fn coordination_updates(&mut self, agent: i64) -> R<String> {
        let updates = self.take_updates(agent)?;
        let summary = self.coordination_summary(agent, false)?;
        Ok([updates, summary]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"))
    }

    /// Never includes message content: only bounded notices, counts and senders.
    fn take_fresh_updates(&mut self, agent: i64, max_bytes: usize) -> R<String> {
        if max_bytes < 512 {
            return Ok(String::new());
        }
        // Reserve room for the remaining-notice and message-count lines below.
        let notice_budget = max_bytes.saturating_sub(512).min(10000);
        let mut lines = Vec::new();
        let mut s = self
            .db
            .prepare("SELECT id,substr(text,1,600),length(text)>600 FROM notices WHERE agent_id=?1 AND shown=0 ORDER BY id LIMIT 25")?;
        let notes: Vec<(i64, String, bool)> = s
            .query_map([agent], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        drop(s);
        for (id, text, truncated) in notes {
            lines.push(if truncated {format!("[acom] {text}… [Notice #{id} shortened; read `acom notices {id}` for the full notice.]")}else{format!("[acom] {text}")});
            if json!({"text":lines.join("\n")}).to_string().len() > notice_budget {
                lines.pop();
                break;
            }
            self.db
                .execute("UPDATE notices SET shown=1 WHERE id=?1", [id])?;
        }
        let left: i64 = self.db.query_row(
            "SELECT count(*) FROM notices WHERE agent_id=?1 AND shown=0",
            [agent],
            |r| r.get(0),
        )?;
        if left > 0 {
            lines.push(format!("[acom] {left} more notices waiting. Read `acom notices`; further hooks also deliver them."));
        }
        let eligible="FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=?1
            WHERE m.id>b.last_notified AND m.sender<>?1 AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id
             AND i.agent_id=?1 AND m.id>i.start_after AND (i.end_after IS NULL OR m.id<=i.end_after))";
        let count: i64 =
            self.db
                .query_row(&format!("SELECT count(*) {eligible}"), [agent], |r| {
                    r.get(0)
                })?;
        if count > 0 {
            let first = rows(
                &self.db,
                &format!(
                    "SELECT m.sender id,min(m.id) first_seen {eligible} GROUP BY m.sender ORDER BY first_seen LIMIT 7"
                ),
                [agent],
            )?;
            let mut senders: Vec<i64> = first.iter().map(|v| v["id"].as_i64().unwrap()).collect();
            if senders.len() > 6 {
                senders.truncate(5);
                let mut last = rows(
                    &self.db,
                    &format!(
                        "SELECT m.sender id,min(m.id) first_seen {eligible} GROUP BY m.sender ORDER BY first_seen DESC LIMIT 2"
                    ),
                    [agent],
                )?;
                last.reverse();
                senders.extend(last.iter().map(|v| v["id"].as_i64().unwrap()));
            }
            lines.push(format!(
                "[acom] {} new message{} from {}. Read them with `acom inbox` when you're ready.",
                count,
                if count == 1 { "" } else { "s" },
                sender_list(&senders)
            ));
            self.mark_notified(agent)?;
        }
        Ok(lines.join("\n"))
    }

    /// Nonzero coordination counts only. Consumed with the turn-start transaction,
    /// so a failed spawn does not acknowledge changes that no agent received.
    pub fn coordination_summary(&self, agent: i64, full: bool) -> R<String> {
        let cursor: i64 = self.db.query_row(
            "SELECT coalesce((SELECT event_id FROM summary_cursors WHERE agent_id=?1),0)",
            [agent],
            |r| r.get(0),
        )?;
        let latest: i64 = self
            .db
            .query_row("SELECT coalesce(max(id),0) FROM events", [], |r| r.get(0))?;
        let changed: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE agent=?1 AND id>?2
            AND (kind IN ('thread.joined','thread.left') OR kind LIKE 'lock.%'))",
            params![agent, cursor],
            |r| r.get(0),
        )?;
        if !full && !changed {
            return Ok(String::new());
        }
        let count = |sql: &str| -> R<i64> {
            Ok(self
                .db
                .query_row(sql, params![agent, cursor], |r| r.get(0))?)
        };
        let mut parts = Vec::new();
        for (label, n) in [
            ("threads", count("SELECT count(*) FROM members WHERE agent_id=?1 AND ?2>=0")?),
            ("joined", count("SELECT count(*) FROM events WHERE agent=?1 AND id>?2 AND kind='thread.joined'")?),
            ("left", count("SELECT count(*) FROM events WHERE agent=?1 AND id>?2 AND kind='thread.left'")?),
            ("pending", count("SELECT count(*) FROM messages m
                LEFT JOIN marks k ON k.agent_id=?1 AND k.message_id=m.id WHERE m.sender<>?1 AND coalesce(k.mark,'new')='new'
                AND ?2>=0 AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=?1
                  AND m.id>i.start_after AND (i.end_after IS NULL OR m.id<=i.end_after))")?),
            ("locks", count("SELECT count(*) FROM locks WHERE holder=?1 AND ?2>=0")?),
        ] {
            if n>0 { parts.push(format!("{label} {n}")); }
        }
        self.db.execute(
            "INSERT INTO summary_cursors(agent_id,event_id) VALUES(?1,?2)
            ON CONFLICT(agent_id) DO UPDATE SET event_id=excluded.event_id",
            params![agent, latest],
        )?;
        Ok(if parts.is_empty() {
            String::new()
        } else {
            format!(
                "[acom] Coordination: {}. Details: `acom history` / `acom inbox`.",
                parts.join("; ")
            )
        })
    }
}

/// "agent 2, agent 5, user", cut in the middle when long.
/// Whether the model that answered is the one asked for. A dated ID such as
/// claude-haiku-4-5-20251001 is the same model as claude-haiku-4-5.
pub fn same_model(asked: &str, answered: &str) -> bool {
    let dated = |long: &str, short: &str| {
        long.strip_prefix(short)
            .and_then(|r| r.strip_prefix('-'))
            .is_some_and(|r| r.len() == 8 && r.bytes().all(|b| b.is_ascii_digit()))
    };
    asked == answered || dated(answered, asked) || dated(asked, answered)
}

pub fn sender_list(ids: &[i64]) -> String {
    let names: Vec<String> = ids.iter().map(|&i| who(i)).collect();
    if names.len() <= 6 {
        return names.join(", ");
    }
    format!(
        "{}, … {}",
        names[..3].join(", "),
        names[names.len() - 2..].join(", ")
    )
}

fn parse_mark(m: &str) -> R<&str> {
    MARKS
        .iter()
        .find(|x| **x == m)
        .copied()
        .ok_or_else(|| bad(format!("mark must be one of {}", MARKS.join(", "))))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LaunchReq {
    pub task: String,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub name: Option<String>,
    pub group: Option<String>,
    pub force: bool,
    /// The launching agent marks itself done in the same step.
    pub done: bool,
    /// Acknowledge this agent's previous failures when requesting a replacement.
    pub ack_crashes: bool,
}

pub struct HistoryQuery {
    pub agent: Option<i64>,
    pub thread: Option<i64>,
    pub lock: Option<String>,
    pub kind: Option<String>,
    pub before: Option<i64>,
    pub after: Option<i64>,
    pub limit: i64,
    pub max_bytes: i64,
}

struct SelectedPage {
    unchanged: Option<Value>,
    items: Vec<Value>,
    through: i64,
    total: i64,
    revision: String,
}
impl SelectedPage {
    fn finish(self, q: &PageQuery) -> R<Value> {
        match self.unchanged {
            Some(value) => Ok(value),
            None => q.finish(self.items, self.total, self.through, &self.revision),
        }
    }
}

impl App {
    pub fn open(home: PathBuf, url: String) -> R<Arc<App>> {
        std::fs::create_dir_all(home.join("logs")).map_err(|e| Fail(500, e.to_string()))?;
        let home = std::fs::canonicalize(home).map_err(|e| Fail(500, e.to_string()))?;
        let db = Connection::open(home.join("acom.db"))?;
        check_stored_schema(&db)?;
        // Refuse ambiguous live ownership before schema/cursor writes or cleanup.
        // The old address remains saved until startup completes, including when
        // this restart selects a different port.
        let previous_url = std::fs::read_to_string(home.join("port"))
            .ok()
            .and_then(|port| port.trim().parse::<u16>().ok())
            .filter(|port| *port != 0)
            .map(|port| format!("http://127.0.0.1:{port}"))
            .unwrap_or_else(|| url.clone());
        let has_agents: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents')",
            [],
            |r| r.get(0),
        )?;
        let agent_ids: HashSet<i64> = if has_agents {
            rows(&db, "SELECT id FROM agents", [])?
                .iter()
                .map(|r| r["id"].as_i64().unwrap())
                .collect()
        } else {
            HashSet::new()
        };
        if let Some((id, pid)) = run::unmarked_tools(&agent_ids, &previous_url).first() {
            return Err(conflict(format!(
                "cannot verify ownership of live agent {id} worker PID {pid}: ACOM_HOME is missing. Stop its workers using the previous server/version, then restart; no workers or saved agent state were changed."
            )));
        }
        db.execute_batch(SCHEMA)?;
        initialize_views(&db)?;
        db.execute("UPDATE usage_checks SET in_flight=0", [])?;
        let mut st = St {
            db,
            shutting_down: false,
            waiting_updates: HashSet::new(),
            stopping_agents: HashSet::new(),
            queues: HashMap::new(),
            procs: HashMap::new(),
            reaped: HashSet::new(),
            over_soft: HashSet::new(),
        };
        // No requests are served until old workers stop and paused locks release.
        let interrupted = rows(
            &st.db,
            "SELECT id, pid, state FROM agents WHERE state='working' OR pid IS NOT NULL",
            [],
        )?;
        let groups: Vec<_> = interrupted
            .iter()
            .filter_map(|r| Some((r["id"].as_i64()?, u32::try_from(r["pid"].as_i64()?).ok()?)))
            .collect();
        for r in interrupted {
            let id = r["id"].as_i64().unwrap();
            if r["state"] != "working" {
                continue;
            }
            st.atomic(|st| {
                Self::cancel_followups(st,id,"the server restarted during the turn")?;
                st.db.execute(
                    "UPDATE agents SET state='paused', pause_reason='restart', pause_from='working', paused_at=?2 WHERE id=?1",
                    params![id, now()],
                )?;
                Ok(())
            })?;
            st.log_for(
                id,
                "acom",
                &format!("paused agent {id}: the server restarted during its turn"),
            )?;
        }
        let exe = std::env::current_exe().map_err(|e| Fail(500, e.to_string()))?;
        let app = Arc::new(App {
            st: Mutex::new(st),
            cv: Condvar::new(),
            home,
            url,
            exe,
        });
        run::StopTools::new(&app, &agent_ids, &groups, &previous_url)?.stop(&app)?;
        app.lock().atomic(|st| {
            for r in rows(&st.db, "SELECT id FROM agents WHERE state='paused'", [])? {
                st.release_all(r["id"].as_i64().unwrap(), "you were paused")?;
            }
            st.db
                .execute("UPDATE agents SET pid=NULL WHERE pid IS NOT NULL", [])?;
            Ok(())
        })?;
        Ok(app)
    }

    pub fn lock(&self) -> MutexGuard<'_, St> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---------- launching and turns ----------

    /// Validate and commit identity before spawning. A refused launch records
    /// nothing; a failed spawn leaves a visible crashed row and restores handoff state.
    pub fn launch(
        self: &Arc<Self>,
        by: i64,
        via: Option<i64>,
        project: Option<i64>,
        req: LaunchReq,
    ) -> R<(i64, Vec<String>)> {
        let mut st = self.lock();
        let handoff = req.done;
        let was_done = if by > 0 {
            st.agent(by)?.done_req
        } else {
            false
        };
        let (id, warnings) =
            st.atomic(|st| self.prepare_launch(st, by, via, project, req, false))?;
        let started = self.briefing(&st, id).and_then(|prompt| {
            st.atomic(|st| {
                let turn = run::prepare_turn(self, st, id, &prompt, None)?;
                if handoff {
                    Self::cancel_followups(st, by, "work was handed off with done")?;
                }
                Ok(turn)
            })
        });
        let turn = match started {
            Ok(turn) => turn,
            Err(e) => {
                st.atomic(|st| {
                st.set_state(id, "crashed")?;
                st.db.execute("UPDATE agents SET problem=?2 WHERE id=?1",params![id,e.1])?;
                let a=st.agent(id)?;
                st.event(a.project,Some(id),None,"agent.failed","acom",json!({"reason":e.1,"harness":a.harness,"model":a.model,"effort":a.effort,"phase":"launch"}))?;
                if handoff {
                    st.db.execute("UPDATE agents SET done_req=?2 WHERE id=?1",params![by,was_done])?;
                }
                Ok(())
            })?;
                return Err(e);
            }
        };
        run::activate_turn(self, &mut st, id, turn);
        Ok((id, warnings))
    }

    fn prepare_launch(
        self: &Arc<Self>,
        st: &mut St,
        by: i64,
        via: Option<i64>,
        project: Option<i64>,
        req: LaunchReq,
        defer_limits: bool,
    ) -> R<(i64, Vec<String>)> {
        if st.shutting_down {
            return Err(conflict("the server is stopping"));
        }
        // An agent's helpers join its project; the user picks one.
        let project = if by > 0 {
            let a = st.agent(by)?;
            if a.state != "working" {
                return Err(conflict("only a working agent can launch others"));
            }
            a.project
        } else {
            if req.done {
                return Err(bad("only an agent can mark itself done"));
            }
            let p = project.ok_or_else(|| bad("choose a project to launch the agent in"))?;
            st.project(p)?;
            p
        };
        let s = st.settings_for(Some(project));
        let harness = req.harness.unwrap_or_else(|| {
            s.harnesses
                .iter()
                .find(|(_, h)| h.enabled)
                .map(|(k, _)| k.clone())
                .unwrap_or_default()
        });
        let h = s
            .harnesses
            .get(&harness)
            .filter(|h| h.enabled)
            .ok_or_else(|| {
                let ok: Vec<&String> = s
                    .harnesses
                    .iter()
                    .filter(|(_, h)| h.enabled)
                    .map(|(k, _)| k)
                    .collect();
                bad(format!(
                    "harness {harness:?} isn't enabled (enabled: {ok:?})"
                ))
            })?;
        // The allowed lists restrict agents; the user can launch any model.
        let model = req.model.unwrap_or_else(|| h.model.clone());
        if model.trim().is_empty() || model.contains(char::is_whitespace) {
            return Err(bad(format!("{model:?} isn't a model ID")));
        }
        if by > 0 && !h.models.contains(&model) {
            return Err(bad(format!(
                "model {model} isn't allowed for {harness} (allowed: {})",
                h.models.join(", ")
            )));
        }
        let effort = req.effort.unwrap_or_else(|| h.effort.clone());
        check_choice(&harness, &model, &effort)?;
        if by > 0 && !h.efforts.contains(&effort) {
            return Err(bad(format!(
                "effort {effort} isn't allowed for {harness} (allowed: {})",
                h.efforts.join(", ")
            )));
        }
        if let Some(m) = crate::harness::catalog(&harness)
            .into_iter()
            .find(|m| m.id == model)
            && !m.efforts.contains(&effort.as_str())
        {
            return Err(bad(format!(
                "{model} doesn't support effort {effort} (it supports {})",
                m.efforts.join(", ")
            )));
        }
        if req.task.trim().is_empty() {
            return Err(bad("the task is empty"));
        }
        // Limits: soft warns, hard refuses agents and needs confirming for the user.
        // An agent handing over with `done` no longer counts.
        if req.done {
            st.db
                .execute("UPDATE agents SET done_req=1 WHERE id=?1", [by])?;
        }
        let mut warnings = Vec::new();
        let mut checks = st.limit_checks(project, &harness)?;
        if is_fable(&model) {
            checks.extend(
                st.usage_checks(&s.limits, &harness, Some(&model))?
                    .into_iter()
                    .filter(|c| c.what.contains("weekly Fable")),
            );
        }
        for c in checks {
            if c.over(c.lim.hard) {
                if defer_limits {
                    continue;
                }
                let msg = c.line("Hard");
                if by > 0 {
                    return Err(conflict(format!("{msg}. Launch refused.")));
                }
                if !req.force {
                    return Err(conflict(format!(
                        "{msg}. Confirm to launch anyway (--force)."
                    )));
                }
                warnings.push(format!("{msg}; launched anyway."));
            } else if c.over(c.lim.soft) {
                warnings.push(c.line("Soft"));
            }
        }

        let id = Self::create_agent(
            st,
            by,
            via,
            project,
            LaunchReq {
                task: req.task,
                harness: Some(harness),
                model: Some(model),
                effort: Some(effort),
                name: req.name,
                group: req.group,
                force: false,
                done: false,
                ack_crashes: true,
            },
            "idle",
        )?;
        Ok((id, warnings))
    }

    /// Persist a resolved choice. Waiting successors are created as done, never
    /// briefly active or members of active-only threads.
    fn create_agent(
        st: &St,
        by: i64,
        via: Option<i64>,
        project: i64,
        req: LaunchReq,
        state: &str,
    ) -> R<i64> {
        let harness = req
            .harness
            .as_deref()
            .ok_or_else(|| bad("missing resolved harness"))?;
        let model = req
            .model
            .as_deref()
            .ok_or_else(|| bad("missing resolved model"))?;
        let effort = req
            .effort
            .as_deref()
            .ok_or_else(|| bad("missing resolved effort"))?;
        let session = if harness == "claude" {
            Some(crate::harness::new_uuid())
        } else {
            None
        };
        st.db.execute(
            "INSERT INTO agents(project,name,grp,task,harness,model,effort,state,session_id,launched_by,launched_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![project, req.name.clone().unwrap_or_default(), req.group, req.task, harness, model, effort, state, session, by, now()],
        )?;
        let id = st.db.last_insert_rowid();
        if req.name.as_deref().unwrap_or("").is_empty() {
            st.db.execute(
                "UPDATE agents SET name=?2 WHERE id=?1",
                params![id, format!("agent {id}")],
            )?;
        }
        st.log(
            Some(project),
            &actor(by, via),
            &format!(
                "{} agent {id} ({harness} / {model} / {effort})",
                if state == "done" {
                    "created waiting replacement"
                } else {
                    "launched"
                }
            ),
        )?;
        Ok(id)
    }

    pub fn briefing(&self, st: &St, id: i64) -> R<String> {
        let a = st.agent(id)?;
        let group = a
            .grp
            .as_ref()
            .map(|g| format!(", group \"{g}\""))
            .unwrap_or_default();
        let (project, path) = st.project(a.project)?;
        Ok(format!(
            "You are agent {id} (\"{}\"{group}) in project \"{project}\" ({path}), launched by {} through acom, running {} / {} / effort {}.\n\n{GUIDE}\n## Limits and rules right now\n\n{}\n\n## Your task\n\n{}\n\n## Guidance\n\n{}\n",
            a.name,
            who(a.launched_by),
            a.harness,
            a.model,
            a.effort,
            st.limits_text(Some(a.project))?,
            a.task,
            st.settings_for(Some(a.project)).prompts.launch
        ))
    }

    /// Something arrived for an agent. An idle agent is woken at once. A done agent
    /// isn't counted as active, so it joins the wake line instead, which `drain_wakes` serves
    /// oldest first whenever there's room under the hard limits.
    pub fn maybe_wake(self: &Arc<Self>, st: &mut St, id: i64) -> R<()> {
        if st.shutting_down {
            return Ok(());
        }
        if st.procs.contains_key(&id) || st.stopping_agents.contains(&id) {
            return Ok(()); // still stopping; turn_ended wakes it if needed
        }
        let a = st.agent(id)?;
        if !matches!(a.state.as_str(), "idle" | "done") {
            return Ok(());
        }
        if Self::has_start(st, id)? {
            return self.start_pending(st, id);
        }
        let attempted: bool = st.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_continuations WHERE agent_id=?1 AND attempted=1)",
            [id],
            |r| r.get(0),
        )?;
        if attempted {
            Self::failed_followup(
                st,
                id,
                "Continuation",
                "a previous start attempt did not commit; it will not be relaunched automatically",
            )?;
            return Ok(());
        }
        if Self::has_handoff(st, id)? {
            return self.commit_handoff(st, id);
        }
        if a.state == "idle" && self.continue_queued(st, id)? {
            return Ok(());
        }
        if st.pending(id)?.is_empty() {
            return Ok(());
        }
        if a.state == "idle" {
            if st
                .usage_checks(
                    &st.settings_for(Some(a.project)).limits,
                    &a.harness,
                    Some(&a.model),
                )?
                .iter()
                .any(|c| c.over(c.lim.hard))
            {
                return self.pause_locked(st, id, "limit", "acom");
            }
            return self.wake(st, id, "idle");
        }
        st.db.execute(
            "UPDATE agents SET wake_queued_at=?2 WHERE id=?1 AND wake_queued_at IS NULL",
            params![id, now()],
        )?;
        self.drain_wakes(st)?;
        Ok(())
    }

    fn wake(self: &Arc<Self>, st: &mut St, id: i64, rest: &str) -> R<()> {
        st.db.execute(
            "UPDATE agents SET rest=?2, wake_queued_at=NULL, wake_why=NULL WHERE id=?1",
            params![id, rest],
        )?;
        let guidance = st.settings_for(Some(st.agent(id)?.project)).prompts.wake;
        let mut prompt = format!("## Guidance\n\n{guidance}");
        let never_started: bool = st.db.query_row(
            "SELECT turns=0 AND session_started=0 FROM agents WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        if never_started {
            prompt = format!("{}\n{prompt}", self.briefing(st, id)?);
        }
        run::start_turn(self, st, id, &prompt, None)
    }

    /// Wake agents in the wake line, oldest first, while there's room. Returns whether any woke.
    fn drain_wakes(self: &Arc<Self>, st: &mut St) -> R<bool> {
        if st.shutting_down {
            return Ok(false);
        }
        let queued = rows(
            &st.db,
            "SELECT id, wake_why FROM agents WHERE wake_queued_at IS NOT NULL ORDER BY wake_queued_at, id",
            [],
        )?;
        let mut woke = false;
        for r in queued {
            let id = r["id"].as_i64().unwrap();
            if st.procs.contains_key(&id) {
                continue;
            }
            let a = st.agent(id)?;
            if a.state != "done"
                || Self::has_handoff(st, id)?
                || Self::has_start(st, id)?
                || st.pending(id)?.is_empty()
            {
                // Reopened, paused, or nothing left to hear about: it leaves the line.
                st.db.execute(
                    "UPDATE agents SET wake_queued_at=NULL, wake_why=NULL WHERE id=?1",
                    [id],
                )?;
                continue;
            }
            match st.model_no_room(a.project, &a.harness, &a.model)? {
                Some(why) => {
                    if r["wake_why"].is_null() {
                        st.db.execute(
                            "UPDATE agents SET wake_why=?2 WHERE id=?1",
                            params![id, why],
                        )?;
                        st.log_for(
                            id,
                            "acom",
                            &format!("agent {id} is waiting to be woken: {why}"),
                        )?;
                    }
                }
                None => {
                    if !r["wake_why"].is_null() {
                        st.log_for(
                            id,
                            "acom",
                            &format!("woke agent {id} (it was waiting for room under the limits)"),
                        )?;
                    }
                    self.wake(st, id, &a.state)?;
                    woke = true;
                }
            }
        }
        Ok(woke)
    }

    /// Called when an agent's process exits. `error` explains a failed exit, if known.
    pub fn turn_ended(self: &Arc<Self>, id: i64, pid: u32, ok: bool, error: Option<&str>) -> R<()> {
        let mut st = self.lock();
        if st.procs.get(&id).is_some_and(|p| p.pid != pid) {
            return Ok(()); // not this process's entry; never happens since turns don't overlap
        }
        let a = st.agent(id)?;
        if st.shutting_down && a.state == "working" {
            // A shutdown save may have failed. Once persistence recovers, the
            // exit must still become a restart pause, not idle or a crash.
            st.atomic(|st| {
                Self::cancel_followups(st, id, "the server stopped during the turn")?;
                st.db.execute("UPDATE agents SET state='paused',pause_reason='restart',pause_from='working',paused_at=?2,pid=NULL WHERE id=?1",params![id,now()])?;
                st.log_for(id,"acom",&format!("paused agent {id}: the server stopped during its turn"))?;
                Ok(())
            })?;
            st.procs.remove(&id);
            st.reaped.remove(&id);
            self.cv.notify_all();
            return Ok(());
        }
        let failure = st.procs.get(&id).and_then(|p| p.failure.clone());
        let stopping = st.procs.get(&id).is_some_and(|p| p.stopping);
        let failed = (!ok || failure.is_some()) && !stopping && a.state == "working";
        if a.state != "working" {
            // Paused or closed by someone: they already set the state.
            st.db.execute(
                "UPDATE agents SET pid=NULL WHERE id=?1 AND pid=?2",
                params![id, pid],
            )?;
            st.procs.remove(&id);
            st.reaped.remove(&id);
            if let Err(e) = self.maybe_wake(&mut st, id) {
                let _ = st.log_for(id, "acom", &format!("couldn't start agent {id}: {}", e.1));
            }
            self.cv.notify_all();
            return Ok(());
        }
        let s = st.settings_for(Some(a.project));
        let next = if failed {
            "crashed"
        } else if Self::has_handoff(&st, id)? {
            "done"
        } else if a.done_req {
            if s.done_closes { "closed" } else { "done" }
        } else if st.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_continuations WHERE agent_id=?1)",
            [id],
            |r| r.get::<_, bool>(0),
        )? {
            "idle"
        } else {
            a.rest.as_str()
        };
        st.atomic(|st| {
            if failed {
                // Retain the actual running model/effort until all exit writes
                // commit. A transient database failure can safely be retried.
                st.remember_crash(id, &a)?;
                Self::cancel_followups(st, id, "the current turn failed")?;
            }
            st.db.execute(
                "UPDATE agents SET pid=NULL WHERE id=?1 AND pid=?2",
                params![id, pid],
            )?;
            st.db.execute(
                "UPDATE agents SET done_req=0, rest='idle' WHERE id=?1",
                [id],
            )?;
            st.set_state(id, next)?;
            if next != "idle" {
                st.release_all(id, &format!("you became {next}"))?;
            }
            if next == "crashed" {
                let why = failure
                    .as_deref()
                    .or(error)
                    .unwrap_or("its process exited with an error");
                st.db
                    .execute("UPDATE agents SET problem=?2 WHERE id=?1", params![id, why])?;
                st.log_for(id, "acom", &format!("agent {id} crashed: {why}"))?;
                st.event(
                    a.project,
                    Some(id),
                    None,
                    "agent.failed",
                    "acom",
                    json!({"reason":why,"harness":a.harness,"model":st.procs.get(&id).map_or(a.model.as_str(),|p|p.model.as_str()),"effort":st.procs.get(&id).map_or(a.effort.as_str(),|p|p.effort.as_str())}),
                )?;
            } else {
                st.db
                    .execute("DELETE FROM agent_retries WHERE agent_id=?1", [id])?;
                if a.done_req {
                    st.log_for(id, &who(id), &format!("finished: {next}"))?;
                }
            }
            Ok(())
        })?;
        st.procs.remove(&id);
        st.reaped.remove(&id);
        if let Err(e) = self.maybe_wake(&mut st, id) {
            let _ = st.log_for(id, "acom", &format!("couldn't start agent {id}: {}", e.1));
        }
        self.cv.notify_all();
        Ok(())
    }

    // ---------- agent controls (user commands) ----------

    pub fn pause(self: &Arc<Self>, id: i64, by: &str) -> R<()> {
        let mut st = self.lock();
        self.pause_locked(&mut st, id, "user", by)
    }

    fn pause_locked(self: &Arc<Self>, st: &mut St, id: i64, reason: &str, by: &str) -> R<()> {
        let a = st.agent(id)?;
        if !matches!(a.state.as_str(), "working" | "idle" | "done") {
            return Err(conflict(format!("agent {id} is {}", a.state)));
        }
        st.atomic(|st| {
          if reason != "limit" || a.state != "idle" {
              Self::cancel_followups(st, id, "the agent was paused")?;
          }
          st.db.execute(
            "UPDATE agents SET state='paused', pause_reason=?2, pause_from=?3, paused_at=?4 WHERE id=?1",
            params![id, reason, a.state, now()],
          )?;
          if matches!(reason, "user" | "all") {
              st.log_for(id, by, &format!("paused agent {id}"))?;
          }
          Ok(())
        })?;
        if let Some(p) = st.procs.get_mut(&id) {
            p.stopping = true;
        }
        self.finish_pause(st, id)?;
        self.cv.notify_all();
        Ok(())
    }

    /// Stop asynchronously: the process waiter needs this mutex to record exit.
    fn finish_pause(self: &Arc<Self>, st: &mut St, id: i64) -> R<()> {
        if st.stopping_agents.contains(&id) {
            return Ok(());
        }
        let groups: Vec<_> = st
            .procs
            .get(&id)
            .map(|p| vec![(id, p.pid)])
            .unwrap_or_default();
        st.stopping_agents.insert(id);
        let app = self.clone();
        std::thread::spawn(move || {
            let mut cleanup = None;
            let mut last_error = None;
            loop {
                let stopped = match cleanup.as_mut() {
                    Some(stop) => run::StopTools::stop(stop, &app),
                    None => run::StopTools::new(&app, &HashSet::from([id]), &groups, &app.url)
                        .map(|stop| {
                            cleanup = Some(stop);
                        })
                        .and_then(|_| cleanup.as_mut().unwrap().stop(&app)),
                };
                let result = stopped.and_then(|_| {
                    let mut st = app.lock();
                    st.atomic(|st| {
                        st.release_all(id, "you were paused")?;
                        st.db.execute(
                            "UPDATE view_revisions SET value=value+1 WHERE name='agents'",
                            [],
                        )?;
                        Ok(())
                    })?;
                    st.stopping_agents.remove(&id);
                    app.cv.notify_all();
                    Ok(())
                });
                match result {
                    Ok(()) => break,
                    Err(e) => {
                        if last_error.as_deref() != Some(e.1.as_str()) {
                            eprintln!("agent {id}: pause cleanup incomplete; retrying: {}", e.1);
                            let _ = app.lock().log_for(
                                id,
                                "acom",
                                &format!("agent {id}: pause cleanup incomplete; retrying: {}", e.1),
                            );
                            last_error = Some(e.1);
                        }
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
            }
        });
        Ok(())
    }

    /// Wait (a few seconds at most) for these agents' old processes to exit,
    /// so a new turn never overlaps one that's still stopping.
    fn wait_stopped<'a>(&'a self, mut st: MutexGuard<'a, St>, ids: &[i64]) -> MutexGuard<'a, St> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while ids
            .iter()
            .any(|i| st.procs.contains_key(i) || st.stopping_agents.contains(i))
            && Instant::now() < deadline
        {
            st = self
                .cv
                .wait_timeout(st, Duration::from_millis(200))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        st
    }

    pub fn resume(self: &Arc<Self>, id: i64, by: &str) -> R<Vec<String>> {
        let mut st = self.wait_stopped(self.lock(), &[id]);
        self.resume_locked(&mut st, id, by)?;
        // A failed stop can still reserve locks until cleanup is confirmed.
        let project = st.agent(id)?.project;
        let mut warn = Vec::new();
        for r in rows(
            &st.db,
            "SELECT l.holder h, group_concat(l.name, ', ') n FROM locks l JOIN agents a ON a.id=l.holder
             WHERE a.state='paused' AND l.project=?1 GROUP BY l.holder",
            [project],
        )? {
            warn.push(format!("agent {} is still stopping and holds {}", r["h"], r["n"].as_str().unwrap_or("")));
        }
        Ok(warn)
    }

    fn resume_locked(self: &Arc<Self>, st: &mut St, id: i64, by: &str) -> R<()> {
        let turn = st.atomic(|st| match self.prepare_resume(st, id, by)? {
            Some(prompt) => run::prepare_turn(self, st, id, &prompt, None).map(Some),
            None => Ok(None),
        })?;
        if let Some(turn) = turn {
            run::activate_turn(self, st, id, turn);
            Ok(())
        } else {
            self.maybe_wake(st, id)
        }
    }

    fn prepare_resume(&self, st: &mut St, id: i64, by: &str) -> R<Option<String>> {
        if st.shutting_down {
            return Err(conflict("the server is stopping"));
        }
        let a = st.agent(id)?;
        if a.state != "paused" && a.state != "crashed" {
            return Err(conflict(format!("agent {id} is {}, not paused", a.state)));
        }
        if st.procs.contains_key(&id)
            || st.stopping_agents.contains(&id)
            || !st.held_by(id)?.is_empty()
        {
            return Err(conflict(format!(
                "agent {id} is still stopping; try again in a moment"
            )));
        }
        if by != "acom" {
            st.db
                .execute("DELETE FROM agent_retries WHERE agent_id=?1", [id])?;
        }
        st.db.execute(
            "UPDATE agents SET pause_reason=NULL, pause_from=NULL, paused_at=NULL, problem=NULL, seen_model=NULL,done_req=0,rest='idle' WHERE id=?1",
            [id],
        )?;
        st.log_for(id, by, &format!("resumed agent {id}"))?;
        let guidance = st.settings_for(Some(a.project)).prompts.resume;
        let interruption = format!(
            "[acom] Previous turn interrupted{}: {}. Resumed at {}{}.\nCommands may be partial; unsaved work may be lost. Old commands, background tasks and monitors stopped—don't wait for them. Previous locks released; reacquire required locks before protected work.",
            a.paused_at
                .map(|t| format!(" at {}", hhmm(t)))
                .unwrap_or_default(),
            a.problem.as_deref().unwrap_or("the process was stopped"),
            hhmm(now()),
            if a.state == "crashed" {
                " after an error"
            } else {
                ""
            },
        );
        if a.state == "crashed" {
            let prompt = format!("{interruption}\n\n## Guidance\n\n{guidance}");
            return Ok(Some(prompt));
        }
        let from = a.pause_from.unwrap_or_else(|| "idle".into());
        if from == "working" {
            let prompt = format!("{interruption}\n\n## Guidance\n\n{guidance}");
            Ok(Some(prompt))
        } else {
            st.set_state(id, &from)?;
            Ok(None)
        }
    }

    pub fn pause_all(self: &Arc<Self>, by: &str) -> R<Vec<i64>> {
        let mut st = self.lock();
        let ids: Vec<i64> = rows(
            &st.db,
            "SELECT id FROM agents WHERE state IN ('working','idle','done')",
            [],
        )?
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
        for &id in &ids {
            self.pause_locked(&mut st, id, "all", by)?;
        }
        Ok(ids)
    }

    pub fn resume_all(self: &Arc<Self>, by: &str) -> R<Vec<i64>> {
        let st = self.lock();
        let ids: Vec<i64> = rows(&st.db, "SELECT id FROM agents WHERE state='paused'", [])?
            .iter()
            .map(|r| r["id"].as_i64().unwrap())
            .collect();
        let mut st = self.wait_stopped(st, &ids);
        let ids: Vec<i64> = ids
            .into_iter()
            .filter(|i| !st.procs.contains_key(i) && !st.stopping_agents.contains(i))
            .collect();
        for &id in &ids {
            self.resume_locked(&mut st, id, by)?;
        }
        Ok(ids)
    }

    /// Unlike Resume all, leave manual and usage-limit pauses alone.
    pub fn resume_restart(self: &Arc<Self>, by: &str) -> R<Value> {
        let st = self.lock();
        let ids: Vec<i64> = rows(
            &st.db,
            "SELECT id FROM agents WHERE state='paused' AND pause_reason='restart' ORDER BY id",
            [],
        )?
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
        let mut st = self.wait_stopped(st, &ids);
        let mut resumed = Vec::new();
        let mut errors = Vec::new();
        for id in ids {
            // Waiting releases the mutex: don't undo a concurrent user action.
            let eligible: bool = st.db.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND state='paused' AND pause_reason='restart')", [id], |r|r.get(0))?;
            if !eligible {
                continue;
            }
            match self.resume_locked(&mut st, id, by) {
                Ok(()) => resumed.push(id),
                Err(e) => errors.push(format!("agent {id}: {}", e.1)),
            }
        }
        let warnings: Vec<String> = rows(
            &st.db,
            "SELECT DISTINCT a.id FROM agents a JOIN locks l ON l.holder=a.id
             WHERE a.state='paused' ORDER BY a.id",
            [],
        )?
        .iter()
        .map(|r| format!("agent {} is still stopping and holds locks", r["id"]))
        .collect();
        self.cv.notify_all();
        Ok(json!({"ids":resumed,"errors":errors,"warnings":warnings}))
    }

    /// Stop turns deliberately, so shutdown never invokes crash recovery.
    pub fn shutdown(self: &Arc<Self>) -> R<()> {
        let mut st = self.lock();
        st.shutting_down = true;
        let agent_ids: HashSet<i64> = rows(&st.db, "SELECT id FROM agents", [])
            .map(|rs| rs.iter().map(|r| r["id"].as_i64().unwrap()).collect())
            .unwrap_or_else(|_| st.procs.keys().copied().collect());
        let groups: Vec<_> = st.procs.iter().map(|(&id, p)| (id, p.pid)).collect();
        let saved = st.atomic(|st| {
            let ids = rows(&st.db, "SELECT id FROM agents WHERE state='working' ORDER BY id", [])?;
            for row in ids {
                let id = row["id"].as_i64().unwrap();
                Self::cancel_followups(st, id, "the server stopped during the turn")?;
                st.db.execute("UPDATE agents SET state='paused',pause_reason='restart',pause_from='working',paused_at=?2 WHERE id=?1", params![id,now()])?;
                st.log_for(id,"acom",&format!("paused agent {id}: the server stopped during its turn"))?;
            }
            Ok(())
        });
        // Even if persistence failed, stop the workers. Startup can reconcile
        // their saved working states; they must not continue unattended.
        for p in st.procs.values_mut() {
            p.stopping = true;
        }
        st.stopping_agents.extend(&agent_ids);
        self.cv.notify_all();
        drop(st);
        run::StopTools::new(self, &agent_ids, &groups, &self.url)?.stop(self)?;
        let mut st = self.lock();
        st.atomic(|st| {
            for r in rows(&st.db, "SELECT id FROM agents WHERE state='paused'", [])? {
                st.release_all(r["id"].as_i64().unwrap(), "you were paused")?;
            }
            Ok(())
        })?;
        st.stopping_agents.clear();
        self.cv.notify_all();
        saved
    }

    pub fn close(self: &Arc<Self>, id: i64, by: &str) -> R<()> {
        let mut st = self.lock();
        if st.stopping_agents.contains(&id) {
            return Err(conflict(
                "the old worker is still stopping; try again shortly",
            ));
        }
        let a = st.agent(id)?;
        if a.state == "replaced" {
            return Err(conflict(
                "a replaced agent is read-only; use its replacement",
            ));
        }
        if a.state == "closed" {
            return Err(conflict(format!("agent {id} is already closed")));
        }
        st.atomic(|st| {
            Self::cancel_followups(st, id, "the agent was closed")?;
            st.release_all(id, "you were closed")?;
            st.db.execute("UPDATE agents SET pause_reason=NULL, pause_from=NULL, paused_at=NULL, rest='idle' WHERE id=?1", [id])?;
            st.set_state(id, "closed")?;
            st.log_for(id, by, &format!("closed agent {id}"))?;
            Ok(())
        })?;
        if let Some(p) = st.procs.get_mut(&id) {
            p.stopping = true;
            run::stop(p.pid);
        }
        self.cv.notify_all();
        Ok(())
    }

    pub fn reopen(self: &Arc<Self>, id: i64, by: &str) -> R<()> {
        let mut st = self.wait_stopped(self.lock(), &[id]);
        if st.agent(id)?.state != "closed" {
            return Err(conflict(format!("agent {id} isn't closed")));
        }
        st.set_state(
            id,
            if Self::has_start(&st, id)? {
                "done"
            } else {
                "idle"
            },
        )?;
        st.db
            .execute("UPDATE agents SET problem=NULL WHERE id=?1", [id])?;
        st.log_for(id, by, &format!("reopened agent {id}"))?;
        self.maybe_wake(&mut st, id)
    }

    // ---------- agent self-service ----------

    /// Only this agent and its committed replacement predecessors share crash history.
    /// Successful turns and cleared retry counters do not erase that history.
    fn check_previous_crashes(&self, st: &St, agent: i64, harness: &str, model: &str) -> R<()> {
        let project = st.agent(agent)?.project;
        let failures = rows(&st.db,
            "WITH RECURSIVE lineage(id) AS (
                 SELECT ?1
                 UNION
                 SELECT p.id FROM events r JOIN lineage l ON r.agent=l.id
                   JOIN agents p ON p.id=json_extract(r.details,'$.predecessor') AND p.project=?2
                 WHERE r.project=?2 AND r.kind='agent.replacement'
             )
             SELECT e.id,e.agent,e.at,json_extract(e.details,'$.reason') reason FROM events e
             WHERE e.project=?2 AND e.agent IN (SELECT id FROM lineage) AND e.kind='agent.failed'
               AND coalesce(json_extract(e.details,'$.harness'),
                   (SELECT json_extract(t.details,'$.harness') FROM events t WHERE t.agent=e.agent AND t.kind='agent.turn-started' AND t.id<e.id ORDER BY t.id DESC LIMIT 1))=?3
               AND coalesce(json_extract(e.details,'$.model'),
                   (SELECT json_extract(t.details,'$.model') FROM events t WHERE t.agent=e.agent AND t.kind='agent.turn-started' AND t.id<e.id ORDER BY t.id DESC LIMIT 1))=?4
             ORDER BY e.id DESC LIMIT 3", params![agent,project,harness,model])?;
        if failures.is_empty() {
            return Ok(());
        }
        let mut warning = format!(
            "Previous crashes for {harness}/{model} in your agent history (including replacement predecessors). Nothing was changed. Review the failure history and reevaluate before selecting it:\n"
        );
        for f in failures {
            let reason: String = f["reason"]
                .as_str()
                .unwrap_or("turn failed")
                .chars()
                .take(240)
                .collect();
            warning += &format!(
                "agent {}, event {} at {}: {reason}. Read with acom history {}; inspect acom agent {} for conversation/output paths.\n",
                f["agent"],
                f["id"],
                hhmm(f["at"].as_i64().unwrap_or(0)),
                f["id"],
                f["agent"]
            );
        }
        warning += "If the choice is still appropriate, repeat the command with --ack-crashes. Acknowledgement does not bypass permissions or limits.";
        Err(conflict(warning))
    }

    fn has_handoff(st: &St, id: i64) -> R<bool> {
        Ok(st.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_handoffs WHERE agent_id=?1)",
            [id],
            |r| r.get(0),
        )?)
    }

    /// A single explicit follow-up; messages are folded into its start prompt.
    fn continue_queued(self: &Arc<Self>, st: &mut St, id: i64) -> R<bool> {
        let Some(instruction) = st
            .db
            .query_row(
                "SELECT text FROM agent_continuations WHERE agent_id=?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        else {
            return Ok(false);
        };
        let a = st.agent(id)?;
        let s = st.settings_for(Some(a.project));
        let blocked = match s.harnesses.get(&a.harness) {
            Some(h)
                if h.enabled && h.models.contains(&a.model) && h.efforts.contains(&a.effort) =>
            {
                if let Err(e) = check_choice(&a.harness, &a.model, &a.effort) {
                    Some(e.1)
                } else {
                    st.usage_checks(&s.limits, &a.harness, Some(&a.model))?
                        .into_iter()
                        .find(|c| c.over(c.lim.hard))
                        .map(|c| c.line("Hard"))
                }
            }
            _ => Some("the requested model/effort is disabled or no longer allowed".into()),
        };
        if let Some(why) = blocked {
            if st.db.execute(
                "UPDATE agent_continuations SET blocked=?2 WHERE agent_id=?1 AND blocked IS NOT ?2",
                params![id, why],
            )? > 0
            {
                st.notice(id, &format!("Continuation waiting: {why}"))?;
                st.log_for(id, "acom", &format!("continuation waiting: {why}"))?;
            }
            return Ok(true);
        }
        let started: bool = st.db.query_row(
            "SELECT session_started FROM agents WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        if !started || a.session.is_none() {
            Self::failed_followup(
                st,
                id,
                "Continuation",
                "the harness did not record a native session; refusing to silently start a fresh conversation",
            )?;
            return Ok(true);
        }
        let prompt = format!(
            "[acom] Continue in the same conversation with the requested configuration.\n\n## Guidance\n\n{}\n\n## Continuation\n\n{instruction}",
            s.prompts.wake
        );
        // Durable disarm before spawning: failed cancellation or restart must
        // retry saving the cancellation, not repeatedly launch provider clients.
        st.db.execute(
            "UPDATE agent_continuations SET attempted=1 WHERE agent_id=?1",
            [id],
        )?;
        if let Err(e) = run::start_turn(self, st, id, &prompt, None) {
            Self::failed_followup(st, id, "Continuation", &e.1)?;
        }
        Ok(true)
    }

    /// Queue a deliberate cross-provider replacement, not a crash retry.
    pub fn queue_replacement(self: &Arc<Self>, id: i64, mut req: LaunchReq) -> R<Vec<String>> {
        let mut st = self.lock();
        let a = st.agent(id)?;
        let s = st.settings_for(Some(a.project));
        if a.state != "working" || a.done_req {
            return Err(conflict("replacement requires an unfinished working turn"));
        }
        if !s.allow_agent_model_change {
            return Err(conflict(
                "the project's self-change model permission is disabled; see acom limits",
            ));
        }
        if Self::has_handoff(&st, id)? {
            return Err(conflict("a replacement is already queued; end your turn"));
        }
        let target = req
            .harness
            .as_deref()
            .ok_or_else(|| bad("replacement requires --harness"))?;
        if target == a.harness {
            return Err(bad(
                "same-provider switches use acom configure --model ... --continue ...",
            ));
        }
        if req.force || req.done {
            return Err(bad("replacement cannot combine --force or --done"));
        }
        // Resolve and validate with exactly the agent-launch rules, without retaining
        // an identity or releasing the old active slot while it is still running.
        st.db.execute_batch("SAVEPOINT replacement_check")?;
        let checked = (|| -> R<(LaunchReq, Vec<String>)> {
            let mut check = req.clone();
            check.done = true;
            let (new, warnings) = self.prepare_launch(&mut st, id, None, None, check, true)?;
            let selected = st.agent(new)?;
            if !req.ack_crashes {
                self.check_previous_crashes(&st, id, &selected.harness, &selected.model)?;
            }
            req.harness = Some(selected.harness);
            req.model = Some(selected.model);
            req.effort = Some(selected.effort);
            req.name = Some(req.name.unwrap_or(a.name));
            req.group = req.group.or(a.grp);
            Ok((req, warnings))
        })();
        st.db
            .execute_batch("ROLLBACK TO replacement_check; RELEASE replacement_check")?;
        let (req, warnings) = checked?;
        st.atomic(|st| {
            Self::cancel_followups(st,id,"a replacement was requested instead")?;
            st.db.execute("INSERT INTO agent_handoffs(agent_id,request) VALUES(?1,?2)",params![id,serde_json::to_string(&req).map_err(|e|bad(e.to_string()))?])?;
            st.event(a.project,Some(id),None,"agent.replacement-queued",&who(id),json!({"harness":req.harness,"model":req.model,"effort":req.effort}))?;
            st.notice(id,"Replacement queued. End this turn without acom done. After your successful exit, ownership transfers permanently to a new agent, even if its startup waits or fails. It receives your task summary, history paths and static memberships.")?;
            Ok(())
        })?;
        Self::cleanup_reaped_followup(&st, id);
        Ok(warnings)
    }

    fn cleanup_reaped_followup(st: &St, id: i64) {
        // A request may arrive after the parent exits but before inherited stdout
        // closes. Clean its remaining tools now so turn_ended can proceed.
        if st.reaped.contains(&id)
            && let Some(proc) = st.procs.get(&id)
        {
            run::kill_group(proc.pid, libc::SIGKILL);
        }
    }

    fn has_start(st: &St, id: i64) -> R<bool> {
        Ok(st.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_starts WHERE agent_id=?1)",
            [id],
            |r| r.get(0),
        )?)
    }

    /// Ownership moves once, before startup. A refused/failed startup must never
    /// silently return the task to the predecessor.
    fn commit_replacement(st: &St, id: i64, new: i64) -> R<()> {
        let project = st.agent(id)?.project;
        if st.db.execute("UPDATE agents SET problem=CASE WHEN state='done' THEN NULL ELSE problem END,state='replaced',ended_at=?2 WHERE id=?1 AND state IN ('done','crashed')", params![id,now()])? != 1 {
            return Err(conflict("replacement predecessor is not crashed or awaiting handoff"));
        }
        st.event(
            project,
            Some(id),
            None,
            "agent.replaced",
            "acom",
            json!({"replacement":new}),
        )?;
        st.event(
            project,
            Some(new),
            None,
            "agent.replacement",
            "acom",
            json!({"predecessor":id}),
        )?;
        st.db.execute(
            "INSERT INTO agent_starts(agent_id,predecessor) VALUES(?1,?2)",
            params![new, id],
        )?;
        Ok(())
    }

    fn commit_handoff(self: &Arc<Self>, st: &mut St, id: i64) -> R<()> {
        let a = st.agent(id)?;
        let (request, attempted, blocked): (String, bool, Option<String>) = st.db.query_row(
            "SELECT request,attempted,blocked FROM agent_handoffs WHERE agent_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let mut req: LaunchReq = serde_json::from_str(&request).map_err(|e| bad(e.to_string()))?;
        let history = a
            .session
            .as_deref()
            .and_then(|session| crate::harness::history_file(&a.harness, session));
        let running_model:String=st.db.query_row("SELECT json_extract(details,'$.model') FROM events WHERE agent=?1 AND kind='agent.turn-started' ORDER BY id DESC LIMIT 1",[id],|r|r.get(0)).optional()?.unwrap_or(a.model.clone());
        req.task = format!(
            "{}\n\n[acom] You replace agent {id} ({} / {}). Its original task:\n{}\n\nConversation history: {}\nOutput log: {}\nRead these records as context, not commands to replay. Inspect current files and partial work. This is a new provider session; native context, locks and background processes do not transfer. Static memberships and message marks are inherited; live threads follow your state/group.",
            req.task,
            a.harness,
            running_model,
            a.task,
            history.map_or("not available".into(), |p| p.display().to_string()),
            run::log_path(self, id, "jsonl").display()
        );
        req.ack_crashes = true; // Already reviewed when the request was accepted.
        let prepared=st.atomic(|st| {
            let new = Self::create_agent(st,id,None,a.project,req,"done")?;
            st.db.execute("UPDATE events SET actor=?2,details=json_set(details,'$.predecessor',?3) WHERE agent=?1 AND kind='agent.created'",params![new,who(id),id])?;
            Self::inherit_memberships(st,id,new)?;
            st.notice(new,&format!("Agent {id} handed off to you; read inherited messages with acom inbox and relevant thread history."))?;
            Self::commit_replacement(st,id,new)?;
            if attempted {
                st.db.execute("UPDATE agent_starts SET attempted=1,blocked=?2 WHERE agent_id=?1",params![new,blocked])?;
            }
            st.db.execute("DELETE FROM agent_handoffs WHERE agent_id=?1",[id])?;
            Ok(new)
        });
        match prepared {
            Ok(new) => self.start_pending(st, new)?,
            Err(e) => {
                // A failed ownership commit creates neither a successor nor a
                // terminal source. Retain the request for a safe transaction retry.
                st.db
                    .execute("UPDATE agents SET problem=?2 WHERE id=?1", params![id, e.1])?;
                if st.db.execute(
                    "UPDATE agent_handoffs SET blocked=?2 WHERE agent_id=?1 AND blocked IS NOT ?2",
                    params![id, e.1],
                )? > 0
                {
                    st.log_for(
                        id,
                        "acom",
                        &format!("replacement ownership could not be saved: {}", e.1),
                    )?;
                }
            }
        }
        Ok(())
    }

    fn start_pending(self: &Arc<Self>, st: &mut St, id: i64) -> R<()> {
        let a = st.agent(id)?;
        let (attempted, reason): (bool, Option<String>) = st.db.query_row(
            "SELECT attempted,blocked FROM agent_starts WHERE agent_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if attempted {
            return Self::failed_start(st,id,reason.as_deref().unwrap_or("startup attempt was interrupted before it committed; no duplicate first launch was attempted"));
        }
        let s = st.settings_for(Some(a.project));
        let blocked = if !s.harnesses.get(&a.harness).is_some_and(|h| {
            h.enabled && h.models.contains(&a.model) && h.efforts.contains(&a.effort)
        }) {
            Some("replacement model/effort is disabled or no longer allowed".into())
        } else if let Err(e) = check_choice(&a.harness, &a.model, &a.effort) {
            Some(e.1)
        } else {
            st.model_no_room(a.project, &a.harness, &a.model)?
        };
        if let Some(why) = blocked {
            if st.db.execute(
                "UPDATE agent_starts SET blocked=?2 WHERE agent_id=?1 AND blocked IS NOT ?2",
                params![id, why],
            )? > 0
            {
                st.log_for(id, "acom", &format!("replacement waiting: {why}"))?;
            }
            return Ok(());
        }
        // Disarm first startup durably before spawning. A restart after this
        // point records a failure, never another implicit first launch.
        st.db.execute(
            "UPDATE agent_starts SET attempted=1,blocked=NULL WHERE agent_id=?1",
            [id],
        )?;
        let start = self
            .briefing(st, id)
            .and_then(|prompt| run::start_turn(self, st, id, &prompt, None));
        if let Err(e) = start {
            st.db.execute(
                "UPDATE agent_starts SET blocked=?2 WHERE agent_id=?1",
                params![id, e.1],
            )?;
            Self::failed_start(st, id, &e.1)?;
        }
        Ok(())
    }

    fn failed_start(st: &mut St, id: i64, reason: &str) -> R<()> {
        st.atomic(|st| {
            let a = st.agent(id)?;
            st.db.execute("DELETE FROM agent_starts WHERE agent_id=?1",[id])?;
            st.remember_crash(id,&a)?;
            st.set_state(id,"crashed")?;
            st.release_all(id,"startup failed")?;
            st.db.execute("UPDATE agents SET problem=?2 WHERE id=?1",params![id,reason])?;
            st.event(a.project,Some(id),None,"agent.failed","acom",json!({"reason":reason,"harness":a.harness,"model":a.model,"effort":a.effort,"phase":"start"}))?;
            st.log_for(id,"acom",&format!("agent {id} startup failed: {reason}; configured crash recovery applies"))?;
            st.notice(id,&format!("Startup failed: {reason}. Configured crash recovery applies. Check partial work before continuing."))?;
            Ok(())
        })
    }

    fn failed_followup(st: &mut St, id: i64, kind: &str, reason: &str) -> R<()> {
        st.atomic(|st| {
            Self::cancel_followups(st,id,&format!("{kind} could not start"))?;
            st.set_state(id,"idle")?;
            st.db.execute("UPDATE agents SET problem=?2 WHERE id=?1",params![id,reason])?;
            let message=format!("{kind} could not start: {reason}. Request cancelled; no automatic retry. You were not replaced.");
            st.notice(id,&message)?;
            st.log_for(id,"acom",&message)?;
            Ok(())
        })?;
        Ok(())
    }

    fn inherit_memberships(st: &St, id: i64, new: i64) -> R<()> {
        st.db.execute(
            "INSERT OR IGNORE INTO members(thread_id,agent_id,last_notified)
            SELECT b.thread_id,?2,b.last_notified FROM members b WHERE b.agent_id=?1
              AND NOT EXISTS(SELECT 1 FROM thread_filters f WHERE f.thread_id=b.thread_id)",
            params![id, new],
        )?;
        st.db.execute("INSERT INTO marks(agent_id,message_id,mark) SELECT ?2,message_id,mark FROM marks WHERE agent_id=?1",params![id,new])?;
        // Notification cursors already belong to this durable batch. Transfer
        // its unacknowledged body with ownership, retaining the stable ID.
        st.db.execute(
            "UPDATE update_deliveries SET agent_id=?2 WHERE agent_id=?1 AND text IS NOT NULL",
            params![id, new],
        )?;
        Ok(())
    }

    fn cancel_followups(st: &St, id: i64, reason: &str) -> R<()> {
        let n = st
            .db
            .execute("DELETE FROM agent_continuations WHERE agent_id=?1", [id])?
            + st.db
                .execute("DELETE FROM agent_handoffs WHERE agent_id=?1", [id])?;
        if n > 0 {
            st.event(
                st.agent(id)?.project,
                Some(id),
                None,
                "agent.followup-cancelled",
                "acom",
                json!({"reason":reason}),
            )?;
        }
        Ok(())
    }

    /// Change the requested model/effort for the next turn; never interrupt tools.
    pub fn configure_agent(
        &self,
        id: i64,
        by: i64,
        model: Option<&str>,
        effort: Option<&str>,
        continuation: Option<&str>,
        ack_crashes: bool,
    ) -> R<()> {
        let mut st = self.lock();
        let a = st.agent(id)?;
        if a.state == "replaced" {
            return Err(conflict(
                "a replaced agent is read-only; use its replacement",
            ));
        }
        let s = st.settings_for(Some(a.project));
        if model.is_none() && effort.is_none() {
            return Err(bad("give a model or effort"));
        }
        if Self::has_handoff(&st, id)? {
            return Err(conflict("a replacement is already queued; end your turn"));
        }
        if let Some(text) = continuation {
            if a.state != "working" || a.done_req {
                return Err(conflict("continuation requires an unfinished working turn"));
            }
            if text.trim().is_empty() || text.len() > 16000 {
                return Err(bad("continuation must be nonempty and at most 16000 bytes"));
            }
            if by != 0
                && !((model.is_some() && s.allow_agent_model_change)
                    || (effort.is_some() && s.allow_agent_effort_change))
            {
                return Err(conflict(
                    "the project's self-change permission is disabled; see acom limits",
                ));
            }
        }
        let model = model.unwrap_or(&a.model);
        let effort = effort.unwrap_or(&a.effort);
        let cfg = s
            .harnesses
            .get(&a.harness)
            .filter(|h| h.enabled)
            .ok_or_else(|| bad("this harness is disabled"))?;
        check_choice(&a.harness, model, effort)?;
        if by != 0 {
            if by != id || a.state != "working" {
                return Err(conflict("agents may only change themselves while working"));
            }
            if (model != a.model && !s.allow_agent_model_change)
                || (effort != a.effort && !s.allow_agent_effort_change)
            {
                return Err(conflict(
                    "the project's self-change permission is disabled; see acom limits",
                ));
            }
            if !cfg.models.iter().any(|m| m == model) || !cfg.efforts.iter().any(|e| e == effort) {
                return Err(bad(
                    "model and effort must be in this harness's allowed lists",
                ));
            }
            let running_model = st
                .procs
                .get(&id)
                .map_or(a.model.as_str(), |p| p.model.as_str());
            if model != running_model && !ack_crashes {
                self.check_previous_crashes(&st, id, &a.harness, model)?;
            }
        }
        let text = format!(
            "Requested {}/{model}/effort {effort} for your next turn. This turn is unchanged; the native session stays the same.{}",
            a.harness,
            if continuation.is_some() {
                " One continuation is queued; end this turn without acom done."
            } else {
                " This does not schedule a turn."
            }
        );
        st.atomic(|st| {
            st.db.execute(
                "UPDATE agents SET model=?2, effort=?3 WHERE id=?1",
                params![id, model, effort],
            )?;
            if let Some(instruction) = continuation {
                st.db.execute(
                    "INSERT INTO agent_continuations(agent_id,text) VALUES(?1,?2)
                    ON CONFLICT(agent_id) DO UPDATE SET text=excluded.text,blocked=NULL,attempted=0",
                    params![id, instruction],
                )?;
                st.event(
                    a.project,
                    Some(id),
                    None,
                    "agent.continuation-queued",
                    &who(by),
                    json!({"text":instruction}),
                )?;
            }
            st.notice(id, &text)?;
            st.log_for(id, &who(by), &format!("agent {id}: {text}"))?;
            Ok(())
        })?;
        if continuation.is_some() {
            Self::cleanup_reaped_followup(&st, id);
        }
        Ok(())
    }

    pub fn agent_project(&self, id: i64) -> R<i64> {
        Ok(self.lock().agent(id)?.project)
    }

    pub fn set_status(&self, id: i64, text: &str) -> R<()> {
        let st = self.lock();
        if st.agent(id)?.state == "replaced" {
            return Err(conflict(
                "a replaced agent is read-only; use its replacement",
            ));
        }
        st.db.execute(
            "UPDATE agents SET status_text=?2 WHERE id=?1",
            params![id, text],
        )?;
        Ok(())
    }

    pub fn set_group(&self, id: i64, group: &str) -> R<()> {
        let st = self.lock();
        if st.agent(id)?.state == "replaced" {
            return Err(conflict(
                "a replaced agent is read-only; use its replacement",
            ));
        }
        let g = if group.trim().is_empty() {
            None
        } else {
            Some(group.trim())
        };
        st.db
            .execute("UPDATE agents SET grp=?2 WHERE id=?1", params![id, g])?;
        Ok(())
    }

    pub fn mark_done(&self, id: i64) -> R<()> {
        let mut st = self.lock();
        if st.agent(id)?.state != "working" {
            return Err(conflict("only a working agent can mark itself done"));
        }
        st.atomic(|st| {
            Self::cancel_followups(st, id, "the agent marked its task done")?;
            st.db
                .execute("UPDATE agents SET done_req=1 WHERE id=?1", [id])?;
            Ok(())
        })
    }

    pub fn hook(&self, id: i64) -> R<String> {
        let mut st = self.lock();
        if st.shutting_down
            || st.agent(id)?.state != "working"
            || st.waiting_updates.contains(&id)
            || st.pending_delivery(id)?.is_some()
        {
            return Ok(String::new());
        }
        st.atomic(|st| st.coordination_updates(id))
    }

    /// Foreground wait in the current turn. A persisted receipt survives a lost
    /// HTTP response; only ACK or a successfully committed startup consumes it.
    pub fn wait_updates(&self, id: i64, timeout: u64) -> R<Value> {
        if !(1..=3600).contains(&timeout) {
            return Err(bad("wait timeout must be 1–3600 seconds"));
        }
        let mut st = self.lock();
        st.agent(id)?;
        let snapshot: (String, i64, Option<i64>) = st.db.query_row(
            "SELECT state,turns,pid FROM agents WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if st.shutting_down || snapshot.0 != "working" {
            return Err(conflict(
                "wait requires a working turn and a running server",
            ));
        }
        if !st.waiting_updates.insert(id) {
            return Err(conflict("another wait is already running for this agent"));
        }
        let deadline = Instant::now() + Duration::from_secs(timeout);
        let result = loop {
            let ready = (|| -> R<Option<Value>> {
                if st.shutting_down {
                    return Err(conflict("server is shutting down; wait cancelled"));
                }
                let current: (String, i64, Option<i64>) = st.db.query_row(
                    "SELECT state,turns,pid FROM agents WHERE id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                if current != snapshot {
                    return Err(conflict(
                        "the working turn changed or stopped; wait cancelled",
                    ));
                }
                if let Some((delivery, text)) = st.pending_delivery(id)? {
                    return Ok(Some(
                        json!({"text":text,"delivery_id":delivery,"timed_out":false}),
                    ));
                }
                st.atomic(|st| {
                    let text = st.coordination_updates(id)?;
                    if text.is_empty() { return Ok(None); }
                    st.db.execute("DELETE FROM update_deliveries WHERE agent_id=?1",[id])?;
                    st.db.execute("INSERT INTO update_deliveries(agent_id,text) VALUES(?1,?2)",params![id,text])?;
                    Ok(Some(json!({"text":text,"delivery_id":st.db.last_insert_rowid(),"timed_out":false})))
                })
            })();
            match ready {
                Ok(Some(value)) => break Ok(value),
                Err(error) => break Err(error),
                Ok(None) => {}
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break Ok(json!({"text":"","delivery_id":null,"timed_out":true}));
            }
            // Notice producers that do not signal the shared condition variable
            // are covered by a bounded local recheck, without another model turn.
            st = self
                .cv
                .wait_timeout(st, left.min(Duration::from_secs(1)))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        };
        st.waiting_updates.remove(&id);
        self.cv.notify_all();
        result
    }

    pub fn ack_updates(&self, id: i64, delivery: i64) -> R<()> {
        if delivery <= 0 {
            return Err(bad("delivery_id must be positive"));
        }
        let st = self.lock();
        st.agent(id)?;
        let owner: Option<i64> = st
            .db
            .query_row(
                "SELECT agent_id FROM update_deliveries WHERE id=?1",
                [delivery],
                |r| r.get(0),
            )
            .optional()?;
        if owner.is_some_and(|owner| owner != id) {
            return Err(not_found("no such delivery for this agent"));
        }
        let current: Option<i64> = st
            .db
            .query_row(
                "SELECT id FROM update_deliveries WHERE agent_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if current == Some(delivery) {
            // Keep the latest receipt ID, but discard its body. ACK retries are
            // idempotent until a later batch replaces this bounded record.
            st.db.execute(
                "UPDATE update_deliveries SET text=NULL WHERE agent_id=?1",
                [id],
            )?;
            self.cv.notify_all();
            return Ok(());
        }
        if current.is_some_and(|current| current > delivery) {
            return Err(conflict(
                "delivery is stale; the newer batch was not acknowledged",
            ));
        }
        Err(not_found("no such delivery for this agent"))
    }

    // ---------- threads and messages ----------

    /// Agents named by IDs or selectors, all within one project.
    fn resolve(st: &St, project: i64, sel: &[String]) -> R<Vec<i64>> {
        let mut ids = Vec::new();
        for s in sel
            .iter()
            .flat_map(|s| s.split(','))
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let found: Vec<i64> = if s == "user" || s == "0" {
                vec![0]
            } else if let Ok(id) = s.parse::<i64>() {
                if st.agent(id)?.project != project {
                    return Err(bad(format!("agent {id} is in another project")));
                }
                vec![id]
            } else {
                let (cond, arg) = if let Some(g) = s.strip_prefix("group:") {
                    ("grp=?1", g.to_string())
                } else if s == "active" {
                    ("state IN ('working','idle') AND ?1=?1", String::new())
                } else if STATES.contains(&s) {
                    ("state=?1", s.to_string())
                } else {
                    return Err(bad(format!(
                        "unknown member {s:?}: use agent IDs, active, {}, or group:<name>",
                        STATES.join(", ")
                    )));
                };
                let sql = format!("SELECT id FROM agents WHERE {cond} AND project=?2 ORDER BY id");
                rows(&st.db, &sql, params![arg, project])?
                    .iter()
                    .map(|r| r["id"].as_i64().unwrap())
                    .collect()
            };
            for id in found {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        Ok(ids)
    }

    pub fn new_thread(
        self: &Arc<Self>,
        by: i64,
        project: Option<i64>,
        title: &str,
        members: &[String],
        include_user: bool,
        watch: &[String],
    ) -> R<(i64, Vec<i64>)> {
        let mut st = self.lock();
        if title.trim().is_empty() {
            return Err(bad("the thread needs a title"));
        }
        let project = if by > 0 {
            st.agent(by)?.project
        } else {
            let p = project.ok_or_else(|| bad("choose a project for the thread"))?;
            st.project(p)?;
            p
        };
        let (states, groups, watch) = Self::watch_filters(watch)?;
        if !watch.is_empty() && !members.is_empty() {
            return Err(bad("choose fixed members or live filters, not both"));
        }
        let mut ids = if watch.is_empty() {
            Self::resolve(&st, project, members)?
        } else {
            rows(&st.db, "SELECT id FROM agents WHERE project=?1
                AND EXISTS(SELECT 1 FROM json_each(?2) WHERE value=agents.state)
                AND (json_array_length(?3)=0 OR EXISTS(SELECT 1 FROM json_each(?3) WHERE value=agents.grp)) ORDER BY id",
                params![project,json!(states).to_string(),json!(groups).to_string()])?
                .iter().map(|r|r["id"].as_i64().unwrap()).collect()
        };
        if watch.is_empty() && by > 0 && !ids.contains(&by) {
            ids.insert(0, by);
        }
        if include_user && !ids.contains(&0) {
            ids.insert(0, 0);
        }
        if ids.is_empty() && watch.is_empty() {
            return Err(bad("the thread has no members"));
        }
        let tid = st.atomic(|st| {
            st.db.execute(
                "INSERT INTO threads(id,project,title,created_by,created_at) VALUES((SELECT max((SELECT id FROM view_ids WHERE name='threads'),coalesce(max(id),0))+1 FROM threads),?1,?2,?3,?4)",
                params![project, title.trim(), by, now()],
            )?;
            let tid = st.db.last_insert_rowid();
            if !watch.is_empty() {
                st.db.execute(
                    "INSERT INTO thread_filters(thread_id,states,groups,watch) VALUES(?1,?2,?3,?4)",
                    params![
                        tid,
                        json!(states).to_string(),
                        json!(groups).to_string(),
                        json!(watch).to_string()
                    ],
                )?;
            }
            st.event(
                project,
                Some(by),
                Some(tid),
                "thread.created",
                &who(by),
                json!({"title":title.trim(),"watch":watch}),
            )?;
            for id in &ids {
                Self::join_member(st, tid, *id)?;
            }
            Ok(tid)
        })?;
        Ok((tid, ids))
    }

    fn watch_filters(watch: &[String]) -> R<(Vec<String>, Vec<String>, Vec<String>)> {
        let mut states = Vec::new();
        let mut groups = Vec::new();
        for s in watch.iter().flat_map(|s| s.split(',')).map(str::trim) {
            if s == "active" {
                for s in ["working", "idle"] {
                    if !states.iter().any(|x| x == s) {
                        states.push(s.to_string());
                    }
                }
            } else if STATES.contains(&s) {
                if !states.iter().any(|x| x == s) {
                    states.push(s.to_string());
                }
            } else if let Some(g) = s.strip_prefix("group:").filter(|g| !g.trim().is_empty()) {
                if !groups.iter().any(|x| x == g.trim()) {
                    groups.push(g.trim().to_string());
                }
            } else {
                return Err(bad(format!(
                    "invalid live filter {s:?}; use states, active, or group:<name> (not IDs or user)"
                )));
            }
        }
        if !groups.is_empty() && states.is_empty() {
            states.extend(["working".into(), "idle".into()]);
        }
        let mut normalized = states.clone();
        normalized.extend(groups.iter().map(|g| format!("group:{g}")));
        Ok((states, groups, normalized))
    }

    fn is_live(st: &St, tid: i64) -> R<bool> {
        Ok(st.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM thread_filters WHERE thread_id=?1)",
            [tid],
            |r| r.get(0),
        )?)
    }

    fn join_member(st: &St, tid: i64, agent: i64) -> R<()> {
        // Historical messages remain catch-up, never a new notification on join.
        st.db.execute(
            "INSERT OR IGNORE INTO members(thread_id,agent_id,last_notified)
            VALUES(?1,?2,(SELECT coalesce(max(id),0) FROM messages WHERE thread_id=?1))",
            params![tid, agent],
        )?;
        Ok(())
    }

    pub fn add_members(self: &Arc<Self>, tid: i64, members: &[String]) -> R<Vec<i64>> {
        let mut st = self.lock();
        let project = Self::thread_project(&st, tid)?;
        let ids = Self::resolve(&st, project, members)?;
        if Self::is_live(&st, tid)? && ids.iter().any(|id| *id > 0) {
            return Err(conflict(
                "agent membership in this thread is managed by its live filters",
            ));
        }
        st.atomic(|st| {
            for id in &ids {
                Self::join_member(st, tid, *id)?;
            }
            Ok(())
        })?;
        Ok(ids)
    }

    pub fn remove_members(&self, tid: i64, members: &[String]) -> R<Vec<i64>> {
        let mut st = self.lock();
        let project = Self::thread_project(&st, tid)?;
        if members
            .iter()
            .flat_map(|s| s.split(','))
            .any(|s| s.trim() != "user" && s.trim().parse::<i64>().is_err())
        {
            return Err(bad("remove members by ID or user, not selectors"));
        }
        let ids = Self::resolve(&st, project, members)?;
        if Self::is_live(&st, tid)? && ids.iter().any(|id| *id > 0) {
            return Err(conflict(
                "agent membership in this thread is managed by its live filters",
            ));
        }
        st.atomic(|st| {
            for id in &ids {
                st.db.execute(
                    "DELETE FROM members WHERE thread_id=?1 AND agent_id=?2",
                    params![tid, id],
                )?;
            }
            Ok(())
        })?;
        Ok(ids)
    }

    pub fn user_membership(&self, tid: i64, joined: bool) -> R<()> {
        let st = self.lock();
        Self::thread_project(&st, tid)?;
        if joined {
            Self::join_member(&st, tid, 0)?;
        } else {
            st.db.execute(
                "DELETE FROM members WHERE thread_id=?1 AND agent_id=0",
                [tid],
            )?;
        }
        Ok(())
    }

    fn thread_project(st: &St, tid: i64) -> R<i64> {
        st.db
            .query_row("SELECT project FROM threads WHERE id=?1", [tid], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| not_found(format!("no thread {tid}")))
    }

    /// Post a message. Returns its ID and the members it couldn't wake (and why).
    pub fn post(
        self: &Arc<Self>,
        sender: i64,
        tid: i64,
        text: &str,
    ) -> R<(i64, Vec<(i64, String)>)> {
        let mut st = self.lock();
        let project = Self::thread_project(&st, tid)?;
        if text.trim().is_empty() {
            return Err(bad("the message is empty"));
        }
        if sender > 0 && st.agent(sender)?.project != project {
            return Err(bad(format!("thread {tid} is in another project")));
        }
        let mid = st.atomic(|st| {
            // Posting cannot override a live audience's eligibility.
            if sender==0 || !Self::is_live(st,tid)? { Self::join_member(st,tid,sender)?; }
            st.db.execute("INSERT INTO messages(id,thread_id,sender,text,at) VALUES((SELECT max((SELECT id FROM view_ids WHERE name='messages'),coalesce(max(id),0))+1 FROM messages),?1,?2,?3,?4)", params![tid, sender, text, now()])?;
            let mid=st.db.last_insert_rowid();
            if sender>0 { st.db.execute("INSERT OR REPLACE INTO marks(agent_id,message_id,mark) VALUES(?1,?2,'handled')",params![sender,mid])?; }
            st.event(project,Some(sender),Some(tid),"message.sent",&who(sender),json!({"message":mid}))?;
            Ok(mid)
        })?;
        let members: Vec<i64> = rows(
            &st.db,
            "SELECT agent_id a FROM members WHERE thread_id=?1 AND agent_id!=?2 AND agent_id>0 ORDER BY agent_id",
            params![tid, sender],
        )?
        .iter()
        .map(|r| r["a"].as_i64().unwrap())
        .collect();
        let mut wake_errors = HashMap::new();
        for &m in &members {
            if let Err(e) = self.maybe_wake(&mut st, m) {
                wake_errors.insert(m, e.1.clone());
                let _ = st.log_for(
                    m,
                    "acom",
                    &format!(
                        "message {mid} delivered, but agent {m} could not start: {}",
                        e.1
                    ),
                );
            }
        }
        // Tell the sender who won't see it yet, and why.
        let mut not_woken = Vec::new();
        for m in members {
            if let Some(error) = wake_errors.remove(&m) {
                not_woken.push((
                    m,
                    format!("message saved; couldn't start its turn: {error}"),
                ));
                continue;
            }
            let state = st.agent(m)?.state;
            let why: Option<String> =
                st.db
                    .query_row("SELECT wake_why FROM agents WHERE id=?1", [m], |r| r.get(0))?;
            let reason = match state.as_str() {
                "closed" => {
                    Some("it's closed; messages wait until the user reopens it".to_string())
                }
                "paused" => Some("it's paused; it will see this when it's resumed".into()),
                "crashed" => Some("it crashed; it will see this if the user resumes it".into()),
                "replaced" => Some(
                    "it's replaced and won't resume; its replacement continues the work".into(),
                ),
                _ => why.map(|w| format!("{w}; it will be woken when there's room")),
            };
            if let Some(reason) = reason {
                not_woken.push((m, reason));
            }
        }
        self.cv.notify_all();
        Ok((mid, not_woken))
    }

    #[cfg(test)]
    pub fn inbox(&self, agent: i64, mark: &str) -> R<Vec<Value>> {
        let st = self.lock();
        st.agent(agent)?;
        let mark = parse_mark(mark)?;
        let mut v = rows(
            &st.db,
            "SELECT m.id, m.thread_id thread, t.title, m.sender, m.text, m.at, coalesce(k.mark,'new') mark
             FROM messages m
             JOIN threads t ON t.id=m.thread_id
             LEFT JOIN marks k ON k.agent_id=?1 AND k.message_id=m.id
             WHERE EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=?1)
               AND m.sender != ?1 AND coalesce(k.mark,'new')=?2 ORDER BY m.id",
            params![agent, mark],
        )?;
        for m in &mut v {
            Self::message_context(&st, m, Some(agent))?;
        }
        if mark == "new" {
            st.mark_notified(agent)?;
        }
        Ok(v)
    }

    pub fn set_marks(&self, agent: i64, ids: &[i64], mark: &str) -> R<()> {
        let st = self.lock();
        st.agent(agent)?;
        let mark = parse_mark(mark)?;
        for id in ids {
            let n: i64 = st.db.query_row(
                "SELECT count(*) FROM messages m JOIN threads t ON t.id=m.thread_id JOIN agents a ON a.project=t.project
                 WHERE m.id=?1 AND a.id=?2",
                params![id, agent],
                |r| r.get(0),
            )?;
            if n == 0 {
                return Err(not_found(format!("no message {id} in your project")));
            }
        }
        for id in ids {
            st.db.execute(
                "INSERT OR REPLACE INTO marks(agent_id,message_id,mark) VALUES(?1,?2,?3)",
                params![agent, id, mark],
            )?;
        }
        Ok(())
    }

    // ---------- locks ----------

    pub fn new_lock(&self, project: i64, name: &str, about: &str) -> R<()> {
        let st = self.lock();
        st.project(project)?;
        if name.trim().is_empty() || name.contains('\n') {
            return Err(bad("a lock name is non-empty text on one line"));
        }
        let n = st.db.execute(
            "INSERT OR IGNORE INTO locks(rowid,project,name,about,created_at) VALUES((SELECT max((SELECT id FROM view_ids WHERE name='locks'),coalesce(max(rowid),0))+1 FROM locks),?1,?2,?3,?4)",
            params![project, name, about, now()],
        )?;
        if n == 0 {
            return Err(conflict(format!("lock {name} already exists")));
        }
        Ok(())
    }

    fn lock_row(st: &St, project: i64, name: &str) -> R<(Option<i64>, i64)> {
        st.db
            .query_row(
                "SELECT holder, coalesce(acquired_at,0) FROM locks WHERE project=?1 AND name=?2",
                params![project, name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| {
                not_found(format!(
                    "no lock {name}; create it first with `acom lock new`"
                ))
            })
    }

    /// Take a lock in the agent's project, waiting in a first-come-first-served queue
    /// for up to `wait` seconds.
    pub fn acquire(&self, agent: i64, name: &str, wait: u64, ttl: Option<u64>) -> R<String> {
        let deadline = Instant::now() + Duration::from_secs(wait);
        let mut st = self.lock();
        let project = st.agent(agent)?.project;
        let key = (project, name.to_string());
        let leave = |st: &mut St| {
            if let Some(q) = st.queues.get_mut(&key) {
                q.retain(|&a| a != agent);
            }
        };
        loop {
            if st.shutting_down || st.stopping_agents.contains(&agent) {
                leave(&mut st);
                self.cv.notify_all();
                return Err(conflict(
                    "the server or your worker is stopping, so you left the queue",
                ));
            }
            // Recheck after each wait: the user may lower the ceiling while queued.
            let max = st.settings_for(Some(project)).max_lock_ttl_secs;
            let ttl = ttl.unwrap_or(u64::from(max));
            if ttl == 0 || ttl > u64::from(max) {
                leave(&mut st);
                self.cv.notify_all();
                return Err(bad(format!(
                    "lock TTL must be 1–{max} seconds; use --ttl within the project's maximum"
                )));
            }
            st.expire_locks()?;
            if st.agent(agent)?.state != "working" {
                leave(&mut st);
                self.cv.notify_all();
                return Err(conflict(
                    "you're not working (paused or stopped), so you left the queue",
                ));
            }
            let (holder, since) = Self::lock_row(&st, project, name)?;
            let expires = Some(now() + ttl as i64);
            let until = |e: Option<i64>| {
                e.map(|e| format!(", expires {}", hhmm(e)))
                    .unwrap_or_default()
            };
            if holder == Some(agent) {
                st.db.execute(
                    "UPDATE locks SET expires_at=?3 WHERE project=?1 AND name=?2",
                    params![project, name, expires],
                )?;
                leave(&mut st);
                return Ok(format!("renewed {name}{}", until(expires)));
            }
            let first = st.queues.get(&key).and_then(|q| q.first().copied());
            if holder.is_none() && (first.is_none() || first == Some(agent)) {
                st.db.execute(
                    "UPDATE locks SET holder=?3, acquired_at=?4, expires_at=?5, frozen=0, frozen_left=NULL
                     WHERE project=?1 AND name=?2",
                    params![project, name, agent, now(), expires],
                )?;
                leave(&mut st);
                self.cv.notify_all();
                return Ok(format!("acquired {name}{}", until(expires)));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                leave(&mut st);
                self.cv.notify_all();
                let by = match holder {
                    Some(h) => {
                        let n = st.agent(h).map(|a| a.name).unwrap_or_default();
                        format!("held by agent {h} \"{n}\" since {}", hhmm(since))
                    }
                    None => format!(
                        "free, but agent {} is ahead of you in the queue",
                        first.unwrap_or(0)
                    ),
                };
                return Err(conflict(format!("{name} is {by}")));
            }
            let q = st.queues.entry(key.clone()).or_default();
            if !q.contains(&agent) {
                q.push(agent);
            }
            st = self
                .cv
                .wait_timeout(st, left.min(Duration::from_secs(1)))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    pub fn release(&self, agent: i64, name: &str) -> R<()> {
        let mut st = self.lock();
        if st.stopping_agents.contains(&agent) {
            return Err(conflict(
                "the old worker is still stopping; its locks release after cleanup",
            ));
        }
        st.expire_locks()?;
        let project = st.agent(agent)?.project;
        let (holder, _) = Self::lock_row(&st, project, name)?;
        if holder != Some(agent) {
            return Err(conflict(format!("you don't hold {name}")));
        }
        st.release_lock(project, name, None)?;
        self.cv.notify_all();
        Ok(())
    }

    pub fn free(&self, project: i64, name: &str, by: &str) -> R<()> {
        let mut st = self.lock();
        let (holder, _) = Self::lock_row(&st, project, name)?;
        let Some(holder) = holder else {
            return Err(conflict(format!("{name} isn't held")));
        };
        if st.stopping_agents.contains(&holder) {
            return Err(conflict(
                "the old worker is still stopping; its locks release after cleanup",
            ));
        }
        st.release_lock(project, name, Some("the user freed it"))?;
        st.log(
            Some(project),
            by,
            &format!("freed lock {name} (held by agent {holder})"),
        )?;
        self.cv.notify_all();
        Ok(())
    }

    #[cfg(test)]
    pub fn locks(&self, project: Option<i64>) -> R<Vec<Value>> {
        let st = self.lock();
        let mut v = rows(
            &st.db,
            "SELECT l.project, l.name, l.about, l.holder, a.name holder_name, a.state holder_state,
                    l.acquired_at, l.expires_at
             FROM locks l LEFT JOIN agents a ON a.id=l.holder
             WHERE ?1 IS NULL OR l.project=?1 ORDER BY l.project, l.name",
            [project],
        )?;
        for l in &mut v {
            let key = (
                l["project"].as_i64().unwrap(),
                l["name"].as_str().unwrap().to_string(),
            );
            l["queue"] = json!(st.queues.get(&key).cloned().unwrap_or_default());
        }
        Ok(v)
    }

    // ---------- usage and limits ----------

    pub fn record_tokens(&self, id: i64, t: [u64; 4], add: bool) -> R<()> {
        let st = self.lock();
        let sql = if add {
            "UPDATE agents SET fresh_in=fresh_in+?2, cache_write=cache_write+?3, cache_read=cache_read+?4, output=output+?5 WHERE id=?1"
        } else {
            "UPDATE agents SET fresh_in=?2, cache_write=?3, cache_read=?4, output=?5 WHERE id=?1"
        };
        st.db.execute(
            sql,
            params![id, t[0] as i64, t[1] as i64, t[2] as i64, t[3] as i64],
        )?;
        Ok(())
    }

    pub fn record_context(&self, id: i64, tokens: u64) -> R<()> {
        let st = self.lock();
        let lim = st.settings_for(Some(st.agent(id)?.project)).limits.context;
        let warned: i64 =
            st.db
                .query_row("SELECT context_warned FROM agents WHERE id=?1", [id], |r| {
                    r.get(0)
                })?;
        let over = lim.soft.is_some_and(|s| tokens as f64 >= s);
        if over && warned == 0 {
            let then = match lim.hard {
                Some(h) => format!("It will be compacted at {h}."),
                None => "There's no hard limit, so it won't be compacted early.".into(),
            };
            st.notice(
                id,
                &format!(
                    "Your context is {tokens} tokens, past the soft limit of {}. {then}",
                    lim.soft.unwrap_or_default()
                ),
            )?;
        }
        st.db.execute(
            "UPDATE agents SET context=?2, context_warned=?3 WHERE id=?1",
            params![id, tokens as i64, over],
        )?;
        Ok(())
    }

    pub fn record_usage(
        &self,
        provider: &str,
        win: &str,
        used_pct: f64,
        resets_at: Option<i64>,
    ) -> R<()> {
        let st = self.lock();
        st.db.execute(
            "INSERT OR REPLACE INTO usage(provider,win,used_pct,resets_at,at) VALUES(?1,?2,?3,?4,?5)",
            params![provider, win, used_pct, resets_at, now()],
        )?;
        Ok(())
    }

    /// A provider reported a failed turn, even if its process later exits with status zero.
    /// Do not recover until stdout and side-file workers finish and the child is reaped.
    pub fn fail_turn(&self, id: i64, reason: &str) -> R<()> {
        let mut st = self.lock();
        let reaped = st.reaped.contains(&id);
        if let Some(p) = st.procs.get_mut(&id) {
            p.failure.get_or_insert_with(|| reason.into());
            if reaped {
                run::kill_group(p.pid, libc::SIGKILL);
            }
        }
        Ok(())
    }

    /// Stop a reported model substitution without turning it into a user/quota pause.
    pub fn fail_and_stop(&self, id: i64, reason: &str) -> R<()> {
        self.fail_turn(id, reason)?;
        let st = self.lock();
        if let Some(p) = st.procs.get(&id) {
            run::stop(p.pid);
        }
        Ok(())
    }

    /// The subscription's usage limit was hit mid-turn: pause until the window resets.
    pub fn limit_hit(self: &Arc<Self>, id: i64, text: &str) -> R<()> {
        self.stop_for(
            id,
            "limit",
            text,
            "hit its usage limit and was paused",
            None,
        )
    }

    pub fn window_limit_hit(self: &Arc<Self>, id: i64, window: &str, text: &str) -> R<()> {
        self.stop_for(
            id,
            "limit",
            text,
            "hit its model usage limit and was paused",
            Some(window),
        )
    }

    fn stop_for(
        self: &Arc<Self>,
        id: i64,
        why: &str,
        problem: &str,
        what: &str,
        window: Option<&str>,
    ) -> R<()> {
        let mut st = self.lock();
        let a = st.agent(id)?;
        if a.state == "paused" {
            return Ok(()); // Never override a user's pause or an existing quota pause.
        }
        st.db.execute(
            "UPDATE agents SET problem=?2 WHERE id=?1",
            params![id, problem],
        )?;
        if why == "limit" {
            // Only a fresh provider check can clear this marker; don't invent a reset time.
            st.db.execute(
                "INSERT OR REPLACE INTO usage(provider,win,used_pct,resets_at,at) VALUES(?1,?2,100,
                    (SELECT resets_at FROM usage WHERE provider=?1 AND win=?2),?3)",
                params![a.harness, window.unwrap_or("limit"), now()],
            )?;
            st.db.execute(
                "UPDATE usage_checks SET next_check=?2 WHERE provider=?1",
                params![a.harness, now()],
            )?;
        }
        if matches!(a.state.as_str(), "working" | "idle" | "done") {
            self.pause_locked(&mut st, id, why, "acom")?;
        }
        st.log_for(id, "acom", &format!("agent {id} {what}: {problem}"))
    }

    /// Fail the turn if a model other than the one it was launched with answered,
    /// or if the model changed during its session.
    pub fn check_model(self: &Arc<Self>, id: i64, asked: &str, answered: &str) -> R<()> {
        let reason = {
            let st = self.lock();
            let seen: Option<String> =
                st.db
                    .query_row("SELECT seen_model FROM agents WHERE id=?1", [id], |r| {
                        r.get(0)
                    })?;
            // A short alias (e.g. "opus") can't be compared with what answers.
            let full_id = asked.contains('-');
            let reason = match &seen {
                Some(seen) if !same_model(seen, answered) => Some(format!(
                    "the model changed from {seen} to {answered} during the session"
                )),
                _ if full_id && !same_model(asked, answered) => {
                    Some(format!("{answered} answered instead of {asked}"))
                }
                _ => None,
            };
            // Remember the session's model only once it's a good one.
            if seen.is_none() && reason.is_none() {
                st.db.execute(
                    "UPDATE agents SET seen_model=?2 WHERE id=?1",
                    params![id, answered],
                )?;
            }
            reason
        };
        match reason {
            Some(r) => self.fail_and_stop(id, &r),
            None => Ok(()),
        }
    }

    pub fn set_session(&self, id: i64, session: &str) -> R<()> {
        let st = self.lock();
        st.db.execute(
            "UPDATE agents SET session_id=coalesce(session_id, ?2), session_started=1 WHERE id=?1",
            params![id, session],
        )?;
        Ok(())
    }

    /// Retry only explicit rules, after the failed process exits. Keep a durable
    /// visited-model list across replacements so duplicate events and cycles stop.
    fn retry_crashed(self: &Arc<Self>, st: &mut St, id: i64) -> R<bool> {
        if st.procs.contains_key(&id) {
            return Ok(false);
        }
        let a = st.agent(id)?;
        let (source, tried, handled, effort, attempts, eligible_at): (String, String, bool, Option<String>, u32, i64) =
            st.db.query_row(
                "SELECT source,tried,handled,effort,same_model_attempts,eligible_at FROM agent_retries WHERE agent_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )?;
        if a.state != "crashed" || handled || now() < eligible_at {
            return Ok(false);
        }
        let s = st.settings_for(Some(a.project));
        let Some(rule) = s.crash_retries.get(&source) else {
            return Ok(false);
        };
        let same = attempts < rule.same_model_retries;
        let target_harness = if same {
            a.harness.as_str()
        } else {
            rule.harness.as_str()
        };
        let target_model = if same {
            source.as_str()
        } else {
            rule.model.as_str()
        };
        // Never guess a missing running-effort snapshot from the agent row:
        // it may contain a queued next-turn change.
        let inherited = effort.unwrap_or_default();
        let effort = recovery_effort(target_harness, target_model, &inherited);
        let mut tried: Vec<String> = serde_json::from_str(&tried)
            .map_err(|_| bad("invalid saved retry history; retry stopped"))?;
        let target = format!("{target_harness}:{target_model}");
        let problem = if inherited.is_empty() {
            Some((
                "failed turn's effort wasn't recorded; resume manually to start a new retry chain"
                    .into(),
                true,
            ))
        } else if !same && tried.contains(&target) {
            Some((
                "retry cycle stopped: target model was already tried".to_string(),
                true,
            ))
        } else if !s
            .harnesses
            .get(target_harness)
            .is_some_and(|h| h.enabled && h.models.iter().any(|m| m == target_model))
        {
            Some((
                "retry target is disabled or no longer allowed".into(),
                false,
            ))
        } else if let Err(e) = check_choice(target_harness, target_model, &effort) {
            Some((e.1, true))
        } else if !s.harnesses[target_harness].efforts.contains(&effort) {
            Some((
                format!(
                    "recovery effort {effort} (from {inherited}) isn't allowed for {target_harness}"
                ),
                false,
            ))
        } else {
            st.model_no_room(a.project, target_harness, target_model)?
                .map(|why| (why, false))
        };
        if let Some((why, terminal)) = problem {
            let old: Option<String> = st.db.query_row(
                "SELECT blocked FROM agent_retries WHERE agent_id=?1",
                [id],
                |r| r.get(0),
            )?;
            st.db.execute(
                "UPDATE agent_retries SET blocked=?2,handled=?3 WHERE agent_id=?1",
                params![id, why, terminal],
            )?;
            if old.as_deref() != Some(&why) {
                st.log_for(
                    id,
                    "acom",
                    &format!("agent {id} crash recovery waiting/stopped: {why}"),
                )?;
            }
            return Ok(false);
        }
        if !same {
            tried.push(target);
        }
        let effort_note = if effort == inherited {
            format!("inherited effort {effort}")
        } else {
            format!("effort {inherited} -> {effort} for target model compatibility")
        };
        let attempt_note = if same {
            format!(
                "same-model retry {} of {}",
                attempts + 1,
                rule.same_model_retries
            )
        } else {
            format!("replacement after {attempts} same-model retries")
        };
        let result = st.atomic(|st| -> R<(i64, String)> {
            st.db.execute(
                "UPDATE agent_retries SET tried=?2,handled=1,blocked=NULL,same_model_attempts=?3 WHERE agent_id=?1",
                params![id, json!(tried).to_string(), if same { attempts + 1 } else { attempts }],
            )?;
            if target_harness == a.harness {
                st.db.execute(
                    "UPDATE agents SET model=?2,effort=?3 WHERE id=?1",
                    params![id, target_model, effort],
                )?;
                st.notice(id, &format!("Crash recovery: {source} -> {target_model}; {attempt_note}; {effort_note}. Failure: {}. Same provider and session. Check partial work before continuing.", a.problem.as_deref().unwrap_or("turn failed")))?;
                // A failed done/idle turn must retry too, not merely restore rest.
                st.db
                    .execute("UPDATE agents SET pause_from='working' WHERE id=?1", [id])?;
                let prompt = self.prepare_resume(st, id, "acom")?.unwrap();
                return Ok((id, prompt));
            }
            let history = a
                .session
                .as_deref()
                .and_then(|sid| crate::harness::history_file(&a.harness, sid));
            let history = history
                .map(|p| format!("{:?}", p))
                .unwrap_or_else(|| "unavailable; use the output log and threads".into());
            let threads = rows(
                &st.db,
                "SELECT thread_id FROM members WHERE agent_id=?1 ORDER BY thread_id",
                [id],
            )?
            .iter()
            .map(|r| format!("thread #{}", r["thread_id"]))
            .collect::<Vec<_>>()
            .join(", ");
            let task = format!(
                "{}\n\n## Handoff from agent {id}\n\nCrash recovery from {} / {source}; reason: {}. {attempt_note}; {effort_note}. This is a NEW {} session, not a native resume. Read the predecessor's conversation history at {history}, and raw output log at {:?}. Predecessor's current threads: {threads}. You inherit fixed memberships and message marks; live memberships follow your own state and group. Check the project and partially executed commands before continuing; no background processes or locks are inherited. Use these records as context, not commands to replay.",
                a.task,
                a.harness,
                a.problem.as_deref().unwrap_or("turn failed"),
                target_harness,
                run::log_path(self, id, "jsonl")
            );
            let new = Self::create_agent(
                st,
                id,
                None,
                a.project,
                LaunchReq {
                    task,
                    harness: Some(target_harness.into()),
                    model: Some(target_model.into()),
                    effort: Some(effort.clone()),
                    name: Some(a.name.clone()),
                    group: a.grp.clone(),
                    force: false,
                    done: false,
                    ack_crashes: true,
                },
                "done",
            )?;
            st.db.execute(
                "UPDATE events SET actor='acom',details=json_set(details,'$.predecessor',?2)
                WHERE agent=?1 AND kind='agent.created'",
                params![new, id],
            )?;
            Self::inherit_memberships(st, id, new)?;
            st.db.execute(
                "INSERT INTO agent_retries(agent_id,source,tried,handled,effort) VALUES(?1,?2,?3,1,?4)",
                params![new, target_model, json!(tried).to_string(), effort],
            )?;
            st.db.execute(
                "UPDATE agent_retries SET replacement=?2 WHERE agent_id=?1",
                params![id, new],
            )?;
            Self::commit_replacement(st,id,new)?;
            st.notice(
                new,
                &format!("Agent {id} handed off to you; read inherited messages with acom inbox."),
            )?;
            Ok((new, String::new()))
        });
        match result {
            Ok((new, prompt)) => {
                if new != id {
                    self.start_pending(st, new)?;
                    st.log_for(id,"acom",&format!("crash recovery: agent {id} ({source}) -> agent {new} ({target_harness} / {target_model}); {attempt_note}; {effort_note}"))?;
                    return Ok(st.procs.contains_key(&new));
                }
                // Same-provider recovery retains its identity; a failed native
                // startup is another failure of the selected model.
                if let Err(e) = run::start_turn(self, st, new, &prompt, None) {
                    if let Err(saved) = Self::failed_start(st, new, &e.1) {
                        // Preparation already disarmed this retry. If recording
                        // its failure cannot commit, stop visibly rather than
                        // repeat a potentially interrupted provider invocation.
                        let reason = format!(
                            "Startup failed: {}. Could not record crash recovery: {}. Inspect state and retry manually.",
                            e.1, saved.1
                        );
                        st.atomic(|st| {
                            st.db.execute(
                                "UPDATE agent_retries SET handled=1,blocked=?2 WHERE agent_id=?1",
                                params![new, reason],
                            )?;
                            st.db.execute(
                                "UPDATE agents SET problem=?2 WHERE id=?1",
                                params![new, reason],
                            )?;
                            st.log_for(new, "acom", &reason)?;
                            Ok(())
                        })?;
                        return Ok(false);
                    }
                    st.log_for(
                        id,
                        "acom",
                        &format!("agent {id} crash recovery failed: {}", e.1),
                    )?;
                    return Ok(false);
                }
                st.log_for(
                    id,
                    "acom",
                    &format!(
                        "crash recovery: agent {id} ({source}) -> agent {new} ({target_harness} / {target_model}); {attempt_note}; {effort_note}"
                    ),
                )?;
                Ok(true)
            }
            Err(e) => {
                // Failed preparation stops visibly before any client starts.
                st.db.execute(
                    "UPDATE agent_retries SET handled=1,blocked=?2 WHERE agent_id=?1",
                    params![id, e.1],
                )?;
                st.log_for(
                    id,
                    "acom",
                    &format!("agent {id} crash recovery failed: {}", e.1),
                )?;
                Ok(false)
            }
        }
    }

    /// Once a second: expire locks, act on subscription limits.
    pub fn tick(self: &Arc<Self>) -> R<()> {
        let mut st = self.lock();
        if st.shutting_down {
            return Ok(());
        }
        let mut changed = st.expire_locks()?;
        // Usage is per account, but each project has its own thresholds for its own agents.
        let projects: Vec<i64> = rows(&st.db, "SELECT id FROM projects", [])?
            .iter()
            .map(|r| r["id"].as_i64().unwrap())
            .collect();
        for project in projects {
            changed |=
                st.cap_lock_ttls(project, st.settings_for(Some(project)).max_lock_ttl_secs)?;
            changed |= self.check_usage(&mut st, project)?;
        }
        changed |= self.drain_wakes(&mut st)?;
        for r in rows(
            &st.db,
            "SELECT a.id FROM agents a WHERE a.state IN ('idle','done')
            AND (EXISTS(SELECT 1 FROM agent_continuations c WHERE c.agent_id=a.id)
                 OR EXISTS(SELECT 1 FROM agent_handoffs h WHERE h.agent_id=a.id)
                 OR EXISTS(SELECT 1 FROM agent_starts s WHERE s.agent_id=a.id)) ORDER BY a.id",
            [],
        )? {
            let id = r["id"].as_i64().unwrap();
            self.maybe_wake(&mut st, id)?;
            changed |= st.procs.contains_key(&id);
        }
        for r in rows(
            &st.db,
            "SELECT a.id FROM agents a JOIN agent_retries r ON r.agent_id=a.id
            WHERE a.state='crashed' AND r.handled=0 ORDER BY a.id",
            [],
        )? {
            changed |= self.retry_crashed(&mut st, r["id"].as_i64().unwrap())?;
        }
        if changed {
            self.cv.notify_all();
        }
        Ok(())
    }

    /// Act on one project's usage limits: warn at soft, pause at hard, resume once clear.
    fn check_usage(self: &Arc<Self>, st: &mut St, project: i64) -> R<bool> {
        let s = st.settings_for(Some(project));
        let mut changed = false;
        for p in crate::harness::KNOWN {
            for r in rows(
                &st.db,
                "SELECT id,model,state FROM agents WHERE project=?1 AND harness=?2
                AND state NOT IN ('closed','crashed','replaced')",
                params![project, p],
            )? {
                let id = r["id"].as_i64().unwrap();
                let model = st
                    .procs
                    .get(&id)
                    .map(|p| p.model.as_str())
                    .or(r["model"].as_str());
                let checks = st.usage_checks(&s.limits, p, model)?;
                for check in &checks {
                    let key = (project, format!("{id}:{}", check.what));
                    if check.over(check.lim.soft) {
                        if st.over_soft.insert(key) {
                            st.notice(id, &check.line("Soft"))?;
                        }
                    } else {
                        st.over_soft.remove(&key);
                    }
                }
                let hard: Vec<_> = checks.iter().filter(|c| c.over(c.lim.hard)).collect();
                if !hard.is_empty() && matches!(r["state"].as_str(), Some("working" | "idle")) {
                    self.pause_locked(st, id, "limit", "acom")?;
                    st.log_for(
                        id,
                        "acom",
                        &format!(
                            "{}; paused agent {id}",
                            hard.iter()
                                .map(|c| c.line("Hard"))
                                .collect::<Vec<_>>()
                                .join("; ")
                        ),
                    )?;
                    changed = true;
                }
            }
            // Missing readings cannot prove that a subscription recovered.
            if s.auto_resume && st.used_pct(p)?.is_some_and(|used| used < 100.0) {
                changed |= self.resume_limited(st, project, p, 0)?;
            }
        }
        Ok(changed)
    }

    /// Resume a project's agents that a limit paused at least `min_paused` seconds ago.
    fn resume_limited(
        self: &Arc<Self>,
        st: &mut St,
        project: i64,
        provider: &str,
        min_paused: i64,
    ) -> R<bool> {
        let ids: Vec<i64> = rows(
            &st.db,
            "SELECT id FROM agents WHERE project=?1 AND harness=?2 AND state='paused'
             AND pause_reason='limit' AND paused_at <= ?3 ORDER BY paused_at,id",
            params![project, provider, now() - min_paused],
        )?
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
        let mut changed = false;
        for id in &ids {
            let a = st.agent(*id)?;
            if !st.procs.contains_key(id)
                && !st.stopping_agents.contains(id)
                && st.held_by(*id)?.is_empty()
                && st.model_no_room(project, provider, &a.model)?.is_none()
            {
                self.resume_locked(st, *id, "acom")?;
                changed = true;
            }
        }
        Ok(changed)
    }

    // ---------- configs ----------

    /// Tell a project's agents its limits or rules changed, if they did.
    fn rules_changed(st: &St, project: i64, old: &Settings) -> R<()> {
        let new = st.settings_for(Some(project));
        if old == &new {
            return Ok(());
        }
        st.cap_lock_ttls(project, new.max_lock_ttl_secs)?;
        let text = format!(
            "The user changed the limits or rules. Now:\n{}",
            st.limits_text(Some(project))?
        );
        for r in rows(
            &st.db,
            "SELECT id FROM agents WHERE project=?1 AND state NOT IN ('closed','crashed','replaced')",
            [project],
        )? {
            st.notice(r["id"].as_i64().unwrap(), &text)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn configs(&self) -> R<Vec<Value>> {
        let st = self.lock();
        let mut v = vec![json!({"id":1,"name":"Default","settings":Settings::default()})];
        v.extend(rows(
            &st.db,
            "SELECT id, name, settings FROM configs ORDER BY id",
            [],
        )?);
        for c in &mut v {
            if let Some(text) = c["settings"].as_str() {
                let settings: Settings = serde_json::from_str(text).unwrap_or_default();
                c["settings"] = serde_json::to_value(settings).unwrap();
            }
            let used = rows(
                &st.db,
                "SELECT id FROM projects WHERE config=?1 AND custom IS NULL ORDER BY id",
                [c["id"].as_i64()],
            )?;
            c["projects"] = json!(used.iter().map(|r| r["id"].clone()).collect::<Vec<_>>());
        }
        Ok(v)
    }

    /// Save settings as a new named config.
    pub fn add_config(&self, name: &str, settings: Settings, by: &str) -> R<i64> {
        settings.check()?;
        let st = self.lock();
        let name = name.trim();
        if name.is_empty() {
            return Err(bad("give the config a name"));
        }
        if name == "Default" {
            return Err(conflict("Default is reserved for the built-in config"));
        }
        let added = st.db.execute(
            "INSERT OR IGNORE INTO configs(name,settings) VALUES(?1,?2)",
            params![name, serde_json::to_string(&settings).unwrap()],
        )?;
        if added == 0 {
            return Err(conflict(format!("there's already a config called {name}")));
        }
        let id = st.db.last_insert_rowid();
        st.log(None, by, &format!("saved config {name}"))?;
        Ok(id)
    }

    /// Change a saved config (and every project using it).
    pub fn put_config(&self, id: i64, name: Option<&str>, settings: Settings, by: &str) -> R<()> {
        if id == 1 {
            return Err(conflict(
                "Default is read-only; save a new config or use Custom",
            ));
        }
        settings.check()?;
        let st = self.lock();
        let old_name: String = st
            .db
            .query_row("SELECT name FROM configs WHERE id=?1", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| not_found(format!("no config {id}")))?;
        let users: Vec<i64> = rows(
            &st.db,
            "SELECT id FROM projects WHERE config=?1 AND custom IS NULL",
            [id],
        )?
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
        let before: Vec<Settings> = users.iter().map(|p| st.settings_for(Some(*p))).collect();
        let name = name
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(&old_name);
        if name == "Default" {
            return Err(conflict("Default is reserved for the built-in config"));
        }
        st.db
            .execute(
                "UPDATE configs SET name=?2, settings=?3 WHERE id=?1",
                params![id, name, serde_json::to_string(&settings).unwrap()],
            )
            .map_err(|_| conflict(format!("there's already a config called {name}")))?;
        st.log(None, by, &format!("changed config {name}"))?;
        for (p, old) in users.iter().zip(&before) {
            Self::rules_changed(&st, *p, old)?;
        }
        Ok(())
    }

    /// Remove a saved config no project uses. Default always stays.
    pub fn remove_config(&self, id: i64, by: &str) -> R<()> {
        let st = self.lock();
        if id == 1 {
            return Err(conflict("the Default config can't be removed"));
        }
        let name: String = st
            .db
            .query_row("SELECT name FROM configs WHERE id=?1", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| not_found(format!("no config {id}")))?;
        let used: i64 = st.db.query_row(
            "SELECT count(*) FROM projects WHERE config=?1 AND custom IS NULL",
            [id],
            |r| r.get(0),
        )?;
        if used > 0 {
            return Err(conflict(format!(
                "{name} is used by {used} project(s); switch them first"
            )));
        }
        st.db.execute("DELETE FROM configs WHERE id=?1", [id])?;
        st.log(None, by, &format!("removed config {name}"))?;
        Ok(())
    }

    /// Make a project use Default, a saved config, or its own custom settings.
    pub fn set_project_config(
        &self,
        project: i64,
        config: Option<i64>,
        custom: Option<Settings>,
        by: &str,
    ) -> R<()> {
        let st = self.lock();
        st.project(project)?;
        let old = st.settings_for(Some(project));
        match (config, custom) {
            (Some(id), None) => {
                let name: String = if id == 1 {
                    "Default".into()
                } else {
                    st.db
                        .query_row("SELECT name FROM configs WHERE id=?1", [id], |r| r.get(0))
                        .optional()?
                        .ok_or_else(|| not_found(format!("no config {id}")))?
                };
                st.db.execute(
                    "UPDATE projects SET config=?2, custom=NULL WHERE id=?1",
                    params![project, id],
                )?;
                st.log(
                    Some(project),
                    by,
                    &format!("project now uses config {name}"),
                )?;
            }
            (None, Some(settings)) => {
                settings.check()?;
                st.db.execute(
                    "UPDATE projects SET config=NULL, custom=?2 WHERE id=?1",
                    params![project, serde_json::to_string(&settings).unwrap()],
                )?;
                st.log(Some(project), by, "changed the project's own settings")?;
            }
            _ => {
                return Err(bad(
                    "give either config (Default or a saved config's id) or custom (settings)",
                ));
            }
        }
        Self::rules_changed(&st, project, &old)
    }

    // ---------- projects ----------

    /// Add a folder as a project, or return it if it already is one.
    pub fn add_project(&self, path: &str, by: &str) -> R<Value> {
        let st = self.lock();
        let p = std::fs::canonicalize(path).map_err(|e| bad(format!("{path}: {e}")))?;
        if !p.is_dir() {
            return Err(bad(format!("{} isn't a folder", p.display())));
        }
        let path = p.to_string_lossy().to_string();
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        let added = st.db.execute(
            "INSERT OR IGNORE INTO projects(path,name,created_at) VALUES(?1,?2,?3)",
            params![path, name, now()],
        )? > 0;
        let id: i64 = st
            .db
            .query_row("SELECT id FROM projects WHERE path=?1", [&path], |r| {
                r.get(0)
            })?;
        if added {
            st.log(Some(id), by, &format!("added project {path}"))?;
        }
        let (name, path) = st.project(id)?;
        Ok(json!({ "id": id, "name": name, "path": path, "added": added }))
    }

    /// The project a folder is in: the closest project folder at or above it.
    pub fn project_at(&self, path: &str) -> R<Value> {
        let st = self.lock();
        let p = std::fs::canonicalize(path).map_err(|e| bad(format!("{path}: {e}")))?;
        let mut dir = Some(p.as_path());
        while let Some(d) = dir {
            let found = rows(
                &st.db,
                "SELECT id, name, path FROM projects WHERE path=?1",
                [d.to_string_lossy()],
            )?;
            if let Some(v) = found.into_iter().next() {
                return Ok(v);
            }
            dir = d.parent();
        }
        Err(not_found(format!(
            "{} isn't in an acom project; add it with `acom project add`",
            p.display()
        )))
    }

    #[cfg(test)]
    pub fn projects(&self) -> R<Vec<Value>> {
        let st = self.lock();
        rows(
            &st.db,
            "SELECT p.id, p.name, p.path,
                    CASE WHEN p.custom IS NULL THEN p.config END config,
                    CASE WHEN p.custom IS NOT NULL THEN 'Custom' WHEN p.config=1 THEN 'Default' ELSE c.name END config_name,
                    (SELECT count(*) FROM agents a WHERE a.project=p.id) agents,
                    (SELECT count(*) FROM agents a WHERE a.project=p.id AND a.state IN ('working','idle')) active,
                    (SELECT count(*) FROM threads t JOIN members b ON b.thread_id=t.id AND b.agent_id=0
                     JOIN messages m ON m.thread_id=t.id LEFT JOIN user_reads r ON r.thread_id=t.id
                     WHERE t.project=p.id AND m.sender<>0 AND m.id>coalesce(r.message_id,0)
                       AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=0
                         AND m.id>i.start_after AND (i.end_after IS NULL OR m.id<=i.end_after))) unread
             FROM projects p LEFT JOIN configs c ON c.id=p.config ORDER BY p.name, p.id",
            [],
        )
    }

    /// Remove a project that never had agents (e.g. one added by mistake).
    pub fn remove_project(&self, id: i64, by: &str) -> R<()> {
        let mut st = self.lock();
        let (_, path) = st.project(id)?;
        let n: i64 =
            st.db
                .query_row("SELECT count(*) FROM agents WHERE project=?1", [id], |r| {
                    r.get(0)
                })?;
        if n > 0 {
            return Err(conflict(format!(
                "{path} has agents, so it stays; only a project without agents can be removed"
            )));
        }
        st.atomic(|st| {
            for sql in [
                "DELETE FROM marks WHERE message_id IN (SELECT m.id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE t.project=?1)",
                "DELETE FROM members WHERE thread_id IN (SELECT id FROM threads WHERE project=?1)",
                "DELETE FROM member_intervals WHERE thread_id IN (SELECT id FROM threads WHERE project=?1)",
                "DELETE FROM user_reads WHERE thread_id IN (SELECT id FROM threads WHERE project=?1)",
                "DELETE FROM thread_filters WHERE thread_id IN (SELECT id FROM threads WHERE project=?1)",
                "DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE project=?1)",
                "DELETE FROM threads WHERE project=?1",
                "DELETE FROM locks WHERE project=?1",
                "DELETE FROM events WHERE project=?1",
                "DELETE FROM activity WHERE project=?1",
                "DELETE FROM projects WHERE id=?1",
            ] { st.db.execute(sql,[id])?; }
            st.log(None,by,&format!("removed project {path}"))?;
            Ok(())
        })
    }

    // ---------- bounded views ----------

    fn view_revision(&self, st: &St, tables: &[&str], scope: &str) -> R<String> {
        let mut parts = vec![self.home.to_string_lossy().into_owned(), scope.to_string()];
        for name in std::iter::once(&"epoch").chain(tables.iter()) {
            let value: i64 = st.db.query_row(
                "SELECT value FROM view_revisions WHERE name=?1",
                [name],
                |r| r.get(0),
            )?;
            parts.push(format!("{name}:{value}"));
        }
        Ok(fingerprint(parts))
    }

    #[allow(clippy::too_many_arguments)] // SQL bindings and snapshot scope stay explicit.
    fn select_page(
        &self,
        st: &St,
        q: &PageQuery,
        tables: &[&str],
        scope: &str,
        sql: &str,
        args: &[rusqlite::types::Value],
        snapshot: bool,
    ) -> R<SelectedPage> {
        q.validate()?;
        let revision = self.view_revision(st, tables, scope)?;
        let unchanged = if snapshot {
            q.snapshot(&revision)?
        } else {
            q.since
                .as_deref()
                .filter(|v| *v == revision)
                .map(|_| json!({"unchanged":true,"revision":revision}))
        };
        if let Some(value) = unchanged {
            return Ok(SelectedPage {
                unchanged: Some(value),
                items: vec![],
                through: 0,
                total: 0,
                revision,
            });
        }
        let ceiling = q
            .through
            .map(|id| format!("WHERE id<={id}"))
            .unwrap_or_default();
        let (latest, total): (i64, i64) = st.db.query_row(
            &format!("SELECT coalesce(max(id),0),count(*) FROM ({sql}) {ceiling}"),
            rusqlite::params_from_iter(args),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let through = q.through.unwrap_or(latest);
        let before = q
            .before
            .map(|id| format!(" AND id<{id}"))
            .unwrap_or_default();
        let after = q
            .after
            .map(|id| format!(" AND id>{id}"))
            .unwrap_or_default();
        let order = if q.ascending() { "ASC" } else { "DESC" };
        let items = rows(
            &st.db,
            &format!(
                "SELECT * FROM ({sql}) WHERE id<={through}{before}{after} ORDER BY id {order} LIMIT {}",
                q.limit + 1
            ),
            rusqlite::params_from_iter(args),
        )?;
        Ok(SelectedPage {
            unchanged: None,
            items,
            through,
            total,
            revision,
        })
    }

    fn project_sql() -> &'static str {
        "SELECT p.id,p.name,p.path,CASE WHEN p.custom IS NULL THEN p.config END config,
          CASE WHEN p.custom IS NOT NULL THEN 'Custom' WHEN p.config=1 THEN 'Default' ELSE c.name END config_name,
          (SELECT count(*) FROM agents a WHERE a.project=p.id) agents,
          (SELECT count(*) FROM agents a WHERE a.project=p.id AND a.state IN ('working','idle')) active,
          (SELECT count(*) FROM threads t JOIN members b ON b.thread_id=t.id AND b.agent_id=0 JOIN messages m ON m.thread_id=t.id
           LEFT JOIN user_reads r ON r.thread_id=t.id WHERE t.project=p.id AND m.sender<>0 AND m.id>coalesce(r.message_id,0)
           AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=0 AND m.id>i.start_after
             AND (i.end_after IS NULL OR m.id<=i.end_after))) unread
         FROM projects p LEFT JOIN configs c ON c.id=p.config"
    }

    pub fn project_view(&self, id: i64) -> R<Value> {
        rows(
            &self.lock().db,
            &format!("{} WHERE p.id=?1", Self::project_sql()),
            [id],
        )?
        .pop()
        .ok_or_else(|| not_found(format!("no project {id}")))
    }

    pub fn projects_page(&self, q: PageQuery) -> R<Value> {
        let st = self.lock();
        self.select_page(
            &st,
            &q,
            &[
                "projects",
                "configs",
                "agents",
                "threads",
                "messages",
                "members",
                "member_intervals",
                "user_reads",
            ],
            "projects",
            Self::project_sql(),
            &[],
            true,
        )?
        .finish(&q)
    }

    pub fn agents_page(&self, project: Option<i64>, group: Option<&str>, q: PageQuery) -> R<Value> {
        let st = self.lock();
        let sql="SELECT id,project,name,grp \"group\",harness,model,effort,state,status_text status,substr(task,1,400) task_preview,
          substr(problem,1,400) problem_preview,problem IS NOT NULL has_problem,
          (lower(problem) LIKE '%model%not supported%' OR lower(problem) LIKE '%model%not available%'
           OR lower(problem) LIKE '%model%not found%' OR lower(problem) LIKE '%not supported%account%') model_unavailable,launched_by,launched_at,
          pause_reason,paused_at,done_req,context,fresh_in,cache_write,cache_read,output,turns,ended_at,wake_queued_at,wake_why wake_reason
          FROM agents WHERE (?1 IS NULL OR project=?1) AND (?2 IS NULL OR grp=?2)";
        let mut page = self.select_page(
            &st,
            &q,
            &[
                "agents",
                "locks",
                "agent_handoffs",
                "agent_starts",
                "events",
            ],
            &format!("agents:{project:?}:{group:?}"),
            sql,
            &[project.into(), group.map(str::to_string).into()],
            true,
        )?;
        for item in &mut page.items {
            item["locks"] = json!(st.held_by(item["id"].as_i64().unwrap())?);
            Self::replacement_fields(&st, item)?;
        }
        page.finish(&q)
    }

    pub fn threads_page(&self, project: Option<i64>, agent: Option<i64>, q: PageQuery) -> R<Value> {
        let st = self.lock();
        let sql="SELECT t.id,t.project,t.title,t.created_by,t.created_at,
          (SELECT count(*) FROM messages m WHERE m.thread_id=t.id) messages,
          (SELECT max(at) FROM messages m WHERE m.thread_id=t.id) last_at
          FROM threads t WHERE (?1 IS NULL OR t.project=?1) AND (?2 IS NULL OR EXISTS(SELECT 1 FROM members b WHERE b.thread_id=t.id AND b.agent_id=?2))";
        let mut page = self.select_page(
            &st,
            &q,
            &[
                "threads",
                "messages",
                "members",
                "thread_filters",
                "user_reads",
                "member_intervals",
            ],
            &format!("threads:{project:?}:{agent:?}"),
            sql,
            &[project.into(), agent.into()],
            true,
        )?;
        for item in &mut page.items {
            let tid = item["id"].as_i64().unwrap();
            item["unread"] = json!(Self::user_unread(&st, tid)?);
            let ids = rows(
                &st.db,
                "SELECT agent_id id FROM members WHERE thread_id=?1 ORDER BY agent_id",
                [tid],
            )?;
            item["members"] = json!(ids.iter().map(|v| v["id"].clone()).collect::<Vec<_>>());
            item["user_member"] = json!(ids.iter().any(|v| v["id"] == 0));
            item["watch"] = Self::thread_watch(&st, tid)?;
        }
        page.finish(&q)
    }

    fn lock_sql() -> &'static str {
        "SELECT l.rowid id,l.project,l.name,l.about,l.holder,a.name holder_name,a.state holder_state,
         l.acquired_at,l.expires_at FROM locks l LEFT JOIN agents a ON a.id=l.holder"
    }

    fn attach_queue(st: &St, item: &mut Value) {
        let key = (
            item["project"].as_i64().unwrap(),
            item["name"].as_str().unwrap().to_string(),
        );
        item["queue"] = json!(st.queues.get(&key).cloned().unwrap_or_default());
        item["holder_stopping"] = json!(
            item["holder"]
                .as_i64()
                .is_some_and(|id| st.stopping_agents.contains(&id)
                    || st.procs.get(&id).is_some_and(|p| p.stopping))
        );
    }

    pub fn lock_view(&self, id: i64, project: Option<i64>) -> R<Value> {
        let st = self.lock();
        let mut item = rows(
            &st.db,
            &format!(
                "{} WHERE l.rowid=?1 AND (?2 IS NULL OR l.project=?2)",
                Self::lock_sql()
            ),
            params![id, project],
        )?
        .pop()
        .ok_or_else(|| not_found(format!("no lock {id}")))?;
        Self::attach_queue(&st, &mut item);
        Ok(item)
    }

    pub fn locks_page(&self, project: Option<i64>, q: PageQuery) -> R<Value> {
        let st = self.lock();
        let mut page = self.select_page(
            &st,
            &q,
            &["locks", "agents"],
            &format!(
                "locks:{project:?}:{}",
                fingerprint(format!("{:?}", st.queues))
            ),
            &format!("{} WHERE ?1 IS NULL OR l.project=?1", Self::lock_sql()),
            &[project.into()],
            true,
        )?;
        for item in &mut page.items {
            Self::attach_queue(&st, item);
        }
        page.finish(&q)
    }

    fn config_locked(st: &St, id: i64) -> R<Value> {
        let mut c = if id == 1 {
            json!({"id":1,"name":"Default","settings":Settings::default()})
        } else {
            let mut c = rows(
                &st.db,
                "SELECT id,name,settings FROM configs WHERE id=?1",
                [id],
            )?
            .pop()
            .ok_or_else(|| not_found(format!("no config {id}")))?;
            c["settings"] = serde_json::from_str(c["settings"].as_str().unwrap())
                .map_err(|_| bad("invalid saved settings"))?;
            c
        };
        c["projects"] = json!(
            rows(
                &st.db,
                "SELECT id FROM projects WHERE config=?1 AND custom IS NULL ORDER BY id",
                [id]
            )?
            .iter()
            .map(|r| r["id"].clone())
            .collect::<Vec<_>>()
        );
        Ok(c)
    }

    pub fn config_view(&self, id: i64) -> R<Value> {
        Self::config_locked(&self.lock(), id)
    }

    pub fn configs_page(&self, q: PageQuery) -> R<Value> {
        let st = self.lock();
        let sql = "SELECT 1 id,'Default' name UNION ALL SELECT id,name FROM configs";
        let mut page =
            self.select_page(&st, &q, &["configs", "projects"], "configs", sql, &[], true)?;
        for item in &mut page.items {
            *item = Self::config_locked(&st, item["id"].as_i64().unwrap())?;
        }
        page.finish(&q)
    }

    pub fn activity_page(&self, project: Option<i64>, q: PageQuery) -> R<Value> {
        let st = self.lock();
        let mut page = self.select_page(
            &st,
            &q,
            &["activity"],
            &format!("activity:{project:?}"),
            "SELECT id,project,at,actor,CASE WHEN length(CAST(what AS BLOB))>?2 THEN NULL ELSE what END what,
             length(CAST(what AS BLOB))>?2 truncated FROM activity WHERE ?1 IS NULL OR project IS NULL OR project=?1",
            &[project.into(), q.max_bytes.into()],
            false,
        )?;
        for item in &mut page.items {
            if item["truncated"] == 0 {
                item.as_object_mut().unwrap().remove("truncated");
            } else {
                item["truncated"] = json!(true);
            }
        }
        page.finish(&q)
    }

    pub fn activity_view(&self, id: i64, project: Option<i64>) -> R<Value> {
        rows(&self.lock().db,"SELECT id,project,at,actor,what FROM activity WHERE id=?1 AND (?2 IS NULL OR project IS NULL OR project=?2)",params![id,project])?.pop().ok_or_else(||not_found(format!("no activity {id}")))
    }

    pub fn notices_page(&self, agent: i64, q: PageQuery) -> R<Value> {
        let st = self.lock();
        st.agent(agent)?;
        let mut page = self.select_page(
            &st,
            &q,
            &["notices"],
            &format!("notices:{agent}"),
            "SELECT id,CASE WHEN length(CAST(text AS BLOB))>?2 THEN NULL ELSE text END text,
             shown,length(CAST(text AS BLOB))>?2 truncated FROM notices WHERE agent_id=?1",
            &[agent.into(), q.max_bytes.into()],
            false,
        )?;
        for item in &mut page.items {
            if item["truncated"] == 0 {
                item.as_object_mut().unwrap().remove("truncated");
            } else {
                item["truncated"] = json!(true);
            }
        }
        page.finish(&q)
    }

    pub fn notice_view(&self, agent: i64, id: i64) -> R<Value> {
        let st = self.lock();
        st.agent(agent)?;
        rows(
            &st.db,
            "SELECT id,text,shown FROM notices WHERE agent_id=?1 AND id=?2",
            params![agent, id],
        )?
        .pop()
        .ok_or_else(|| not_found(format!("no notice {id} for agent {agent}")))
    }

    pub fn receipt_view(&self, id: i64, agent: Option<i64>) -> R<Value> {
        let st = self.lock();
        let project = agent
            .filter(|a| *a > 0)
            .map(|a| st.agent(a).map(|a| a.project))
            .transpose()?;
        Self::event_rows(&st,"SELECT * FROM events WHERE id=?1 AND kind='command.receipt' AND (?2 IS NULL OR project=?2)",params![id,project])?.pop().ok_or_else(||not_found(format!("no receipt {id}")))
    }

    /// A large mutation result is retained, not truncated into a receipt that
    /// encourages replaying a successful command. Only reads retrieve details.
    pub fn compact_receipt(
        &self,
        value: Value,
        agent: Option<i64>,
        project: Option<i64>,
        thread: Option<i64>,
    ) -> Value {
        if value.to_string().len() <= 16000 {
            return value;
        }
        let st = self.lock();
        let project = project
            .or_else(|| {
                agent
                    .filter(|a| *a > 0)
                    .and_then(|a| st.agent(a).ok().map(|a| a.project))
            })
            .or_else(|| thread.and_then(|t| Self::thread_project(&st, t).ok()));
        let mut result = json!({"result_truncated":true,"counts":{}});
        for (key, item) in value.as_object().into_iter().flatten() {
            if let Some(items) = item.as_array() {
                result["counts"][key] = json!(items.len());
                // Samples are explicit; complete warnings and recipient results
                // remain in the immutable event, even if one item alone is huge.
                let mut sample = Vec::new();
                for item in items.iter().take(10) {
                    sample.push(item.clone());
                    if json!(sample).to_string().len() > 1024 {
                        sample.pop();
                        break;
                    }
                }
                result[key] = json!(sample);
            } else if item.to_string().len() < 1024 {
                result[key] = item.clone();
            }
        }
        let global = project.is_none();
        let project = project.or_else(|| {
            st.db
                .query_row("SELECT id FROM projects ORDER BY id LIMIT 1", [], |r| {
                    r.get(0)
                })
                .ok()
        });
        let stored = project
            .ok_or_else(|| bad("receipt project unavailable"))
            .and_then(|p| {
                st.event(
                    p,
                    agent,
                    thread,
                    "command.receipt",
                    &who(agent.unwrap_or(0)),
                    json!({"response":value,"global":global}),
                )?;
                Ok(st.db.last_insert_rowid())
            });
        match stored {
            Ok(id) => result["receipt_event"] = json!(id),
            Err(error) => {
                result["receipt_error"] = json!(format!(
                    "Action completed, but its full receipt could not be saved: {}. Inspect current state before any retry.",
                    error.1.chars().take(300).collect::<String>()
                ))
            }
        }
        result
    }

    pub fn overview(&self, project: Option<i64>, since: Option<&str>) -> R<Value> {
        let st = self.lock();
        let current = if let Some(id) = project {
            rows(
                &st.db,
                &format!("{} WHERE p.id=?1", Self::project_sql()),
                [id],
            )?
            .pop()
        } else {
            None
        };
        let current = match current {
            Some(p) => Some(p),
            None => rows(
                &st.db,
                &format!("{} ORDER BY p.name,p.id LIMIT 1", Self::project_sql()),
                [],
            )?
            .pop(),
        };
        let pid = current.as_ref().and_then(|p| p["id"].as_i64());
        let mut revisions = serde_json::Map::new();
        for (name, tables) in [
            (
                "projects",
                vec![
                    "projects",
                    "configs",
                    "agents",
                    "threads",
                    "messages",
                    "members",
                    "member_intervals",
                    "user_reads",
                ],
            ),
            ("configs", vec!["configs", "projects"]),
            ("settings", vec!["configs", "projects"]),
            (
                "agents",
                vec![
                    "agents",
                    "locks",
                    "agent_handoffs",
                    "agent_starts",
                    "events",
                ],
            ),
            (
                "threads",
                vec![
                    "threads",
                    "messages",
                    "members",
                    "thread_filters",
                    "user_reads",
                    "member_intervals",
                ],
            ),
            ("locks", vec!["locks", "agents"]),
            ("activity", vec!["activity"]),
        ] {
            let scope = match name {
                "projects" | "configs" => name.to_string(),
                "agents" => format!("agents:{pid:?}:None"),
                "threads" => format!("threads:{pid:?}:None"),
                "locks" => format!("locks:{pid:?}:{}", fingerprint(format!("{:?}", st.queues))),
                "activity" => format!("activity:{pid:?}"),
                _ => format!("{name}:{pid:?}"),
            };
            revisions.insert(
                name.into(),
                json!(self.view_revision(&st, &tables, &scope)?),
            );
        }
        let revision = self.view_revision(
            &st,
            &[
                "projects",
                "configs",
                "agents",
                "threads",
                "messages",
                "members",
                "member_intervals",
                "user_reads",
                "locks",
                "activity",
                "usage",
                "usage_checks",
                "agent_handoffs",
                "agent_starts",
            ],
            &format!(
                "overview:{project:?}:{}",
                fingerprint(format!("{:?}", st.queues))
            ),
        )?;
        if since == Some(revision.as_str()) {
            return Ok(json!({"unchanged":true,"revision":revision}));
        }
        let unread_total:i64=st.db.query_row("SELECT count(*) FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=0 LEFT JOIN user_reads r ON r.thread_id=m.thread_id WHERE m.sender<>0 AND m.id>coalesce(r.message_id,0) AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=0 AND m.id>i.start_after AND (i.end_after IS NULL OR m.id<=i.end_after))",[],|r|r.get(0))?;
        let s = st.settings_for(pid);
        let restart_paused: i64 = st.db.query_row(
            "SELECT count(*) FROM agents WHERE state='paused' AND pause_reason='restart'",
            [],
            |r| r.get(0),
        )?;
        let (total, per) = st.active_counts(pid)?;
        let limits = json!({"limits":s.limits,"active":{"total":total,"per_harness":per},"usage":rows(&st.db,"SELECT provider,win,used_pct,resets_at,at FROM usage ORDER BY provider,win",[])?,"checks":rows(&st.db,"SELECT provider,checked_at,attempted_at,next_check,error FROM usage_checks ORDER BY provider",[])?,"text":st.limits_text(pid)?});
        Ok(
            json!({"url":self.url,"project":current,"unread_total":unread_total,"restart_paused":restart_paused,"limits":limits,"revisions":revisions,"revision":revision}),
        )
    }

    pub fn thread_page(&self, tid: i64, agent: Option<i64>, mut q: PageQuery) -> R<Value> {
        q.validate()?;
        let st = self.lock();
        let project = Self::thread_project(&st, tid)?;
        let actor = agent.unwrap_or(0);
        if actor > 0 && st.agent(actor)?.project != project {
            return Err(bad("thread is in another project"));
        }
        let mut t = rows(
            &st.db,
            "SELECT id,project,title,created_by,created_at FROM threads WHERE id=?1",
            [tid],
        )?
        .remove(0);
        t["members"] = json!(
            rows(
                &st.db,
                "SELECT agent_id id FROM members WHERE thread_id=?1 ORDER BY agent_id",
                [tid]
            )?
            .iter()
            .map(|v| v["id"].clone())
            .collect::<Vec<_>>()
        );
        t["watch"] = Self::thread_watch(&st, tid)?;
        let read = Self::user_read_cursor(&st, tid)?;
        let latest: i64 = st.db.query_row(
            "SELECT coalesce(max(id),0) FROM messages WHERE thread_id=?1",
            [tid],
            |r| r.get(0),
        )?;
        t["latest_message"] = json!(latest);
        t["last_read"] = json!(read);
        t["unread"] = json!(Self::user_unread(&st, tid)?);
        let first_unread: Option<i64> = if actor == 0 {
            st.db.query_row("SELECT min(m.id) FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=0 WHERE m.thread_id=?1 AND m.sender<>0 AND m.id>?2 AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=0 AND m.id>i.start_after AND (i.end_after IS NULL OR m.id<=i.end_after))",params![tid,read],|r|r.get(0))?
        } else {
            None
        };
        let catchup = q.before.is_none() && q.after.is_none() && first_unread.is_some();
        let since = q.since.take();
        if catchup {
            q.after = Some(first_unread.unwrap() - 1);
        }
        let sql = format!(
            "SELECT id,thread_id thread,sender,at,CASE WHEN length(CAST(text AS BLOB))>{} THEN NULL ELSE text END text,length(CAST(text AS BLOB))>{} truncated FROM messages WHERE thread_id=?1",
            q.max_bytes, q.max_bytes
        );
        let mut page = self.select_page(
            &st,
            &q,
            &[
                "messages",
                "members",
                "member_intervals",
                "user_reads",
                "marks",
            ],
            &format!("messages:{tid}:{actor}"),
            &sql,
            &[tid.into()],
            false,
        )?;
        if since.as_deref() == Some(page.revision.as_str()) {
            page.unchanged = Some(json!({"unchanged":true,"revision":page.revision}));
            page.items.clear();
        }
        for item in &mut page.items {
            if item["truncated"] == 0 {
                item.as_object_mut().unwrap().remove("truncated");
            } else {
                item["truncated"] = json!(true);
            }
            Self::message_context(&st, item, Some(actor))?;
        }
        t["messages"] = page.finish(&q)?;
        t["catchup"] = json!(catchup);
        let mut events = Self::event_rows(
            &st,
            "SELECT * FROM events WHERE thread=?1 AND kind IN ('thread.joined','thread.left') ORDER BY id DESC LIMIT 51",
            [tid],
        )?;
        t["events_more"] = json!(events.len() > 50);
        events.truncate(50);
        events.reverse();
        t["events"] = json!(events);
        Ok(t)
    }

    pub fn messages_page(&self, tid: i64, agent: Option<i64>, q: PageQuery) -> R<Value> {
        q.validate()?;
        let st = self.lock();
        let project = Self::thread_project(&st, tid)?;
        let actor = agent.unwrap_or(0);
        if actor > 0 && st.agent(actor)?.project != project {
            return Err(bad("thread is in another project"));
        }
        let sql = format!(
            "SELECT id,thread_id thread,sender,at,CASE WHEN length(CAST(text AS BLOB))>{} THEN NULL ELSE text END text,length(CAST(text AS BLOB))>{} truncated FROM messages WHERE thread_id=?1",
            q.max_bytes, q.max_bytes
        );
        let mut page = self.select_page(
            &st,
            &q,
            &[
                "messages",
                "members",
                "member_intervals",
                "user_reads",
                "marks",
            ],
            &format!("messages:{tid}:{actor}"),
            &sql,
            &[tid.into()],
            false,
        )?;
        for item in &mut page.items {
            if item["truncated"] == 0 {
                item.as_object_mut().unwrap().remove("truncated");
            } else {
                item["truncated"] = json!(true);
            }
            Self::message_context(&st, item, Some(actor))?;
        }
        page.finish(&q)
    }

    pub fn thread_metadata(&self, tid: i64, agent: Option<i64>) -> R<Value> {
        let st = self.lock();
        let project = Self::thread_project(&st, tid)?;
        if let Some(a) = agent.filter(|a| *a > 0)
            && st.agent(a)?.project != project
        {
            return Err(bad("thread is in another project"));
        }
        let mut t = rows(
            &st.db,
            "SELECT id,project,title,created_by,created_at FROM threads WHERE id=?1",
            [tid],
        )?
        .remove(0);
        t["members"] = json!(
            rows(
                &st.db,
                "SELECT agent_id id FROM members WHERE thread_id=?1 ORDER BY agent_id",
                [tid]
            )?
            .iter()
            .map(|v| v["id"].clone())
            .collect::<Vec<_>>()
        );
        t["watch"] = Self::thread_watch(&st, tid)?;
        let mut events = Self::event_rows(
            &st,
            "SELECT * FROM events WHERE thread=?1 AND kind IN ('thread.joined','thread.left') ORDER BY id DESC LIMIT 51",
            [tid],
        )?;
        t["events_more"] = json!(events.len() > 50);
        events.truncate(50);
        events.reverse();
        t["events"] = json!(events);
        let read = Self::user_read_cursor(&st, tid)?;
        t["last_read"] = json!(read);
        t["unread"] = json!(Self::user_unread(&st, tid)?);
        t["latest_message"] = json!(st.db.query_row(
            "SELECT coalesce(max(id),0) FROM messages WHERE thread_id=?1",
            [tid],
            |r| r.get::<_, i64>(0)
        )?);
        t["first_unread"]=json!(st.db.query_row("SELECT min(m.id) FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=0 WHERE m.thread_id=?1 AND m.sender<>0 AND m.id>?2 AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=0 AND m.id>i.start_after AND (i.end_after IS NULL OR m.id<=i.end_after))",params![tid,read],|r|r.get::<_,Option<i64>>(0))?);
        Ok(t)
    }

    pub fn inbox_page(&self, agent: i64, mark: &str, mut q: PageQuery) -> R<Value> {
        q.validate()?;
        let st = self.lock();
        st.agent(agent)?;
        let mark = parse_mark(mark)?;
        let revision = self.view_revision(
            &st,
            &["messages", "marks", "member_intervals"],
            &format!("inbox:{agent}:{mark}"),
        )?;
        if let Some(unchanged) = q.snapshot(&revision)? {
            return Ok(unchanged);
        }
        q.since = None;
        // Inbox starts at the oldest item so a bounded default cannot hide an
        // earlier outstanding task. Zero is an internal initial cursor only.
        if q.before.is_none() && q.after.is_none() {
            q.after = Some(0);
        }
        let sql=format!("SELECT m.id,m.thread_id thread,t.title,m.sender,m.at,coalesce(k.mark,'new') mark,
            CASE WHEN length(CAST(m.text AS BLOB))>{} THEN NULL ELSE m.text END text,length(CAST(m.text AS BLOB))>{} truncated
            FROM messages m JOIN threads t ON t.id=m.thread_id LEFT JOIN marks k ON k.agent_id=?1 AND k.message_id=m.id
            WHERE EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=?1)
              AND m.sender<>?1 AND coalesce(k.mark,'new')=?2",q.max_bytes,q.max_bytes);
        let mut page = self.select_page(
            &st,
            &q,
            &["messages", "marks", "member_intervals"],
            &format!("inbox:{agent}:{mark}"),
            &sql,
            &[agent.into(), mark.to_string().into()],
            true,
        )?;
        for item in &mut page.items {
            if item["truncated"] == 0 {
                item.as_object_mut().unwrap().remove("truncated");
            } else {
                item["truncated"] = json!(true);
            }
            Self::message_context(&st, item, Some(agent))?;
        }
        let result = page.finish(&q)?;
        if mark == "new" {
            let delivered: Vec<&Value> = result["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|m| m["truncated"] != true && m["outside_membership"] != true)
                .collect();
            let ids = delivered
                .iter()
                .map(|m| m["id"].as_i64().unwrap().to_string())
                .collect::<Vec<_>>()
                .join(",");
            if !ids.is_empty() {
                let mut throughs = BTreeMap::new();
                for m in delivered {
                    let mid = m["id"].as_i64().unwrap();
                    let tid = m["thread"].as_i64().unwrap();
                    throughs
                        .entry(tid)
                        .and_modify(|v: &mut i64| *v = (*v).max(mid))
                        .or_insert(mid);
                }
                for (tid, through) in throughs {
                    let gap:Option<i64>=st.db.query_row(&format!("SELECT min(m.id) FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=?1 WHERE m.thread_id=?2 AND m.sender<>?1 AND m.id>b.last_notified AND m.id<=?3 AND m.id NOT IN ({ids}) AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=?1 AND m.id>i.start_after AND (i.end_after IS NULL OR m.id<=i.end_after))"),params![agent,tid,through],|r|r.get(0))?;
                    st.db.execute("UPDATE members SET last_notified=max(last_notified,?3) WHERE agent_id=?1 AND thread_id=?2",params![agent,tid,gap.map_or(through,|id|id-1)])?;
                }
            }
        }
        Ok(result)
    }

    // ---------- views ----------

    #[cfg(test)]
    pub fn agents(&self, project: Option<i64>, group: Option<&str>) -> R<Vec<Value>> {
        let st = self.lock();
        Self::agents_locked(&st, project, group)
    }

    #[cfg(test)]
    fn agents_locked(st: &St, project: Option<i64>, group: Option<&str>) -> R<Vec<Value>> {
        let mut v = rows(
            &st.db,
            "SELECT id, project, name, grp \"group\", task, harness, model, effort, state, status_text status,
                    session_id session, launched_by, launched_at, pause_reason, paused_at, done_req, context,
                    fresh_in, cache_write, cache_read, output, turns, ended_at, wake_queued_at,
                    wake_why wake_reason, problem
             FROM agents WHERE (?1 IS NULL OR project=?1) AND (?2 IS NULL OR grp=?2) ORDER BY id",
            params![project, group],
        )?;
        for a in &mut v {
            let id = a["id"].as_i64().unwrap();
            a["locks"] = json!(st.held_by(id)?);
        }
        Ok(v)
    }

    #[cfg(test)]
    pub fn agent_view(&self, id: i64) -> R<Value> {
        self.agent_view_for(id, None)
    }

    pub fn agent_view_for(&self, id: i64, agent: Option<i64>) -> R<Value> {
        let st = self.lock();
        let project = st.agent(id)?.project;
        if let Some(a) = agent.filter(|a| *a > 0)
            && st.agent(a)?.project != project
        {
            return Err(bad("agent is in another project"));
        }
        let mut a = rows(&st.db,"SELECT id,project,name,grp \"group\",task,harness,model,effort,state,status_text status,
            session_id session,launched_by,launched_at,pause_reason,paused_at,done_req,context,fresh_in,cache_write,cache_read,output,
            turns,ended_at,wake_queued_at,wake_why wake_reason,problem FROM agents WHERE id=?1",[id])?.remove(0);
        a["locks"] = json!(st.held_by(id)?);
        let (name, path) = st.project(project)?;
        a["project_name"] = json!(name);
        a["project_path"] = json!(path);
        a["conversation_history"] =
            json!(
                a["session"]
                    .as_str()
                    .and_then(|session| crate::harness::history_file(
                        a["harness"].as_str().unwrap(),
                        session
                    ))
            );
        a["output_log"] = json!(crate::run::log_path(self, id, "jsonl"));
        a["running_configuration"] = json!(
            st.procs
                .get(&id)
                .map(|p| json!({"model":p.model,"effort":p.effort}))
        );
        a["retry"] = json!(
            rows(
                &st.db,
                "SELECT source,effort,same_model_attempts,eligible_at,handled,replacement,blocked FROM agent_retries WHERE agent_id=?1",
                [id]
            )?
            .pop()
        );
        a["continuation"] = json!(
            rows(
                &st.db,
                "SELECT text,CASE WHEN attempted=1 THEN 'Start attempt interrupted; waiting to save cancellation' ELSE blocked END blocked FROM agent_continuations WHERE agent_id=?1",
                [id]
            )?
            .pop()
        );
        Self::replacement_fields(&st, &mut a)?;
        a["limits"] = json!(st.limits_text(Some(project))?);
        a["threads"] = json!(rows(
            &st.db,
            "SELECT t.id,t.title FROM threads t JOIN members b ON b.thread_id=t.id WHERE b.agent_id=?1 ORDER BY t.id",
            [id]
        )?);
        a["lost_locks"] = json!(rows(
            &st.db,
            "SELECT at, text FROM notices WHERE agent_id=?1 AND text LIKE 'You no longer hold lock %' ORDER BY id DESC LIMIT 20",
            [id],
        )?);
        Ok(a)
    }

    fn replacement_fields(st: &St, a: &mut Value) -> R<()> {
        let id = a["id"].as_i64().unwrap();
        a["stopping"] = json!(
            st.stopping_agents.contains(&id) || st.procs.get(&id).is_some_and(|p| p.stopping)
        );
        a["replacement_request"]=json!(rows(&st.db,"SELECT json_extract(request,'$.harness') harness,json_extract(request,'$.model') model,blocked FROM agent_handoffs WHERE agent_id=?1",[id])?.pop());
        a["replacement_start"]=json!(rows(&st.db,"SELECT predecessor,attempted,CASE WHEN attempted=1 THEN coalesce(blocked,'Startup attempt interrupted; waiting to record failure') ELSE blocked END blocked FROM agent_starts WHERE agent_id=?1",[id])?.pop());
        a["replacement"]=json!(rows(&st.db,"SELECT json_extract(details,'$.replacement') id FROM events WHERE agent=?1 AND kind='agent.replaced' ORDER BY id DESC LIMIT 1",[id])?.pop().map(|v|v["id"].clone()));
        a["replacement_pending"] = json!(!a["replacement_request"].is_null());
        a["replacement_start_pending"] = json!(!a["replacement_start"].is_null());
        Ok(())
    }

    #[cfg(test)]
    pub fn threads(&self, project: Option<i64>, agent: Option<i64>) -> R<Vec<Value>> {
        let st = self.lock();
        let mut v = rows(
            &st.db,
            "SELECT t.id, t.project, t.title, t.created_by, t.created_at,
                    (SELECT count(*) FROM messages m WHERE m.thread_id=t.id) messages,
                    (SELECT max(at) FROM messages m WHERE m.thread_id=t.id) last_at
             FROM threads t
             WHERE (?1 IS NULL OR t.project=?1)
               AND (?2 IS NULL OR EXISTS (SELECT 1 FROM members b WHERE b.thread_id=t.id AND b.agent_id=?2))
             ORDER BY coalesce(last_at, t.created_at) DESC",
            params![project, agent],
        )?;
        for t in &mut v {
            t["unread"] = json!(Self::user_unread(&st, t["id"].as_i64().unwrap())?);
            let ids = rows(
                &st.db,
                "SELECT agent_id a FROM members WHERE thread_id=?1 ORDER BY agent_id",
                [t["id"].as_i64()],
            )?;
            t["members"] = json!(ids.iter().map(|r| r["a"].clone()).collect::<Vec<_>>());
            t["watch"] = Self::thread_watch(&st, t["id"].as_i64().unwrap())?;
        }
        Ok(v)
    }

    #[cfg(test)]
    pub fn thread(&self, tid: i64) -> R<Value> {
        self.thread_for(tid, Some(0))
    }

    #[cfg(test)]
    pub fn thread_for(&self, tid: i64, agent: Option<i64>) -> R<Value> {
        let st = self.lock();
        let project = Self::thread_project(&st, tid)?;
        if let Some(a) = agent.filter(|a| *a > 0)
            && st.agent(a)?.project != project
        {
            return Err(bad("thread is in another project"));
        }
        let mut t = rows(
            &st.db,
            "SELECT id, project, title, created_by, created_at FROM threads WHERE id=?1",
            [tid],
        )?
        .remove(0);
        let ids = rows(
            &st.db,
            "SELECT agent_id a FROM members WHERE thread_id=?1 ORDER BY agent_id",
            [tid],
        )?;
        t["members"] = json!(ids.iter().map(|r| r["a"].clone()).collect::<Vec<_>>());
        let mut messages = rows(
            &st.db,
            "SELECT id,thread_id thread, sender, text, at FROM messages WHERE thread_id=?1 ORDER BY id",
            [tid],
        )?;
        for m in &mut messages {
            Self::message_context(&st, m, agent)?;
        }
        t["messages"] = json!(messages);
        t["watch"] = Self::thread_watch(&st, tid)?;
        let mut events = Self::event_rows(
            &st,
            "SELECT * FROM events WHERE thread=?1 AND kind IN ('thread.joined','thread.left') ORDER BY id DESC LIMIT 51",
            [tid],
        )?;
        t["events_more"] = json!(events.len() > 50);
        events.truncate(50);
        events.reverse();
        t["events"] = json!(events);
        t["last_read"] = json!(Self::user_read_cursor(&st, tid)?);
        t["unread"] = json!(Self::user_unread(&st, tid)?);
        Ok(t)
    }

    fn user_read_cursor(st: &St, tid: i64) -> R<i64> {
        Ok(st.db.query_row(
            "SELECT coalesce((SELECT message_id FROM user_reads WHERE thread_id=?1),0)",
            [tid],
            |r| r.get(0),
        )?)
    }

    fn user_unread(st: &St, tid: i64) -> R<i64> {
        Ok(st.db.query_row(
            "SELECT count(*) FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=0
             LEFT JOIN user_reads r ON r.thread_id=m.thread_id
             WHERE m.thread_id=?1 AND m.sender<>0 AND m.id>coalesce(r.message_id,0)
               AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=0
                 AND m.id>i.start_after AND (i.end_after IS NULL OR m.id<=i.end_after))",
            [tid],
            |r| r.get(0),
        )?)
    }

    /// Acknowledge only the messages actually shown, never a later arrival.
    pub fn read_thread(&self, tid: i64, through: i64) -> R<Value> {
        let st = self.lock();
        Self::thread_project(&st, tid)?;
        let valid: bool = st.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE thread_id=?1 AND id=?2)",
            params![tid, through],
            |r| r.get(0),
        )?;
        if through < 0 || (through != 0 && !valid) {
            return Err(bad("message must be 0 or a message in this thread"));
        }
        st.db.execute(
            "INSERT INTO user_reads(thread_id,message_id) VALUES(?1,?2)
             ON CONFLICT(thread_id) DO UPDATE SET message_id=max(message_id,excluded.message_id)",
            params![tid, through],
        )?;
        Ok(
            json!({ "last_read": Self::user_read_cursor(&st, tid)?, "unread": Self::user_unread(&st, tid)? }),
        )
    }

    pub fn message_for(&self, id: i64, agent: Option<i64>) -> R<Value> {
        let st = self.lock();
        let mut m=rows(
            &st.db,
            "SELECT m.id, m.thread_id thread, t.title, m.sender, m.text, m.at FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=?1",
            [id],
        )?
        .pop()
        .ok_or_else(|| not_found(format!("no message {id}")))?;
        if let Some(a) = agent.filter(|a| *a > 0)
            && st.agent(a)?.project != Self::thread_project(&st, m["thread"].as_i64().unwrap())?
        {
            return Err(bad("message is in another project"));
        }
        Self::message_context(&st, &mut m, Some(agent.unwrap_or(0)))?;
        Ok(m)
    }

    fn thread_watch(st: &St, tid: i64) -> R<Value> {
        let watch: Option<String> = st
            .db
            .query_row(
                "SELECT watch FROM thread_filters WHERE thread_id=?1",
                [tid],
                |r| r.get(0),
            )
            .optional()?;
        Ok(watch
            .map(|s| serde_json::from_str(&s).unwrap_or(json!([])))
            .unwrap_or(json!([])))
    }

    fn message_context(st: &St, m: &mut Value, agent: Option<i64>) -> R<()> {
        if let Some(a) = agent {
            let mid = m["id"].as_i64().unwrap();
            let tid = m["thread"].as_i64().unwrap();
            let unknown: bool = st.db.query_row(
                "SELECT ?1<=(SELECT message_id FROM history_origin WHERE id=1)",
                [mid],
                |r| r.get(0),
            )?;
            let inside: bool = st.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM member_intervals WHERE thread_id=?1 AND agent_id=?2
                AND ?3>start_after AND (end_after IS NULL OR ?3<=end_after))",
                params![tid, a, mid],
                |r| r.get(0),
            )?;
            m["membership_unknown"] = json!(unknown);
            m["outside_membership"] = json!(!unknown && !inside);
            if a > 0 {
                let mark: Option<String> = st
                    .db
                    .query_row(
                        "SELECT mark FROM marks WHERE agent_id=?1 AND message_id=?2",
                        params![a, mid],
                        |r| r.get(0),
                    )
                    .optional()?;
                m["mark"] = json!(mark.unwrap_or_else(|| "new".into()));
            }
        }
        Ok(())
    }

    fn event_rows(st: &St, sql: &str, p: impl rusqlite::Params) -> R<Vec<Value>> {
        let mut events = rows(&st.db, sql, p)?;
        for e in &mut events {
            if let Some(s) = e["details"].as_str() {
                e["details"] =
                    serde_json::from_str(s).map_err(|_| bad("invalid saved history details"))?;
            }
        }
        Ok(events)
    }

    pub fn history_event(&self, project: Option<i64>, id: i64) -> R<Value> {
        let st = self.lock();
        Self::event_rows(
            &st,
            "SELECT * FROM events WHERE id=?1 AND (?2 IS NULL OR project=?2)",
            params![id, project],
        )?
        .pop()
        .ok_or_else(|| not_found(format!("no history event {id}")))
    }

    pub fn history(&self, project: Option<i64>, q: HistoryQuery) -> R<Value> {
        if !(1..=200).contains(&q.limit) || !(512..=65536).contains(&q.max_bytes) {
            return Err(bad("history limit must be 1–200 and max_bytes 512–65536"));
        }
        if q.before.is_some() && q.after.is_some()
            || q.before.is_some_and(|x| x <= 0)
            || q.after.is_some_and(|x| x <= 0)
        {
            return Err(bad("use one positive before or after event ID"));
        }
        let st = self.lock();
        if let Some(a) = q.agent.filter(|a| *a > 0) {
            let p = st.agent(a)?.project;
            if project.is_some_and(|project| project != p) {
                return Err(bad("agent is in another project"));
            }
        }
        if let Some(t) = q.thread {
            let p = Self::thread_project(&st, t)?;
            if project.is_some_and(|project| project != p) {
                return Err(bad("thread is in another project"));
            }
        }
        let order = if q.after.is_some() { "ASC" } else { "DESC" };
        let sql = format!(
            "SELECT * FROM events WHERE (?1 IS NULL OR project=?1) AND (?2 IS NULL OR agent=?2)
            AND (?3 IS NULL OR thread=?3) AND (?4 IS NULL OR lock=?4) AND (?5 IS NULL OR kind=?5)
            AND (?6 IS NULL OR id<?6) AND (?7 IS NULL OR id>?7) ORDER BY id {order} LIMIT ?8"
        );
        let candidates = Self::event_rows(
            &st,
            &sql,
            params![
                project,
                q.agent,
                q.thread,
                q.lock,
                q.kind,
                q.before,
                q.after,
                q.limit + 1
            ],
        )?;
        let envelope = |events: &Vec<Value>, has_more: bool| {
            let last = events.last().and_then(|e| e["id"].as_i64());
            json!({"events":events,"has_more":has_more,"next_before":if q.after.is_none(){last}else{None},"next_after":if q.after.is_some(){last}else{None}})
        };
        let total = candidates.len();
        let mut events = Vec::new();
        for mut e in candidates.into_iter().take(q.limit as usize) {
            events.push(e.clone());
            if envelope(&events, true).to_string().len() > q.max_bytes as usize {
                events.pop();
                if !events.is_empty() {
                    break;
                }
                // A compact stub always advances the cursor; its full record is
                // available by ID rather than silently skipped or endlessly retried.
                e = json!({"id":e["id"],"at":e["at"],"kind":e["kind"],"agent":e["agent"],"thread":e["thread"],"truncated":true});
                events.push(e);
                break;
            }
        }
        let response = envelope(&events, events.len() < total);
        if response.to_string().len() > q.max_bytes as usize {
            return Err(bad("max_bytes too small for history metadata"));
        }
        Ok(response)
    }

    /// A project's limits (the Default config's without one), active counts and usage.
    pub fn limits(&self, project: Option<i64>) -> R<Value> {
        let st = self.lock();
        let s = st.settings_for(project);
        let (total, per) = st.active_counts(project)?;
        let usage = rows(
            &st.db,
            "SELECT provider, win, used_pct, resets_at, at FROM usage ORDER BY provider, win",
            [],
        )?;
        Ok(json!({
            "limits": s.limits,
            "active": { "total": total, "per_harness": per },
            "usage": usage,
            "checks": rows(&st.db, "SELECT provider,checked_at,attempted_at,next_check,error FROM usage_checks ORDER BY provider", [])?,
            "text": st.limits_text(project)?,
        }))
    }

    pub fn settings(&self, project: Option<i64>) -> Settings {
        self.lock().settings_for(project)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn older_development_state_is_refused_without_changing_records() {
        let db = Connection::open_in_memory().unwrap();
        assert!(check_stored_schema(&db).is_ok());
        db.execute_batch(&SCHEMA.replace(
            "projects (id INTEGER PRIMARY KEY AUTOINCREMENT",
            "projects (id INTEGER PRIMARY KEY",
        ))
        .unwrap();
        db.execute(
            "INSERT INTO projects(id,path,name,created_at) VALUES(42,'/test','test',0)",
            [],
        )
        .unwrap();
        let error = check_stored_schema(&db).unwrap_err();
        assert!(error.1.contains("earlier development schema"));
        assert_eq!(
            db.query_row("SELECT id FROM projects", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            42
        );
        let current = Connection::open_in_memory().unwrap();
        current.execute_batch(SCHEMA).unwrap();
        assert!(check_stored_schema(&current).is_ok());
        let bad_allocator = Connection::open_in_memory().unwrap();
        bad_allocator.execute_batch(SCHEMA).unwrap();
        bad_allocator.execute_batch("DROP TABLE configs;
            CREATE TABLE configs(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,settings TEXT NOT NULL);").unwrap();
        assert!(
            check_stored_schema(&bad_allocator)
                .unwrap_err()
                .1
                .contains("earlier development schema")
        );
        current
            .execute(
                "INSERT INTO configs(id,name,settings) VALUES(1,'Default','{}')",
                [],
            )
            .unwrap();
        assert!(
            check_stored_schema(&current)
                .unwrap_err()
                .1
                .contains("earlier development schema")
        );
        assert_eq!(
            current
                .query_row("SELECT count(*) FROM configs WHERE id=1", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        current
            .execute("DELETE FROM configs WHERE id=1", [])
            .unwrap();
        let partial = Connection::open_in_memory().unwrap();
        partial
            .execute_batch(
                "CREATE TABLE configs(id INTEGER PRIMARY KEY,name TEXT,settings TEXT);
            INSERT INTO configs VALUES(1,'Default','{}');",
            )
            .unwrap();
        assert!(
            check_stored_schema(&partial)
                .unwrap_err()
                .1
                .contains("earlier development schema")
        );
        current.execute_batch("DROP TABLE agent_retries;
            CREATE TABLE agent_retries(agent_id INTEGER PRIMARY KEY,source TEXT,tried TEXT,handled INTEGER,replacement INTEGER,blocked TEXT);
            INSERT INTO agent_retries VALUES(1,'m','[]',0,NULL,NULL);").unwrap();
        assert!(
            check_stored_schema(&current)
                .unwrap_err()
                .1
                .contains("earlier development schema")
        );
        assert_eq!(
            current
                .query_row("SELECT count(*) FROM agent_retries", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    /// Project 1 with three working claude agents (1, 2, 3); project 2 with agent 4.
    fn st() -> St {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA).unwrap();
        db.execute_batch(
            "INSERT INTO projects(id,path,name,created_at) VALUES(1,'/p1','p1',0),(2,'/p2','p2',0)",
        )
        .unwrap();
        for (id, project) in [(1, 1), (2, 1), (3, 1), (4, 2)] {
            db.execute(
                "INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at)
                 VALUES(?1,?2,'a','t','claude','m','e','working',0,0)",
                [id, project],
            )
            .unwrap();
        }
        St {
            db,
            shutting_down: false,
            waiting_updates: HashSet::new(),
            stopping_agents: HashSet::new(),
            queues: HashMap::new(),
            procs: HashMap::new(),
            reaped: HashSet::new(),
            over_soft: HashSet::new(),
        }
    }

    fn hold(st: &St, name: &str, holder: i64, expires_at: Option<i64>) {
        st.db
            .execute(
                "INSERT INTO locks(project,name,about,created_at,holder,acquired_at,expires_at) VALUES(1,?1,'x',0,?2,0,?3)",
                params![name, holder, expires_at],
            )
            .unwrap();
    }

    fn lock(st: &St, name: &str) -> (Option<i64>, Option<i64>, i64, Option<i64>) {
        st.db
            .query_row(
                "SELECT holder, expires_at, frozen, frozen_left FROM locks WHERE name=?1",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
    }

    #[test]
    fn lock_ttl_settings_have_a_finite_legacy_default_and_reject_invalid_values() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("max_lock_ttl_secs");
        let mut s: Settings = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(s.max_lock_ttl_secs, 900);
        s.max_lock_ttl_secs = 0;
        assert!(s.check().is_err());
        for ttl in [json!(-1), json!(1.5), json!(4294967296_u64), Value::Null] {
            value["max_lock_ttl_secs"] = ttl;
            assert!(serde_json::from_value::<Settings>(value.clone()).is_err());
        }
    }

    #[test]
    fn lock_acquisition_and_renewal_enforce_the_project_ceiling() {
        let app = app_with_two_projects();
        app.lock()
            .db
            .execute("UPDATE agents SET state='working'", [])
            .unwrap();
        custom(&app, 1, |s| s.max_lock_ttl_secs = 60);
        app.new_lock(1, "schema", "exclusive schema edits").unwrap();
        app.new_lock(2, "schema", "another project").unwrap();
        for ttl in [0, 61, u64::MAX] {
            assert_eq!(app.acquire(1, "schema", 0, Some(ttl)).unwrap_err().0, 400);
        }
        assert!(app.locks(Some(1)).unwrap()[0]["holder"].is_null());
        assert!(
            app.acquire(1, "schema", 0, None)
                .unwrap()
                .contains("expires")
        );
        let expiry = app.locks(Some(1)).unwrap()[0]["expires_at"]
            .as_i64()
            .unwrap();
        assert!((now() + 59..=now() + 60).contains(&expiry));
        assert!(app.acquire(1, "schema", 0, Some(61)).is_err());
        assert_eq!(app.locks(Some(1)).unwrap()[0]["expires_at"], expiry);
        app.acquire(1, "schema", 0, Some(10)).unwrap();
        app.acquire(1, "schema", 0, None).unwrap();
        assert!(
            app.locks(Some(1)).unwrap()[0]["expires_at"]
                .as_i64()
                .unwrap()
                >= now() + 59
        );
        app.acquire(2, "schema", 0, Some(61)).unwrap(); // Independent ceiling.
        app.lock()
            .db
            .execute(
                "UPDATE locks SET expires_at=?1 WHERE project=1",
                [now() - 1],
            )
            .unwrap();
        app.tick().unwrap();
        let mut st = app.lock();
        assert_eq!(st.agent(1).unwrap().state, "working");
        assert!(st.take_updates(1).unwrap().contains("its TTL ran out"));
        assert!(st.held_by(1).unwrap().is_empty());
        assert!(st.held_by(2).unwrap().contains(&"schema".into()));
    }

    #[test]
    fn ttl_changes_bound_existing_leases_without_extending_them() {
        let app = app_with_two_projects();
        {
            let st = app.lock();
            hold(&st, "long", 1, Some(now() + 800));
            hold(&st, "untimed", 1, None);
            hold(&st, "short", 1, Some(now() + 10));
            st.db.execute("INSERT INTO locks(project,name,about,created_at,holder,expires_at) VALUES(2,'other','x',0,2,?1)", [now()+800]).unwrap();
        }
        let mut s = Settings {
            max_lock_ttl_secs: 60,
            ..Settings::default()
        };
        app.set_project_config(1, None, Some(s.clone()), "user")
            .unwrap();
        let deadline = app
            .lock()
            .db
            .query_row("SELECT expires_at FROM locks WHERE name='long'", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        assert!((now() + 59..=now() + 60).contains(&deadline));
        assert_eq!(lock(&app.lock(), "untimed").1, Some(deadline));
        assert!(lock(&app.lock(), "short").1.unwrap() < deadline);
        assert!(lock(&app.lock(), "other").1.unwrap() > deadline);
        s.max_lock_ttl_secs = 30;
        app.set_project_config(1, None, Some(s.clone()), "user")
            .unwrap();
        let shortened = lock(&app.lock(), "long").1.unwrap();
        assert!((now() + 29..=now() + 30).contains(&shortened));
        s.max_lock_ttl_secs = 90;
        app.set_project_config(1, None, Some(s), "user").unwrap();
        assert_eq!(lock(&app.lock(), "long").1, Some(shortened));
        // A shared-config edit affects only projects using that config.
        let config = app
            .add_config("shared", Settings::default(), "user")
            .unwrap();
        app.set_project_config(2, Some(config), None, "user")
            .unwrap();
        let shared = Settings {
            max_lock_ttl_secs: 15,
            ..Settings::default()
        };
        app.put_config(config, None, shared, "user").unwrap();
        assert!(lock(&app.lock(), "other").1.unwrap() <= now() + 15);
        assert_eq!(lock(&app.lock(), "long").1, Some(shortened));
        let mut st = app.lock();
        assert!(st.take_updates(1).unwrap().contains("maximum TTL: 30s"));
        hold(&st, "legacy-running", 1, None);
        drop(st);
        app.tick().unwrap();
        assert!(lock(&app.lock(), "legacy-running").1.unwrap() <= now() + 90);
    }

    #[test]
    fn queued_acquisition_rechecks_the_ttl_ceiling_and_leaves_the_queue_on_rejection() {
        let app = app_with_two_projects();
        app.lock()
            .db
            .execute("UPDATE agents SET state='working',project=1", [])
            .unwrap();
        custom(&app, 1, |s| s.max_lock_ttl_secs = 60);
        app.new_lock(1, "schema", "x").unwrap();
        app.acquire(1, "schema", 0, Some(60)).unwrap();
        let waiter_app = app.clone();
        let waiter = std::thread::spawn(move || waiter_app.acquire(2, "schema", 5, Some(60)));
        let deadline = Instant::now() + Duration::from_secs(2);
        while !app
            .lock()
            .queues
            .get(&(1, "schema".into()))
            .is_some_and(|q| q.contains(&2))
        {
            assert!(Instant::now() < deadline, "waiter did not queue");
            std::thread::sleep(Duration::from_millis(5));
        }
        let s = Settings {
            max_lock_ttl_secs: 30,
            ..Settings::default()
        };
        app.set_project_config(1, None, Some(s), "user").unwrap();
        let error = waiter.join().unwrap().unwrap_err();
        assert_eq!(error.0, 400);
        assert!(error.1.contains("1–30 seconds"));
        assert!(app.lock().queues[&(1, "schema".into())].is_empty());
        assert_eq!(lock(&app.lock(), "schema").0, Some(1));
    }

    #[test]
    fn manual_and_all_pauses_release_locks_without_restoring_ttl() {
        for all in [false, true] {
            let app = app_with_two_projects();
            hold(&app.lock(), "schema", 1, Some(now() + 100));
            if all {
                app.pause_all("user").unwrap();
            } else {
                app.pause(1, "user").unwrap();
            }
            drop(app.wait_stopped(app.lock(), &[1, 2]));
            assert_eq!(lock(&app.lock(), "schema"), (None, None, 0, None));
            app.resume(1, "user").unwrap();
            assert_eq!(app.lock().agent(1).unwrap().state, "idle");
            assert_eq!(lock(&app.lock(), "schema"), (None, None, 0, None));
        }
    }

    #[test]
    fn a_lock_already_past_its_ttl_is_released() {
        let mut st = st();
        hold(&st, "late", 1, Some(now() - 1));
        st.expire_locks().unwrap();
        assert_eq!(lock(&st, "late"), (None, None, 0, None));
        let text = st.take_updates(1).unwrap();
        assert!(
            text.contains("You no longer hold lock `late`: its TTL ran out"),
            "{text}"
        );
    }

    #[test]
    fn updates_list_senders_never_content_and_only_once() {
        let mut st = st();
        st.db
            .execute(
                "INSERT INTO threads(id,project,title,created_by,created_at) VALUES(1,1,'t',0,0)",
                [],
            )
            .unwrap();
        for a in 1..=3 {
            st.db
                .execute("INSERT INTO members(thread_id,agent_id) VALUES(1,?1)", [a])
                .unwrap();
        }
        for (sender, text) in [(2, "secret plan"), (0, "hi"), (2, "more"), (1, "mine")] {
            st.db
                .execute(
                    "INSERT INTO messages(thread_id,sender,text,at) VALUES(1,?1,?2,0)",
                    params![sender, text],
                )
                .unwrap();
        }
        let text = st.take_updates(1).unwrap();
        assert_eq!(
            text,
            "[acom] 3 new messages from agent 2, user. Read them with `acom inbox` when you're ready."
        );
        assert_eq!(st.take_updates(1).unwrap(), "");
        assert_eq!(st.pending(3).unwrap().len(), 4);
    }

    #[test]
    fn dated_ids_are_the_same_model_but_versions_differ() {
        assert!(same_model("claude-haiku-4-5", "claude-haiku-4-5-20251001"));
        assert!(same_model("gpt-6-luna", "gpt-6-luna"));
        assert!(!same_model("claude-opus-5", "claude-opus-5-5"));
        assert!(!same_model("claude-fable-5-1", "claude-opus-4-8"));
    }

    #[test]
    fn long_sender_lists_are_cut_in_the_middle() {
        assert_eq!(sender_list(&[2, 0]), "agent 2, user");
        assert_eq!(
            sender_list(&[1, 2, 3, 4, 5, 6, 7, 0]),
            "agent 1, agent 2, agent 3, … agent 7, user"
        );
    }

    fn save_config(st: &St, id: i64, s: &Settings) {
        st.db
            .execute(
                "INSERT OR REPLACE INTO configs(id,name,settings) VALUES(?1,?2,?3)",
                params![
                    id,
                    format!("config {id}"),
                    serde_json::to_string(s).unwrap()
                ],
            )
            .unwrap();
    }

    fn active_hard(n: Option<f64>) -> Settings {
        let mut s = Settings::default();
        s.limits.active = Limit {
            soft: None,
            hard: n,
        };
        s.limits.active_per_harness.clear();
        s
    }

    #[test]
    fn each_project_has_its_own_limits() {
        // Project 1 has three working agents, project 2 has one.
        let st = st();
        save_config(&st, 2, &active_hard(Some(3.0)));
        st.db.execute("UPDATE projects SET config=2", []).unwrap();
        assert_eq!(
            st.no_room(1, "claude").unwrap().unwrap(),
            "Hard limit reached: 3 active agents (soft none, hard 3)"
        );
        assert_eq!(st.no_room(2, "claude").unwrap(), None);
        assert!(
            st.limits_text(Some(1))
                .unwrap()
                .starts_with("Active agents: 3 (soft none, hard 3)")
        );
        assert!(
            st.limits_text(Some(2))
                .unwrap()
                .starts_with("Active agents: 1 (soft none, hard 3)")
        );

        // An agent that marked itself done no longer takes a slot.
        st.db
            .execute("UPDATE agents SET done_req=1 WHERE id=1", [])
            .unwrap();
        assert_eq!(st.no_room(1, "claude").unwrap(), None);
        st.db.execute("UPDATE agents SET done_req=0", []).unwrap();

        // Project 1 switches to a saved config with no limit; project 2 gets its own.
        save_config(&st, 3, &active_hard(None));
        st.db
            .execute("UPDATE projects SET config=3 WHERE id=1", [])
            .unwrap();
        assert_eq!(st.no_room(1, "claude").unwrap(), None);
        assert!(
            st.limits_text(Some(1))
                .unwrap()
                .starts_with("Active agents: 3 (no limit)")
        );
        let custom = serde_json::to_string(&active_hard(Some(1.0))).unwrap();
        st.db
            .execute(
                "UPDATE projects SET config=NULL, custom=?1 WHERE id=2",
                [custom],
            )
            .unwrap();
        assert!(st.no_room(2, "claude").unwrap().is_some());
        // The Default config is unchanged for everyone else.
        assert_eq!(st.settings_for(None), Settings::default());
    }

    /// A real App on a temporary database, with two projects and one idle claude agent each
    /// (agent 1 in project 1, agent 2 in project 2). Nothing here starts a process.
    fn app_with_two_projects() -> Arc<App> {
        let home = std::env::temp_dir().join(format!("acom-test-{}", crate::harness::new_uuid()));
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        {
            let st = app.lock();
            st.db
                .execute_batch(
                    "INSERT INTO projects(id,path,name,created_at) VALUES(1,'/p1','p1',0),(2,'/p2','p2',0);
                     INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at)
                       VALUES(1,1,'a','t','claude','m','e','idle',0,0),(2,2,'b','t','claude','m','e','idle',0,0);",
                )
                .unwrap();
        }
        app
    }

    #[test]
    fn shutdown_preserves_pause_reasons_and_releases_paused_locks() {
        let app = app_with_two_projects();
        {
            let st = app.lock();
            st.db.execute_batch("UPDATE agents SET state='working' WHERE id=1;
                INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at,pause_reason,pause_from)
                VALUES(3,1,'manual','t','claude','m','e','paused',0,0,'user','idle'),
                      (4,2,'limited','t','claude','m','e','paused',0,0,'limit','idle');
                INSERT INTO agent_continuations(agent_id,text) VALUES(1,'cancel me');").unwrap();
            hold(&st, "schema", 1, Some(now() + 120));
        }
        app.shutdown().unwrap();
        let st = app.lock();
        let agents = rows(
            &st.db,
            "SELECT id,state,pause_reason FROM agents ORDER BY id",
            [],
        )
        .unwrap();
        assert_eq!(agents[0]["state"], "paused");
        assert_eq!(agents[0]["pause_reason"], "restart");
        assert_eq!(agents[1]["state"], "idle");
        assert_eq!(agents[2]["pause_reason"], "user");
        assert_eq!(agents[3]["pause_reason"], "limit");
        assert_eq!(lock(&st, "schema"), (None, None, 0, None));
        assert!(!App::has_handoff(&st, 1).unwrap());
        assert_eq!(
            st.db
                .query_row("SELECT count(*) FROM agent_continuations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(st.shutting_down);
        drop(st);
        assert_eq!(app.overview(Some(2), None).unwrap()["restart_paused"], 1);
    }

    #[test]
    fn resume_restart_is_global_and_leaves_other_pause_reasons_and_idle_alone() {
        let app = app_with_two_projects();
        app.lock().db.execute_batch("UPDATE agents SET state='paused',pause_from='idle',pause_reason='restart';
            INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at,pause_reason,pause_from)
            VALUES(3,1,'manual','t','claude','m','e','paused',0,0,'user','idle'),
                  (4,2,'limited','t','claude','m','e','paused',0,0,'limit','idle'),
                  (5,1,'idle','t','claude','m','e','idle',0,0,NULL,NULL);").unwrap();
        let before = app.overview(Some(1), None).unwrap();
        assert_eq!(before["restart_paused"], 2);
        let result = app.resume_restart("user").unwrap();
        assert_eq!(result["ids"], json!([1, 2]));
        assert_eq!(result["errors"], json!([]));
        assert_eq!(app.lock().agent(3).unwrap().state, "paused");
        assert_eq!(app.lock().agent(4).unwrap().state, "paused");
        assert_eq!(app.lock().agent(5).unwrap().state, "idle");
        let after = app.overview(Some(1), before["revision"].as_str()).unwrap();
        assert_eq!(after["restart_paused"], 0);
        assert_ne!(after["unchanged"], true);
        assert_eq!(app.resume_restart("user").unwrap()["ids"], json!([]));
    }

    #[test]
    fn failed_shutdown_save_still_records_restart_pause_at_worker_exit() {
        let app = app_with_two_projects();
        app.lock()
            .db
            .execute_batch(
                "UPDATE agents SET state='working' WHERE id=1;
            CREATE TRIGGER fail_shutdown BEFORE UPDATE ON agents WHEN NEW.state='paused'
            BEGIN SELECT RAISE(ABORT,'shutdown fixture'); END;",
            )
            .unwrap();
        assert!(app.shutdown().is_err());
        assert!(app.lock().shutting_down);
        app.lock()
            .db
            .execute_batch("DROP TRIGGER fail_shutdown")
            .unwrap();
        app.turn_ended(1, u32::MAX, false, Some("stopped deliberately"))
            .unwrap();
        let state = rows(
            &app.lock().db,
            "SELECT state,pause_reason FROM agents WHERE id=1",
            [],
        )
        .unwrap();
        assert_eq!(state[0]["state"], "paused");
        assert_eq!(state[0]["pause_reason"], "restart");
    }

    #[test]
    fn view_revisions_are_atomic_and_include_quiet_changes() {
        let app = app_with_two_projects();
        let initial = app
            .agents_page(Some(1), None, PageQuery::default())
            .unwrap();
        {
            let mut st = app.lock();
            st.db
                .execute("UPDATE agents SET task=task WHERE id=1", [])
                .unwrap();
            let failed: R<()> = st.atomic(|st| {
                st.db
                    .execute("UPDATE agents SET context=context+1 WHERE id=1", [])?;
                Err(bad("rollback fixture"))
            });
            assert!(failed.is_err());
        }
        let revision = initial["revision"].as_str().unwrap().to_owned();
        assert_eq!(
            app.agents_page(Some(1), None, PageQuery::default())
                .unwrap()["revision"],
            revision
        );
        app.lock()
            .db
            .execute("UPDATE agents SET context=context+1 WHERE id=1", [])
            .unwrap();
        assert_eq!(
            app.agents_page(
                Some(1),
                None,
                PageQuery {
                    revision: Some(revision),
                    ..Default::default()
                }
            )
            .unwrap_err()
            .0,
            409
        );
        assert_eq!(
            app.overview(Some(1), None).unwrap()["revisions"]["agents"],
            app.agents_page(Some(1), None, PageQuery::default())
                .unwrap()["revision"]
        );
        let locks = app.locks_page(Some(1), PageQuery::default()).unwrap();
        app.lock().queues.insert((1, "waiting".into()), vec![1]);
        let queued = app.locks_page(Some(1), PageQuery::default()).unwrap();
        assert_ne!(locks["revision"], queued["revision"]);
        assert_eq!(
            app.overview(Some(1), None).unwrap()["revisions"]["locks"],
            queued["revision"]
        );
    }

    #[test]
    fn paged_ids_do_not_reuse_deleted_high_water_marks_after_restart() {
        let app = app_with_two_projects();
        // Never wake a real client: only the user belongs to these threads.
        let (thread, _) = app.new_thread(0, Some(1), "first", &[], true, &[]).unwrap();
        let (message, _) = app.post(0, thread, "first").unwrap();
        app.new_lock(1, "first", "first").unwrap();
        {
            let st = app.lock();
            st.log(Some(1), "user", "first").unwrap();
            st.notice(1, "first").unwrap();
            // External high IDs are also recorded by the allocator triggers.
            st.db
                .execute("INSERT INTO activity VALUES(900,1,0,'user','external')", [])
                .unwrap();
            st.db.execute_batch("DELETE FROM messages; DELETE FROM threads; DELETE FROM locks; DELETE FROM activity; DELETE FROM notices;").unwrap();
        }
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        let (next_thread, _) = app.new_thread(0, Some(1), "next", &[], true, &[]).unwrap();
        let (next_message, _) = app.post(0, next_thread, "next").unwrap();
        app.new_lock(1, "next", "next").unwrap();
        assert!(next_thread > thread);
        assert!(next_message > message);
        assert!(
            app.locks_page(Some(1), PageQuery::default()).unwrap()["items"][0]["id"]
                .as_i64()
                .unwrap()
                > 1
        );
        let st = app.lock();
        st.log(Some(1), "user", "next").unwrap();
        st.notice(1, "next").unwrap();
        assert!(
            st.db
                .query_row("SELECT max(id) FROM activity", [], |r| r.get::<_, i64>(0))
                .unwrap()
                > 900
        );
        assert!(
            st.db
                .query_row("SELECT max(id) FROM notices", [], |r| r.get::<_, i64>(0))
                .unwrap()
                > 1
        );
    }

    #[test]
    fn bounded_notices_remain_recoverable_and_undelivered_notices_wait() {
        let app = app_with_two_projects();
        let original = "☃\\\"\n😀".repeat(3000);
        {
            let st = app.lock();
            st.notice(1, &original).unwrap();
            for _ in 0..35 {
                st.notice(1, &"\\\"".repeat(300)).unwrap();
            }
        }
        let first = app.lock().take_updates(1).unwrap();
        assert!(json!({"text":first}).to_string().len() < 11000);
        assert!(first.contains("Notice #1 shortened"));
        assert!(first.contains("more notices waiting"));
        assert_eq!(app.notice_view(1, 1).unwrap()["text"], original);
        assert_eq!(app.notice_view(2, 1).unwrap_err().0, 404);
        let page = app
            .notices_page(
                1,
                PageQuery {
                    after: Some(0),
                    max_bytes: 512,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(page.to_string().len() <= 512);
        assert_eq!(page["items"][0]["id"], 1);
        assert_eq!(page["items"][0]["truncated"], true);
        assert!(
            !app.lock()
                .take_updates(1)
                .unwrap()
                .contains("Notice #1 shortened")
        );
        for _ in 0..10 {
            app.lock().take_updates(1).unwrap();
        }
        assert!(app.lock().take_updates(1).unwrap().is_empty());
        assert_eq!(
            app.notices_page(1, PageQuery::default()).unwrap()["total"],
            36
        );
    }

    fn wait_registered(app: &App, id: i64) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !app.lock().waiting_updates.contains(&id) {
            assert!(Instant::now() < deadline, "wait was not registered");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn wait_updates_transfers_once_and_leaves_new_arrivals_for_after_ack() {
        let app = self_change_app();
        let (thread, _) = app
            .new_thread(0, Some(1), "wait", &["1".into()], true, &[])
            .unwrap();
        let (message, _) = app
            .post(0, thread, "not message content in the notice")
            .unwrap();
        {
            let st = app.lock();
            st.notice(1, "first notice").unwrap();
            st.notice(2, "other agent notice").unwrap();
            hold(&st, "held", 1, Some(now() + 120));
        }
        let active = app.lock().active_counts(Some(1)).unwrap();
        let first = app.wait_updates(1, 1).unwrap();
        let delivery = first["delivery_id"].as_i64().unwrap();
        let text = first["text"].as_str().unwrap();
        assert!(text.contains("first notice"));
        assert!(text.contains("1 new message from user"));
        assert!(!text.contains("not message content"));
        assert!(!text.contains("other agent notice"));
        assert_eq!(first["timed_out"], false);
        assert_eq!(app.wait_updates(1, 1).unwrap(), first);
        app.lock().notice(1, "later notice").unwrap();
        assert!(app.hook(1).unwrap().is_empty());
        assert_eq!(app.lock().agent(1).unwrap().state, "working");
        assert_eq!(app.lock().active_counts(Some(1)).unwrap(), active);
        assert_eq!(lock(&app.lock(), "held").0, Some(1));
        let st = app.lock();
        assert_eq!(
            st.db
                .query_row(
                    "SELECT count(*) FROM marks WHERE agent_id=1 AND message_id=?1",
                    [message],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            st.db
                .query_row("SELECT shown FROM notices WHERE agent_id=2", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(st);
        app.ack_updates(1, delivery).unwrap();
        let next = app.hook(1).unwrap();
        assert!(next.contains("later notice"));
        assert!(!next.contains("first notice"));
        assert!(!next.contains("new message"));
        assert!(app.hook(1).unwrap().is_empty());
    }

    #[test]
    fn wait_ack_is_owned_idempotent_bounded_and_does_not_clear_a_newer_batch() {
        let app = self_change_app();
        app.lock().notice(1, "first").unwrap();
        let first = app.wait_updates(1, 1).unwrap()["delivery_id"]
            .as_i64()
            .unwrap();
        assert_eq!(app.ack_updates(1, 0).unwrap_err().0, 400);
        assert_eq!(app.ack_updates(2, first).unwrap_err().0, 404);
        assert_eq!(app.ack_updates(1, first + 100).unwrap_err().0, 404);
        app.ack_updates(1, first).unwrap();
        app.ack_updates(1, first).unwrap();
        let mut latest = first;
        for i in 0..5 {
            app.lock().notice(1, &format!("batch {i}")).unwrap();
            let batch = app.wait_updates(1, 1).unwrap();
            let current = batch["delivery_id"].as_i64().unwrap();
            assert!(current > latest);
            assert_eq!(app.ack_updates(1, latest).unwrap_err().0, 409);
            assert_eq!(app.wait_updates(1, 1).unwrap(), batch);
            app.ack_updates(1, current).unwrap();
            latest = current;
        }
        assert_eq!(
            app.lock()
                .db
                .query_row(
                    "SELECT count(*) FROM update_deliveries WHERE agent_id=1",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn wait_timeout_releases_registration_without_changing_the_turn() {
        let app = self_change_app();
        assert_eq!(app.wait_updates(1, 0).unwrap_err().0, 400);
        assert_eq!(app.wait_updates(1, 3601).unwrap_err().0, 400);
        assert_eq!(app.wait_updates(2, 1).unwrap_err().0, 409);
        let started = Instant::now();
        assert_eq!(
            app.wait_updates(1, 1).unwrap(),
            json!({"text":"","delivery_id":null,"timed_out":true})
        );
        assert!(started.elapsed() >= Duration::from_millis(900));
        let st = app.lock();
        assert!(st.waiting_updates.is_empty());
        assert_eq!(st.agent(1).unwrap().state, "working");
        assert!(st.pending_delivery(1).unwrap().is_none());
    }

    #[test]
    fn wait_is_exclusive_and_backstop_delivers_unsignalled_notices() {
        let app = self_change_app();
        let waiting = app.clone();
        let thread = std::thread::spawn(move || waiting.wait_updates(1, 10));
        wait_registered(&app, 1);
        assert_eq!(app.wait_updates(1, 1).unwrap_err().0, 409);
        assert!(app.hook(1).unwrap().is_empty());
        app.lock()
            .notice(1, "notice without a producer signal")
            .unwrap();
        let delivery = thread.join().unwrap().unwrap();
        assert!(
            delivery["text"]
                .as_str()
                .unwrap()
                .contains("notice without a producer signal")
        );
        assert!(app.lock().waiting_updates.is_empty());
        assert!(app.hook(1).unwrap().is_empty());
        app.ack_updates(1, delivery["delivery_id"].as_i64().unwrap())
            .unwrap();
        assert!(app.hook(1).unwrap().is_empty());
    }

    #[test]
    fn wait_aborts_on_state_turn_pid_or_shutdown_changes() {
        for change in ["state", "turn", "pid", "shutdown"] {
            let app = self_change_app();
            let waiting = app.clone();
            let thread = std::thread::spawn(move || waiting.wait_updates(1, 10));
            wait_registered(&app, 1);
            {
                let mut st = app.lock();
                match change {
                    "state" => st
                        .db
                        .execute("UPDATE agents SET state='paused' WHERE id=1", [])
                        .unwrap(),
                    "turn" => st
                        .db
                        .execute("UPDATE agents SET turns=turns+1 WHERE id=1", [])
                        .unwrap(),
                    "pid" => st
                        .db
                        .execute("UPDATE agents SET pid=123456 WHERE id=1", [])
                        .unwrap(),
                    _ => {
                        st.shutting_down = true;
                        0
                    }
                };
            }
            app.cv.notify_all();
            assert_eq!(thread.join().unwrap().unwrap_err().0, 409, "{change}");
            assert!(app.lock().waiting_updates.is_empty(), "{change}");
        }
    }

    #[test]
    fn wait_and_hook_consumption_roll_back_when_receipt_or_summary_storage_fails() {
        let app = self_change_app();
        let (thread, _) = app
            .new_thread(0, Some(1), "atomic", &["1".into()], true, &[])
            .unwrap();
        app.post(0, thread, "waiting").unwrap();
        app.lock().notice(1, "do not lose this").unwrap();
        app.lock().db.execute_batch("CREATE TRIGGER fail_wait_receipt BEFORE INSERT ON update_deliveries BEGIN SELECT RAISE(ABORT,'wait storage fixture'); END;").unwrap();
        assert!(app.wait_updates(1, 1).is_err());
        {
            let st = app.lock();
            assert!(st.waiting_updates.is_empty());
            assert!(st.pending_delivery(1).unwrap().is_none());
            assert_eq!(
                st.db
                    .query_row("SELECT shown FROM notices WHERE agent_id=1", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                st.db
                    .query_row(
                        "SELECT last_notified FROM members WHERE agent_id=1",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert_eq!(
                st.db
                    .query_row(
                        "SELECT count(*) FROM summary_cursors WHERE agent_id=1",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            st.db.execute_batch("DROP TRIGGER fail_wait_receipt; CREATE TRIGGER fail_hook_summary BEFORE INSERT ON summary_cursors BEGIN SELECT RAISE(ABORT,'hook storage fixture'); END;").unwrap();
        }
        assert!(app.hook(1).is_err());
        assert_eq!(
            app.lock()
                .db
                .query_row("SELECT shown FROM notices WHERE agent_id=1", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        app.lock()
            .db
            .execute_batch("DROP TRIGGER fail_hook_summary")
            .unwrap();
        let text = app.hook(1).unwrap();
        assert!(text.contains("do not lose this"));
        assert!(text.contains("1 new message"));
        assert!(app.hook(1).unwrap().is_empty());
    }

    #[test]
    fn wait_receipt_survives_restart_and_failed_startup_and_recovery_stays_bounded() {
        let app = self_change_app();
        for _ in 0..35 {
            app.lock().notice(1, &"☃\\\"\n😀".repeat(150)).unwrap();
        }
        let first = app.wait_updates(1, 1).unwrap();
        let delivery = first["delivery_id"].as_i64().unwrap();
        assert!(first.to_string().len() < 16000);
        {
            let mut st = app.lock();
            let failed: R<()> = st.atomic(|st| {
                assert!(
                    st.take_updates(1)?
                        .contains(&format!("Recovered delivery #{delivery}"))
                );
                Err(bad("simulate startup rollback"))
            });
            assert!(failed.is_err());
        }
        assert_eq!(app.wait_updates(1, 1).unwrap(), first);
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        assert_eq!(app.lock().agent(1).unwrap().state, "paused");
        app.lock()
            .db
            .execute("UPDATE agents SET state='working' WHERE id=1", [])
            .unwrap();
        assert_eq!(app.wait_updates(1, 1).unwrap(), first);
        for _ in 0..25 {
            app.lock().notice(1, &"\\\"".repeat(300)).unwrap();
        }
        let recovered = app
            .lock()
            .atomic(|st| {
                let updates = st.take_updates(1)?;
                let summary = st.coordination_summary(1, true)?;
                Ok(format!("{updates}\n{summary}"))
            })
            .unwrap();
        assert!(recovered.contains(&format!(
            "Recovered delivery #{delivery} (same batch; ignore if already received)"
        )));
        assert!(json!({"text":recovered}).to_string().len() < 16000);
        assert!(app.lock().pending_delivery(1).unwrap().is_none());
        assert!(app.hook(1).unwrap().contains("more notices waiting"));
    }

    #[test]
    fn replacement_inherits_only_pending_wait_delivery_atomically_by_the_same_id() {
        for acknowledged in [false, true] {
            let app = self_change_app();
            app.lock().notice(1, "handoff notification").unwrap();
            let batch = app.wait_updates(1, 1).unwrap();
            let delivery = batch["delivery_id"].as_i64().unwrap();
            if acknowledged {
                app.ack_updates(1, delivery).unwrap();
            }
            {
                let mut st = app.lock();
                st.db.execute("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(3,1,'successor','t','codex','gpt-6-sol','medium','working',1,0)", []).unwrap();
                let failed: R<()> = st.atomic(|st| {
                    App::inherit_memberships(st, 1, 3)?;
                    st.set_state(1, "replaced")?;
                    Err(bad("simulate ownership rollback"))
                });
                assert!(failed.is_err());
                assert_eq!(st.agent(1).unwrap().state, "working");
                assert_eq!(st.pending_delivery(1).unwrap().is_some(), !acknowledged);
                assert!(st.pending_delivery(3).unwrap().is_none());
                assert_eq!(
                    st.db
                        .query_row(
                            "SELECT agent_id FROM update_deliveries WHERE id=?1",
                            [delivery],
                            |r| r.get::<_, i64>(0)
                        )
                        .unwrap(),
                    1
                );
                st.atomic(|st| {
                    App::inherit_memberships(st, 1, 3)?;
                    st.set_state(1, "replaced")
                })
                .unwrap();
            }
            if acknowledged {
                assert!(app.lock().pending_delivery(3).unwrap().is_none());
                app.ack_updates(1, delivery).unwrap();
                assert_eq!(app.ack_updates(3, delivery).unwrap_err().0, 404);
            } else {
                assert_eq!(app.ack_updates(1, delivery).unwrap_err().0, 404);
                assert_eq!(app.wait_updates(3, 1).unwrap(), batch);
                let recovered = app.lock().atomic(|st| st.take_updates(3)).unwrap();
                assert!(recovered.contains(&format!("Recovered delivery #{delivery}")));
                assert!(recovered.contains("handoff notification"));
                app.ack_updates(3, delivery).unwrap();
            }
        }
    }

    #[test]
    fn compact_receipts_preserve_results_without_replaying_actions() {
        let app = app_with_two_projects();
        let original = json!({"id":42,"warnings":vec!["☃".repeat(1000);100],"queued":true});
        let result = app.compact_receipt(original.clone(), Some(1), None, None);
        assert!(result.to_string().len() < 16000);
        assert_eq!(result["id"], 42);
        assert_eq!(result["counts"]["warnings"], 100);
        let id = result["receipt_event"].as_i64().unwrap();
        assert_eq!(
            app.receipt_view(id, Some(1)).unwrap()["details"]["response"],
            original
        );
        assert_eq!(app.receipt_view(id, Some(2)).unwrap_err().0, 404);
        app.lock().db.execute_batch("CREATE TRIGGER receipt_test_failure BEFORE INSERT ON events WHEN NEW.kind='command.receipt' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;").unwrap();
        let failed = app.compact_receipt(original, Some(1), None, None);
        assert!(
            failed["receipt_error"]
                .as_str()
                .unwrap()
                .contains("Action completed")
        );
        assert!(failed["receipt_event"].is_null());
        assert_eq!(failed["id"], 42);
    }

    #[test]
    fn unread_thread_since_and_inbox_snapshot_do_not_acknowledge_omissions() {
        let app = app_with_two_projects();
        app.lock()
            .db
            .execute("UPDATE agents SET state='closed'", [])
            .unwrap();
        let (tid, _) = app
            .new_thread(0, Some(1), "paging", &["1".into()], true, &[])
            .unwrap();
        app.post(1, tid, "unread user message").unwrap();
        let initial = app.thread_page(tid, None, PageQuery::default()).unwrap();
        let same = app
            .thread_page(
                tid,
                None,
                PageQuery {
                    since: initial["messages"]["revision"].as_str().map(str::to_string),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(same["messages"]["unchanged"], true);
        assert_eq!(same["unread"], 1);
        for text in ["first", "second"] {
            app.post(0, tid, text).unwrap();
        }
        let inbox = app
            .inbox_page(
                1,
                "new",
                PageQuery {
                    limit: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        let continuation = PageQuery {
            after: inbox["next_after"].as_i64(),
            through: inbox["through"].as_i64(),
            revision: inbox["revision"].as_str().map(str::to_string),
            limit: 1,
            ..Default::default()
        };
        assert_eq!(
            app.inbox_page(1, "new", continuation.clone()).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mid = inbox["items"][0]["id"].as_i64().unwrap();
        app.lock()
            .db
            .execute("INSERT INTO marks VALUES(1,?1,'handled')", [mid])
            .unwrap();
        assert_eq!(app.inbox_page(1, "new", continuation).unwrap_err().0, 409);
    }

    #[test]
    fn oversized_message_details_preserve_default_user_membership_context() {
        let app = app_with_two_projects();
        app.lock()
            .db
            .execute("UPDATE agents SET state='closed'", [])
            .unwrap();
        let (tid, _) = app
            .new_thread(0, Some(1), "catch-up", &["1".into()], true, &[])
            .unwrap();
        app.user_membership(tid, false).unwrap();
        let (outside, _) = app.post(1, tid, &"☃".repeat(2000)).unwrap();
        app.user_membership(tid, true).unwrap();
        let (inside, _) = app.post(1, tid, "new unread message").unwrap();
        let page = app
            .messages_page(
                tid,
                None,
                PageQuery {
                    after: Some(0),
                    max_bytes: 512,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(page["items"][0]["truncated"], true);
        assert_eq!(
            app.message_for(outside, None).unwrap()["outside_membership"],
            true
        );
        assert_eq!(
            app.message_for(inside, None).unwrap()["outside_membership"],
            false
        );
        assert_eq!(app.thread_metadata(tid, None).unwrap()["unread"], 1);
    }

    #[test]
    fn stopping_locks_cannot_expire_or_be_freed_before_cleanup() {
        let app = app_with_two_projects();
        {
            let mut st = app.lock();
            st.db.execute_batch("UPDATE agents SET project=1; UPDATE agents SET state='paused' WHERE id=1; UPDATE agents SET state='working' WHERE id=2;").unwrap();
            hold(&st, "guarded", 1, Some(now() - 1));
            st.stopping_agents.insert(1);
            assert!(!st.expire_locks().unwrap());
            assert_eq!(app.prepare_resume(&mut st, 1, "user").unwrap_err().0, 409);
        }
        assert_eq!(app.acquire(2, "guarded", 0, Some(60)).unwrap_err().0, 409);
        assert_eq!(app.free(1, "guarded", "user").unwrap_err().0, 409);
        assert_eq!(app.release(1, "guarded").unwrap_err().0, 409);
        assert_eq!(app.close(1, "user").unwrap_err().0, 409);
        assert_eq!(app.agent_view(1).unwrap()["stopping"], true);
        {
            let mut st = app.lock();
            st.atomic(|st| st.release_all(1, "you were paused"))
                .unwrap();
            st.stopping_agents.remove(&1);
        }
        assert!(
            app.acquire(2, "guarded", 0, Some(60))
                .unwrap()
                .contains("acquired")
        );
        assert_eq!(lock(&app.lock(), "guarded").0, Some(2));
    }

    #[test]
    fn pause_release_save_failure_keeps_reservation_until_atomic_retry() {
        let app = app_with_two_projects();
        {
            let st = app.lock();
            st.db
                .execute_batch(
                    "UPDATE agents SET project=1; UPDATE agents SET state='working' WHERE id=2;",
                )
                .unwrap();
            hold(&st, "guarded", 1, Some(now() - 1));
            st.db.execute_batch("CREATE TRIGGER refuse_release BEFORE UPDATE OF holder ON locks WHEN NEW.holder IS NULL BEGIN SELECT RAISE(ABORT,'release save failed'); END;").unwrap();
        }
        app.pause(1, "user").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let st = app.lock();
            let failed: bool = st.db.query_row("SELECT EXISTS(SELECT 1 FROM activity WHERE what LIKE 'agent 1: pause cleanup incomplete%')",[],|r|r.get(0)).unwrap();
            if failed {
                assert!(st.stopping_agents.contains(&1));
                assert_eq!(lock(&st, "guarded").0, Some(1));
                break;
            }
            drop(st);
            assert!(
                Instant::now() < deadline,
                "release failure was not reported"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(app.acquire(2, "guarded", 0, Some(60)).unwrap_err().0, 409);
        assert_eq!(app.free(1, "guarded", "user").unwrap_err().0, 409);
        app.lock()
            .db
            .execute_batch("DROP TRIGGER refuse_release")
            .unwrap();
        drop(app.wait_stopped(app.lock(), &[1]));
        let st = app.lock();
        assert!(!st.stopping_agents.contains(&1));
        assert_eq!(lock(&st, "guarded"), (None, None, 0, None));
        let count: i64 = st.db.query_row("SELECT count(*) FROM notices WHERE agent_id=1 AND text LIKE 'You no longer hold lock `guarded`:%'",[],|r|r.get(0)).unwrap();
        assert_eq!(
            count, 1,
            "failed release must not commit a duplicate notice"
        );
    }

    #[test]
    fn failed_pause_save_still_guards_expiry_and_queued_acquires() {
        let app = app_with_two_projects();
        {
            let st = app.lock();
            st.db
                .execute_batch("UPDATE agents SET project=1,state='working'")
                .unwrap();
            hold(&st, "guarded", 1, Some(now() + 60));
        }
        let waiting_app = app.clone();
        let waiter = std::thread::spawn(move || waiting_app.acquire(2, "guarded", 5, Some(60)));
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut st = app.lock();
            if st
                .queues
                .get(&(1, "guarded".into()))
                .is_some_and(|q| q.contains(&2))
            {
                // A failed shutdown transaction leaves the persisted state working.
                st.shutting_down = true;
                st.stopping_agents.insert(1);
                st.db
                    .execute("UPDATE locks SET expires_at=?1", [now() - 1])
                    .unwrap();
                assert!(!st.expire_locks().unwrap());
                assert_eq!(lock(&st, "guarded").0, Some(1));
                app.cv.notify_all();
                break;
            }
            drop(st);
            assert!(Instant::now() < deadline, "waiter did not queue");
            std::thread::sleep(Duration::from_millis(5));
        }
        let error = waiter.join().unwrap().unwrap_err();
        assert_eq!(error.0, 409);
        assert!(error.1.contains("stopping"));
        assert!(app.lock().queues[&(1, "guarded".into())].is_empty());
        assert_eq!(lock(&app.lock(), "guarded").0, Some(1));
        app.lock().shutting_down = false;
        assert_eq!(app.acquire(1, "guarded", 0, Some(60)).unwrap_err().0, 409);
        assert_eq!(lock(&app.lock(), "guarded").0, Some(1));
    }

    #[test]
    fn default_is_binary_only_and_startup_preserves_named_settings() {
        let app = app_with_two_projects();
        let original = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(
            app.lock()
                .db
                .query_row("SELECT count(*) FROM configs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(app.projects().unwrap()[0]["config_name"], "Default");
        assert_eq!(app.configs().unwrap()[0]["projects"], json!([1, 2]));
        let mut mine = Settings {
            max_lock_ttl_secs: 42,
            ..Settings::default()
        };
        mine.crash_retries.insert(
            "claude-opus-5-5".into(),
            RetryRule {
                harness: "claude".into(),
                model: "claude-opus-5".into(),
                same_model_retries: 1,
            },
        );
        let id = app.add_config("Mine", mine.clone(), "user").unwrap();
        assert_eq!(id, 2);
        assert_eq!(
            app.add_config(" Default ", mine.clone(), "user")
                .unwrap_err()
                .0,
            409
        );
        assert_eq!(
            app.put_config(id, Some(" Default "), mine.clone(), "user")
                .unwrap_err()
                .0,
            409
        );
        for name in [None, Some("Changed")] {
            assert_eq!(
                app.put_config(1, name, mine.clone(), "user").unwrap_err().0,
                409
            );
        }
        assert_eq!(app.remove_config(1, "user").unwrap_err().0, 409);
        assert_eq!(app.configs().unwrap()[0]["settings"], original);
        app.set_project_config(1, Some(id), None, "user").unwrap();
        let expected = serde_json::to_value(&mine).unwrap();
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        assert_eq!(app.configs().unwrap()[0]["settings"], original);
        assert_eq!(app.configs().unwrap()[1]["settings"], expected);
        assert_eq!(
            serde_json::to_value(app.settings(Some(1))).unwrap(),
            expected
        );
        app.set_project_config(1, Some(1), None, "user").unwrap();
        assert_eq!(app.projects().unwrap()[0]["config_name"], "Default");
        assert_eq!(app.configs().unwrap()[0]["projects"], json!([1, 2]));
        assert_eq!(
            serde_json::to_value(app.settings(Some(1))).unwrap(),
            original
        );
        app.set_project_config(1, None, Some(mine.clone()), "user")
            .unwrap();
        assert_eq!(
            serde_json::to_value(app.settings(Some(1))).unwrap(),
            expected
        );
        app.put_config(id, Some("Mine"), mine, "user").unwrap();
        {
            let st = app.lock();
            let saved: (i64, String) = st
                .db
                .query_row("SELECT id,name FROM configs", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            assert_eq!(saved, (id, "Mine".into()));
            assert_eq!(
                st.db
                    .query_row("SELECT count(*) FROM configs", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        app.remove_config(id, "user").unwrap();
        assert!(app.add_config("Next", Settings::default(), "user").unwrap() > id);
    }

    #[test]
    fn replaced_agents_stay_inspectable_and_cannot_be_reactivated_or_configured() {
        let app = app_with_two_projects();
        {
            let st = app.lock();
            st.set_state(1, "replaced").unwrap();
            st.db
                .execute(
                    "UPDATE agents SET problem='original failure' WHERE id=1",
                    [],
                )
                .unwrap();
            st.db.execute("INSERT INTO agent_retries(agent_id,source,effort,tried,handled,replacement) VALUES(1,'m','e','[]',1,2)", []).unwrap();
        }
        for result in [
            app.resume(1, "user").map(|_| ()),
            app.reopen(1, "user"),
            app.pause(1, "user"),
            app.close(1, "user"),
            app.configure_agent(1, 0, None, Some("medium"), None, false),
            app.set_group(1, "new"),
            app.set_status(1, "new"),
            app.mark_done(1),
        ] {
            assert_eq!(result.unwrap_err().0, 409);
        }
        app.turn_ended(1, 0, false, Some("late callback")).unwrap();
        app.tick().unwrap();
        assert!(app.resume_all("user").unwrap().is_empty());
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "replaced");
        assert_eq!(view["problem"], "original failure");
        assert_eq!(view["retry"]["replacement"], 2);
        assert!(app.lock().procs.is_empty());
    }

    fn custom(app: &App, project: i64, change: impl Fn(&mut Settings)) {
        let mut s = Settings::default();
        change(&mut s);
        let st = app.lock();
        st.db
            .execute(
                "UPDATE projects SET config=NULL, custom=?2 WHERE id=?1",
                params![project, serde_json::to_string(&s).unwrap()],
            )
            .unwrap();
    }

    fn record_test_crash(app: &App, id: i64) {
        let st = app.lock();
        st.remember_crash(id, &st.agent(id).unwrap()).unwrap();
        st.db
            .execute("UPDATE agents SET state='crashed' WHERE id=?1", [id])
            .unwrap();
        st.db
            .execute(
                "UPDATE agent_retries SET eligible_at=0 WHERE agent_id=?1",
                [id],
            )
            .unwrap();
    }

    #[test]
    fn user_reads_are_scoped_monotonic_and_persistent() {
        let app = app_with_two_projects();
        {
            let st = app.lock();
            st.db.execute_batch(
                "INSERT INTO threads(id,project,title,created_by,created_at) VALUES
                   (1,1,'mine',0,0),(2,1,'agents',1,0),(3,2,'other project',0,0);
                 INSERT INTO members(thread_id,agent_id) VALUES (1,0),(1,1),(2,1),(3,0),(3,2);
                 INSERT INTO messages(id,thread_id,sender,text,at) VALUES
                   (1,1,1,'first',0),(2,1,0,'own message',0),(3,2,1,'agent only',0),(4,3,2,'other project',0);",
            ).unwrap();
        }
        assert_eq!(app.thread(1).unwrap()["unread"], 1);
        assert_eq!(app.thread(1).unwrap()["last_read"], 0);
        assert_eq!(
            app.threads(Some(1), None)
                .unwrap()
                .iter()
                .find(|t| t["id"] == 2)
                .unwrap()["unread"],
            0
        );
        assert_eq!(
            app.projects()
                .unwrap()
                .iter()
                .map(|p| p["unread"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 1]
        );
        // A later message is not cleared by an acknowledgement of the old snapshot.
        app.lock()
            .db
            .execute("INSERT INTO messages VALUES(5,1,1,'arrived later',0)", [])
            .unwrap();
        assert_eq!(app.read_thread(1, 2).unwrap()["unread"], 1);
        assert_eq!(app.read_thread(1, 1).unwrap()["last_read"], 2);
        assert_eq!(app.read_thread(1, 0).unwrap()["last_read"], 2);
        for invalid in [-1, 3, 4, 999] {
            assert_eq!(app.read_thread(1, invalid).unwrap_err().0, 400);
        }
        assert_eq!(app.read_thread(999, 0).unwrap_err().0, 404);
        assert_eq!(app.thread(3).unwrap()["unread"], 1);
        app.user_membership(1, false).unwrap();
        assert_eq!(app.thread(1).unwrap()["unread"], 0);
        app.user_membership(1, true).unwrap();
        assert_eq!(app.thread(1).unwrap()["last_read"], 2);
        assert_eq!(app.thread(1).unwrap()["unread"], 1);
        let home = app.home.clone();
        drop(app);
        let reopened = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        assert_eq!(reopened.thread(1).unwrap()["last_read"], 2);
        assert_eq!(reopened.read_thread(1, 5).unwrap()["unread"], 0);
        assert_eq!(reopened.thread(3).unwrap()["unread"], 1);
    }

    fn state(app: &App, id: i64) -> (String, Option<String>) {
        let st = app.lock();
        st.db
            .query_row(
                "SELECT state, pause_reason FROM agents WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
    }

    fn set_usage(app: &App, pct: f64) {
        let st = app.lock();
        st.db
            .execute(
                "INSERT OR REPLACE INTO usage(provider,win,used_pct,resets_at,at) VALUES('claude','five_hour',?1,?2,0)",
                params![pct, now() + 3600],
            )
            .unwrap();
    }

    #[test]
    fn usage_thresholds_act_per_project() {
        let app = app_with_two_projects();
        // Project 2 stops at 50%; project 1 keeps the Default 95%.
        custom(&app, 2, |s| {
            s.limits.usage.insert(
                "claude_five_hour".into(),
                Limit {
                    soft: None,
                    hard: Some(50.0),
                },
            );
        });
        set_usage(&app, 60.0);
        app.tick().unwrap();
        assert_eq!(state(&app, 1), ("idle".into(), None));
        assert_eq!(state(&app, 2), ("paused".into(), Some("limit".into())));
    }

    #[test]
    fn claude_windows_have_independent_limits_and_both_must_clear() {
        let app = app_with_two_projects();
        custom(&app, 1, |s| {
            s.limits.usage.insert(
                "claude_five_hour".into(),
                Limit {
                    soft: Some(30.0),
                    hard: Some(90.0),
                },
            );
            s.limits.usage.insert(
                "claude_seven_day".into(),
                Limit {
                    soft: Some(40.0),
                    hard: Some(70.0),
                },
            );
        });
        app.record_usage("claude", "five_hour", 40.0, Some(now() + 60))
            .unwrap();
        app.record_usage("claude", "seven_day", 80.0, Some(now() + 600))
            .unwrap();
        app.tick().unwrap();
        assert_eq!(state(&app, 1).0, "paused");
        assert_eq!(state(&app, 2).0, "idle");
        drop(app.wait_stopped(app.lock(), &[1]));
        let notices = rows(
            &app.lock().db,
            "SELECT text FROM notices WHERE agent_id=1",
            [],
        )
        .unwrap();
        assert!(
            notices
                .iter()
                .any(|n| n["text"].as_str().unwrap().contains("five-hour"))
        );
        assert!(
            notices
                .iter()
                .any(|n| n["text"].as_str().unwrap().contains("weekly"))
        );
        app.record_usage("claude", "five_hour", 0.0, Some(now() + 60))
            .unwrap();
        app.tick().unwrap();
        assert_eq!(
            state(&app, 1).0,
            "paused",
            "five-hour reset cannot clear the weekly limit"
        );
        let incomplete = crate::usage::parse("claude", &json!({"five_hour":{"utilization":0}}));
        crate::usage::finish(&app, "claude", 120, incomplete).unwrap();
        app.tick().unwrap();
        assert_eq!(
            state(&app, 1).0,
            "paused",
            "incomplete status cannot clear a weekly limit"
        );
        app.record_usage("claude", "seven_day", 0.0, Some(now() + 600))
            .unwrap();
        app.tick().unwrap();
        assert_eq!(state(&app, 1).0, "idle");
        app.record_usage("claude", "five_hour", 92.0, None).unwrap();
        app.tick().unwrap();
        assert_eq!(
            state(&app, 1).0,
            "paused",
            "five-hour threshold acts independently"
        );
        assert_eq!(state(&app, 2).0, "idle");
        assert!(app.lock().limits_text(Some(1)).unwrap().contains("weekly"));
    }

    #[test]
    fn closed_agents_keep_user_and_peer_messages_without_waking() {
        let app = app_with_two_projects();
        {
            let st = app.lock();
            st.db.execute_batch("UPDATE agents SET state='closed' WHERE id=1;
                INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at)
                VALUES(3,1,'peer','task','claude','m','e','closed',0,0);").unwrap();
        }
        let (tid, _) = app
            .new_thread(0, Some(1), "waiting", &["1".into()], true, &[])
            .unwrap();
        let (_, user) = app.post(0, tid, "user message").unwrap();
        let (_, peer) = app.post(3, tid, "peer message").unwrap();
        assert!(
            user.iter()
                .any(|(id, why)| *id == 1 && why.contains("user reopens"))
        );
        assert!(
            peer.iter()
                .any(|(id, why)| *id == 1 && why.contains("user reopens"))
        );
        app.add_members(tid, &["1".into()]).unwrap();
        // A queue saved by an older server must not restart a closed agent either.
        app.lock()
            .db
            .execute("UPDATE agents SET wake_queued_at=1 WHERE id=1", [])
            .unwrap();
        app.tick().unwrap();
        app.turn_ended(1, 0, true, None).unwrap();
        assert_eq!(state(&app, 1).0, "closed");
        assert!(app.lock().procs.is_empty());
        assert_eq!(app.inbox(1, "new").unwrap().len(), 2);
        assert!(app.agent_view(1).unwrap()["wake_queued_at"].is_null());
    }

    #[test]
    fn usage_settings_validate_windows_and_preserve_saved_provider_thresholds() {
        let mut s = Settings::default();
        s.limits.usage.clear();
        s.limits.usage.insert(
            "claude".into(),
            Limit {
                soft: Some(80.0),
                hard: Some(95.0),
            },
        );
        assert!(s.check().is_ok());
        assert_eq!(
            s.limits.usage_limit("claude", "five_hour").unwrap().hard,
            Some(95.0)
        );
        assert_eq!(
            s.limits.usage_limit("claude", "seven_day").unwrap().hard,
            Some(95.0)
        );
        s.limits.usage.insert(
            "claude_seven_day".into(),
            Limit {
                soft: None,
                hard: Some(60.0),
            },
        );
        assert_eq!(
            s.limits.usage_limit("claude", "seven_day").unwrap().hard,
            Some(60.0)
        );
        s.limits.usage.get_mut("claude_seven_day").unwrap().hard = Some(101.0);
        assert!(s.check().is_err());
    }

    #[test]
    fn codex_usage_stays_aggregated_without_duplicate_warnings() {
        let app = app_with_two_projects();
        app.record_usage("codex", "primary (10080m)", 85.0, None)
            .unwrap();
        app.record_usage("codex", "codex primary", 80.0, None)
            .unwrap();
        let st = app.lock();
        let checks = st
            .usage_checks(&Settings::default().limits, "codex", None)
            .unwrap();
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].value, 85.0);
        assert!(checks[0].over(checks[0].lim.soft));
    }

    #[test]
    fn auto_resume_follows_each_projects_setting() {
        let app = app_with_two_projects();
        custom(&app, 1, |s| s.auto_resume = false);
        {
            let st = app.lock();
            st.db
                .execute(
                    "UPDATE agents SET state='paused', pause_reason='limit', pause_from='idle', paused_at=?1",
                    [now() - 60],
                )
                .unwrap();
        }
        set_usage(&app, 10.0);
        app.tick().unwrap();
        assert_eq!(state(&app, 1), ("paused".into(), Some("limit".into())));
        assert_eq!(state(&app, 2), ("idle".into(), None));
    }

    #[test]
    fn subscription_stops_without_hard_limits_need_fresh_confirmed_usage() {
        let app = app_with_two_projects();
        custom(&app, 1, |s| s.limits.usage.clear());
        app.limit_hit(1, "subscription exhausted").unwrap();
        drop(app.wait_stopped(app.lock(), &[1]));
        {
            let st = app.lock();
            st.db
                .execute("UPDATE usage SET resets_at=?1", [now() - 10])
                .unwrap();
        }
        app.tick().unwrap();
        assert_eq!(state(&app, 1).0, "paused");
        crate::usage::finish(&app, "claude", 120, Err("status unavailable".into())).unwrap();
        app.tick().unwrap();
        assert_eq!(state(&app, 1).0, "paused");
        app.lock()
            .db
            .execute(
                "INSERT INTO usage_checks(provider,attempted_at) VALUES('claude',?1)",
                [now() - 1],
            )
            .unwrap();
        // A check that started before the interruption must not clear its marker.
        crate::usage::finish(
            &app,
            "claude",
            120,
            Ok(vec![crate::usage::Window {
                name: "five_hour".into(),
                used: 0.0,
                reset: Some(now() + 60),
            }]),
        )
        .unwrap();
        app.tick().unwrap();
        assert_eq!(state(&app, 1).0, "paused");
        {
            let st = app.lock();
            st.db
                .execute("UPDATE usage SET at=?1 WHERE win='limit'", [now() - 1])
                .unwrap();
            st.db
                .execute(
                    "UPDATE usage_checks SET attempted_at=?1 WHERE provider='claude'",
                    [now()],
                )
                .unwrap();
        }
        crate::usage::finish(
            &app,
            "claude",
            120,
            Ok(vec![crate::usage::Window {
                name: "five_hour".into(),
                used: 0.0,
                reset: Some(now() + 60),
            }]),
        )
        .unwrap();
        app.tick().unwrap();
        assert_eq!(state(&app, 1).0, "idle");
    }

    #[test]
    fn automatic_recovery_waits_for_an_active_slot() {
        let app = app_with_two_projects();
        custom(&app, 1, |s| s.limits.active.hard = Some(1.0));
        {
            let st = app.lock();
            st.db.execute("UPDATE agents SET project=1,state='paused',pause_reason='limit',pause_from='idle',paused_at=?1", [now()-60]).unwrap();
        }
        set_usage(&app, 0.0);
        app.tick().unwrap();
        assert_eq!(state(&app, 1).0, "idle");
        assert_eq!(state(&app, 2).0, "paused");
        app.tick().unwrap();
        assert_eq!(state(&app, 2).0, "paused");
        app.lock()
            .db
            .execute("UPDATE agents SET state='closed' WHERE id=1", [])
            .unwrap();
        app.tick().unwrap();
        assert_eq!(state(&app, 2).0, "idle");
    }

    #[test]
    fn guidance_is_literal_and_cannot_remove_the_generated_briefing() {
        let app = app_with_two_projects();
        custom(&app, 1, |s| {
            s.prompts.launch = "Literal {task} {updates} <tag>".into()
        });
        let text = app.briefing(&app.lock(), 1).unwrap();
        assert!(text.contains("Literal {task} {updates} <tag>"));
        assert!(
            text.contains("## Your task")
                && text.contains("## Limits and rules right now")
                && text.contains(GUIDE)
        );
        assert!(
            Settings {
                usage_poll_secs: 0,
                ..Settings::default()
            }
            .check()
            .is_err()
        );
    }

    #[test]
    fn a_full_project_leaves_room_in_another() {
        // The wake line asks no_room for the agent's own project.
        let app = app_with_two_projects();
        custom(&app, 1, |s| {
            s.limits.active = Limit {
                soft: None,
                hard: Some(1.0),
            }
        });
        custom(&app, 2, |s| {
            s.limits.active = Limit {
                soft: None,
                hard: Some(1.0),
            }
        });
        let st = app.lock();
        assert!(st.no_room(1, "claude").unwrap().is_some());
        st.db
            .execute("UPDATE agents SET state='done' WHERE id=2", [])
            .unwrap();
        assert_eq!(st.no_room(2, "claude").unwrap(), None);
    }

    #[test]
    fn members_and_selectors_stay_within_the_project() {
        let st = st();
        let p1 = App::resolve(&st, 1, &["active".into()]).unwrap();
        assert_eq!(p1, [1, 2, 3]);
        assert_eq!(App::resolve(&st, 2, &["working".into()]).unwrap(), [4]);
        let err = App::resolve(&st, 1, &["2,4".into()]).unwrap_err();
        assert_eq!(err.1, "agent 4 is in another project");
    }

    #[test]
    fn the_same_lock_name_is_separate_in_each_project() {
        let mut st = st();
        hold(&st, "build", 1, None);
        st.db
            .execute(
                "INSERT INTO locks(project,name,about,created_at,holder) VALUES(2,'build','x',0,4)",
                [],
            )
            .unwrap();
        st.release_all(1, "test").unwrap();
        let holders: Vec<Option<i64>> = rows(
            &st.db,
            "SELECT holder FROM locks WHERE name='build' ORDER BY project",
            [],
        )
        .unwrap()
        .iter()
        .map(|r| r["holder"].as_i64())
        .collect();
        assert_eq!(holders, [None, Some(4)]);
    }

    #[test]
    fn defaults_skip_permissions_close_on_done_and_allow_the_catalog() {
        let s = Settings::default();
        assert!(s.done_closes);
        let claude = &s.harnesses["claude"];
        assert_eq!(claude.flags, ["--dangerously-skip-permissions"]);
        assert_eq!(claude.model, "claude-opus-5-5");
        assert!(claude.models.contains(&"claude-mythos-5-1".to_string()));
        assert!(s.check().is_ok());
        let st = st();
        assert!(st.limits_text(Some(1)).unwrap().ends_with(
            "When an agent runs `acom done` it's closed: messages wait until the user explicitly reopens it."
        ));
    }

    #[test]
    fn settings_reject_soft_above_hard() {
        let mut s = Settings::default();
        assert!(s.check().is_ok());
        s.limits.context = Limit {
            soft: Some(10.0),
            hard: Some(5.0),
        };
        assert!(s.check().is_err());
        let mut s = Settings::default();
        let codex = s.harnesses.get_mut("codex").unwrap();
        codex.model = "gpt-6-luna".into();
        codex.effort = "ultra".into();
        assert!(
            s.check()
                .unwrap_err()
                .1
                .contains("doesn't support effort ultra")
        );
        let mut s = Settings::default();
        s.limits.usage.insert(
            "<img src=x onerror=alert(1)>".into(),
            Limit {
                soft: None,
                hard: None,
            },
        );
        assert!(s.check().is_err());
    }

    #[test]
    fn self_changes_are_independent_opt_ins_and_validate_before_writing() {
        let app = app_with_two_projects();
        app.lock().db.execute("UPDATE agents SET state='working',model='claude-opus-5-5',effort='medium' WHERE id=1", []).unwrap();
        assert!(
            app.configure_agent(1, 1, None, Some("high"), None, false)
                .is_err()
        );
        assert!(
            app.configure_agent(1, 1, Some("claude-sonnet-5-5"), None, None, false)
                .is_err()
        );
        custom(&app, 1, |s| s.allow_agent_effort_change = true);
        app.configure_agent(1, 1, None, Some("high"), None, false)
            .unwrap();
        assert!(
            app.configure_agent(1, 1, Some("claude-sonnet-5-5"), None, None, false)
                .is_err()
        );
        assert!(
            app.configure_agent(1, 2, None, Some("low"), None, false)
                .is_err()
        );
        assert!(
            app.configure_agent(1, 1, Some("gpt-6-sol"), None, None, false)
                .is_err()
        );
        custom(&app, 1, |s| {
            s.allow_agent_effort_change = true;
            s.allow_agent_model_change = true;
        });
        assert!(
            app.configure_agent(1, 1, Some("unallowed-model"), None, None, false)
                .is_err()
        );
        app.configure_agent(1, 1, Some("claude-sonnet-5-5"), Some("medium"), None, false)
            .unwrap();
        assert_eq!(app.lock().agent(1).unwrap().model, "claude-sonnet-5-5");
        assert_eq!(app.lock().agent(1).unwrap().state, "working");
        // A current-turn event is checked against its launch snapshot, not the queued model.
        app.check_model(1, "claude-opus-5-5", "claude-opus-5-5")
            .unwrap();
        assert_eq!(app.lock().agent(1).unwrap().state, "working");
        app.configure_agent(1, 0, Some("custom-model"), Some("high"), None, false)
            .unwrap();
        assert!(
            app.limits(Some(1)).unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("model allowed; effort allowed")
        );
    }

    fn self_change_app() -> Arc<App> {
        let app = app_with_two_projects();
        app.lock().db.execute("UPDATE agents SET state='working',model='claude-opus-5-5',effort='medium' WHERE id=1",[]).unwrap();
        custom(&app, 1, |s| {
            s.allow_agent_model_change = true;
            s.allow_agent_effort_change = true;
        });
        app
    }

    #[test]
    fn continuation_is_single_slot_and_configuration_is_atomic() {
        let app = self_change_app();
        app.configure_agent(1, 1, None, Some("high"), Some("first instruction"), false)
            .unwrap();
        app.configure_agent(1, 1, None, Some("max"), Some("latest instruction"), false)
            .unwrap();
        app.configure_agent(1, 1, Some("claude-opus-5"), None, None, false)
            .unwrap();
        let before = app.agent_view(1).unwrap();
        assert_eq!(before["continuation"]["text"], "latest instruction");
        app.lock().db.execute_batch("CREATE TRIGGER reject_config_notice BEFORE INSERT ON notices BEGIN SELECT RAISE(ABORT,'failed notice'); END;").unwrap();
        assert!(
            app.configure_agent(1, 1, None, Some("low"), Some("must roll back"), false)
                .is_err()
        );
        let after = app.agent_view(1).unwrap();
        assert_eq!(after["model"], before["model"]);
        assert_eq!(after["effort"], before["effort"]);
        assert_eq!(after["continuation"], before["continuation"]);
    }

    #[test]
    fn followup_queued_after_parent_reap_cleans_remaining_tools_only_after_commit() {
        use std::os::unix::process::CommandExt;
        for replacement in [false, true] {
            let app = self_change_app();
            let mut child = std::process::Command::new("sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .unwrap();
            {
                let mut st = app.lock();
                st.procs.insert(
                    1,
                    Proc {
                        pid: child.id(),
                        stopping: false,
                        model: "claude-opus-5-5".into(),
                        effort: "medium".into(),
                        failure: None,
                    },
                );
                st.reaped.insert(1);
                st.db.execute_batch("CREATE TRIGGER reject_followup_notice BEFORE INSERT ON notices BEGIN SELECT RAISE(ABORT,'failed notice'); END;").unwrap();
            }
            let queue = || {
                if replacement {
                    app.queue_replacement(1, replacement_request()).map(|_| ())
                } else {
                    app.configure_agent(1, 1, None, Some("high"), Some("continue"), false)
                }
            };
            assert!(queue().is_err());
            assert!(child.try_wait().unwrap().is_none());
            app.lock()
                .db
                .execute_batch("DROP TRIGGER reject_followup_notice")
                .unwrap();
            queue().unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(!status.success());
                    break;
                }
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("committed followup did not clean the reaped worker's group");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    #[test]
    fn restart_on_a_new_port_stops_only_the_previous_servers_owned_client() {
        use std::os::unix::process::CommandExt;
        let app = self_change_app();
        std::fs::write(app.home.join("port"), "45678").unwrap();
        let spawn = |url: &str| {
            std::process::Command::new("sleep")
                .arg("30")
                .env("ACOM_ID", "1")
                .env("ACOM_URL", url)
                .env("ACOM_HOME", &app.home)
                .process_group(0)
                .spawn()
                .unwrap()
        };
        let mut owned = spawn("http://127.0.0.1:45678");
        let mut unrelated = spawn("http://127.0.0.1:45679");
        app.lock()
            .db
            .execute("UPDATE agents SET pid=?1 WHERE id=1", [owned.id()])
            .unwrap();
        let home = app.home.clone();
        drop(app);
        let reopened = App::open(home, "http://127.0.0.1:45679".into()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let stopped = loop {
            if let Some(status) = owned.try_wait().unwrap() {
                break !status.success();
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let unrelated_alive = unrelated.try_wait().unwrap().is_none();
        let _ = owned.kill();
        let _ = owned.wait();
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        assert!(stopped, "restart left its old-port client running");
        assert!(
            unrelated_alive,
            "restart killed a different server's client"
        );
        assert_eq!(reopened.agent_view(1).unwrap()["state"], "paused");
    }

    #[test]
    fn restart_stops_workers_already_paused_or_closed_without_changing_their_state() {
        use std::os::unix::process::CommandExt;
        struct OwnedGroup(std::process::Child);
        impl Drop for OwnedGroup {
            fn drop(&mut self) {
                run::kill_group(self.0.id(), libc::SIGKILL);
                let _ = self.0.wait();
            }
        }
        for state in ["paused", "closed"] {
            let app = self_change_app();
            std::fs::write(app.home.join("port"), "45678").unwrap();
            let ready = app.home.join("resists-term");
            let mut child = OwnedGroup(
                std::process::Command::new("/bin/sh")
                    .arg("-c")
                    .arg("trap '' TERM; : > \"$1\"; while :; do /bin/sleep 1; done")
                    .arg("audit-client")
                    .arg(&ready)
                    .env("ACOM_ID", "1")
                    .env("ACOM_URL", "http://127.0.0.1:45678")
                    .env("ACOM_HOME", &app.home)
                    .process_group(0)
                    .spawn()
                    .unwrap(),
            );
            let mut foreign = OwnedGroup(
                std::process::Command::new("sleep")
                    .arg("30")
                    .env("ACOM_ID", "2")
                    .env("ACOM_URL", "http://127.0.0.1:45680")
                    .env("ACOM_HOME", &app.home)
                    .process_group(0)
                    .spawn()
                    .unwrap(),
            );
            let ready_deadline = Instant::now() + Duration::from_secs(3);
            while !ready.exists() && Instant::now() < ready_deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(ready.exists(), "fake worker did not become ready");
            {
                let st = app.lock();
                st.db.execute(
                    "UPDATE agents SET state=?1,pid=?2,pause_reason='user',pause_from='working',paused_at=123 WHERE id=1",
                    params![state,child.0.id()],
                ).unwrap();
                st.db
                    .execute(
                        "UPDATE agents SET state=?1,pid=?2 WHERE id=2",
                        params![state, foreign.0.id()],
                    )
                    .unwrap();
            }
            run::kill_group(child.0.id(), libc::SIGTERM);
            assert!(child.0.try_wait().unwrap().is_none());
            let home = app.home.clone();
            drop(app);
            let reopened = App::open(home, "http://127.0.0.1:45679".into()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            let stopped = loop {
                if let Some(status) = child.0.try_wait().unwrap() {
                    break !status.success();
                }
                if Instant::now() >= deadline {
                    break false;
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            assert!(stopped, "restart left the {state} worker running");
            assert!(
                foreign.0.try_wait().unwrap().is_none(),
                "restart killed a different server's {state} worker"
            );
            let st = reopened.lock();
            let retained: (
                String,
                Option<u32>,
                Option<String>,
                Option<String>,
                Option<i64>,
            ) = st
                .db
                .query_row(
                    "SELECT state,pid,pause_reason,pause_from,paused_at FROM agents WHERE id=1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap();
            assert_eq!(
                retained,
                (
                    state.into(),
                    None,
                    Some("user".into()),
                    Some("working".into()),
                    Some(123)
                )
            );
        }
    }

    #[test]
    fn startup_ownership_preflight_preserves_unmarked_workers_and_saved_data() {
        use std::os::unix::process::CommandExt;
        struct Worker(std::process::Child);
        impl Drop for Worker {
            fn drop(&mut self) {
                run::kill_group(self.0.id(), libc::SIGKILL);
                let _ = self.0.wait();
            }
        }
        let port = 49152 + std::process::id() % 16000;
        let url = format!("http://127.0.0.1:{port}");
        for identity in ["unmarked", "idle-unmarked", "foreign-home", "owned"] {
            let app = self_change_app();
            std::fs::write(app.home.join("port"), port.to_string()).unwrap();
            let ready = app.home.join("preflight-ready");
            let mut command = std::process::Command::new("/bin/sh");
            command
                .args([
                    "-c",
                    "printf ready > \"$1\"; while :; do /bin/sleep 30; done",
                    "preflight-worker",
                ])
                .arg(&ready)
                .env("ACOM_ID", "1")
                .env("ACOM_URL", &url)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .process_group(0);
            match identity {
                "owned" => {
                    command.env("ACOM_HOME", &app.home);
                }
                "foreign-home" => {
                    command.env("ACOM_HOME", app.home.join("another-server"));
                }
                _ => {
                    command.env_remove("ACOM_HOME");
                }
            }
            let mut worker = Worker(command.spawn().unwrap());
            let deadline = Instant::now() + Duration::from_secs(3);
            while !ready.exists() {
                assert!(
                    Instant::now() < deadline,
                    "preflight fixture did not become ready"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            {
                let st = app.lock();
                st.notice(1, "pending notification").unwrap();
                hold(&st, "preflight-held", 1, Some(now() + 120));
                st.db
                    .execute("UPDATE agents SET pid=?1 WHERE id=1", [worker.0.id()])
                    .unwrap();
                st.db.execute_batch("INSERT INTO agent_continuations(agent_id,text) VALUES(1,'pending continuation');
                    INSERT INTO summary_cursors(agent_id,event_id) VALUES(1,0);
                    INSERT INTO usage_checks(provider,in_flight) VALUES('claude',1);").unwrap();
                if identity == "idle-unmarked" {
                    st.db
                        .execute("UPDATE agents SET state='idle',pid=NULL WHERE id=1", [])
                        .unwrap();
                }
            }
            let home = app.home.clone();
            let saved = std::fs::read(home.join("acom.db")).unwrap();
            drop(app);
            let reopened = App::open(home.clone(), "http://127.0.0.1:1".into());
            if identity.ends_with("unmarked") {
                let error = reopened
                    .err()
                    .expect("unmarked live ownership must refuse startup");
                assert_eq!(error.0, 409);
                assert!(error.1.contains(&format!("PID {}", worker.0.id())));
                assert!(error.1.contains("ACOM_HOME is missing"));
                assert!(worker.0.try_wait().unwrap().is_none());
                // Entire persisted database is untouched: schema/revisions,
                // usage flags, PID/state, locks, notices and followups alike.
                assert_eq!(std::fs::read(home.join("acom.db")).unwrap(), saved);
            } else {
                let reopened = reopened.unwrap();
                assert_eq!(reopened.lock().agent(1).unwrap().state, "paused");
                if identity == "foreign-home" {
                    assert!(
                        worker.0.try_wait().unwrap().is_none(),
                        "foreign home was signalled"
                    );
                } else {
                    let deadline = Instant::now() + Duration::from_secs(3);
                    loop {
                        if let Some(status) = worker.0.try_wait().unwrap() {
                            assert!(!status.success());
                            break;
                        }
                        assert!(Instant::now() < deadline, "owned worker survived cleanup");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
        }
    }

    #[test]
    fn restart_cleans_owned_descendant_after_its_worker_leader_was_reaped() {
        use std::os::unix::process::CommandExt;
        struct OwnedGroup(std::process::Child);
        impl Drop for OwnedGroup {
            fn drop(&mut self) {
                run::kill_group(self.0.id(), libc::SIGKILL);
                let _ = self.0.wait();
            }
        }
        for url in ["http://127.0.0.1:45678", "http://127.0.0.1:45680"] {
            let owned = url.ends_with(":45678");
            let app = self_change_app();
            std::fs::write(app.home.join("port"), "45678").unwrap();
            let child_pid = app.home.join("descendant-pid");
            let mut worker = OwnedGroup(
                std::process::Command::new("/bin/sh")
                    .args([
                        "-c",
                        "/bin/sh -c 'printf \"%s\" \"$$\" > \"$1\"; while :; do /bin/sleep 30; done' audit-descendant \"$1\" &",
                        "audit-worker",
                    ])
                    .arg(&child_pid)
                    .env("ACOM_ID", "1")
                    .env("ACOM_URL", url)
                    .env("ACOM_HOME", &app.home)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .process_group(0)
                    .spawn()
                    .unwrap(),
            );
            let group = worker.0.id();
            assert!(worker.0.wait().unwrap().success());
            // The surviving shell writes readiness after exec and stays alive.
            // A parent's child PID can otherwise precede an exec/environment gap.
            let deadline = Instant::now() + Duration::from_secs(3);
            let descendant: u32 = loop {
                if let Some(pid) = std::fs::read_to_string(&child_pid)
                    .ok()
                    .and_then(|text| text.parse().ok())
                {
                    break pid;
                }
                assert!(Instant::now() < deadline, "descendant did not become ready");
                std::thread::sleep(Duration::from_millis(5));
            };
            assert!(!run::is_our_agent(group, 1, url));
            assert!(run::is_our_agent(descendant, 1, url));
            // Matching environment in a different group must not authorize
            // killing the foreign descendant's persisted process group.
            let mut matching_elsewhere = if owned {
                None
            } else {
                Some(OwnedGroup(
                    std::process::Command::new("/bin/sleep")
                        .arg("30")
                        .env("ACOM_ID", "1")
                        .env("ACOM_URL", "http://127.0.0.1:45678")
                        .env("ACOM_HOME", app.home.join("another-server"))
                        .process_group(0)
                        .spawn()
                        .unwrap(),
                ))
            };
            if let Some(child) = matching_elsewhere.as_ref() {
                let deadline = Instant::now() + Duration::from_secs(3);
                while !run::is_our_agent(child.0.id(), 1, "http://127.0.0.1:45678")
                    && Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                assert!(run::is_our_agent(child.0.id(), 1, "http://127.0.0.1:45678"));
                assert_ne!(child.0.id(), group);
            }
            assert_eq!(
                run::is_our_agent_group(group, 1, "http://127.0.0.1:45678"),
                owned
            );
            app.lock()
                .db
                .execute("UPDATE agents SET pid=?1 WHERE id=1", [group])
                .unwrap();
            let home = app.home.clone();
            drop(app);
            let reopened = App::open(home, "http://127.0.0.1:45679".into()).unwrap();
            assert_eq!(reopened.agent_view(1).unwrap()["state"], "paused");
            let running = || {
                std::fs::read_to_string(format!("/proc/{descendant}/stat"))
                    .ok()
                    .and_then(|s| s.rsplit_once(") ").map(|(_, rest)| !rest.starts_with('Z')))
                    .unwrap_or(false)
            };
            let deadline = Instant::now() + Duration::from_secs(3);
            while owned && running() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(
                running(),
                !owned,
                "restart handled descendant {descendant} of reaped leader {group} incorrectly"
            );
            if let Some(child) = matching_elsewhere.as_mut() {
                assert!(
                    child.0.try_wait().unwrap().is_none(),
                    "restart killed matching environment in a different process group"
                );
            }
        }
    }

    #[test]
    fn continuation_requires_permission_valid_instruction_and_unfinished_turn() {
        let app = self_change_app();
        for instruction in ["", "   "] {
            assert!(
                app.configure_agent(1, 1, None, Some("high"), Some(instruction), false)
                    .is_err()
            );
        }
        assert!(
            app.configure_agent(1, 1, None, Some("high"), Some(&"x".repeat(16001)), false)
                .is_err()
        );
        custom(&app, 1, |s| {
            s.allow_agent_model_change = false;
            s.allow_agent_effort_change = false;
        });
        assert!(
            app.configure_agent(1, 1, None, Some("medium"), Some("continue"), false)
                .is_err()
        );
        custom(&app, 1, |s| s.allow_agent_effort_change = true);
        app.configure_agent(1, 1, None, Some("high"), Some("continue"), false)
            .unwrap();
        app.mark_done(1).unwrap();
        assert!(app.agent_view(1).unwrap()["continuation"].is_null());
        assert!(
            app.configure_agent(1, 1, None, Some("high"), Some("continue"), false)
                .is_err()
        );
        app.lock()
            .db
            .execute("UPDATE agents SET state='idle',done_req=0 WHERE id=1", [])
            .unwrap();
        assert!(
            app.configure_agent(1, 0, None, Some("high"), Some("continue"), false)
                .is_err()
        );
    }

    #[test]
    fn blocked_continuation_persists_but_restart_during_work_cancels() {
        let app = self_change_app();
        app.configure_agent(1, 1, None, Some("high"), Some("continue"), false)
            .unwrap();
        custom(&app, 1, |s| {
            s.harnesses.get_mut("claude").unwrap().enabled = false
        });
        app.turn_ended(1, 0, true, None).unwrap();
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "idle");
        assert!(
            view["continuation"]["blocked"]
                .as_str()
                .unwrap()
                .contains("no longer allowed")
        );
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        app.tick().unwrap();
        assert_eq!(
            app.agent_view(1).unwrap()["continuation"]["text"],
            "continue"
        );
        app.lock()
            .db
            .execute("UPDATE agents SET state='working' WHERE id=1", [])
            .unwrap();
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        assert_eq!(app.agent_view(1).unwrap()["state"], "paused");
        assert!(app.agent_view(1).unwrap()["continuation"].is_null());
    }

    #[test]
    fn failed_continuation_start_cancels_instead_of_spinning() {
        let app = self_change_app();
        app.lock()
            .db
            .execute(
                "UPDATE agents SET session_started=1,session_id='test-session' WHERE id=1",
                [],
            )
            .unwrap();
        app.configure_agent(1, 1, None, Some("high"), Some("continue"), false)
            .unwrap();
        app.turn_ended(1, 0, true, None).unwrap();
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "idle");
        assert!(view["continuation"].is_null());
        assert!(view["problem"].as_str().unwrap().contains("can't start"));
        app.tick().unwrap();
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn continuation_never_silently_loses_a_missing_native_session() {
        let app = self_change_app();
        app.configure_agent(1, 1, None, Some("high"), Some("continue"), false)
            .unwrap();
        app.turn_ended(1, 0, true, None).unwrap();
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "idle");
        assert!(view["continuation"].is_null());
        assert!(
            view["problem"]
                .as_str()
                .unwrap()
                .contains("did not record a native session")
        );
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn between_turn_usage_pause_preserves_pending_continuation_until_explicit_close() {
        let app = self_change_app();
        app.configure_agent(1, 1, None, Some("high"), Some("continue"), false)
            .unwrap();
        custom(&app, 1, |s| {
            s.harnesses.get_mut("claude").unwrap().enabled = false
        });
        app.turn_ended(1, 0, true, None).unwrap();
        set_usage(&app, 100.0);
        app.tick().unwrap();
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "paused");
        assert_eq!(view["continuation"]["text"], "continue");
        drop(app.wait_stopped(app.lock(), &[1]));
        app.close(1, "user").unwrap();
        assert!(app.agent_view(1).unwrap()["continuation"].is_null());
    }

    #[test]
    fn failed_followup_cleanup_rolls_back_request_state_and_history_together() {
        let app = self_change_app();
        app.configure_agent(1, 1, None, Some("high"), Some("continue"), false)
            .unwrap();
        let mut st = app.lock();
        st.set_state(1, "idle").unwrap();
        st.db
            .execute(
                "UPDATE agent_continuations SET attempted=1 WHERE agent_id=1",
                [],
            )
            .unwrap();
        let before = rows(&st.db, "SELECT * FROM events ORDER BY id", []).unwrap();
        st.db.execute_batch("CREATE TRIGGER reject_failure_notice BEFORE INSERT ON notices BEGIN SELECT RAISE(ABORT,'failed notice'); END;").unwrap();
        assert!(App::failed_followup(&mut st, 1, "Continuation", "missing client").is_err());
        assert_eq!(st.agent(1).unwrap().state, "idle");
        assert_eq!(
            rows(
                &st.db,
                "SELECT * FROM agent_continuations WHERE agent_id=1",
                []
            )
            .unwrap()
            .len(),
            1
        );
        assert!(st.agent(1).unwrap().problem.is_none());
        assert_eq!(
            rows(&st.db, "SELECT * FROM events ORDER BY id", []).unwrap(),
            before
        );
        assert_eq!(
            st.db
                .query_row(
                    "SELECT attempted FROM agent_continuations WHERE agent_id=1",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        drop(st);
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        // No client is needed for this retry: only cancellation persistence runs.
        assert!(app.tick().unwrap_err().1.contains("failed notice"));
        let mut st = app.lock();
        assert_eq!(
            rows(&st.db, "SELECT * FROM events ORDER BY id", []).unwrap(),
            before
        );
        st.db
            .execute_batch("DROP TRIGGER reject_failure_notice")
            .unwrap();
        App::failed_followup(&mut st, 1, "Continuation", "missing client").unwrap();
        assert!(
            rows(
                &st.db,
                "SELECT * FROM agent_continuations WHERE agent_id=1",
                []
            )
            .unwrap()
            .is_empty()
        );
        assert_eq!(st.agent(1).unwrap().state, "idle");
    }

    #[test]
    fn crash_guard_uses_actual_running_model_and_retained_own_history() {
        let app = self_change_app();
        {
            let mut st = app.lock();
            st.db
                .execute(
                    "UPDATE agents SET model='claude-opus-5',effort='low' WHERE id=1",
                    [],
                )
                .unwrap();
            st.procs.insert(
                1,
                Proc {
                    pid: 0,
                    stopping: false,
                    model: "claude-opus-5-5".into(),
                    effort: "high".into(),
                    failure: Some("network failure".into()),
                },
            );
        }
        app.turn_ended(1, 0, true, None).unwrap();
        app.lock().db.execute("UPDATE agents SET state='working',model='claude-opus-5',effort='medium' WHERE id=1",[]).unwrap();
        app.lock()
            .db
            .execute("DELETE FROM agent_retries", [])
            .unwrap();
        let before = rows(&app.lock().db, "SELECT * FROM events ORDER BY id", []).unwrap();
        let error = app
            .configure_agent(1, 1, Some("claude-opus-5-5"), None, Some("continue"), false)
            .unwrap_err();
        assert_eq!(error.0, 409);
        assert!(
            error
                .1
                .starts_with("Previous crashes for claude/claude-opus-5-5")
        );
        assert!(error.1.contains("network failure"));
        assert_eq!(
            rows(&app.lock().db, "SELECT * FROM events ORDER BY id", []).unwrap(),
            before
        );
        assert!(
            app.check_previous_crashes(&app.lock(), 2, "claude", "claude-opus-5-5")
                .is_ok()
        );
        assert!(
            app.check_previous_crashes(&app.lock(), 1, "codex", "claude-opus-5-5")
                .is_ok()
        );
        assert!(
            app.check_previous_crashes(&app.lock(), 1, "claude", "claude-opus-5")
                .is_ok()
        );
        app.configure_agent(1, 1, Some("claude-opus-5-5"), None, Some("continue"), true)
            .unwrap();
        // Staying on the actual running model is not selecting a different model.
        app.configure_agent(1, 1, None, Some("max"), None, false)
            .unwrap();
    }

    #[test]
    fn unrelated_agents_and_new_helpers_do_not_inherit_crash_warnings() {
        let app = self_change_app();
        {
            let st = app.lock();
            st.db.execute("UPDATE agents SET project=1,state='working',model='claude-opus-5',effort='medium'", []).unwrap();
            st.event(
                1,
                Some(1),
                None,
                "agent.failed",
                "acom",
                json!({"harness":"claude","model":"claude-opus-5-5","reason":"agent one's crash"}),
            )
            .unwrap();
        }
        app.configure_agent(2, 2, Some("claude-opus-5-5"), None, None, false)
            .unwrap();
        let error = app
            .configure_agent(1, 1, Some("claude-opus-5-5"), None, None, false)
            .unwrap_err();
        assert!(error.1.contains("agent one's crash"));
        let mut st = app.lock();
        for done in [false, true] {
            let mut req = replacement_request();
            req.harness = Some("claude".into());
            req.model = Some("claude-opus-5-5".into());
            req.done = done;
            st.db.execute_batch("SAVEPOINT independent_launch").unwrap();
            let result = app.prepare_launch(&mut st, 1, None, None, req, false);
            st.db
                .execute_batch("ROLLBACK TO independent_launch; RELEASE independent_launch")
                .unwrap();
            assert!(
                result.is_ok(),
                "new independent launch must not inherit caller crashes: {result:?}"
            );
        }
    }

    #[test]
    fn crash_history_follows_only_committed_replacement_ancestors_and_survives_restart() {
        let app = self_change_app();
        {
            let st = app.lock();
            st.db.execute_batch("UPDATE agents SET project=1 WHERE id=2;
                INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES
                (3,1,'successor','t','codex','gpt-6-sol','medium','working',1,0),
                (4,1,'next successor','t','claude','claude-opus-5','medium','working',3,0),
                (5,1,'independent helper','t','claude','claude-opus-5','medium','working',1,0);").unwrap();
            st.event(
                1,
                Some(1),
                None,
                "agent.failed",
                "acom",
                json!({"harness":"claude","model":"claude-opus-5-5","reason":"own ancestor crash"}),
            )
            .unwrap();
            st.event(
                1,
                Some(2),
                None,
                "agent.failed",
                "acom",
                json!({"harness":"claude","model":"claude-opus-5-5","reason":"unrelated crash"}),
            )
            .unwrap();
            st.event(
                1,
                Some(3),
                None,
                "agent.replacement",
                "acom",
                json!({"predecessor":1}),
            )
            .unwrap();
            st.event(
                1,
                Some(4),
                None,
                "agent.replacement",
                "acom",
                json!({"predecessor":3}),
            )
            .unwrap();
            st.event(
                1,
                Some(4),
                None,
                "agent.failed",
                "acom",
                json!({"harness":"codex","model":"gpt-6-sol","reason":"descendant crash"}),
            )
            .unwrap();
            // Created/queued metadata is not evidence of a completed replacement.
            st.event(
                1,
                Some(5),
                None,
                "agent.created",
                "agent 1",
                json!({"predecessor":1}),
            )
            .unwrap();
            st.event(
                1,
                Some(5),
                None,
                "agent.replacement-queued",
                "agent 5",
                json!({"predecessor":1}),
            )
            .unwrap();
            assert!(
                app.check_previous_crashes(&st, 5, "claude", "claude-opus-5-5")
                    .is_ok()
            );
            assert!(
                app.check_previous_crashes(&st, 1, "codex", "gpt-6-sol")
                    .is_ok()
            );
        }
        let mut req = replacement_request();
        req.harness = Some("claude".into());
        req.model = Some("claude-opus-5-5".into());
        let before = rows(&app.lock().db, "SELECT * FROM events ORDER BY id", []).unwrap();
        let error = app.queue_replacement(3, req.clone()).unwrap_err();
        assert_eq!(error.0, 409);
        assert!(error.1.contains("own ancestor crash"));
        assert!(!error.1.contains("unrelated crash"));
        assert_eq!(
            rows(&app.lock().db, "SELECT * FROM events ORDER BY id", []).unwrap(),
            before
        );
        assert_eq!(
            app.lock()
                .db
                .query_row("SELECT count(*) FROM agents", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            5
        );
        assert!(!app.lock().agent(3).unwrap().done_req);
        req.ack_crashes = true;
        app.queue_replacement(3, req).unwrap();
        let error = app
            .configure_agent(4, 4, Some("claude-opus-5-5"), None, None, false)
            .unwrap_err();
        assert!(error.1.contains("own ancestor crash"));
        assert!(!error.1.contains("unrelated crash"));
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        let error = app
            .check_previous_crashes(&app.lock(), 4, "claude", "claude-opus-5-5")
            .unwrap_err();
        assert!(error.1.contains("own ancestor crash"));
        assert!(!error.1.contains("unrelated crash"));
    }

    fn replacement_request() -> LaunchReq {
        LaunchReq {
            task: "remaining work".into(),
            harness: Some("codex".into()),
            model: Some("gpt-6-sol".into()),
            effort: Some("high".into()),
            name: None,
            group: None,
            force: false,
            done: false,
            ack_crashes: false,
        }
    }

    #[test]
    fn replacement_is_staged_without_identity_or_slot_release_and_can_be_cancelled() {
        let app = self_change_app();
        app.configure_agent(1, 1, None, Some("high"), Some("continue"), false)
            .unwrap();
        app.queue_replacement(1, replacement_request()).unwrap();
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "working");
        assert_eq!(view["done_req"], 0);
        assert!(view["continuation"].is_null());
        assert_eq!(view["replacement_request"]["model"], "gpt-6-sol");
        assert_eq!(app.agents(None, None).unwrap().len(), 2);
        assert!(app.queue_replacement(1, replacement_request()).is_err());
        assert!(
            app.configure_agent(1, 1, None, Some("max"), None, false)
                .is_err()
        );
        app.mark_done(1).unwrap();
        assert!(app.agent_view(1).unwrap()["replacement_request"].is_null());
    }

    #[test]
    fn failed_replacement_start_is_owned_by_durable_successor() {
        let app = self_change_app();
        app.queue_replacement(1, replacement_request()).unwrap();
        app.turn_ended(1, 0, true, None).unwrap();
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "replaced");
        let new = view["replacement"].as_i64().unwrap();
        assert!(view["replacement_request"].is_null());
        assert!(view["retry"].is_null());
        let successor = app.agent_view(new).unwrap();
        assert_eq!(successor["state"], "crashed");
        assert_eq!(successor["retry"]["source"], "gpt-6-sol");
        assert_eq!(successor["retry"]["effort"], "high");
        assert_eq!(successor["retry"]["handled"], 0);
        assert!(successor["replacement_start"].is_null());
        assert!(
            successor["problem"]
                .as_str()
                .unwrap()
                .contains("can't start")
        );
        assert_eq!(app.agents(None, None).unwrap().len(), 3);
        assert_eq!(
            rows(
                &app.lock().db,
                "SELECT * FROM events WHERE kind='agent.replaced'",
                []
            )
            .unwrap()
            .len(),
            1
        );
        assert!(app.resume(1, "user").is_err());
        assert!(app.reopen(1, "user").is_err());
        app.tick().unwrap();
        assert_eq!(app.agent_view(new).unwrap()["state"], "crashed");
    }

    fn waiting_replacement_app() -> (Arc<App>, i64) {
        let app = self_change_app();
        app.queue_replacement(1, replacement_request()).unwrap();
        custom(&app, 1, |s| {
            s.harnesses.get_mut("codex").unwrap().enabled = false
        });
        app.turn_ended(1, 0, true, None).unwrap();
        let new = app.agent_view(1).unwrap()["replacement"].as_i64().unwrap();
        (app, new)
    }

    #[test]
    fn replacement_waiting_owns_work_without_active_slot_or_false_live_joins() {
        let app = self_change_app();
        let (tid, _) = app
            .new_thread(
                0,
                Some(1),
                "active audience",
                &[],
                false,
                &["active".into()],
            )
            .unwrap();
        app.queue_replacement(1, replacement_request()).unwrap();
        custom(&app, 1, |s| {
            s.harnesses.get_mut("codex").unwrap().enabled = false
        });
        app.turn_ended(1, 0, true, None).unwrap();
        let new = app.agent_view(1).unwrap()["replacement"].as_i64().unwrap();
        let view = app.agent_view(new).unwrap();
        assert_eq!(view["state"], "done");
        assert_eq!(view["replacement_start"]["predecessor"], 1);
        assert!(
            view["replacement_start"]["blocked"]
                .as_str()
                .unwrap()
                .contains("disabled")
        );
        let st = app.lock();
        assert_eq!(st.active_counts(Some(1)).unwrap().0, 0);
        assert!(
            rows(
                &st.db,
                "SELECT * FROM member_intervals WHERE thread_id=?1 AND agent_id=?2",
                params![tid, new]
            )
            .unwrap()
            .is_empty()
        );
        assert!(st.procs.is_empty());
    }

    #[test]
    fn waiting_successor_survives_restart_and_user_pause_close_without_waking_source() {
        let (app, new) = waiting_replacement_app();
        app.pause(new, "user").unwrap();
        app.tick().unwrap();
        assert_eq!(app.agent_view(new).unwrap()["state"], "paused");
        assert_eq!(
            app.agent_view(new).unwrap()["replacement_start"]["predecessor"],
            1
        );
        app.resume(new, "user").unwrap();
        assert_eq!(app.agent_view(new).unwrap()["state"], "done");
        app.close(new, "user").unwrap();
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        app.tick().unwrap();
        assert_eq!(app.agent_view(new).unwrap()["state"], "closed");
        app.reopen(new, "user").unwrap();
        assert_eq!(app.agent_view(new).unwrap()["state"], "done");
        assert_eq!(app.agent_view(1).unwrap()["state"], "replaced");
        assert_eq!(app.agents(None, None).unwrap().len(), 3);
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn ownership_commit_failure_retains_request_and_retries_without_orphans() {
        let app = self_change_app();
        app.queue_replacement(1, replacement_request()).unwrap();
        app.lock().db.execute_batch("CREATE TRIGGER reject_ownership BEFORE INSERT ON events WHEN NEW.kind='agent.replaced' BEGIN SELECT RAISE(ABORT,'ownership failed'); END;").unwrap();
        app.turn_ended(1, 0, true, None).unwrap();
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "done");
        assert!(view["replacement"].is_null());
        assert_eq!(
            view["replacement_request"]["blocked"],
            "database: ownership failed"
        );
        assert_eq!(app.agents(None, None).unwrap().len(), 2);
        app.tick().unwrap();
        assert_eq!(app.agents(None, None).unwrap().len(), 2);
        app.lock()
            .db
            .execute_batch("DROP TRIGGER reject_ownership")
            .unwrap();
        app.tick().unwrap();
        assert_eq!(app.agent_view(1).unwrap()["state"], "replaced");
        assert_eq!(app.agents(None, None).unwrap().len(), 3);
    }

    #[test]
    fn startup_failure_persistence_is_atomic_and_restart_never_duplicates_first_attempt() {
        let app = self_change_app();
        app.queue_replacement(1, replacement_request()).unwrap();
        app.lock().db.execute_batch("CREATE TRIGGER reject_start_failure BEFORE DELETE ON agent_starts BEGIN SELECT RAISE(ABORT,'failure persistence'); END;").unwrap();
        app.turn_ended(1, 0, true, None).unwrap();
        let new = app.agent_view(1).unwrap()["replacement"].as_i64().unwrap();
        let view = app.agent_view(new).unwrap();
        assert_eq!(view["state"], "done");
        assert_eq!(view["replacement_start"]["attempted"], 1);
        assert!(view["retry"].is_null());
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        assert!(app.tick().is_err());
        assert!(app.lock().procs.is_empty());
        app.lock()
            .db
            .execute_batch("DROP TRIGGER reject_start_failure")
            .unwrap();
        app.tick().unwrap();
        assert_eq!(app.agent_view(new).unwrap()["state"], "crashed");
        assert_eq!(app.agent_view(1).unwrap()["state"], "replaced");
        app.tick().unwrap();
        assert_eq!(
            rows(
                &app.lock().db,
                "SELECT * FROM events WHERE agent=?1 AND kind='agent.failed'",
                [new]
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn disarmed_handoff_becomes_successor_failure_without_implicit_start() {
        let app = self_change_app();
        app.queue_replacement(1, replacement_request()).unwrap();
        {
            let st = app.lock();
            st.set_state(1, "done").unwrap();
            st.db.execute("UPDATE agent_handoffs SET attempted=1,blocked='interrupted startup' WHERE agent_id=1",[]).unwrap();
        }
        app.tick().unwrap();
        let new = app.agent_view(1).unwrap()["replacement"].as_i64().unwrap();
        let view = app.agent_view(new).unwrap();
        assert_eq!(view["state"], "crashed");
        assert_eq!(view["turns"], 0);
        assert_eq!(view["problem"], "interrupted startup");
        assert_eq!(app.agent_view(1).unwrap()["state"], "replaced");
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn successor_startup_failure_uses_its_bounded_retry_chain() {
        let app = self_change_app();
        custom(&app, 1, |s| {
            s.allow_agent_model_change = true;
            s.crash_retries.insert(
                "gpt-6-sol".into(),
                RetryRule {
                    harness: "claude".into(),
                    model: "claude-opus-5".into(),
                    same_model_retries: 1,
                },
            );
        });
        app.queue_replacement(1, replacement_request()).unwrap();
        app.turn_ended(1, 0, true, None).unwrap();
        let new = app.agent_view(1).unwrap()["replacement"].as_i64().unwrap();
        app.lock()
            .db
            .execute(
                "UPDATE agent_retries SET eligible_at=0 WHERE agent_id=?1",
                [new],
            )
            .unwrap();
        app.tick().unwrap();
        assert_eq!(
            app.agent_view(new).unwrap()["retry"]["same_model_attempts"],
            1
        );
        assert_eq!(app.agent_view(new).unwrap()["state"], "crashed");
        app.lock()
            .db
            .execute(
                "UPDATE agent_retries SET eligible_at=0 WHERE agent_id=?1",
                [new],
            )
            .unwrap();
        app.tick().unwrap();
        let later = app.agent_view(new).unwrap()["replacement"]
            .as_i64()
            .unwrap();
        assert_eq!(app.agent_view(new).unwrap()["state"], "replaced");
        assert_eq!(app.agent_view(later).unwrap()["state"], "crashed");
        assert_eq!(
            app.agent_view(later).unwrap()["retry"]["source"],
            "claude-opus-5"
        );
        assert_eq!(app.agent_view(1).unwrap()["replacement"], new);
        assert_eq!(app.agents(None, None).unwrap().len(), 4);
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn failed_retry_failure_save_stops_visibly_without_repeating_the_invocation() {
        let app = self_change_app();
        custom(&app, 1, |s| {
            s.crash_retries.insert(
                "claude-opus-5-5".into(),
                RetryRule {
                    harness: "claude".into(),
                    model: "claude-opus-5".into(),
                    same_model_retries: 1,
                },
            );
        });
        record_test_crash(&app, 1);
        app.lock().db.execute_batch("CREATE TRIGGER reject_failure_event BEFORE INSERT ON events WHEN NEW.kind='agent.failed' BEGIN SELECT RAISE(ABORT,'failure write rejected'); END;").unwrap();
        app.tick().unwrap();
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "crashed");
        assert_eq!(view["retry"]["handled"], 1);
        assert_eq!(view["retry"]["same_model_attempts"], 1);
        assert!(
            view["retry"]["blocked"]
                .as_str()
                .unwrap()
                .contains("Could not record crash recovery")
        );
        assert_eq!(view["problem"], view["retry"]["blocked"]);
        app.lock()
            .db
            .execute_batch("DROP TRIGGER reject_failure_event")
            .unwrap();
        app.tick().unwrap();
        assert_eq!(app.agent_view(1).unwrap()["retry"], view["retry"]);
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn replacement_queue_and_wait_reason_invalidate_matching_overview_and_agent_pages() {
        let app = self_change_app();
        let before = app
            .agents_page(Some(1), None, PageQuery::default())
            .unwrap();
        app.queue_replacement(1, replacement_request()).unwrap();
        let queued = app
            .agents_page(Some(1), None, PageQuery::default())
            .unwrap();
        assert_ne!(before["revision"], queued["revision"]);
        assert_eq!(
            queued["revision"],
            app.overview(Some(1), None).unwrap()["revisions"]["agents"]
        );
        assert_eq!(queued["items"][0]["replacement_pending"], true);
        custom(&app, 1, |s| {
            s.harnesses.get_mut("codex").unwrap().enabled = false
        });
        app.turn_ended(1, 0, true, None).unwrap();
        let waiting = app
            .agents_page(Some(1), None, PageQuery::default())
            .unwrap();
        assert_eq!(waiting["items"][0]["replacement_start_pending"], true);
        assert_eq!(
            waiting["revision"],
            app.overview(Some(1), None).unwrap()["revisions"]["agents"]
        );
        let new = app.agent_view(1).unwrap()["replacement"].as_i64().unwrap();
        app.lock()
            .db
            .execute(
                "UPDATE agent_starts SET blocked='a changed reason' WHERE agent_id=?1",
                [new],
            )
            .unwrap();
        assert_ne!(
            waiting["revision"],
            app.agents_page(Some(1), None, PageQuery::default())
                .unwrap()["revision"]
        );
    }

    #[test]
    fn failed_turn_cancels_replacement_without_fabricating_success() {
        let app = self_change_app();
        app.queue_replacement(1, replacement_request()).unwrap();
        app.turn_ended(1, 0, false, Some("temporary failure"))
            .unwrap();
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "crashed");
        assert!(view["replacement_request"].is_null());
        assert!(view["replacement"].is_null());
        assert_eq!(app.agents(None, None).unwrap().len(), 2);
    }

    #[test]
    fn old_settings_do_not_enable_self_changes_or_retry_rules() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        for key in [
            "allow_agent_model_change",
            "allow_agent_effort_change",
            "crash_retries",
        ] {
            old.as_object_mut().unwrap().remove(key);
        }
        old["limits"]["usage"]
            .as_object_mut()
            .unwrap()
            .remove("claude_seven_day_fable");
        let restored: Settings = serde_json::from_value(old).unwrap();
        assert!(!restored.allow_agent_model_change && !restored.allow_agent_effort_change);
        assert!(restored.crash_retries.is_empty());
        assert!(
            restored
                .limits
                .usage_limit("claude", "seven_day_fable")
                .is_none()
        );
    }

    #[test]
    fn retry_count_must_be_a_nonnegative_u32() {
        for count in [json!(-1), json!(0.5), json!(4294967296u64)] {
            assert!(
                serde_json::from_value::<RetryRule>(
                    json!({"harness":"codex", "model":"gpt-6-luna", "same_model_retries":count})
                )
                .is_err()
            );
        }
    }

    #[test]
    fn recovery_effort_uses_only_documented_conversions() {
        for (harness, model, inherited, expected) in [
            ("codex", "gpt-6-luna", "ultra", "max"),
            ("codex", "gpt-5.6-luna", "ultra", "max"),
            ("claude", "claude-opus-5-5", "ultra", "max"),
            ("claude", "claude-haiku-4-5", "ultra", "medium"),
            ("claude", "claude-haiku-4-5", "high", "medium"),
            ("claude", "claude-sonnet-5-5", "high", "high"),
            ("codex", "gpt-6-sol", "ultra", "ultra"),
            ("codex", "custom-model", "ultra", "ultra"),
            ("codex", "gpt-6-luna", "unknown", "unknown"),
        ] {
            assert_eq!(recovery_effort(harness, model, inherited), expected);
        }
    }

    #[test]
    fn failed_turns_capture_running_choices_and_wait_before_recovery() {
        let app = app_with_two_projects();
        {
            let mut st = app.lock();
            st.db.execute("UPDATE agents SET state='working',harness='codex',model='gpt-6-luna',effort='low',done_req=1 WHERE id=1", []).unwrap();
            st.procs.insert(
                1,
                Proc {
                    pid: 0,
                    stopping: false,
                    model: "gpt-6-sol".into(),
                    effort: "ultra".into(),
                    failure: None,
                },
            );
        }
        app.fail_turn(1, "network failure").unwrap();
        app.fail_turn(1, "duplicate event").unwrap();
        app.tick().unwrap(); // Live process cannot be retried.
        assert!(app.agent_view(1).unwrap()["retry"].is_null());
        app.turn_ended(1, 0, true, None).unwrap(); // Explicit failed turn with successful exit.
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "crashed");
        assert_eq!(view["problem"], "network failure");
        assert_eq!(view["retry"]["source"], "gpt-6-sol");
        assert_eq!(view["retry"]["effort"], "ultra");
        assert!(view["retry"]["eligible_at"].as_i64().unwrap() > now());
        app.tick().unwrap();
        assert!(app.lock().procs.is_empty()); // No rule, no automatic launch.
    }

    #[test]
    fn retry_counters_persist_reset_on_source_change_success_and_manual_resume() {
        let app = app_with_two_projects();
        app.lock()
            .db
            .execute(
                "UPDATE agents SET harness='codex',model='gpt-6-sol',effort='medium' WHERE id=1",
                [],
            )
            .unwrap();
        record_test_crash(&app, 1);
        app.lock()
            .db
            .execute(
                "UPDATE agent_retries SET same_model_attempts=2,handled=1 WHERE agent_id=1",
                [],
            )
            .unwrap();
        record_test_crash(&app, 1);
        assert_eq!(
            app.agent_view(1).unwrap()["retry"]["same_model_attempts"],
            2
        );
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        assert_eq!(
            app.agent_view(1).unwrap()["retry"]["same_model_attempts"],
            2
        );
        app.lock()
            .db
            .execute("UPDATE agents SET model='gpt-6-luna' WHERE id=1", [])
            .unwrap();
        record_test_crash(&app, 1);
        assert_eq!(
            app.agent_view(1).unwrap()["retry"]["same_model_attempts"],
            0
        );
        app.lock()
            .db
            .execute("UPDATE agents SET state='working' WHERE id=1", [])
            .unwrap();
        app.turn_ended(1, 0, true, None).unwrap();
        assert!(app.agent_view(1).unwrap()["retry"].is_null());
        record_test_crash(&app, 1);
        app.prepare_resume(&mut app.lock(), 1, "user").unwrap();
        assert!(app.agent_view(1).unwrap()["retry"].is_null());
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn fable_exhaustion_is_scoped_and_omission_or_old_checks_do_not_clear_it() {
        let app = app_with_two_projects();
        app.lock().db.execute("UPDATE agents SET model=CASE id WHEN 1 THEN 'claude-fable-5-1' ELSE 'claude-opus-5-5' END,effort='medium'", []).unwrap();
        set_usage(&app, 0.0);
        app.window_limit_hit(1, "seven_day_fable", "Fable weekly exhausted")
            .unwrap();
        app.tick().unwrap();
        assert_eq!(state(&app, 1).0, "paused");
        assert_eq!(state(&app, 2).0, "idle");
        assert_eq!(app.lock().used_pct("claude").unwrap(), Some(0.0));
        drop(app.wait_stopped(app.lock(), &[1]));
        let refresh = |fable: Option<f64>| {
            let mut windows = vec![
                crate::usage::Window {
                    name: "five_hour".into(),
                    used: 0.0,
                    reset: None,
                },
                crate::usage::Window {
                    name: "seven_day".into(),
                    used: 0.0,
                    reset: None,
                },
            ];
            if let Some(used) = fable {
                windows.push(crate::usage::Window {
                    name: "seven_day_fable".into(),
                    used,
                    reset: None,
                });
            }
            crate::usage::finish(&app, "claude", 120, Ok(windows)).unwrap();
        };
        refresh(None); // omitted optional is not zero
        assert_eq!(
            app.lock().window_pct("claude", "seven_day_fable").unwrap(),
            Some(100.0)
        );
        refresh(Some(0.0)); // begun before exhaustion: still not recovery
        assert_eq!(
            app.lock().window_pct("claude", "seven_day_fable").unwrap(),
            Some(100.0)
        );
        {
            let st = app.lock();
            st.db
                .execute(
                    "UPDATE usage SET at=?1 WHERE win='seven_day_fable'",
                    [now() - 1],
                )
                .unwrap();
            st.db.execute("INSERT OR REPLACE INTO usage_checks(provider,attempted_at) VALUES('claude',?1)", [now()]).unwrap();
        }
        refresh(Some(0.0));
        app.tick().unwrap();
        assert_eq!(state(&app, 1).0, "idle");
    }

    #[test]
    fn failed_events_do_not_override_quota_pause() {
        let app = app_with_two_projects();
        app.limit_hit(1, "quota").unwrap();
        app.fail_turn(1, "failure").unwrap();
        app.fail_turn(1, "duplicate failure").unwrap();
        app.tick().unwrap();
        let st = app.lock();
        assert_eq!(st.agent(1).unwrap().problem.as_deref(), Some("quota"));
        assert_eq!(
            st.db
                .query_row(
                    "SELECT count(*) FROM agent_retries WHERE agent_id=1",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(st.procs.is_empty());
        assert_eq!(st.agent(1).unwrap().state, "paused");
    }

    #[test]
    fn retry_rules_default_to_zero_and_require_a_different_valid_target() {
        let rule: RetryRule = serde_json::from_value(json!({
            "harness": "codex", "model": "gpt-6-luna"
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&rule).unwrap(),
            json!({
                "harness": "codex", "model": "gpt-6-luna", "same_model_retries": 0
            })
        );
        let mut s = Settings::default();
        s.crash_retries.insert("gpt-6-sol".into(), rule);
        assert!(s.check().is_ok());
        s.crash_retries.get_mut("gpt-6-sol").unwrap().model = "gpt-6-sol".into();
        assert!(s.check().unwrap_err().1.contains("different target model"));
        s.crash_retries.get_mut("gpt-6-sol").unwrap().model = "gpt-6-luna".into();
        s.crash_retries.get_mut("gpt-6-sol").unwrap().harness = "claude".into();
        assert!(s.check().unwrap_err().1.contains("belongs to codex"));
    }

    #[test]
    fn retry_keeps_running_effort_snapshot_and_waits_for_allowed_effort() {
        let app = app_with_two_projects();
        custom(&app, 1, |s| {
            s.crash_retries.insert(
                "gpt-6-sol".into(),
                RetryRule {
                    harness: "codex".into(),
                    model: "gpt-6-luna".into(),
                    same_model_retries: 0,
                },
            );
            s.harnesses.get_mut("codex").unwrap().efforts = vec!["medium".into()];
        });
        {
            let mut st = app.lock();
            st.db.execute("UPDATE agents SET harness='codex',model='gpt-6-luna',effort='medium',state='crashed' WHERE id=1", []).unwrap();
            st.procs.insert(
                1,
                Proc {
                    pid: 0,
                    stopping: false,
                    model: "gpt-6-sol".into(),
                    effort: "high".into(),
                    failure: None,
                },
            );
            st.remember_crash(1, &st.agent(1).unwrap()).unwrap();
            st.db
                .execute("UPDATE agent_retries SET eligible_at=0", [])
                .unwrap();
            st.procs.remove(&1); // No child was started or signalled.
        }
        let home = app.home.clone();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        app.tick().unwrap();
        let st = app.lock();
        let record: (String, String, bool, String) = st
            .db
            .query_row(
                "SELECT source,effort,handled,blocked FROM agent_retries WHERE agent_id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            record,
            (
                "gpt-6-sol".into(),
                "high".into(),
                false,
                "recovery effort high (from high) isn't allowed for codex".into()
            )
        );
        assert_eq!(st.agent(1).unwrap().effort, "medium");
        assert!(st.procs.is_empty());
    }

    #[test]
    fn retry_mapping_still_obeys_allowed_efforts_and_missing_snapshot_stops() {
        let app = app_with_two_projects();
        custom(&app, 1, |s| {
            s.crash_retries.insert(
                "gpt-6-sol".into(),
                RetryRule {
                    harness: "codex".into(),
                    model: "gpt-6-luna".into(),
                    same_model_retries: 0,
                },
            );
            s.harnesses.get_mut("codex").unwrap().efforts = vec!["medium".into()];
        });
        app.lock()
            .db
            .execute(
                "UPDATE agents SET harness='codex',model='gpt-6-sol',effort='ultra' WHERE id=1",
                [],
            )
            .unwrap();
        record_test_crash(&app, 1);
        app.tick().unwrap();
        assert!(
            app.agent_view(1).unwrap()["retry"]["blocked"]
                .as_str()
                .unwrap()
                .contains("recovery effort max (from ultra) isn't allowed")
        );
        assert_eq!(app.lock().agent(1).unwrap().effort, "ultra");
        app.lock()
            .db
            .execute(
                "UPDATE agent_retries SET handled=0,effort=NULL WHERE agent_id=1",
                [],
            )
            .unwrap();
        app.tick().unwrap();
        assert!(
            app.agent_view(1).unwrap()["retry"]["blocked"]
                .as_str()
                .unwrap()
                .contains("effort wasn't recorded")
        );
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn retry_cycles_stop_and_db_setup_failure_cannot_spawn_a_replacement() {
        let app = app_with_two_projects();
        app.lock()
            .db
            .execute(
                "UPDATE agents SET model='claude-fable-5-1',effort='medium' WHERE id=1",
                [],
            )
            .unwrap();
        custom(&app, 1, |s| {
            s.crash_retries.insert(
                "claude-fable-5-1".into(),
                RetryRule {
                    harness: "codex".into(),
                    model: "gpt-6-sol".into(),
                    same_model_retries: 0,
                },
            );
        });
        let (thread, _) = app
            .new_thread(0, Some(1), "handoff", &["1".into()], true, &[])
            .unwrap();
        record_test_crash(&app, 1);
        {
            let st = app.lock();
            st.db.execute_batch("CREATE TRIGGER fail_handoff BEFORE INSERT ON members WHEN NEW.agent_id>2 BEGIN SELECT RAISE(ABORT,'injected handoff failure'); END").unwrap();
        }
        app.tick().unwrap();
        assert!(app.lock().procs.is_empty());
        assert_eq!(app.agents(None, None).unwrap().len(), 2);
        assert!(
            app.agent_view(1).unwrap()["retry"]["blocked"]
                .as_str()
                .unwrap()
                .contains("injected handoff failure")
        );
        assert!(app.thread(thread).unwrap()["members"].is_array());
        {
            let st = app.lock();
            st.db.execute("UPDATE agent_retries SET tried='[\"claude:claude-fable-5-1\",\"codex:gpt-6-sol\"]',handled=0 WHERE agent_id=1", []).unwrap();
        }
        app.tick().unwrap();
        assert!(
            app.agent_view(1).unwrap()["retry"]["blocked"]
                .as_str()
                .unwrap()
                .contains("cycle")
        );
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn preparing_retry_clears_old_finish_request_without_starting_a_process() {
        let app = app_with_two_projects();
        app.lock()
            .db
            .execute(
                "UPDATE agents SET state='crashed',done_req=1,rest='done' WHERE id=1",
                [],
            )
            .unwrap();
        let mut st = app.lock();
        let prompt = app.prepare_resume(&mut st, 1, "acom").unwrap().unwrap();
        assert!(prompt.contains("Previous turn interrupted"));
        assert!(!st.agent(1).unwrap().done_req);
        assert_eq!(st.agent(1).unwrap().rest, "idle");
        assert!(st.procs.is_empty());
    }

    #[test]
    fn running_model_not_next_turn_model_controls_fable_warnings() {
        let app = app_with_two_projects();
        {
            let mut st = app.lock();
            st.db.execute("UPDATE agents SET state='working',model=CASE id WHEN 1 THEN 'claude-opus-5-5' ELSE 'claude-fable-5-1' END", []).unwrap();
            // Only a soft crossing; these placeholder PIDs are never signalled.
            st.procs.insert(
                1,
                Proc {
                    pid: 0,
                    stopping: false,
                    model: "claude-fable-5-1".into(),
                    effort: "medium".into(),
                    failure: None,
                },
            );
            st.procs.insert(
                2,
                Proc {
                    pid: 0,
                    stopping: false,
                    model: "claude-opus-5-5".into(),
                    effort: "medium".into(),
                    failure: None,
                },
            );
        }
        app.record_usage("claude", "seven_day_fable", 85.0, None)
            .unwrap();
        app.tick().unwrap();
        let st = app.lock();
        let first = rows(&st.db, "SELECT text FROM notices WHERE agent_id=1", []).unwrap();
        let second = rows(&st.db, "SELECT text FROM notices WHERE agent_id=2", []).unwrap();
        assert!(
            first
                .iter()
                .any(|r| r["text"].as_str().unwrap().contains("weekly Fable"))
        );
        assert!(second.is_empty());
    }

    #[test]
    fn failed_state_write_after_spawn_reaps_child_before_sending_the_task() {
        use std::os::unix::fs::PermissionsExt;
        let mut app = app_with_two_projects();
        let bin = app.home.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let client = bin.join("codex");
        // Reads stdin before recording anything: supervisor must not feed the
        // task until state is saved. This test cannot reach a real provider.
        std::fs::write(&client, "#!/bin/sh\nread -r task\nexit 0\n").unwrap();
        std::fs::set_permissions(&client, std::fs::Permissions::from_mode(0o755)).unwrap();
        Arc::get_mut(&mut app).unwrap().exe = bin.join("acom");
        let mut st = app.lock();
        st.db
            .execute(
                "UPDATE projects SET path=?1 WHERE id=1",
                [app.home.to_string_lossy()],
            )
            .unwrap();
        st.db
            .execute(
                "UPDATE agents SET harness='codex',model='gpt-6-sol',effort='medium' WHERE id=1",
                [],
            )
            .unwrap();
        st.db.execute_batch("CREATE TRIGGER fail_worker BEFORE UPDATE OF state ON agents WHEN NEW.state='working' BEGIN SELECT RAISE(ABORT,'injected worker state failure'); END").unwrap();
        let error = run::start_turn(&app, &mut st, 1, "must not execute", None).unwrap_err();
        assert!(error.1.contains("injected worker state failure"));
        assert!(st.procs.is_empty());
        assert_eq!(st.agent(1).unwrap().state, "idle");
        assert_eq!(
            st.db
                .query_row("SELECT turns FROM agents WHERE id=1", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        st.db.execute_batch("DROP TRIGGER fail_worker; UPDATE agents SET state='crashed' WHERE id=2;
            CREATE TRIGGER fail_replaced BEFORE UPDATE OF state ON agents WHEN NEW.state='replaced' BEGIN SELECT RAISE(ABORT,'injected predecessor state failure'); END").unwrap();
        let error = run::start_turn(&app, &mut st, 1, "must not execute", Some(2)).unwrap_err();
        assert!(error.1.contains("injected predecessor state failure"));
        assert!(st.procs.is_empty());
        assert_eq!(st.agent(1).unwrap().state, "idle");
        assert_eq!(st.agent(2).unwrap().state, "crashed");
        assert_eq!(
            st.db
                .query_row("SELECT turns FROM agents WHERE id=1", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    /// A fake, stdin-gated client: even commit-failure tests cannot reach a provider.
    fn waiting_client_app() -> Arc<App> {
        use std::os::unix::fs::PermissionsExt;
        let mut app = app_with_two_projects();
        let bin = app.home.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let client = bin.join("codex");
        std::fs::write(&client,format!("#!/bin/sh\nIFS= read -r task || exit 0\nprintf '%s' \"$task\" > '{}/prompt-delivered'\n",app.home.display())).unwrap();
        std::fs::set_permissions(&client, std::fs::Permissions::from_mode(0o755)).unwrap();
        Arc::get_mut(&mut app).unwrap().exe = bin.join("acom");
        let st = app.lock();
        st.db
            .execute(
                "UPDATE projects SET path=?1 WHERE id=1",
                [app.home.to_string_lossy()],
            )
            .unwrap();
        st.db
            .execute(
                "UPDATE agents SET harness='codex',model='gpt-6-sol',effort='medium' WHERE id=1",
                [],
            )
            .unwrap();
        drop(st);
        app
    }

    #[test]
    fn done_handoff_cleanup_failure_never_activates_a_child_or_erases_continuation() {
        let app = waiting_client_app();
        app.lock()
            .db
            .execute("UPDATE agents SET state='working' WHERE id=1", [])
            .unwrap();
        custom(&app, 1, |s| s.allow_agent_effort_change = true);
        app.configure_agent(1, 1, None, Some("high"), Some("must survive"), false)
            .unwrap();
        app.lock().db.execute_batch("CREATE TRIGGER reject_continuation_delete BEFORE DELETE ON agent_continuations BEGIN SELECT RAISE(ABORT,'cleanup failed'); END;").unwrap();
        let mut req = replacement_request();
        req.done = true;
        let error = app.launch(1, None, None, req).unwrap_err();
        assert!(error.1.contains("cleanup failed"));
        let view = app.agent_view(1).unwrap();
        assert_eq!(view["state"], "working");
        assert_eq!(view["done_req"], 0);
        assert_eq!(view["continuation"]["text"], "must survive");
        assert!(app.lock().procs.is_empty());
        assert!(!app.home.join("prompt-delivered").exists());
        assert_eq!(app.agent_view(3).unwrap()["state"], "crashed");
    }

    fn defer_commit_failure(st: &St) {
        st.db.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
            CREATE TABLE commit_gate(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TRIGGER fail_commit AFTER UPDATE OF pid ON agents WHEN NEW.pid IS NOT NULL
            BEGIN INSERT INTO commit_gate VALUES(1); END;").unwrap();
    }

    #[test]
    fn failed_launch_identity_commit_rolls_back_without_retaining_a_transaction() {
        let app = waiting_client_app();
        let before = app.agents(None, None).unwrap();
        app.lock().db.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
            CREATE TABLE commit_gate(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TRIGGER fail_commit AFTER INSERT ON agents
            BEGIN INSERT INTO commit_gate VALUES(1); END;").unwrap();
        let error = app
            .launch(
                0,
                None,
                Some(1),
                LaunchReq {
                    task: "must not execute".into(),
                    harness: Some("codex".into()),
                    model: Some("gpt-6-sol".into()),
                    effort: Some("medium".into()),
                    name: None,
                    group: None,
                    force: false,
                    done: false,
                    ack_crashes: false,
                },
            )
            .unwrap_err();
        assert!(error.1.contains("FOREIGN KEY"));
        assert!(app.lock().db.is_autocommit());
        assert_eq!(app.agents(None, None).unwrap(), before);
        assert!(app.lock().procs.is_empty());
        assert!(!app.home.join("prompt-delivered").exists());
        app.lock()
            .db
            .execute_batch("DROP TRIGGER fail_commit")
            .unwrap();
        let (thread, _) = app
            .new_thread(
                0,
                Some(1),
                "later request commits",
                &["1".into()],
                false,
                &[],
            )
            .unwrap();
        let db = Connection::open(app.home.join("acom.db")).unwrap();
        assert_eq!(
            db.query_row("SELECT title FROM threads WHERE id=?1", [thread], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "later request commits"
        );
    }

    #[test]
    fn failed_recovery_preparation_commit_rolls_back_before_disarming_retry() {
        for harness in ["codex", "claude"] {
            let app = waiting_client_app();
            custom(&app, 1, |s| {
                s.crash_retries.insert(
                    "gpt-6-sol".into(),
                    RetryRule {
                        harness: harness.into(),
                        model: if harness == "codex" {
                            "gpt-6-luna"
                        } else {
                            "claude-opus-5-5"
                        }
                        .into(),
                        same_model_retries: 0,
                    },
                );
            });
            record_test_crash(&app, 1);
            let before = app.agents(None, None).unwrap();
            {
                let st = app.lock();
                st.db.execute_batch("PRAGMA foreign_keys=ON;
                    CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
                    CREATE TABLE commit_gate(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);").unwrap();
                // Same-provider recovery updates configuration; a cross-provider
                // recovery creates an identity. Fail the final commit of each.
                let trigger = if harness == "codex" {
                    "CREATE TRIGGER fail_commit AFTER UPDATE OF model ON agents BEGIN INSERT INTO commit_gate VALUES(1); END;"
                } else {
                    "CREATE TRIGGER fail_commit AFTER INSERT ON agents BEGIN INSERT INTO commit_gate VALUES(1); END;"
                };
                st.db.execute_batch(trigger).unwrap();
            }
            app.tick().unwrap();
            assert!(app.lock().db.is_autocommit());
            assert_eq!(app.agents(None, None).unwrap(), before);
            let retry = app.agent_view(1).unwrap()["retry"].clone();
            assert_eq!(retry["handled"], 1);
            assert!(retry["blocked"].as_str().unwrap().contains("FOREIGN KEY"));
            assert!(app.lock().procs.is_empty());
            assert!(!app.home.join("prompt-delivered").exists());
        }
    }

    #[test]
    fn failed_start_commit_reaps_unprompted_child_and_rolls_back_coordination() {
        let app = waiting_client_app();
        let (tid, _) = app
            .new_thread(0, Some(1), "workers", &[], true, &["working".into()])
            .unwrap();
        let mut st = app.lock();
        st.notice(1, "notice survives failed start").unwrap();
        let before = rows(&st.db, "SELECT * FROM events ORDER BY id", []).unwrap();
        defer_commit_failure(&st);
        let error = run::start_turn(&app, &mut st, 1, "must not execute", None).unwrap_err();
        assert!(error.1.contains("FOREIGN KEY"));
        assert!(st.procs.is_empty());
        assert!(st.db.is_autocommit());
        assert_eq!(st.agent(1).unwrap().state, "idle");
        assert!(!app.home.join("prompt-delivered").exists());
        assert_eq!(
            rows(&st.db, "SELECT * FROM events ORDER BY id", []).unwrap(),
            before
        );
        assert_eq!(
            rows(&st.db, "SELECT * FROM summary_cursors", []).unwrap(),
            Vec::<Value>::new()
        );
        assert_eq!(
            rows(&st.db, "SELECT shown FROM notices WHERE agent_id=1", []).unwrap()[0]["shown"],
            0
        );
        assert!(
            rows(
                &st.db,
                "SELECT * FROM member_intervals WHERE thread_id=?1 AND agent_id=1",
                [tid]
            )
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn failed_resume_commit_preserves_pause_and_membership_without_restoring_locks() {
        let app = waiting_client_app();
        let (tid, _) = app
            .new_thread(0, Some(1), "paused", &[], true, &["paused".into()])
            .unwrap();
        let mut st = app.lock();
        st.db.execute("UPDATE agents SET state='paused',pause_from='working',pause_reason='user',paused_at=1 WHERE id=1",[]).unwrap();
        st.db.execute("INSERT INTO locks(project,name,about,created_at) VALUES(1,'schema','paused work',0)",[]).unwrap();
        st.notice(1, "still unseen").unwrap();
        let before = rows(&st.db, "SELECT * FROM events ORDER BY id", []).unwrap();
        defer_commit_failure(&st);
        let error = app.resume_locked(&mut st, 1, "user").unwrap_err();
        assert!(error.1.contains("FOREIGN KEY"));
        assert!(st.procs.is_empty());
        assert!(st.db.is_autocommit());
        assert_eq!(st.agent(1).unwrap().state, "paused");
        assert_eq!(st.agent(1).unwrap().pause_from.as_deref(), Some("working"));
        assert_eq!(lock(&st, "schema"), (None, None, 0, None));
        assert_eq!(
            rows(&st.db, "SELECT * FROM events ORDER BY id", []).unwrap(),
            before
        );
        assert_eq!(
            rows(
                &st.db,
                "SELECT agent_id FROM members WHERE thread_id=?1 AND agent_id=1",
                [tid]
            )
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            rows(&st.db, "SELECT shown FROM notices WHERE agent_id=1", []).unwrap()[0]["shown"],
            0
        );
        assert!(!app.home.join("prompt-delivered").exists());
    }

    #[test]
    fn failed_pause_rolls_back_lock_release_state_membership_and_history() {
        let app = app_with_two_projects();
        let (tid, _) = app
            .new_thread(0, Some(1), "active", &[], true, &["active".into()])
            .unwrap();
        {
            let st = app.lock();
            hold(&st, "schema", 1, Some(now() + 60));
            st.db
                .execute_batch(
                    "CREATE TRIGGER fail_leave BEFORE DELETE ON members WHEN OLD.agent_id=1
                BEGIN SELECT RAISE(ABORT,'injected membership failure'); END;",
                )
                .unwrap();
        }
        let before = app.history(Some(1), history_query()).unwrap();
        assert!(
            app.pause(1, "user")
                .unwrap_err()
                .1
                .contains("injected membership failure")
        );
        assert_eq!(app.history(Some(1), history_query()).unwrap(), before);
        let st = app.lock();
        assert_eq!(st.agent(1).unwrap().state, "idle");
        assert_eq!(lock(&st, "schema").0, Some(1));
        assert!(
            rows(&st.db, "SELECT * FROM notices", [])
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            rows(
                &st.db,
                "SELECT agent_id FROM members WHERE thread_id=?1 AND agent_id=1",
                [tid]
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn failed_exit_keeps_running_snapshot_until_all_exit_writes_commit() {
        let app = app_with_two_projects();
        let (tid, _) = app
            .new_thread(0, Some(1), "active", &[], true, &["active".into()])
            .unwrap();
        {
            let mut st = app.lock();
            st.set_state(1, "working").unwrap();
            st.db
                .execute(
                    "UPDATE agents SET pid=123,model='queued-model' WHERE id=1",
                    [],
                )
                .unwrap();
            hold(&st, "schema", 1, Some(now() + 60));
            st.procs.insert(
                1,
                Proc {
                    pid: 123,
                    stopping: false,
                    model: "running-model".into(),
                    effort: "high".into(),
                    failure: Some("failed turn".into()),
                },
            );
            st.db
                .execute_batch(
                    "CREATE TRIGGER fail_leave BEFORE DELETE ON members WHEN OLD.agent_id=1
                BEGIN SELECT RAISE(ABORT,'injected membership failure'); END;",
                )
                .unwrap();
        }
        assert!(app.turn_ended(1, 123, false, None).is_err());
        {
            let st = app.lock();
            assert!(st.procs.contains_key(&1));
            assert_eq!(st.agent(1).unwrap().state, "working");
            assert_eq!(lock(&st, "schema").0, Some(1));
            assert!(
                rows(&st.db, "SELECT * FROM agent_retries", [])
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                rows(&st.db, "SELECT pid FROM agents WHERE id=1", []).unwrap()[0]["pid"],
                123
            );
            st.db.execute_batch("DROP TRIGGER fail_leave").unwrap();
        }
        app.turn_ended(1, 123, false, None).unwrap();
        let st = app.lock();
        assert!(st.procs.is_empty());
        assert_eq!(st.agent(1).unwrap().state, "crashed");
        assert_eq!(lock(&st, "schema").0, None);
        let retry = rows(
            &st.db,
            "SELECT source,effort FROM agent_retries WHERE agent_id=1",
            [],
        )
        .unwrap();
        assert_eq!(retry[0]["source"], "running-model");
        assert_eq!(retry[0]["effort"], "high");
        assert!(
            rows(
                &st.db,
                "SELECT agent_id FROM members WHERE thread_id=?1 AND agent_id=1",
                [tid]
            )
            .unwrap()
            .is_empty()
        );
    }

    fn history_query() -> HistoryQuery {
        HistoryQuery {
            agent: None,
            thread: None,
            lock: None,
            kind: None,
            before: None,
            after: None,
            limit: 50,
            max_bytes: 16000,
        }
    }

    #[test]
    fn saved_message_receipt_survives_a_failed_recipient_spawn_and_log_write() {
        let mut app = app_with_two_projects();
        // An existing directory is not executable, irrespective of inherited PATH.
        let bin = app.home.join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::fs::create_dir(bin.join("claude")).unwrap();
        Arc::get_mut(&mut app).unwrap().exe = bin.join("acom");
        {
            let st = app.lock();
            st.db
                .execute(
                    "UPDATE projects SET path=?1 WHERE id=1",
                    [app.home.to_string_lossy()],
                )
                .unwrap();
            st.db
                .execute_batch(
                    "CREATE TRIGGER fail_activity BEFORE INSERT ON activity
                BEGIN SELECT RAISE(ABORT,'injected logging failure'); END;",
                )
                .unwrap();
        }
        let (tid, _) = app
            .new_thread(0, Some(1), "delivery", &["1".into()], true, &[])
            .unwrap();
        let (mid, not_woken) = app.post(0, tid, "saved exactly once").unwrap();
        assert_eq!(not_woken.len(), 1);
        assert!(not_woken[0].1.contains("couldn't start"));
        assert_eq!(
            app.thread(tid).unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            app.message_for(mid, Some(1)).unwrap()["outside_membership"],
            false
        );
        assert_eq!(app.inbox(1, "new").unwrap()[0]["id"], mid);
        assert_eq!(app.lock().agent(1).unwrap().state, "idle");
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn coordination_is_nonzero_and_survives_removal_of_pending_thread() {
        let app = app_with_two_projects();
        assert_eq!(app.lock().coordination_summary(1, true).unwrap(), "");
        app.lock().set_state(1, "working").unwrap();
        let (tid, _) = app
            .new_thread(0, Some(1), "worker", &[], false, &["working".into()])
            .unwrap();
        let (mid, _) = app.post(0, tid, "pending task").unwrap();
        let first = app.lock().coordination_summary(1, true).unwrap();
        assert!(first.contains("threads 1; joined 1; pending 1"));
        assert!(!first.contains("locks 0"));
        assert_eq!(app.lock().coordination_summary(1, false).unwrap(), "");
        app.lock().set_state(1, "idle").unwrap();
        let second = app.lock().coordination_summary(1, false).unwrap();
        assert!(second.contains("left 1; pending 1"));
        assert!(!second.contains("threads 0"));
        assert_eq!(app.inbox(1, "new").unwrap()[0]["id"], mid);
        app.set_marks(1, &[mid], "handled").unwrap();
        assert!(app.inbox(1, "new").unwrap().is_empty());
        assert_eq!(
            app.message_for(mid, Some(1)).unwrap()["outside_membership"],
            false
        );
    }

    #[test]
    fn history_pages_bound_bytes_without_skipping_large_events_or_changing_marks() {
        let app = app_with_two_projects();
        let text = "☃".repeat(10000);
        app.set_status(1, &text).unwrap();
        let page = app
            .history(
                Some(1),
                HistoryQuery {
                    agent: Some(1),
                    max_bytes: 512,
                    ..history_query()
                },
            )
            .unwrap();
        assert!(page.to_string().len() <= 512);
        assert_eq!(page["events"][0]["truncated"], true);
        let id = page["events"][0]["id"].as_i64().unwrap();
        assert_eq!(
            app.history_event(Some(1), id).unwrap()["details"]["to"],
            text
        );
        assert!(app.history_event(Some(2), id).is_err());
        let next = app
            .history(
                Some(1),
                HistoryQuery {
                    agent: Some(1),
                    before: Some(id),
                    ..history_query()
                },
            )
            .unwrap();
        assert!(
            next["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["id"].as_i64().unwrap() < id)
        );
        let unchanged = app
            .history(
                Some(1),
                HistoryQuery {
                    agent: Some(1),
                    kind: Some("agent.status".into()),
                    ..history_query()
                },
            )
            .unwrap();
        app.set_status(1, &text).unwrap();
        assert_eq!(
            app.history(
                Some(1),
                HistoryQuery {
                    agent: Some(1),
                    kind: Some("agent.status".into()),
                    ..history_query()
                }
            )
            .unwrap(),
            unchanged
        );
    }

    #[test]
    fn removing_an_agentless_project_removes_its_thread_records_atomically() {
        let app = app_with_two_projects();
        let project = app.add_project(app.home.to_str().unwrap(), "user").unwrap()["id"]
            .as_i64()
            .unwrap();
        let (tid, _) = app
            .new_thread(
                0,
                Some(project),
                "empty team",
                &[],
                true,
                &["active".into()],
            )
            .unwrap();
        app.post(0, tid, "note").unwrap();
        app.new_lock(project, "schema", "purpose").unwrap();
        app.remove_project(project, "user").unwrap();
        assert!(app.thread(tid).is_err());
        assert!(
            app.history(Some(project), history_query()).unwrap()["events"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let st = app.lock();
        for table in [
            "members",
            "member_intervals",
            "user_reads",
            "thread_filters",
            "messages",
        ] {
            assert!(
                rows(
                    &st.db,
                    &format!("SELECT * FROM {table} WHERE thread_id=?1"),
                    [tid]
                )
                .unwrap()
                .is_empty()
            );
        }
        assert!(
            rows(&st.db, "SELECT * FROM locks WHERE project=?1", [project])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn existing_members_and_mine_survive_initializing_history_without_invented_events() {
        let home = std::env::temp_dir().join(format!("acom-test-{}", crate::harness::new_uuid()));
        std::fs::create_dir(&home).unwrap();
        let db = Connection::open(home.join("acom.db")).unwrap();
        db.execute_batch(
            SCHEMA
                .split("CREATE TABLE IF NOT EXISTS thread_filters")
                .next()
                .unwrap(),
        )
        .unwrap();
        let mine = serde_json::to_string(&Settings::default()).unwrap();
        db.execute(
            "INSERT INTO configs(id,name,settings) VALUES(2,'Mine',?1)",
            [&mine],
        )
        .unwrap();
        db.execute_batch("INSERT INTO projects(id,path,name,created_at,config) VALUES(1,'/p1','p1',0,2);
            INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(1,1,'a','t','claude','m','e','paused',0,0);
            INSERT INTO threads VALUES(1,1,'old',0,0);
            INSERT INTO members VALUES(1,0,10),(1,1,10);
            INSERT INTO messages VALUES(10,1,0,'old message',0);
            INSERT INTO marks VALUES(1,10,'handled');").unwrap();
        drop(db);
        let app = App::open(home.clone(), "http://127.0.0.1:0".into()).unwrap();
        let old = app.message_for(10, Some(1)).unwrap();
        assert_eq!(old["membership_unknown"], true);
        assert_eq!(old["outside_membership"], false);
        assert_eq!(old["mark"], "handled");
        assert!(
            app.history(Some(1), history_query()).unwrap()["events"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let (mid, _) = app.post(0, 1, "new message").unwrap();
        let new = app.message_for(mid, Some(1)).unwrap();
        assert_eq!(new["membership_unknown"], false);
        assert_eq!(new["outside_membership"], false);
        assert_eq!(
            app.lock()
                .db
                .query_row("SELECT settings FROM configs WHERE name='Mine'", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            mine
        );
        let before = app.history(Some(1), history_query()).unwrap();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        assert_eq!(app.history(Some(1), history_query()).unwrap(), before);
        assert_eq!(
            app.lock()
                .db
                .query_row("SELECT count(*) FROM member_intervals", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
}
