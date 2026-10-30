use super::*;
use crate::app::Settings;
use crate::archive::{self, Stage};
use std::collections::BTreeSet;
use std::fs::File;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    project: String,
    source_instance: String,
    created_at: i64,
    exported_at: i64,
    configuration: Configuration,
    metrics_error: Option<String>,
    warnings: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Configuration {
    Default {
        fingerprint: String,
    },
    Snapshot {
        name: Option<String>,
        key: Option<String>,
        settings: Box<Settings>,
    },
}

impl Workspace {
    pub fn export_project(
        &self,
        id: &str,
        destination: &str,
        logs: bool,
        native: bool,
        by: &str,
    ) -> R<Value> {
        let _lifecycle = self.lifecycle();
        self.require_running()?;
        let engine = self.lookup(id)?;
        let project = self.record(id)?;
        let stage = Stage::new(&self.home.join("projects"))?;
        let snapshot = engine.snapshot_state(&stage.0)?;
        let agents = snapshot["agents"]
            .as_array()
            .ok_or_else(|| Fail(500, "snapshot agent manifest is missing".into()))?;
        let mut files = vec![(
            "acom.db".into(),
            stage.0.join("acom.db"),
            fs::metadata(stage.0.join("acom.db"))
                .map_err(io_error)?
                .len(),
        )];
        let mut warnings = Vec::new();
        if snapshot["metrics_error"].is_null() {
            files.push((
                "metrics.db".into(),
                stage.0.join("metrics.db"),
                fs::metadata(stage.0.join("metrics.db"))
                    .map_err(io_error)?
                    .len(),
            ));
        }
        if logs {
            // Capture fixed prefixes, never follow an actively growing log forever.
            for agent in agents {
                for extension in ["jsonl", "txt", "err"] {
                    let name = format!("logs/{}.{}", agent["id"], extension);
                    let path = engine.home.join(&name);
                    match archive::regular(&path) {
                        Ok(file) => {
                            files.push((name, path, file.metadata().map_err(io_error)?.len()))
                        }
                        Err(_) if !path.try_exists().map_err(io_error)? => {}
                        Err(error) => return Err(error),
                    }
                }
            }
        }
        if native {
            for agent in agents {
                let id = agent["id"].as_i64().unwrap();
                let archived = engine.home.join(format!("native/{id}.jsonl"));
                let source = agent["session_id"]
                    .as_str()
                    .and_then(|session| {
                        crate::harness::history_file(agent["harness"].as_str().unwrap(), session)
                    })
                    .or_else(|| archived.is_file().then_some(archived));
                if let Some(path) = source {
                    let file = archive::regular(&path)?;
                    files.push((
                        format!("native/{id}.jsonl"),
                        path,
                        file.metadata().map_err(io_error)?.len(),
                    ));
                } else if warnings.len() < 50 {
                    warnings.push(format!("agent {id}: no readable native transcript"));
                }
            }
        }
        if native && agents.len() > 50 && warnings.len() == 50 {
            warnings.push("Additional missing native transcripts are not listed.".into());
        }
        let manifest = Manifest {
            format: "acom-project".into(),
            version: 1,
            project: project.id,
            source_instance: project.source_instance,
            created_at: project.created_at,
            exported_at: now(),
            configuration: serde_json::from_value(snapshot["configuration"].clone())
                .map_err(|e| Fail(500, e.to_string()))?,
            metrics_error: snapshot["metrics_error"].as_str().map(str::to_owned),
            warnings,
        };
        let path = stage.0.join("manifest.json");
        let encoded = serde_json::to_vec(&manifest).map_err(|e| Fail(500, e.to_string()))?;
        if encoded.len() > 1024 * 1024 {
            return Err(bad("archive configuration manifest exceeds 1 MiB"));
        }
        fs::write(&path, encoded).map_err(io_error)?;
        files.insert(
            0,
            (
                "manifest.json".into(),
                path.clone(),
                fs::metadata(&path).map_err(io_error)?.len(),
            ),
        );
        let publication_warning = archive::write_archive(Path::new(destination), &files)?;
        let mut warnings = manifest.warnings;
        warnings.extend(publication_warning);
        let receipt = json!({"exported":true,"project":id,"archive":destination,"files":files.len(),"snapshot_at":manifest.exported_at,"warnings":warnings,"metrics_error":manifest.metrics_error,
            "notes":"Core state and effective settings are consistent snapshots. Logs/native transcripts are fixed prefixes, not provider-session backups. The archive contains private project data."});
        if let Err(error) = engine.lock().log(Some(1), by, "exported project snapshot") {
            let mut receipt = receipt;
            receipt["audit_warning"] = json!(error.1);
            return Ok(receipt);
        }
        Ok(receipt)
    }

