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

pub const GUIDE: &str = include_str!("guide.md");
pub const STATES: [&str; 6] = ["working", "idle", "paused", "done", "closed", "crashed"];
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

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Settings {
    pub harnesses: BTreeMap<String, HarnessCfg>,
    pub limits: Limits,
    pub auto_resume: bool,
    pub done_closes: bool,
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
                "gpt-6.1-sol",
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
            usage.insert(h.to_string(), per(80.0, 95.0));
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
        }
    }
}

impl Settings {
    fn check(&self) -> R<()> {
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
        let l = &self.limits;
        for k in l.active_per_harness.keys().chain(l.usage.keys()) {
            if !crate::harness::KNOWN.contains(&k.as_str()) {
                return Err(bad(format!("unknown harness {k} in limits")));
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
}

pub struct St {
    pub db: Connection,
    /// Lock queues by (project, lock name).
    pub queues: HashMap<(i64, String), Vec<i64>>,
    pub procs: HashMap<i64, Proc>,
    pub over_hard: HashSet<String>,
    pub over_soft: HashSet<String>,
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
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
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
CREATE TABLE IF NOT EXISTS marks (agent_id INTEGER NOT NULL, message_id INTEGER NOT NULL, mark TEXT NOT NULL, PRIMARY KEY (agent_id, message_id));
CREATE TABLE IF NOT EXISTS locks (project INTEGER NOT NULL, name TEXT NOT NULL, about TEXT NOT NULL, created_at INTEGER NOT NULL,
  holder INTEGER, acquired_at INTEGER, expires_at INTEGER, frozen INTEGER NOT NULL DEFAULT 0, frozen_left INTEGER,
  PRIMARY KEY (project, name));
CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, shown INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS usage (provider TEXT NOT NULL, win TEXT NOT NULL, used_pct REAL NOT NULL, resets_at INTEGER, at INTEGER NOT NULL, PRIMARY KEY (provider, win));
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, project INTEGER, at INTEGER NOT NULL, actor TEXT NOT NULL, what TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

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
    pub fn settings(&self) -> Settings {
        self.db
            .query_row("SELECT value FROM settings WHERE key='settings'", [], |r| {
                r.get::<_, String>(0)
            })
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn agent(&self, id: i64) -> R<Agent> {
        self.db
            .query_row(
                "SELECT name,grp,task,harness,model,effort,state,rest,session_id,launched_by,
                        pause_from,paused_at,done_req,project FROM agents WHERE id=?1",
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
        let ended = matches!(state, "done" | "closed" | "crashed");
        self.db.execute(
            "UPDATE agents SET state=?2, ended_at=CASE WHEN ?3 THEN ?4 ELSE NULL END WHERE id=?1",
            params![id, state, ended, now()],
        )?;
        Ok(())
    }

    /// Record an activity line, for one project or (None) for all of them.
    pub fn log(&self, project: Option<i64>, actor: &str, what: &str) -> R<()> {
        self.db.execute(
            "INSERT INTO activity(project,at,actor,what) VALUES(?1,?2,?3,?4)",
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
            "INSERT INTO notices(agent_id,text,at) VALUES(?1,?2,?3)",
            params![agent, text, now()],
        )?;
        Ok(())
    }

    fn active_counts(&self) -> R<(i64, BTreeMap<String, i64>)> {
        let mut per = BTreeMap::new();
        let mut total = 0;
        for r in rows(
            &self.db,
            "SELECT harness h, count(*) n FROM agents WHERE state IN ('working','idle') AND done_req=0 GROUP BY harness",
            [],
        )? {
            let n = r["n"].as_i64().unwrap_or(0);
            total += n;
            per.insert(r["h"].as_str().unwrap_or("").to_string(), n);
        }
        Ok((total, per))
    }

    /// Highest usage % across a provider's windows that haven't reset yet, if known.
    pub fn used_pct(&self, provider: &str) -> R<Option<f64>> {
        Ok(self.db.query_row(
            "SELECT max(used_pct) FROM usage WHERE provider=?1 AND (resets_at IS NULL OR resets_at > ?2)",
            params![provider, now()],
            |r| r.get::<_, Option<f64>>(0),
        )?)
    }

    pub fn limits_text(&self) -> R<String> {
        let s = self.settings();
        let l = &s.limits;
        let (total, per) = self.active_counts()?;
        let mut out = format!("Active agents: {total} ({})", l.active.text(""));
        for (h, lim) in &l.active_per_harness {
            out += &format!("; {h}: {} ({})", per.get(h).unwrap_or(&0), lim.text(""));
        }
        out += "\nSubscription usage:";
        for (i, (h, lim)) in l.usage.iter().enumerate() {
            let used = match self.used_pct(h)? {
                Some(p) => format!("{p:.0}%"),
                None => "unknown".into(),
            };
            out += &format!(
                "{} {h} {used} ({})",
                if i > 0 { ";" } else { "" },
                lim.text("%")
            );
        }
        out += &format!("\nContext per agent: {}", l.context.text(" tokens"));
        if l.context.hard.is_some() {
            out += " (the harness compacts at the hard value)";
        }
        out += if s.done_closes {
            "\nWhen an agent runs `acom done` it's closed: only the user's messages wake it again."
        } else {
            "\nWhen an agent runs `acom done` it's done: any new message in its threads wakes it again."
        };
        Ok(out)
    }

    /// The limits a new active agent of this harness would be checked against.
    fn limit_checks(&self, harness: &str) -> R<Vec<Check>> {
        let l = self.settings().limits;
        let (total, per) = self.active_counts()?;
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
        if let (Some(lim), Some(used)) = (l.usage.get(harness), self.used_pct(harness)?) {
            checks.push(Check {
                what: format!("{harness} subscription usage"),
                value: used,
                lim: lim.clone(),
                unit: "%",
            });
        }
        Ok(checks)
    }

    /// Why an agent of this harness can't become active right now, if it can't.
    fn no_room(&self, harness: &str) -> R<Option<String>> {
        let checks = self.limit_checks(harness)?;
        Ok(checks
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

    /// Expired TTLs free their locks. Frozen locks never expire.
    pub fn expire_locks(&mut self) -> R<bool> {
        let mut s = self.db.prepare(
            "SELECT project, name FROM locks WHERE holder IS NOT NULL AND frozen=0 AND expires_at <= ?1",
        )?;
        let expired: Vec<(i64, String)> = s
            .query_map([now()], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(s);
        for (project, name) in &expired {
            self.release_lock(*project, name, Some("its TTL ran out"))?;
        }
        Ok(!expired.is_empty())
    }

    /// Keep an agent's locks while it's paused: stop their TTL clocks.
    /// A lock whose TTL has already run out is released instead, never frozen.
    fn freeze_locks(&mut self, agent: i64) -> R<()> {
        self.expire_locks()?;
        self.db.execute(
            "UPDATE locks SET frozen=1, frozen_left=CASE WHEN expires_at IS NULL THEN NULL ELSE expires_at-?2 END,
             expires_at=NULL WHERE holder=?1 AND frozen=0",
            params![agent, now()],
        )?;
        Ok(())
    }

    fn unfreeze_locks(&mut self, agent: i64) -> R<()> {
        self.db.execute(
            "UPDATE locks SET frozen=0, expires_at=CASE WHEN frozen_left IS NULL THEN NULL ELSE ?2+frozen_left END,
             frozen_left=NULL WHERE holder=?1 AND frozen=1",
            params![agent, now()],
        )?;
        Ok(())
    }

    // ---------- messages ----------

    /// Messages in the agent's threads it hasn't been told about yet.
    fn pending(&self, agent: i64, only_user: bool) -> R<Vec<(i64, i64)>> {
        let mut s = self.db.prepare(
            "SELECT m.id, m.sender FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=?1
             WHERE m.id > b.last_notified AND m.sender != ?1 AND (?2=0 OR m.sender=0) ORDER BY m.id",
        )?;
        let v = s
            .query_map(params![agent, only_user], |r| Ok((r.get(0)?, r.get(1)?)))?
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

    /// Everything new for an agent, as `[acom]` lines, and mark it all as told.
    /// Never includes message content: only counts and senders.
    pub fn take_updates(&mut self, agent: i64) -> R<String> {
        let mut lines = Vec::new();
        let mut s = self
            .db
            .prepare("SELECT id, text FROM notices WHERE agent_id=?1 AND shown=0 ORDER BY id")?;
        let notes: Vec<(i64, String)> = s
            .query_map([agent], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(s);
        for (id, text) in notes {
            lines.push(format!("[acom] {text}"));
            self.db
                .execute("UPDATE notices SET shown=1 WHERE id=?1", [id])?;
        }
        let msgs = self.pending(agent, false)?;
        if !msgs.is_empty() {
            let mut senders: Vec<i64> = Vec::new();
            for (_, s) in &msgs {
                if !senders.contains(s) {
                    senders.push(*s);
                }
            }
            lines.push(format!(
                "[acom] {} new message{} from {}. Read them with `acom inbox` when you're ready.",
                msgs.len(),
                if msgs.len() == 1 { "" } else { "s" },
                sender_list(&senders)
            ));
            self.mark_notified(agent)?;
        }
        Ok(lines.join("\n"))
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
}

pub enum LockMode {
    Release,
    Keep,
    Ask,
}

impl App {
    pub fn open(home: PathBuf, url: String) -> R<Arc<App>> {
        std::fs::create_dir_all(home.join("logs")).map_err(|e| Fail(500, e.to_string()))?;
        let db = Connection::open(home.join("acom.db"))?;
        db.execute_batch(SCHEMA)?;
        db.execute(
            "INSERT OR IGNORE INTO settings(key,value) VALUES('settings',?1)",
            [serde_json::to_string(&Settings::default()).unwrap()],
        )?;
        let mut st = St {
            db,
            queues: HashMap::new(),
            procs: HashMap::new(),
            over_hard: HashSet::new(),
            over_soft: HashSet::new(),
        };
        // Agents that were mid-turn when the server stopped can't be followed any more.
        // Treat it like pause all: stop leftovers, keep their locks frozen.
        for r in rows(
            &st.db,
            "SELECT id, pid FROM agents WHERE state='working'",
            [],
        )? {
            let id = r["id"].as_i64().unwrap();
            if let Some(pid) = r["pid"].as_i64()
                && run::is_our_agent(pid as u32, id, &url)
            {
                run::kill_group(pid as u32, libc::SIGKILL);
            }
            st.freeze_locks(id)?;
            st.db.execute(
                "UPDATE agents SET state='paused', pause_reason='restart', pause_from='working', paused_at=?2, pid=NULL WHERE id=?1",
                params![id, now()],
            )?;
            st.log_for(
                id,
                "acom",
                &format!("paused agent {id}: the server restarted during its turn"),
            )?;
        }
        let exe = std::env::current_exe().map_err(|e| Fail(500, e.to_string()))?;
        Ok(Arc::new(App {
            st: Mutex::new(st),
            cv: Condvar::new(),
            home,
            url,
            exe,
        }))
    }

    pub fn lock(&self) -> MutexGuard<'_, St> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---------- launching and turns ----------

    /// Launch an agent. All or nothing: if anything fails, including starting the
    /// process, nothing is recorded and a caller handing over with `done` stays working.
    pub fn launch(
        self: &Arc<Self>,
        by: i64,
        via: Option<i64>,
        project: Option<i64>,
        req: LaunchReq,
    ) -> R<(i64, Vec<String>)> {
        let mut st = self.lock();
        st.db.execute_batch("SAVEPOINT launch")?;
        let r = self.launch_in(&mut st, by, via, project, req);
        let end = if r.is_ok() {
            "RELEASE launch"
        } else {
            "ROLLBACK TO launch; RELEASE launch"
        };
        st.db.execute_batch(end)?;
        r
    }

    fn launch_in(
        self: &Arc<Self>,
        st: &mut St,
        by: i64,
        via: Option<i64>,
        project: Option<i64>,
        req: LaunchReq,
    ) -> R<(i64, Vec<String>)> {
        let s = st.settings();
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
        for c in st.limit_checks(&harness)? {
            if c.over(c.lim.hard) {
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

        let session = if harness == "claude" {
            Some(crate::harness::new_uuid())
        } else {
            None
        };
        st.db.execute(
            "INSERT INTO agents(project,name,grp,task,harness,model,effort,state,session_id,launched_by,launched_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,'idle',?8,?9,?10)",
            params![project, req.name.clone().unwrap_or_default(), req.group, req.task, harness, model, effort, session, by, now()],
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
            &format!("launched agent {id} ({harness} / {model} / {effort})"),
        )?;
        let prompt = self.briefing(st, id)?;
        run::start_turn(self, st, id, &prompt)?;
        Ok((id, warnings))
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
            "You are agent {id} (\"{}\"{group}) in project \"{project}\" ({path}), launched by {} through acom, running {} / {} / effort {}.\n\n{GUIDE}\n## Limits and rules right now\n\n{}\n\n## Your task\n\n{}\n",
            a.name,
            who(a.launched_by),
            a.harness,
            a.model,
            a.effort,
            st.limits_text()?,
            a.task
        ))
    }

    /// Something arrived for an agent. An idle agent is woken at once. A done or closed agent
    /// isn't counted as active, so it joins the wake line instead, which `drain_wakes` serves
    /// oldest first whenever there's room under the hard limits.
    pub fn maybe_wake(self: &Arc<Self>, st: &mut St, id: i64) -> R<()> {
        if st.procs.contains_key(&id) {
            return Ok(()); // still stopping; turn_ended wakes it if needed
        }
        let a = st.agent(id)?;
        let only_user = match a.state.as_str() {
            "idle" | "done" => false,
            "closed" => true,
            _ => return Ok(()),
        };
        if st.pending(id, only_user)?.is_empty() {
            return Ok(());
        }
        if a.state == "idle" {
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
        let updates = st.take_updates(id)?;
        let prompt = format!("{updates}\n\nYou were woken up because of the above. Carry on.");
        run::start_turn(self, st, id, &prompt)
    }

    /// Wake agents in the wake line, oldest first, while there's room. Returns whether any woke.
    fn drain_wakes(self: &Arc<Self>, st: &mut St) -> R<bool> {
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
            let only_user = a.state == "closed";
            if !matches!(a.state.as_str(), "done" | "closed")
                || st.pending(id, only_user)?.is_empty()
            {
                // Reopened, paused, or nothing left to hear about: it leaves the line.
                st.db.execute(
                    "UPDATE agents SET wake_queued_at=NULL, wake_why=NULL WHERE id=?1",
                    [id],
                )?;
                continue;
            }
            match st.no_room(&a.harness)? {
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
        let stopping = st.procs.remove(&id).map(|p| p.stopping).unwrap_or(false);
        st.db.execute(
            "UPDATE agents SET pid=NULL WHERE id=?1 AND pid=?2",
            params![id, pid],
        )?;
        let a = st.agent(id)?;
        if a.state != "working" {
            // Paused or closed by someone: they already set the state. A closed agent may
            // have a message from the user waiting that couldn't wake it while it stopped.
            self.maybe_wake(&mut st, id)?;
            self.cv.notify_all();
            return Ok(());
        }
        let s = st.settings();
        let next = if !ok && !stopping {
            "crashed"
        } else if a.done_req {
            if s.done_closes { "closed" } else { "done" }
        } else {
            a.rest.as_str()
        };
        st.db.execute(
            "UPDATE agents SET done_req=0, rest='idle' WHERE id=?1",
            [id],
        )?;
        st.set_state(id, next)?;
        if next != "idle" {
            let why = format!("you became {next}");
            st.release_all(id, &why)?;
        }
        if next == "crashed" {
            let why = error.unwrap_or("its process exited with an error");
            st.db
                .execute("UPDATE agents SET problem=?2 WHERE id=?1", params![id, why])?;
            st.log_for(id, "acom", &format!("agent {id} crashed: {why}"))?;
        } else if a.done_req {
            st.log_for(id, &who(id), &format!("finished: {next}"))?;
        }
        self.maybe_wake(&mut st, id)?;
        self.cv.notify_all();
        Ok(())
    }

    // ---------- agent controls (user commands) ----------

    pub fn pause(self: &Arc<Self>, id: i64, locks: LockMode, by: &str) -> R<()> {
        let mut st = self.lock();
        self.pause_locked(&mut st, id, locks, "user", by)
    }

    fn pause_locked(
        self: &Arc<Self>,
        st: &mut St,
        id: i64,
        locks: LockMode,
        reason: &str,
        by: &str,
    ) -> R<()> {
        let a = st.agent(id)?;
        if !matches!(a.state.as_str(), "working" | "idle" | "done") {
            return Err(conflict(format!("agent {id} is {}", a.state)));
        }
        let held = st.held_by(id)?;
        match locks {
            LockMode::Ask if !held.is_empty() => {
                return Err(conflict(format!(
                    "agent {id} holds {}: choose whether to release them or keep them frozen",
                    held.join(", ")
                )));
            }
            LockMode::Release => {
                st.release_all(id, &format!("you were paused at {}", hhmm(now())))?
            }
            _ => st.freeze_locks(id)?,
        }
        st.db.execute(
            "UPDATE agents SET state='paused', pause_reason=?2, pause_from=?3, paused_at=?4 WHERE id=?1",
            params![id, reason, a.state, now()],
        )?;
        if let Some(p) = st.procs.get_mut(&id) {
            p.stopping = true;
            run::stop(p.pid);
        }
        // Limits and flags log their own, more specific line.
        if matches!(reason, "user" | "all") {
            st.log_for(id, by, &format!("paused agent {id}"))?;
        }
        self.cv.notify_all();
        Ok(())
    }

    /// Wait (a few seconds at most) for these agents' old processes to exit,
    /// so a new turn never overlaps one that's still stopping.
    fn wait_stopped<'a>(&'a self, mut st: MutexGuard<'a, St>, ids: &[i64]) -> MutexGuard<'a, St> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while ids.iter().any(|i| st.procs.contains_key(i)) && Instant::now() < deadline {
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
        // Warn about agents in its project still paused that keep frozen locks.
        let project = st.agent(id)?.project;
        let mut warn = Vec::new();
        for r in rows(
            &st.db,
            "SELECT l.holder h, group_concat(l.name, ', ') n FROM locks l JOIN agents a ON a.id=l.holder
             WHERE l.frozen=1 AND a.state='paused' AND l.project=?1 GROUP BY l.holder",
            [project],
        )? {
            warn.push(format!("agent {} is still paused and holds {}", r["h"], r["n"].as_str().unwrap_or("")));
        }
        Ok(warn)
    }

    fn resume_locked(self: &Arc<Self>, st: &mut St, id: i64, by: &str) -> R<()> {
        let a = st.agent(id)?;
        if a.state != "paused" && a.state != "crashed" {
            return Err(conflict(format!("agent {id} is {}, not paused", a.state)));
        }
        if st.procs.contains_key(&id) {
            return Err(conflict(format!(
                "agent {id} is still stopping; try again in a moment"
            )));
        }
        st.unfreeze_locks(id)?;
        st.db.execute(
            "UPDATE agents SET pause_reason=NULL, pause_from=NULL, paused_at=NULL, problem=NULL WHERE id=?1",
            [id],
        )?;
        st.log_for(id, by, &format!("resumed agent {id}"))?;
        if a.state == "crashed" {
            let updates = st.take_updates(id)?;
            let prompt = format!(
                "Your last turn ended with an error and you've been resumed. Background tasks and monitors from before are gone: don't wait for them.\n{updates}\n\nCarry on."
            );
            return run::start_turn(self, st, id, &prompt);
        }
        let from = a.pause_from.unwrap_or_else(|| "idle".into());
        if from == "working" {
            let updates = st.take_updates(id)?;
            let prompt = format!(
                "[acom] You were paused at {} and resumed at {}. Your process was stopped, so every command, background task and monitor from before the pause is gone: don't wait for any of them. Check what finished and redo the rest.\n{updates}\n\nCarry on.",
                hhmm(a.paused_at.unwrap_or(now())),
                hhmm(now())
            );
            run::start_turn(self, st, id, &prompt)
        } else {
            st.set_state(id, &from)?;
            self.maybe_wake(st, id)
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
            self.pause_locked(&mut st, id, LockMode::Keep, "all", by)?;
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
            .filter(|i| !st.procs.contains_key(i))
            .collect();
        for &id in &ids {
            self.resume_locked(&mut st, id, by)?;
        }
        Ok(ids)
    }

    pub fn close(self: &Arc<Self>, id: i64, by: &str) -> R<()> {
        let mut st = self.lock();
        let a = st.agent(id)?;
        if a.state == "closed" {
            return Err(conflict(format!("agent {id} is already closed")));
        }
        if let Some(p) = st.procs.get_mut(&id) {
            p.stopping = true;
            run::stop(p.pid);
        }
        st.release_all(id, "you were closed")?;
        st.db.execute("UPDATE agents SET pause_reason=NULL, pause_from=NULL, paused_at=NULL, rest='idle' WHERE id=?1", [id])?;
        st.set_state(id, "closed")?;
        st.log_for(id, by, &format!("closed agent {id}"))?;
        self.cv.notify_all();
        Ok(())
    }

    pub fn reopen(self: &Arc<Self>, id: i64, by: &str) -> R<()> {
        let mut st = self.wait_stopped(self.lock(), &[id]);
        if st.agent(id)?.state != "closed" {
            return Err(conflict(format!("agent {id} isn't closed")));
        }
        st.set_state(id, "idle")?;
        st.db
            .execute("UPDATE agents SET problem=NULL WHERE id=?1", [id])?;
        st.log_for(id, by, &format!("reopened agent {id}"))?;
        self.maybe_wake(&mut st, id)
    }

    // ---------- agent self-service ----------

    pub fn agent_project(&self, id: i64) -> R<i64> {
        Ok(self.lock().agent(id)?.project)
    }

    pub fn set_status(&self, id: i64, text: &str) -> R<()> {
        let st = self.lock();
        st.agent(id)?;
        st.db.execute(
            "UPDATE agents SET status_text=?2 WHERE id=?1",
            params![id, text],
        )?;
        Ok(())
    }

    pub fn set_group(&self, id: i64, group: &str) -> R<()> {
        let st = self.lock();
        st.agent(id)?;
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
        let st = self.lock();
        if st.agent(id)?.state != "working" {
            return Err(conflict("only a working agent can mark itself done"));
        }
        st.db
            .execute("UPDATE agents SET done_req=1 WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn hook(&self, id: i64) -> R<String> {
        let mut st = self.lock();
        if st.agent(id)?.state != "working" {
            return Ok(String::new());
        }
        st.take_updates(id)
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
            let found: Vec<i64> = if let Ok(id) = s.parse::<i64>() {
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
    ) -> R<(i64, Vec<i64>)> {
        let st = self.lock();
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
        let mut ids = Self::resolve(&st, project, members)?;
        if by > 0 && !ids.contains(&by) {
            ids.insert(0, by);
        }
        if ids.is_empty() {
            return Err(bad("the thread has no members"));
        }
        st.db.execute(
            "INSERT INTO threads(project,title,created_by,created_at) VALUES(?1,?2,?3,?4)",
            params![project, title.trim(), by, now()],
        )?;
        let tid = st.db.last_insert_rowid();
        for id in &ids {
            st.db.execute(
                "INSERT OR IGNORE INTO members(thread_id,agent_id) VALUES(?1,?2)",
                params![tid, id],
            )?;
        }
        Ok((tid, ids))
    }

    pub fn add_members(self: &Arc<Self>, tid: i64, members: &[String]) -> R<Vec<i64>> {
        let mut st = self.lock();
        let project = Self::thread_project(&st, tid)?;
        let ids = Self::resolve(&st, project, members)?;
        for id in &ids {
            st.db.execute(
                "INSERT OR IGNORE INTO members(thread_id,agent_id) VALUES(?1,?2)",
                params![tid, id],
            )?;
        }
        // Earlier messages count as new for them, so resting members may need waking.
        for id in &ids {
            self.maybe_wake(&mut st, *id)?;
        }
        Ok(ids)
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
        if sender > 0 {
            if st.agent(sender)?.project != project {
                return Err(bad(format!("thread {tid} is in another project")));
            }
            st.db.execute(
                "INSERT OR IGNORE INTO members(thread_id,agent_id) VALUES(?1,?2)",
                params![tid, sender],
            )?;
        }
        st.db.execute(
            "INSERT INTO messages(thread_id,sender,text,at) VALUES(?1,?2,?3,?4)",
            params![tid, sender, text, now()],
        )?;
        let mid = st.db.last_insert_rowid();
        if sender > 0 {
            // You've seen your own message.
            st.db.execute(
                "INSERT OR REPLACE INTO marks(agent_id,message_id,mark) VALUES(?1,?2,'handled')",
                params![sender, mid],
            )?;
        }
        let members: Vec<i64> = rows(
            &st.db,
            "SELECT agent_id a FROM members WHERE thread_id=?1 AND agent_id!=?2 ORDER BY agent_id",
            params![tid, sender],
        )?
        .iter()
        .map(|r| r["a"].as_i64().unwrap())
        .collect();
        for &m in &members {
            self.maybe_wake(&mut st, m)?;
        }
        // Tell the sender who won't see it yet, and why.
        let mut not_woken = Vec::new();
        for m in members {
            let state = st.agent(m)?.state;
            let why: Option<String> =
                st.db
                    .query_row("SELECT wake_why FROM agents WHERE id=?1", [m], |r| r.get(0))?;
            let reason = match state.as_str() {
                "closed" if sender != 0 => {
                    Some("it's closed, so only the user's messages wake it".to_string())
                }
                "paused" => Some("it's paused; it will see this when it's resumed".into()),
                "crashed" => Some("it crashed; it will see this if the user resumes it".into()),
                _ => why.map(|w| format!("{w}; it will be woken when there's room")),
            };
            if let Some(reason) = reason {
                not_woken.push((m, reason));
            }
        }
        self.cv.notify_all();
        Ok((mid, not_woken))
    }

    pub fn inbox(&self, agent: i64, mark: &str) -> R<Vec<Value>> {
        let st = self.lock();
        st.agent(agent)?;
        let mark = parse_mark(mark)?;
        let v = rows(
            &st.db,
            "SELECT m.id, m.thread_id thread, t.title, m.sender, m.text, m.at, coalesce(k.mark,'new') mark
             FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=?1
             JOIN threads t ON t.id=m.thread_id
             LEFT JOIN marks k ON k.agent_id=?1 AND k.message_id=m.id
             WHERE m.sender != ?1 AND coalesce(k.mark,'new')=?2 ORDER BY m.id",
            params![agent, mark],
        )?;
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
                "SELECT count(*) FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=?2
                 WHERE m.id=?1",
                params![id, agent],
                |r| r.get(0),
            )?;
            if n == 0 {
                return Err(not_found(format!("no message {id} in your threads")));
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
            "INSERT OR IGNORE INTO locks(project,name,about,created_at) VALUES(?1,?2,?3,?4)",
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
            st.expire_locks()?;
            if st.agent(agent)?.state != "working" {
                leave(&mut st);
                self.cv.notify_all();
                return Err(conflict(
                    "you're not working (paused or stopped), so you left the queue",
                ));
            }
            let (holder, since) = Self::lock_row(&st, project, name)?;
            let expires = ttl.map(|t| now() + t as i64);
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
        st.release_lock(project, name, Some("the user freed it"))?;
        st.log(
            Some(project),
            by,
            &format!("freed lock {name} (held by agent {holder})"),
        )?;
        self.cv.notify_all();
        Ok(())
    }

    pub fn locks(&self, project: Option<i64>) -> R<Vec<Value>> {
        let st = self.lock();
        let mut v = rows(
            &st.db,
            "SELECT l.project, l.name, l.about, l.holder, a.name holder_name, a.state holder_state,
                    l.acquired_at, l.expires_at, l.frozen, l.frozen_left
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
        let lim = st.settings().limits.context;
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

    /// The model refused or was flagged, or the harness switched models. Pause the agent
    /// (releasing its locks) and keep the reason for the user; it stays paused until they act.
    pub fn flag(self: &Arc<Self>, id: i64, reason: &str) -> R<()> {
        self.stop_for(id, "flagged", reason, "was flagged and paused")
    }

    /// The subscription's usage limit was hit mid-turn: pause until the window resets.
    pub fn limit_hit(self: &Arc<Self>, id: i64, text: &str) -> R<()> {
        self.stop_for(id, "limit", text, "hit its usage limit and was paused")
    }

    fn stop_for(self: &Arc<Self>, id: i64, why: &str, problem: &str, what: &str) -> R<()> {
        let mut st = self.lock();
        let a = st.agent(id)?;
        let reason: Option<String> =
            st.db
                .query_row("SELECT pause_reason FROM agents WHERE id=?1", [id], |r| {
                    r.get(0)
                })?;
        if a.state == "paused" && reason.as_deref() == Some(why) {
            return Ok(()); // one refusal often arrives as several events
        }
        st.db.execute(
            "UPDATE agents SET problem=?2 WHERE id=?1",
            params![id, problem],
        )?;
        if matches!(a.state.as_str(), "working" | "idle" | "done") {
            self.pause_locked(&mut st, id, LockMode::Release, why, "acom")?;
        }
        st.log_for(id, "acom", &format!("agent {id} {what}: {problem}"))
    }

    /// Flag the agent if a model other than the one it was launched with answered,
    /// or if the model changed during its session.
    pub fn check_model(self: &Arc<Self>, id: i64, answered: &str) -> R<()> {
        let reason = {
            let st = self.lock();
            let (asked, seen): (String, Option<String>) = st.db.query_row(
                "SELECT model, seen_model FROM agents WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if seen.is_none() {
                st.db.execute(
                    "UPDATE agents SET seen_model=?2 WHERE id=?1",
                    params![id, answered],
                )?;
            }
            // A short alias (e.g. "opus") can't be compared with what answers.
            let full_id = asked.contains('-');
            match seen {
                Some(seen) if !same_model(&seen, answered) => Some(format!(
                    "the model changed from {seen} to {answered} during the session"
                )),
                _ if full_id && !same_model(&asked, answered) => {
                    Some(format!("{answered} answered instead of {asked}"))
                }
                _ => None,
            }
        };
        match reason {
            Some(r) => self.flag(id, &r),
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

    /// Once a second: expire locks, act on subscription limits.
    pub fn tick(self: &Arc<Self>) -> R<()> {
        let mut st = self.lock();
        let mut changed = st.expire_locks()?;
        let s = st.settings();
        for (p, lim) in &s.limits.usage {
            let Some(used) = st.used_pct(p)? else {
                st.over_soft.remove(p);
                st.over_hard.remove(p);
                if s.auto_resume {
                    // The window reset: resume. Never had any usage: give it a few minutes.
                    let known: i64 = st.db.query_row(
                        "SELECT count(*) FROM usage WHERE provider=?1",
                        [p],
                        |r| r.get(0),
                    )?;
                    let wait = if known > 0 { 0 } else { 300 };
                    changed |= self.resume_limited(&mut st, p, wait)?;
                }
                continue;
            };
            let line = format!("{p} subscription usage {used:.0}% ({})", lim.text("%"));
            let (over_soft, over_hard) = (
                lim.soft.is_some_and(|v| used >= v),
                lim.hard.is_some_and(|v| used >= v),
            );
            if over_soft && st.over_soft.insert(p.clone()) {
                for r in rows(
                    &st.db,
                    "SELECT id FROM agents WHERE harness=?1 AND state NOT IN ('closed','crashed')",
                    [p],
                )? {
                    st.notice(
                        r["id"].as_i64().unwrap(),
                        &format!("Soft limit reached: {line}."),
                    )?;
                }
            } else if !over_soft {
                st.over_soft.remove(p);
            }
            if over_hard {
                if st.over_hard.insert(p.clone()) {
                    let ids: Vec<i64> = rows(
                        &st.db,
                        "SELECT id FROM agents WHERE harness=?1 AND state IN ('working','idle')",
                        [p],
                    )?
                    .iter()
                    .map(|r| r["id"].as_i64().unwrap())
                    .collect();
                    for id in &ids {
                        self.pause_locked(&mut st, *id, LockMode::Release, "limit", "acom")?;
                    }
                    st.log(
                        None,
                        "acom",
                        &format!("hard limit reached: {line}; paused {} agent(s)", ids.len()),
                    )?;
                    changed = true;
                }
            } else {
                st.over_hard.remove(p);
                // A window that's used up blocks the agents whatever the limits say.
                if s.auto_resume && used < 100.0 {
                    changed |= self.resume_limited(&mut st, p, 0)?;
                }
            }
        }
        changed |= self.drain_wakes(&mut st)?;
        if changed {
            self.cv.notify_all();
        }
        Ok(())
    }

    /// Resume agents a limit paused at least `min_paused` seconds ago.
    fn resume_limited(self: &Arc<Self>, st: &mut St, provider: &str, min_paused: i64) -> R<bool> {
        let ids: Vec<i64> = rows(
            &st.db,
            "SELECT id FROM agents WHERE harness=?1 AND state='paused' AND pause_reason='limit'
             AND paused_at <= ?2",
            params![provider, now() - min_paused],
        )?
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
        for id in &ids {
            if !st.procs.contains_key(id) {
                self.resume_locked(st, *id, "acom")?;
            }
        }
        Ok(!ids.is_empty())
    }

    pub fn put_settings(&self, new: Settings, by: &str) -> R<()> {
        new.check()?;
        let st = self.lock();
        let old = st.settings();
        st.db.execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('settings',?1)",
            [serde_json::to_string(&new).unwrap()],
        )?;
        st.log(None, by, "changed settings")?;
        if old.limits != new.limits || old.done_closes != new.done_closes {
            let text = format!(
                "The user changed the limits or rules. Now:\n{}",
                st.limits_text()?
            );
            for r in rows(
                &st.db,
                "SELECT id FROM agents WHERE state NOT IN ('closed','crashed')",
                [],
            )? {
                st.notice(r["id"].as_i64().unwrap(), &text)?;
            }
        }
        Ok(())
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

    pub fn projects(&self) -> R<Vec<Value>> {
        let st = self.lock();
        rows(
            &st.db,
            "SELECT p.id, p.name, p.path,
                    (SELECT count(*) FROM agents a WHERE a.project=p.id) agents,
                    (SELECT count(*) FROM agents a WHERE a.project=p.id AND a.state IN ('working','idle')) active
             FROM projects p ORDER BY p.name, p.id",
            [],
        )
    }

    /// Remove a project that never had agents (e.g. one added by mistake).
    pub fn remove_project(&self, id: i64, by: &str) -> R<()> {
        let st = self.lock();
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
        st.db.execute("DELETE FROM locks WHERE project=?1", [id])?;
        st.db.execute("DELETE FROM projects WHERE id=?1", [id])?;
        st.log(None, by, &format!("removed project {path}"))?;
        Ok(())
    }

    // ---------- views ----------

    pub fn agents(&self, project: Option<i64>, group: Option<&str>) -> R<Vec<Value>> {
        let st = self.lock();
        Self::agents_locked(&st, project, group)
    }

    fn agents_locked(st: &St, project: Option<i64>, group: Option<&str>) -> R<Vec<Value>> {
        let mut v = rows(
            &st.db,
            "SELECT id, project, name, grp \"group\", task, harness, model, effort, state, status_text status,
                    session_id session, launched_by, launched_at, pause_reason, paused_at, context,
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

    pub fn agent_view(&self, id: i64) -> R<Value> {
        let st = self.lock();
        let project = st.agent(id)?.project;
        let mut a = Self::agents_locked(&st, Some(project), None)?
            .into_iter()
            .find(|a| a["id"] == id)
            .unwrap();
        let (name, path) = st.project(project)?;
        a["project_name"] = json!(name);
        a["project_path"] = json!(path);
        a["limits"] = json!(st.limits_text()?);
        a["lost_locks"] = json!(rows(
            &st.db,
            "SELECT at, text FROM notices WHERE agent_id=?1 AND text LIKE 'You no longer hold lock %' ORDER BY id DESC LIMIT 20",
            [id],
        )?);
        Ok(a)
    }

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
            let ids = rows(
                &st.db,
                "SELECT agent_id a FROM members WHERE thread_id=?1 ORDER BY agent_id",
                [t["id"].as_i64()],
            )?;
            t["members"] = json!(ids.iter().map(|r| r["a"].clone()).collect::<Vec<_>>());
        }
        Ok(v)
    }

    pub fn thread(&self, tid: i64) -> R<Value> {
        let st = self.lock();
        Self::thread_project(&st, tid)?;
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
        t["messages"] = json!(rows(
            &st.db,
            "SELECT id, sender, text, at FROM messages WHERE thread_id=?1 ORDER BY id",
            [tid]
        )?);
        Ok(t)
    }

    pub fn message(&self, id: i64) -> R<Value> {
        let st = self.lock();
        rows(
            &st.db,
            "SELECT m.id, m.thread_id thread, t.title, m.sender, m.text, m.at FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=?1",
            [id],
        )?
        .pop()
        .ok_or_else(|| not_found(format!("no message {id}")))
    }

    pub fn limits(&self) -> R<Value> {
        let st = self.lock();
        let s = st.settings();
        let (total, per) = st.active_counts()?;
        let usage = rows(
            &st.db,
            "SELECT provider, win, used_pct, resets_at, at FROM usage ORDER BY provider, win",
            [],
        )?;
        Ok(
            json!({ "limits": s.limits, "active": { "total": total, "per_harness": per }, "usage": usage, "text": st.limits_text()? }),
        )
    }

    /// Recent activity for a project (with the lines about all projects), or for everything.
    pub fn activity(&self, project: Option<i64>, limit: i64) -> R<Vec<Value>> {
        let st = self.lock();
        rows(
            &st.db,
            "SELECT id, project, at, actor, what FROM activity
             WHERE ?1 IS NULL OR project IS NULL OR project=?1 ORDER BY id DESC LIMIT ?2",
            params![project, limit],
        )
    }

    pub fn settings(&self) -> Settings {
        self.lock().settings()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            queues: HashMap::new(),
            procs: HashMap::new(),
            over_hard: HashSet::new(),
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
    fn freezing_stops_the_ttl_and_resuming_restarts_it() {
        let mut st = st();
        hold(&st, "a", 1, Some(now() + 100));
        hold(&st, "b", 1, None);
        st.freeze_locks(1).unwrap();
        let (holder, expires, frozen, left) = lock(&st, "a");
        assert_eq!((holder, expires, frozen), (Some(1), None, 1));
        assert!((99..=100).contains(&left.unwrap()));
        assert_eq!(lock(&st, "b"), (Some(1), None, 1, None));

        // A frozen lock never expires, however long the holder stays paused.
        st.db
            .execute("UPDATE locks SET frozen_left=-50 WHERE name='a'", [])
            .unwrap();
        assert!(!st.expire_locks().unwrap());
        assert_eq!(lock(&st, "a").0, Some(1));

        st.db
            .execute("UPDATE locks SET frozen_left=60 WHERE name='a'", [])
            .unwrap();
        st.unfreeze_locks(1).unwrap();
        let (holder, expires, frozen, left) = lock(&st, "a");
        assert_eq!((holder, frozen, left), (Some(1), 0, None));
        assert!((now() + 59..=now() + 60).contains(&expires.unwrap()));
        assert_eq!(lock(&st, "b"), (Some(1), None, 0, None));
    }

    #[test]
    fn a_lock_already_past_its_ttl_is_released_not_frozen() {
        let mut st = st();
        hold(&st, "late", 1, Some(now() - 1));
        st.freeze_locks(1).unwrap();
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
        // A closed agent is only woken by the user.
        assert_eq!(st.pending(3, true).unwrap().len(), 1);
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

    #[test]
    fn room_follows_the_hard_limits_and_unset_means_no_limit() {
        let st = st(); // four working claude agents, across two projects
        let mut s = Settings::default();
        s.limits.active = Limit {
            soft: None,
            hard: Some(4.0),
        };
        s.limits.active_per_harness.clear();
        let save = |st: &St, s: &Settings| {
            st.db
                .execute(
                    "INSERT OR REPLACE INTO settings(key,value) VALUES('settings',?1)",
                    [serde_json::to_string(s).unwrap()],
                )
                .unwrap();
        };
        save(&st, &s);
        let why = st.no_room("claude").unwrap().unwrap();
        assert_eq!(
            why,
            "Hard limit reached: 4 active agents (soft none, hard 4)"
        );
        // An agent that marked itself done no longer takes a slot.
        st.db
            .execute("UPDATE agents SET done_req=1 WHERE id=1", [])
            .unwrap();
        assert_eq!(st.no_room("claude").unwrap(), None);
        s.limits.active = Limit {
            soft: None,
            hard: None,
        };
        save(&st, &s);
        st.db.execute("UPDATE agents SET done_req=0", []).unwrap();
        assert_eq!(st.no_room("claude").unwrap(), None);
        assert!(
            st.limits_text()
                .unwrap()
                .starts_with("Active agents: 4 (no limit)")
        );
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
        assert!(st.limits_text().unwrap().ends_with(
            "When an agent runs `acom done` it's closed: only the user's messages wake it again."
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
}
