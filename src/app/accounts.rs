use super::*;
use std::path::Path;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS global.configs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 uuid TEXT NOT NULL UNIQUE DEFAULT(lower(hex(randomblob(16)))),
 name TEXT NOT NULL UNIQUE, settings TEXT NOT NULL);
INSERT INTO global.sqlite_sequence(name,seq) SELECT 'configs',1
 WHERE NOT EXISTS (SELECT 1 FROM global.sqlite_sequence WHERE name='configs');
CREATE TABLE IF NOT EXISTS global.usage (
 provider TEXT NOT NULL, win TEXT NOT NULL, used_pct REAL NOT NULL,
 resets_at INTEGER, at INTEGER NOT NULL, PRIMARY KEY(provider,win));
CREATE TABLE IF NOT EXISTS global.usage_checks (
 provider TEXT PRIMARY KEY, checked_at INTEGER, attempted_at INTEGER,
 next_check INTEGER, error TEXT, in_flight INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS global.usage_observations (
 provider TEXT NOT NULL, win TEXT NOT NULL, used_pct REAL NOT NULL,
 resets_at INTEGER, at INTEGER NOT NULL, PRIMARY KEY(provider,win));
CREATE TABLE IF NOT EXISTS global.account_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, details TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS global.command_receipts(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,response TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS global.config_uses(project TEXT PRIMARY KEY, config INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS global.view_revisions(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
PRAGMA global.application_id=1094929735;
PRAGMA global.user_version=1;
";

pub(super) const TABLES: &[&str] = &[
    "configs",
    "config_uses",
    "usage",
    "usage_checks",
    "global_settings",
];

/// Project and shared-account writes use SQLite's multi-file rollback journal.
/// Metrics are deliberately not attached: their WAL/checkpoint lifecycle is optional.
pub(super) fn initialize(db: &Connection, path: Option<&Path>) -> R<()> {
    db.busy_timeout(Duration::from_secs(5))?;
    if rows(db, "PRAGMA database_list", [])?
        .iter()
        .any(|r| r["name"] == "global")
    {
        return Ok(());
    }
    db.execute(
        "ATTACH DATABASE ?1 AS global",
        [path
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| ":memory:".into())],
    )?;
    let version: i64 = db.query_row("PRAGMA global.user_version", [], |r| r.get(0))?;
    let application: i64 = db.query_row("PRAGMA global.application_id", [], |r| r.get(0))?;
    let populated: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM global.sqlite_master WHERE type='table')",
        [],
        |r| r.get(0),
    )?;
    if (populated || version != 0 || application != 0)
        && (version != 1 || application != 1094929735)
    {
        return Err(conflict(
            "unsupported shared data format; keep a backup and use a fresh ACOM_HOME",
        ));
    }
    if populated {
        for saved in rows(db, "SELECT id,settings FROM global.configs", [])? {
            let text = saved["settings"].as_str().ok_or_else(|| {
                bad(format!(
                    "invalid saved settings type for config {}; saved data has not been changed",
                    saved["id"]
                ))
            })?;
            let settings: Settings = serde_json::from_str(text).map_err(|e| {
                bad(format!(
                    "invalid saved settings for config {}: {e}; saved data has not been changed",
                    saved["id"]
                ))
            })?;
            settings.check().map_err(|e| {
                bad(format!(
                    "invalid saved settings for config {}: {}; saved data has not been changed",
                    saved["id"], e.1
                ))
            })?;
        }
    }
    db.execute_batch(
        "PRAGMA main.journal_mode=DELETE; PRAGMA main.synchronous=FULL;
                      PRAGMA global.journal_mode=DELETE; PRAGMA global.synchronous=FULL;",
    )?;
    db.execute_batch(SCHEMA)?;
    db.execute_batch(globals::SCHEMA)?;
    for table in TABLES {
        db.execute(
            "INSERT OR IGNORE INTO global.view_revisions VALUES(?1,0)",
            [table],
        )?;
        let columns: Vec<String> = rows(db, &format!("PRAGMA global.table_info({table})"), [])?
            .into_iter()
            .map(|r| r["name"].as_str().unwrap().into())
            .collect();
        let changed = columns
            .iter()
            .map(|c| format!("OLD.\"{c}\" IS NOT NEW.\"{c}\""))
            .collect::<Vec<_>>()
            .join(" OR ");
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            let when = if operation == "UPDATE" {
                format!("WHEN {changed}")
            } else {
                String::new()
            };
            db.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS global.view_{table}_{operation}
                AFTER {operation} ON {table} {when} BEGIN
                UPDATE view_revisions SET value=value+1 WHERE name='{table}'; END;"
            ))?;
        }
    }
    Ok(())
}