    pub fn inspect_archive(&self, source: &str) -> R<Value> {
        let stage = Stage::new(&self.home.join("projects"))?;
        let (manifest, files, version) = read_archive(source, &stage.0, None)?;
        let default_changed = matches!(&manifest.configuration,Configuration::Default{fingerprint} if fingerprint!=&default_fingerprint());
        Ok(
            json!({"project":manifest.project,"source_instance":manifest.source_instance,"exported_at":manifest.exported_at,"version":version,
            "configuration":match &manifest.configuration {Configuration::Default{..}=>json!({"kind":"default","settings":Settings::default()}),Configuration::Snapshot{name,settings,..}=>json!({"kind":"snapshot","name":name,"settings":settings})},
            "files":files.len(),"metrics":files.contains("metrics.db"),"default_changed":default_changed,
            "warnings":manifest.warnings,"metrics_error":manifest.metrics_error,"already_exists":self.lookup(&manifest.project).is_ok()}),
        )
    }

    pub fn import_project(
        &self,
        source: &str,
        path: &str,
        accept_default_change: bool,
        by: &str,
        expected_version: &str,
    ) -> R<Value> {
        let _lifecycle = self.lifecycle();
        self.require_running()?;
        let canonical = canonical_project(path)?;
        let path = canonical
            .to_str()
            .ok_or_else(|| bad("project paths must be valid UTF-8"))?;
        let stage = Stage::new(&self.home.join("projects"))?;
        let (manifest, _, version) = read_archive(source, &stage.0, Some(expected_version))?;
        if version != expected_version {
            return Err(conflict(
                "archive differs from the inspected file; inspect it again before importing",
            ));
        }
        if self.lookup(&manifest.project).is_ok()
            || self
                .project_directory(&manifest.project)
                .try_exists()
                .map_err(io_error)?
        {
            return Err(conflict(
                "this project identity already exists; import never overwrites or duplicates an existing project",
            ));
        }
        let path_exists: bool = self.global.lock().db.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_projects WHERE path=?)",
            [path],
            |r| r.get(0),
        )?;
        if path_exists {
            return Err(conflict("this folder already belongs to an acom project"));
        }
        let settings = match &manifest.configuration {
            Configuration::Default { fingerprint } => {
                if fingerprint != &default_fingerprint() && !accept_default_change {
                    return Err(conflict(
                        "the archive references a different built-in Default configuration; inspect it and explicitly accept the current Default",
                    ));
                }
                None
            }
            Configuration::Snapshot { settings, .. } => Some(settings.as_ref()),
        };
        let mut database = crate::app::portable::validate_state(&stage.0.join("acom.db"))?;
        let name = canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Project".into());
        crate::app::portable::prepare_import(&mut database, path, &name, settings, by)?;
        drop(database);
        let id = manifest.project;
        self.global.lock().db.execute(
            "INSERT INTO workspace_imports(project,stage) VALUES(?,?)",
            params![id, stage.0.to_string_lossy()],
        )?;
        let directory = self.project_directory(&id);
        let imported = (|| {
            fs::rename(&stage.0, &directory).map_err(io_error)?;
            File::open(self.home.join("projects"))
                .and_then(|file| file.sync_all())
                .map_err(io_error)?;
            let engine = App::open_shared(
                directory.clone(),
                self.engine_url(&id),
                &self.home.join("global/shared.db"),
            )?;
            let imported_at = now();
            engine.initialize_metric_origin(&self.instance_id, Some(imported_at))?;
            engine.lock().db.execute("UPDATE account_cursor SET event_id=(SELECT coalesce(max(id),0) FROM global.account_events) WHERE id=1",[])?;
            let project = Project {
                id: id.clone(),
                path: path.into(),
                name,
                created_at: manifest.created_at,
                source_instance: manifest.source_instance,
                imported_at: Some(imported_at),
            };
            let mut summary = self.summary(&project, &engine)?;
            {
                let st = self.global.lock();
                let _engine_state = engine.lock();
                st.db.execute(
                    "ATTACH DATABASE ? AS imported",
                    [directory.join("acom.db").to_string_lossy()],
                )?;
                let committed = (|| -> R<Option<(String, String)>> {
                    let transaction = rusqlite::Transaction::new_unchecked(
                        &st.db,
                        rusqlite::TransactionBehavior::Immediate,
                    )?;
                    let config = match &manifest.configuration {
                        Configuration::Default { .. } => Some(1),
                        Configuration::Snapshot {
                            name: Some(name),
                            key: Some(key),
                            settings,
                        } => Some(import_config(&transaction, name, key, settings)?),
                        _ => None,
                    };
                    if let Some(config) = config {
                        transaction.execute(
                            "UPDATE imported.projects SET config=?,custom=NULL WHERE id=1",
                            [config],
                        )?;
                        transaction.execute(
                            "INSERT INTO global.config_uses(project,config) VALUES(?,?)",
                            params![id, config],
                        )?;
                    }
                    transaction.execute("INSERT INTO workspace_projects(id,path,name,created_at,source_instance,imported_at) VALUES(?,?,?,?,?,?)",params![project.id,project.path,project.name,project.created_at,project.source_instance,project.imported_at])?;
                    transaction.execute("DELETE FROM workspace_imports WHERE project=?", [&id])?;
                    let identity = match config {
                        Some(1) => Some(("default".into(), "Default".into())),
                        Some(config) => Some(transaction.query_row(
                            "SELECT uuid,name FROM global.configs WHERE id=?",
                            [config],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )?),
                        None => None,
                    };
                    transaction.commit()?;
                    Ok(identity)
                })();
                let detached = st.db.execute_batch("DETACH DATABASE imported");
                if let Some((key, name)) = committed? {
                    summary["config"] = json!(key);
                    summary["config_name"] = json!(name);
                }
                if let Err(error) = detached {
                    summary["warning"] = json!(format!(
                        "Import committed, but closing the temporary database attachment failed: {error}"
                    ));
                }
            }
            self.projects().insert(id.clone(), engine);
            summary["imported"] = json!(true);
            summary["configuration_note"] = json!(match &manifest.configuration {
                Configuration::Default { .. } =>
                    "Applied this binary's built-in Default configuration.",
                Configuration::Snapshot { name: Some(_), .. } =>
                    "Restored the archived named configuration without overwriting an existing configuration; conflicting identities or names receive a new identity/name.",
                _ => "Restored project Custom settings.",
            });
            summary["workers_started"] = json!(0);
            summary["warnings"] = json!(manifest.warnings);
            Ok(summary)
        })();
        if imported.is_err() {
            self.recover_imports()?;
        }
        imported
    }

    pub(super) fn recover_imports(&self) -> R<()> {
        let records = crate::app::rows(
            &self.global.lock().db,
            "SELECT project,stage FROM workspace_imports",
            [],
        )?;
        for record in records {
            let id = record["project"]
                .as_str()
                .ok_or_else(|| conflict("invalid pending import identity"))?;
            validate_uuid(id)?;
            let registered: bool = self.global.lock().db.query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_projects WHERE id=?)",
                [id],
                |r| r.get(0),
            )?;
            if !registered {
                let staged = PathBuf::from(
                    record["stage"]
                        .as_str()
                        .ok_or_else(|| conflict("invalid import stage"))?,
                );
                if staged.parent() != Some(self.home.join("projects").as_path())
                    || !staged
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with(".acom-stage-"))
                {
                    return Err(conflict("pending import stage escaped the workspace"));
                }
                for path in [self.project_directory(id), staged] {
                    if path.try_exists().map_err(io_error)? {
                        require_directory(&path)?;
                        let trash = self.home.join("trash").join(format!(
                            "interrupted-import-{id}-{}",
                            crate::harness::try_new_uuid().map_err(io_error)?
                        ));
                        fs::rename(path, trash).map_err(io_error)?;
                    }
                }
            }
            self.global
                .lock()
                .db
                .execute("DELETE FROM workspace_imports WHERE project=?", [id])?;
        }
        Ok(())
    }
}

