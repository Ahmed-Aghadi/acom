use super::*;
use std::path::Path;

pub(crate) fn check_settings(settings: &Settings) -> R<()> {
    settings.check()
}

pub(crate) fn validate_state(path: &Path) -> R<Connection> {
    let db = Connection::open(path)?;
    db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;")?;
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(SCHEMA)?;
    initialize_views(&expected)?;
    let schema = |db: &Connection| -> R<Vec<Value>> {
        rows(
            db,
            "SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
            [],
        )
    };
    if schema(&db)? != schema(&expected)? {
        return Err(bad(
            "archive state schema differs from this binary; no compatibility conversion is performed",
        ));
    }
    let integrity: String = db.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(bad("archive state integrity check failed"));
    }
    if db.query_row("SELECT count(*) FROM projects WHERE id=1", [], |r| {
        r.get::<_, i64>(0)
    })? != 1
        || db.query_row("SELECT count(*) FROM projects", [], |r| r.get::<_, i64>(0))? != 1
    {
        return Err(bad(
            "archive must contain exactly one local project with ID 1",
        ));
    }
    for table in rows(
        &db,
        "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        [],
    )? {
        let name = table["name"].as_str().unwrap();
        let columns = rows(&db, &format!("PRAGMA table_info({name})"), [])?;
        let invalid_types = columns
            .iter()
            .map(|column| {
                let types = match column["type"].as_str().unwrap() {
                    "INTEGER" => "'integer'",
                    "REAL" => "'integer','real'",
                    "TEXT" => "'text'",
                    _ => unreachable!("schema was compared above"),
                };
                format!(
                    "typeof(\"{}\") NOT IN ({types}{})",
                    column["name"].as_str().unwrap(),
                    if column["notnull"] == 1 {
                        ""
                    } else {
                        ",'null'"
                    }
                )
            })
            .collect::<Vec<_>>()
            .join(" OR ");
        let invalid: bool = db.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM \"{name}\" WHERE {invalid_types})"),
            [],
            |row| row.get(0),
        )?;
        if invalid {
            return Err(bad(format!("archive contains invalid {name} value types")));
        }
        for column in columns {
            if column["name"] == "id"
                && column["type"] == "INTEGER"
                && column["pk"].as_i64().is_some_and(|pk| pk > 0)
                && name != "view_ids"
            {
                let invalid: bool = db.query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {name} WHERE id<=0)"),
                    [],
                    |r| r.get(0),
                )?;
                if invalid {
                    return Err(bad(format!("archive contains an invalid {name} identity")));
                }
            }
            let column = column["name"].as_str().unwrap();
            let target = match column {
                "agent" | "agent_id" | "holder" | "sender" | "owner" | "created_by"
                | "launched_by" | "predecessor" | "ancestor" | "replacement" => Some("agents"),
                "thread" | "thread_id" => Some("threads"),
                "project" => Some("projects"),
                "message_id" if name == "marks" => Some("messages"),
                "subscription" => Some("subscriptions"),
                _ => None,
            };
            if let Some(target) = target {
                let user = target == "agents"
                    && matches!(
                        (name, column),
                        ("members", "agent_id")
                            | ("member_intervals", "agent_id")
                            | ("messages", "sender")
                            | ("threads", "created_by")
                            | ("agents", "launched_by")
                            | ("events", "agent")
                            | ("thread_exclusions", "agent_id")
                    );
                let user = if user {
                    format!("AND {column}<>0")
                } else {
                    String::new()
                };
                let invalid:bool=db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {name} source WHERE {column} IS NOT NULL {user} AND ({column}<=0 OR NOT EXISTS(SELECT 1 FROM {target} target WHERE target.id=source.{column})))"),[],|r|r.get(0))?;
                if invalid {
                    return Err(bad(format!(
                        "archive contains an invalid {name}.{column} reference"
                    )));
                }
            }
        }
    }
    check_stored_schema(&db)?;
    tokens::validate_archive(&db)?;
    controls::validate_archive(&db)?;
    subscriptions::validate_archive(&db)?;
    let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id<=0 OR state NOT IN ('working','idle','paused','done','closed','crashed','replaced') OR harness NOT IN ('claude','codex'))",[],|r|r.get(0))?;
    if invalid {
        return Err(bad("archive contains invalid agent identities or states"));
    }
    Ok(db)
}