pub(super) fn record(st: &St, kind: &str, details: Value) -> R<()> {
    st.db.execute(
        "INSERT INTO global.account_events(at,details) VALUES(?1,?2)",
        params![now(), json!({"kind":kind,"details":details}).to_string()],
    )?;
    sync(st)
}

/// Replay the shared journal into this project's history exactly once. Advancing
/// the cursor is in the same local transaction as the events it materializes.
pub(super) fn sync(st: &St) -> R<()> {
    let cursor: i64 =
        st.db
            .query_row("SELECT event_id FROM account_cursor WHERE id=1", [], |r| {
                r.get(0)
            })?;
    for row in rows(
        &st.db,
        "SELECT id,at,details FROM global.account_events WHERE id>?1 ORDER BY id LIMIT 256",
        [cursor],
    )? {
        let event: Value = serde_json::from_str(row["details"].as_str().unwrap())
            .map_err(|e| Fail(500, format!("invalid shared account event: {e}")))?;
        for project in rows(&st.db, "SELECT id FROM projects", [])? {
            let project = project["id"].as_i64().unwrap();
            let kind = event["kind"]
                .as_str()
                .ok_or_else(|| Fail(500, "missing account event kind".into()))?;
            if kind == "config.changed" {
                let applied: bool = st.db.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND config=?2 AND custom IS NULL)",params![project,event["details"]["config"].as_i64()],|r|r.get(0))?;
                if applied {
                    let previous: Settings =
                        serde_json::from_value(event["details"]["previous"].clone())
                            .map_err(|e| Fail(500, e.to_string()))?;
                    App::rules_changed(st, project, &previous)?;
                    st.event(
                        project,
                        None,
                        None,
                        "project.rules",
                        "acom",
                        json!({"reason":"saved configuration changed"}),
                    )?;
                }
                continue;
            }
            st.db.execute(
                "INSERT INTO events(project,at,kind,actor,details) VALUES(?1,?2,?3,'acom',?4)",
                params![
                    project,
                    row["at"].as_i64(),
                    kind,
                    event["details"].to_string()
                ],
            )?;
        }
        st.db.execute(
            "UPDATE account_cursor SET event_id=?1 WHERE id=1",
            [row["id"].as_i64().unwrap()],
        )?;
    }
    Ok(())
}

/// Use inside the caller's transaction before creating a notification audience
/// or its baseline. A bounded replay must not leave older account events behind it.
pub(super) fn catch_up(st: &St) -> R<()> {
    sync(st)?;
    let pending: bool = st.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM global.account_events WHERE id>(SELECT event_id FROM account_cursor WHERE id=1))",
        [], |row| row.get(0),
    )?;
    if pending {
        return Err(Fail(
            503,
            "account event synchronization is pending; retry shortly".into(),
        ));
    }
    Ok(())
}

impl App {
    pub fn config_key(&self, id: i64) -> R<String> {
        if id == 1 {
            return Ok("default".into());
        }
        self.lock()
            .db
            .query_row("SELECT uuid FROM global.configs WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| not_found("no saved configuration"))
    }

    pub fn config_rowid(&self, key: &str) -> R<i64> {
        if key == "default" {
            return Ok(1);
        }
        if key.len() != 32
            || !key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(bad(
                "configuration ID must be default or a saved configuration's opaque ID",
            ));
        }
        self.lock()
            .db
            .query_row("SELECT id FROM global.configs WHERE uuid=?1", [key], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| not_found("no saved configuration"))
    }