fn default_fingerprint() -> String {
    crate::paging::fingerprint(serde_json::to_string(&Settings::default()).unwrap())
}

fn read_archive(
    source: &str,
    destination: &Path,
    expected_version: Option<&str>,
) -> R<(Manifest, BTreeSet<String>, String)> {
    let source = Path::new(source);
    if !source.is_absolute() {
        return Err(bad("archive source must be an absolute path"));
    }
    let (files, version) = archive::extract_versioned(source, destination, expected_version)?;
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(destination.join("manifest.json")).map_err(io_error)?)
            .map_err(|e| bad(format!("invalid archive manifest: {e}")))?;
    if manifest.format != "acom-project"
        || manifest.version != 1
        || manifest.exported_at < 0
        || manifest.created_at < 0
    {
        return Err(bad("unsupported project archive format"));
    }
    match &manifest.configuration {
        Configuration::Snapshot {
            name,
            key,
            settings,
        } => {
            crate::app::portable::check_settings(settings)?;
            if name.is_some() != key.is_some()
                || name
                    .as_ref()
                    .is_some_and(|name| name.trim().is_empty() || name == "Default")
                || key.as_ref().is_some_and(|key| {
                    key.len() != 32
                        || !key
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
            {
                return Err(bad("invalid archived configuration identity"));
            }
        }
        Configuration::Default { fingerprint }
            if fingerprint.len() != 16 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            return Err(bad("invalid archived Default fingerprint"));
        }
        _ => {}
    }
    validate_uuid(&manifest.project)?;
    validate_uuid(&manifest.source_instance)?;
    let database = crate::app::portable::validate_state(&destination.join("acom.db"))?;
    for name in &files {
        if let Some((_, filename)) = name.split_once('/') {
            let id = filename
                .split('.')
                .next()
                .unwrap()
                .parse::<i64>()
                .map_err(|_| bad("invalid archived agent filename"))?;
            let exists: bool = database.query_row(
                "SELECT EXISTS(SELECT 1 FROM agents WHERE id=?)",
                [id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(bad("archive contains a file for an unknown agent"));
            }
        }
    }
    if files.contains("metrics.db") == manifest.metrics_error.is_some() {
        return Err(bad(
            "archive metric history availability differs from its manifest",
        ));
    }
    if files.contains("metrics.db") {
        crate::metrics::Metrics::validate_snapshot(&destination.join("metrics.db")).map_err(bad)?;
        let metrics = rusqlite::Connection::open_with_flags(
            destination.join("metrics.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        metrics.execute_batch("PRAGMA trusted_schema=OFF")?;
        let mut series = metrics.prepare("SELECT DISTINCT entity FROM metric_series")?;
        for entity in series.query_map([], |row| row.get::<_, String>(0))? {
            let entity = entity?;
            let id = entity
                .strip_prefix("agent:")
                .and_then(|id| id.parse::<i64>().ok())
                .filter(|id| *id > 0 && entity == format!("agent:{id}"))
                .ok_or_else(|| bad("project archive contains a non-project metric entity"))?;
            let exists: bool = database.query_row(
                "SELECT EXISTS(SELECT 1 FROM agents WHERE id=?)",
                [id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(bad(
                    "archive metric history refers to an unknown project agent",
                ));
            }
        }
        let mut origins =
            metrics.prepare("SELECT id,source_instance,imported_at FROM metric_origins")?;
        for origin in origins.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })? {
            let (id, instance, imported) = origin?;
            let exists:bool=database.query_row("SELECT EXISTS(SELECT 1 FROM recording_origins WHERE id=?1 AND source_instance=?2 AND imported_at IS ?3)",params![id,instance,imported],|row|row.get(0))?;
            if !exists {
                return Err(bad("archive metric origin differs from project accounting"));
            }
        }
    }
    Ok((manifest, files, version))
}

fn import_config(db: &rusqlite::Connection, name: &str, key: &str, settings: &Settings) -> R<i64> {
    let saved: Option<(i64, String)> = db
        .query_row(
            "SELECT id,settings FROM global.configs WHERE uuid=?",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((id, encoded)) = &saved {
        let existing: Settings = serde_json::from_str(encoded)
            .map_err(|e| Fail(500, format!("invalid saved configuration: {e}")))?;
        if &existing == settings {
            return Ok(*id);
        }
    }
    let key = if saved.is_some() {
        crate::harness::try_new_uuid()
            .map_err(io_error)?
            .replace('-', "")
    } else {
        key.into()
    };
    let used: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM global.configs WHERE name=?)",
        [name],
        |r| r.get(0),
    )?;
    let name = if used {
        let mut candidate = format!("{name} (imported {})", &key[..8]);
        let mut found = false;
        for _ in 0..16 {
            let taken: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM global.configs WHERE name=?)",
                [&candidate],
                |r| r.get(0),
            )?;
            if !taken {
                found = true;
                break;
            }
            candidate = format!(
                "{name} (imported {})",
                crate::harness::try_new_uuid().map_err(io_error)?
            );
        }
        if !found {
            return Err(conflict(
                "could not allocate an unused imported configuration name",
            ));
        }
        candidate
    } else {
        name.into()
    };
    db.execute(
        "INSERT INTO global.configs(uuid,name,settings) VALUES(?,?,?)",
        params![key, name, serde_json::to_string(settings).unwrap()],
    )?;
    Ok(db.last_insert_rowid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_history_cannot_import_foreign_entities() {
        for entity in ["agent:999", "account:claude:five_hour"] {
            let fixture = Fixture::new();
            let engine = fixture.workspace.lookup(&fixture.id).unwrap();
            engine.metric_history.lock().unwrap().store.as_ref().unwrap().connection().execute("INSERT INTO metric_series(entity,metric,kind) VALUES(?,'total_tokens','counter')",[entity]).unwrap();
            let archive = fixture.root.join("invalid-metrics.tar");
            fixture
                .workspace
                .export_project(&fixture.id, archive.to_str().unwrap(), false, false, "user")
                .unwrap();
            let error = fixture
                .workspace
                .inspect_archive(archive.to_str().unwrap())
                .unwrap_err();
            assert_eq!(error.0, 400);
            assert!(error.1.contains("metric"));
        }
    }

    #[test]
    fn imported_configuration_name_can_collide_with_an_earlier_import() {
        let fixture = Fixture::new();
        let key = "11111111111111111111111111111111";
        fixture
            .workspace
            .global
            .add_config("Review", Settings::default(), "user")
            .unwrap();
        fixture
            .workspace
            .global
            .add_config("Review (imported 11111111)", Settings::default(), "user")
            .unwrap();
        let st = fixture.workspace.global.lock();
        let settings = Settings {
            auto_resume: false,
            ..Settings::default()
        };
        let imported = import_config(&st.db, "Review", key, &settings).unwrap();
        let name: String = st
            .db
            .query_row(
                "SELECT name FROM global.configs WHERE id=?",
                [imported],
                |row| row.get(0),
            )
            .unwrap();
        assert!(name.starts_with("Review (imported "));
        assert_ne!(name, "Review (imported 11111111)");
        assert_eq!(
            st.db
                .query_row("SELECT count(*) FROM global.configs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    struct Fixture {
        root: PathBuf,
        workspace: Arc<Workspace>,
        id: String,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("acom-portable-test-{}", crate::harness::new_uuid()));
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("source")).unwrap();
            fs::create_dir(root.join("restored")).unwrap();
            let workspace =
                Workspace::open(root.join("installation-a"), "http://localhost:1".into()).unwrap();
            let project = workspace
                .add(root.join("source").to_str().unwrap(), "user")
                .unwrap();
            let id = project["id"].as_str().unwrap().into();
            Self {
                root,
                workspace,
                id,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn archive_import_keeps_identity_drafts_settings_and_history_but_no_live_resources() {
        let fixture = Fixture::new();
        let engine = fixture.workspace.lookup(&fixture.id).unwrap();
        let settings = Settings {
            auto_resume: false,
            ..Settings::default()
        };
        engine
            .set_project_config(1, None, Some(settings.clone()), "user")
            .unwrap();
        engine.lock().db.execute_batch("INSERT INTO agents(id,project,name,task,harness,model,effort,state,session_id,session_started,launched_by,launched_at,pid) VALUES(1,1,'Worker','Synthetic task','codex','gpt-6-sol','medium','working','old-native',1,0,1,2147483646);
            INSERT INTO threads VALUES(1,1,'Notes',0,1);
            INSERT INTO members(thread_id,agent_id) VALUES(1,0);
            INSERT INTO messages VALUES(1,1,1,'Synthetic message',1);
            INSERT INTO locks VALUES(1,'resource','Synthetic lock',1,1,1,9999999999);
            INSERT INTO agent_continuations VALUES(1,'Old continuation',NULL,0);").unwrap();
        engine
            .save_user_draft(1, "Unsent synthetic draft", "empty")
            .unwrap();
        engine
            .record_tokens(
                1,
                crate::harness::TokenUsage {
                    counts: [Some(10), Some(0), Some(20), Some(30)],
                    total: Some(60),
                    source: crate::harness::TokenSource::CodexSession { finalized: false },
                },
            )
            .unwrap();
        engine.record_context(1, 40).unwrap();
        let history_count = engine
            .metric_history
            .lock()
            .unwrap()
            .store
            .as_ref()
            .unwrap()
            .connection()
            .query_row("SELECT count(*) FROM metric_samples", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert!(history_count > 0);
        fs::write(engine.home.join("logs/1.txt"), b"Synthetic activity\n").unwrap();
        fs::create_dir(engine.home.join("native")).unwrap();
        fs::write(
            engine.home.join("native/1.jsonl"),
            b"{\"synthetic\":true}\n",
        )
        .unwrap();
        let archive = fixture.root.join("project.tar");
        let exported = fixture
            .workspace
            .export_project(&fixture.id, archive.to_str().unwrap(), true, true, "user")
            .unwrap();
        assert_eq!(exported["exported"], true);
        assert_eq!(engine.lock().agent(1).unwrap().state, "working");
        let target = Workspace::open(
            fixture.root.join("installation-b"),
            "http://localhost:2".into(),
        )
        .unwrap();
        let imported = target
            .import_project(
                archive.to_str().unwrap(),
                fixture.root.join("restored").to_str().unwrap(),
                false,
                "user",
                &archive::source_version(&archive).unwrap(),
            )
            .unwrap();
        assert_eq!(imported["id"], fixture.id);
        assert_eq!(imported["workers_started"], 0);
        let restored = target.lookup(&fixture.id).unwrap();
        assert_eq!(restored.lock().agent(1).unwrap().state, "paused");
        assert!(restored.lock().agent(1).unwrap().session.is_none());
        assert!(restored.lock().procs.is_empty());
        assert_eq!(restored.settings(Some(1)), settings);
        let restored_view = restored.agent_view(1).unwrap();
        assert_eq!(restored_view["total_tokens"], 60);
        assert_eq!(restored_view["context"], 40);
        assert_eq!(restored_view["token_usage_state"], "partial");
        assert!(
            restored
                .metric_history
                .lock()
                .unwrap()
                .store
                .as_ref()
                .unwrap()
                .connection()
                .query_row("SELECT count(*) FROM metric_samples", [], |row| row
                    .get::<_, i64>(0))
                .unwrap()
                >= history_count
        );
        assert_eq!(
            restored.user_draft(1).unwrap()["text"],
            "Unsent synthetic draft"
        );
        assert_eq!(
            restored
                .lock()
                .db
                .query_row("SELECT text FROM messages WHERE id=1", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "Synthetic message"
        );
        assert!(
            restored
                .lock()
                .db
                .query_row("SELECT holder IS NULL FROM locks", [], |r| r
                    .get::<_, bool>(0))
                .unwrap()
        );
        assert_eq!(
            restored
                .lock()
                .db
                .query_row("SELECT count(*) FROM agent_continuations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            fs::read(restored.home.join("native/1.jsonl")).unwrap(),
            b"{\"synthetic\":true}\n"
        );
        target.tick().unwrap();
        assert!(restored.lock().procs.is_empty());
        assert_eq!(
            target
                .import_project(
                    archive.to_str().unwrap(),
                    fixture.root.join("restored").to_str().unwrap(),
                    false,
                    "user",
                    &archive::source_version(&archive).unwrap(),
                )
                .unwrap_err()
                .0,
            409
        );
        assert_eq!(target.list(10, None).unwrap()["total"], 1);
        let list = std::process::Command::new("tar")
            .args(["-tf", archive.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            list.status.success(),
            "{}",
            String::from_utf8_lossy(&list.stderr)
        );
        assert!(String::from_utf8_lossy(&list.stdout).contains("manifest.json"));
    }

    #[test]
    fn unknown_schema_and_paths_are_rejected_without_registry_side_effects() {
        let fixture = Fixture::new();
        let archive = fixture.root.join("project.tar");
        fixture
            .workspace
            .export_project(&fixture.id, archive.to_str().unwrap(), false, false, "user")
            .unwrap();
        let stage = Stage::new(&fixture.root).unwrap();
        let names = archive::extract(&archive, &stage.0).unwrap();
        let database = rusqlite::Connection::open(stage.0.join("acom.db")).unwrap();
        database
            .execute_batch(
                "CREATE TRIGGER unexpected AFTER INSERT ON agents BEGIN DELETE FROM messages; END;",
            )
            .unwrap();
        drop(database);
        let entries = names
            .iter()
            .map(|name| {
                (
                    name.clone(),
                    stage.0.join(name),
                    fs::metadata(stage.0.join(name)).unwrap().len(),
                )
            })
            .collect::<Vec<_>>();
        let malicious = fixture.root.join("malformed.tar");
        archive::write_archive(&malicious, &entries).unwrap();
        let target = Workspace::open(
            fixture.root.join("installation-b"),
            "http://localhost:2".into(),
        )
        .unwrap();
        assert!(target.inspect_archive(malicious.to_str().unwrap()).is_err());
        assert!(
            target
                .import_project(
                    malicious.to_str().unwrap(),
                    fixture.root.join("restored").to_str().unwrap(),
                    false,
                    "user",
                    &archive::source_version(&malicious).unwrap(),
                )
                .is_err()
        );
        assert_eq!(target.list(10, None).unwrap()["total"], 0);
        assert!(!target.project_directory(&fixture.id).exists());
    }

    #[test]
    fn interrupted_import_is_quarantined_and_never_started_on_restart() {
        let fixture = Fixture::new();
        let id = crate::harness::new_uuid();
        let stage = Stage::new(&fixture.workspace.home.join("projects")).unwrap();
        fs::write(stage.0.join("acom.db"), b"interrupted unpublished state").unwrap();
        fixture
            .workspace
            .global
            .lock()
            .db
            .execute(
                "INSERT INTO workspace_imports VALUES(?,?)",
                params![id, stage.0.to_string_lossy()],
            )
            .unwrap();
        fs::rename(&stage.0, fixture.workspace.project_directory(&id)).unwrap();
        fixture.workspace.recover_imports().unwrap();
        assert!(!fixture.workspace.project_directory(&id).exists());
        assert!(fixture.workspace.lookup(&id).is_err());
        assert_eq!(
            fs::read_dir(fixture.workspace.home.join("trash"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn named_configuration_collisions_never_overwrite_and_publish_atomically() {
        let fixture = Fixture::new();
        let source = &fixture.workspace;
        let settings = Settings {
            auto_resume: false,
            ..Settings::default()
        };
        let config = source
            .global
            .add_config("Review", settings.clone(), "user")
            .unwrap();
        source
            .lookup(&fixture.id)
            .unwrap()
            .set_project_config(1, Some(config), None, "user")
            .unwrap();
        let source_key = source.global.config_key(config).unwrap();
        let archive = fixture.root.join("named.tar");
        source
            .export_project(&fixture.id, archive.to_str().unwrap(), false, false, "user")
            .unwrap();
        let target = Workspace::open(
            fixture.root.join("installation-b"),
            "http://localhost:2".into(),
        )
        .unwrap();
        let existing = target
            .global
            .add_config("Review", Settings::default(), "user")
            .unwrap();
        target
            .global
            .lock()
            .db
            .execute(
                "UPDATE global.configs SET uuid=? WHERE id=?",
                params![source_key, existing],
            )
            .unwrap();
        target.global.lock().db.execute_batch("CREATE TRIGGER reject_import BEFORE INSERT ON workspace_projects BEGIN SELECT RAISE(FAIL,'synthetic import rejection'); END;").unwrap();
        assert!(
            target
                .import_project(
                    archive.to_str().unwrap(),
                    fixture.root.join("restored").to_str().unwrap(),
                    false,
                    "user",
                    &archive::source_version(&archive).unwrap(),
                )
                .is_err()
        );
        assert_eq!(
            target
                .global
                .lock()
                .db
                .query_row("SELECT count(*) FROM global.configs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            target
                .global
                .lock()
                .db
                .query_row("SELECT count(*) FROM global.config_uses", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(target.list(10, None).unwrap()["total"], 0);
        target
            .global
            .lock()
            .db
            .execute_batch("DROP TRIGGER reject_import")
            .unwrap();
        let imported = target
            .import_project(
                archive.to_str().unwrap(),
                fixture.root.join("restored").to_str().unwrap(),
                false,
                "user",
                &archive::source_version(&archive).unwrap(),
            )
            .unwrap();
        assert_ne!(imported["config"], source_key);
        assert!(
            imported["config_name"]
                .as_str()
                .unwrap()
                .starts_with("Review (imported ")
        );
        assert_eq!(
            target.global.config_view(existing).unwrap()["settings"],
            json!(Settings::default())
        );
        assert_eq!(
            target.lookup(&fixture.id).unwrap().settings(Some(1)),
            settings
        );
        assert_eq!(
            target
                .global
                .lock()
                .db
                .query_row(
                    "SELECT count(*) FROM global.config_uses WHERE project=?",
                    [&fixture.id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn archive_replacement_after_inspection_requires_a_new_review() {
        let fixture = Fixture::new();
        let archive = fixture.root.join("reviewed.tar");
        fixture
            .workspace
            .export_project(&fixture.id, archive.to_str().unwrap(), false, false, "user")
            .unwrap();
        let target = Workspace::open(
            fixture.root.join("installation-b"),
            "http://localhost:2".into(),
        )
        .unwrap();
        let inspection = target.inspect_archive(archive.to_str().unwrap()).unwrap();
        let replacement = fixture.root.join("replacement.tar");
        std::fs::copy(&archive, &replacement).unwrap();
        std::fs::rename(replacement, &archive).unwrap();
        assert_eq!(
            target
                .import_project(
                    archive.to_str().unwrap(),
                    fixture.root.join("restored").to_str().unwrap(),
                    false,
                    "user",
                    inspection["version"].as_str().unwrap()
                )
                .unwrap_err()
                .0,
            409
        );
        assert_eq!(target.list(10, None).unwrap()["total"], 0);
        let inspection = target.inspect_archive(archive.to_str().unwrap()).unwrap();
        assert_eq!(
            target
                .import_project(
                    archive.to_str().unwrap(),
                    fixture.root.join("restored").to_str().unwrap(),
                    false,
                    "user",
                    inspection["version"].as_str().unwrap()
                )
                .unwrap()["workers_started"],
            0
        );
    }
}