impl App {
    pub fn snapshot_state(&self, destination: &Path) -> R<Value> {
        let st = self.lock();
        // A read transaction pins both the local state and its effective shared
        // configuration while SQLite copies the core database.
        let transaction = st.db.unchecked_transaction()?;
        let project = rows(
            &transaction,
            "SELECT path,name,config,custom FROM projects WHERE id=1",
            [],
        )?
        .pop()
        .ok_or_else(|| not_found("no local project"))?;
        let settings = st.settings_for(Some(1));
        settings.check()?;
        let agents = rows(
            &transaction,
            "SELECT id,harness,session_id FROM agents ORDER BY id",
            [],
        )?;
        let config = if project["custom"].is_null() && project["config"] == 1 {
            json!({"kind":"default","fingerprint":fingerprint(serde_json::to_string(&Settings::default()).unwrap())})
        } else {
            let name = if project["custom"].is_null() {
                transaction
                    .query_row(
                        "SELECT name FROM global.configs WHERE id=?",
                        [project["config"].as_i64()],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?
            } else {
                None
            };
            let key = if name.is_some() {
                Some(transaction.query_row(
                    "SELECT uuid FROM global.configs WHERE id=?",
                    [project["config"].as_i64()],
                    |r| r.get::<_, String>(0),
                )?)
            } else {
                None
            };
            json!({"kind":"snapshot","name":name,"key":key,"settings":settings})
        };
        crate::archive::snapshot(&transaction, &destination.join("acom.db"))?;
        // Pin optional history while the core view is stable, but do not hold
        // the core mutex during its potentially slow backup.
        let metrics = self.pin_metric_snapshot();
        transaction.commit()?;
        drop(st);
        let metrics_error = metrics
            .and_then(|metrics| {
                crate::archive::snapshot(metrics.connection(), &destination.join("metrics.db"))
            })
            .err()
            .map(|e| e.1);
        Ok(json!({"configuration":config,"metrics_error":metrics_error,"agents":agents}))
    }
}

pub(crate) fn prepare_import(
    db: &mut Connection,
    path: &str,
    name: &str,
    settings: Option<&Settings>,
    by: &str,
) -> R<()> {
    if let Some(settings) = settings {
        settings.check()?;
    }
    let transaction = db.transaction()?;
    tokens::seal_import(&transaction)?;
    // These are evidence/history, not resumable OS resources or provider sessions.
    transaction.execute(
        "UPDATE projects SET path=?1,name=?2,config=?3,custom=?4 WHERE id=1",
        params![
            path,
            name,
            settings.is_none().then_some(1),
            settings.map(|s| serde_json::to_string(s).unwrap())
        ],
    )?;
    transaction.execute_batch("UPDATE agents SET pid=NULL,session_id=NULL,session_started=0,wake_queued_at=NULL,wake_why=NULL;
        UPDATE agents SET pause_from='working',pause_reason='manual',paused_at=unixepoch(),state='paused',rest='idle',done_req=0,problem='Imported snapshot; native conversation is not resumed automatically' WHERE state IN ('working','idle','paused');
        UPDATE locks SET holder=NULL,acquired_at=NULL,expires_at=NULL;
        UPDATE agent_retries SET handled=1,blocked='Imported snapshot; recovery is suspended until an explicit owner action';
        DELETE FROM agent_continuations; DELETE FROM agent_handoffs; DELETE FROM agent_starts;
        DELETE FROM active_recording_origin;
        DELETE FROM subscription_starts; DELETE FROM agent_quota_blocks;
        UPDATE subscriptions SET state='canceled',completed_at=unixepoch(),completion=json_object('kind','canceled','summary','imported snapshot') WHERE mode='once' AND state='active';")?;
    for agent in rows(
        &transaction,
        "SELECT id FROM agents WHERE state<>'replaced'",
        [],
    )? {
        let id = agent["id"].as_i64().unwrap();
        // Finalize any partial reporting without creating new numeric evidence.
        let ledger: Option<String> = transaction
            .query_row(
                "SELECT ledger FROM agent_token_usage WHERE agent_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(ledger) = ledger {
            let _: serde_json::Value =
                serde_json::from_str(&ledger).map_err(|_| bad("invalid archived token ledger"))?;
        }
        transaction.execute("INSERT INTO notices(agent_id,text,at) VALUES(?1,'[acom] Imported snapshot. No old processes, background jobs or held locks were restored. This is a fresh provider session; inspect acom history/inbox and any native/<ID>.jsonl archive before continuing.',?2)",params![id,now()])?;
    }
    transaction.execute("INSERT INTO activity(project,at,actor,what) VALUES(1,?1,?2,'imported project snapshot; workers remain stopped')",params![now(),by])?;
    transaction.execute(
        "INSERT INTO events(project,at,kind,actor,details) VALUES(1,?1,'project.imported',?2,'{}')",
        params![now(), by],
    )?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_checked_before_reading_saved_settings() {
        let stage = crate::archive::Stage::new(&std::env::temp_dir()).unwrap();
        let path = stage.0.join("acom.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA application_id=1094929731;PRAGMA user_version=2;CREATE TABLE unrelated(value);CREATE VIEW projects AS SELECT 1 id,42 custom;").unwrap();
        drop(db);
        let error = validate_state(&path).unwrap_err();
        assert_eq!(error.0, 400);
        assert!(error.1.contains("schema differs"));
    }

    #[test]
    fn current_schema_with_invalid_scalar_types_is_rejected() {
        for statement in [
            "UPDATE projects SET custom=x'ff'",
            "UPDATE projects SET created_at='not a timestamp'",
            "UPDATE projects SET name=x'ff'",
        ] {
            let stage = crate::archive::Stage::new(&std::env::temp_dir()).unwrap();
            let app = App::open(stage.0.clone(), "http://localhost:1".into()).unwrap();
            app.lock().db.execute_batch("INSERT INTO projects(id,path,name,created_at) VALUES(1,'/example','Example',0)").unwrap();
            app.lock().db.execute_batch(statement).unwrap();
            let error = validate_state(&stage.0.join("acom.db")).unwrap_err();
            assert_eq!(error.0, 400);
            assert!(error.1.contains("value types"), "{statement}: {}", error.1);
        }
    }
    #[test]
    fn zero_or_negative_entities_and_nonuser_references_are_rejected() {
        for statement in [
            "INSERT INTO threads VALUES(0,1,'Unreachable',0,0)",
            "INSERT INTO threads VALUES(1,0,'Orphan project',0,0)",
            "INSERT INTO messages VALUES(1,0,0,'Orphan thread',0)",
            "INSERT INTO locks VALUES(0,'resource','Orphan project',0,NULL,NULL,NULL)",
            "INSERT INTO notices(agent_id,text,at) VALUES(0,'Not a user delivery',0)",
        ] {
            let root = std::env::temp_dir().join(format!(
                "acom-import-validation-test-{}",
                crate::harness::new_uuid()
            ));
            let app = App::open(root.clone(), "http://localhost:1".into()).unwrap();
            app.lock().db.execute_batch("INSERT INTO projects(id,path,name,created_at) VALUES(1,'/example','Example',0)").unwrap();
            app.lock().db.execute_batch(statement).unwrap();
            assert!(
                validate_state(&root.join("acom.db")).is_err(),
                "accepted {statement}"
            );
            drop(app);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