    pub fn sync_accounts(&self) -> R<()> {
        self.lock().atomic(|st| sync(st))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        app: Arc<App>,
        config: i64,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "acom-account-barrier-{}",
                crate::harness::new_uuid()
            ));
            std::fs::create_dir(&root).unwrap();
            let app = App::open(root.clone(), "http://127.0.0.1:1".into()).unwrap();
            app.lock().db.execute("INSERT INTO projects(id,path,name,created_at) VALUES(1,'/synthetic','Synthetic',0)",[]).unwrap();
            let config = app.add_config("Test", Settings::default(), "user").unwrap();
            app.set_project_config(1, Some(config), None, "user")
                .unwrap();
            Self { root, app, config }
        }
        fn request() -> LaunchReq {
            LaunchReq {
                task: "Synthetic work".into(),
                harness: Some("codex".into()),
                model: Some("gpt-6-sol".into()),
                effort: Some("medium".into()),
                name: None,
                group: None,
                force: false,
                done: false,
                ack_crashes: true,
            }
        }
        fn create(&self, state: &str) -> i64 {
            self.app
                .lock()
                .atomic(|st| App::create_agent(st, 0, None, 1, Self::request(), state))
                .unwrap()
        }
        fn queue_change(&self) {
            let previous = Settings::default();
            let mut changed = previous.clone();
            changed.auto_resume = false;
            let st = self.app.lock();
            st.db
                .execute(
                    "UPDATE global.configs SET settings=? WHERE id=?",
                    params![json!(changed).to_string(), self.config],
                )
                .unwrap();
            st.db.execute("INSERT INTO global.account_events(at,details) VALUES(1,?)",[json!({"kind":"config.changed","details":{"config":self.config,"previous":previous}}).to_string()]).unwrap();
        }
        fn cursor(&self) -> i64 {
            self.app
                .lock()
                .db
                .query_row("SELECT event_id FROM account_cursor WHERE id=1", [], |r| {
                    r.get(0)
                })
                .unwrap()
        }
        fn notices(&self, id: i64) -> i64 {
            self.app
                .lock()
                .db
                .query_row("SELECT count(*) FROM notices WHERE agent_id=?", [id], |r| {
                    r.get(0)
                })
                .unwrap()
        }
        fn backlog(&self) {
            let st = self.app.lock();
            for _ in 0..257 {
                st.db.execute("INSERT INTO global.account_events(at,details) VALUES(1,?)",[json!({"kind":"usage.observed","details":{"provider":"codex","window":"primary","before_used":10,"used":20}}).to_string()]).unwrap();
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn creation_materializes_old_config_changes_before_allocating_new_audiences() {
        for state in ["idle", "done"] {
            let f = Fixture::new();
            let existing = f.create("idle");
            f.queue_change();
            let new = f.create(state);
            assert_eq!(f.notices(existing), 1);
            assert_eq!(
                f.notices(new),
                0,
                "old changes must not become new-agent notices"
            );
            assert_eq!(f.cursor(), 1);
            assert!(!f.app.settings(Some(1)).auto_resume);
            f.app.sync_accounts().unwrap();
            assert_eq!(f.notices(new), 0);
        }
    }

    #[test]
    fn closed_and_crashed_reactivation_do_not_receive_changes_from_their_absent_audience() {
        let f = Fixture::new();
        let closed = f.create("closed");
        let crashed = f.create("crashed");
        f.queue_change();
        f.app.reopen(closed, "user").unwrap();
        assert_eq!(f.notices(closed), 0);
        assert_eq!(f.notices(crashed), 0);
        assert_eq!(f.app.lock().agent(closed).unwrap().state, "idle");
        f.app
            .lock()
            .atomic(|st| f.app.prepare_resume(st, crashed, "user"))
            .unwrap();
        assert_eq!(f.notices(crashed), 0);
        assert_eq!(f.cursor(), 1);
    }

    #[test]
    fn bounded_barriers_roll_back_creation_resume_reopen_and_cursors() {
        let f = Fixture::new();
        let closed = f.create("closed");
        let paused = f.create("paused");
        f.backlog();
        let before = rows(&f.app.lock().db, "SELECT * FROM agents ORDER BY id", []).unwrap();
        let result = f
            .app
            .lock()
            .atomic(|st| App::create_agent(st, 0, None, 1, Fixture::request(), "idle"));
        assert_eq!(result.unwrap_err().0, 503);
        assert_eq!(f.app.reopen(closed, "user").unwrap_err().0, 503);
        assert_eq!(
            f.app
                .lock()
                .atomic(|st| f.app.prepare_resume(st, paused, "user"))
                .unwrap_err()
                .0,
            503
        );
        assert_eq!(
            rows(&f.app.lock().db, "SELECT * FROM agents ORDER BY id", []).unwrap(),
            before
        );
        assert_eq!(f.cursor(), 0);
        assert_eq!(f.notices(closed), 0);
        assert_eq!(f.notices(paused), 0);
        assert_eq!(
            f.app
                .lock()
                .db
                .query_row(
                    "SELECT count(*) FROM events WHERE kind='usage.observed'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        f.app.sync_accounts().unwrap();
        f.app.reopen(closed, "user").unwrap();
        assert_eq!(f.cursor(), 257);
    }
}
