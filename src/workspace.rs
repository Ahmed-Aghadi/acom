use crate::app::{App, Fail, R, bad, conflict, not_found, now};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
mod portable;

const LAYOUT_FILE: &str = "workspace.json";
const PAGE_LIMIT: usize = 200;
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS workspace_identity(
  id INTEGER PRIMARY KEY CHECK(id=1),instance_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_projects(
  id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,
  created_at INTEGER NOT NULL,source_instance TEXT NOT NULL,imported_at INTEGER);
CREATE TABLE IF NOT EXISTS workspace_removals(
  project TEXT PRIMARY KEY,original_path TEXT NOT NULL,trash_path TEXT NOT NULL,
  requested_at INTEGER NOT NULL,actor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_imports(project TEXT PRIMARY KEY,stage TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_revision(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
INSERT OR IGNORE INTO workspace_revision VALUES(1,0);
CREATE TRIGGER IF NOT EXISTS workspace_project_insert AFTER INSERT ON workspace_projects BEGIN
  UPDATE workspace_revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS workspace_project_delete AFTER DELETE ON workspace_projects BEGIN
  UPDATE workspace_revision SET value=value+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS workspace_project_update AFTER UPDATE ON workspace_projects
WHEN OLD.id IS NOT NEW.id OR OLD.path IS NOT NEW.path OR OLD.name IS NOT NEW.name
  OR OLD.created_at IS NOT NEW.created_at OR OLD.source_instance IS NOT NEW.source_instance
  OR OLD.imported_at IS NOT NEW.imported_at BEGIN
  UPDATE workspace_revision SET value=value+1 WHERE id=1; END;";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Layout {
    format: String,
    version: u32,
}

#[derive(Clone, Debug, Serialize)]
struct Project {
    id: String,
    path: String,
    name: String,
    created_at: i64,
    source_instance: String,
    imported_at: Option<i64>,
}

pub struct Workspace {
    pub home: PathBuf,
    pub url: String,
    pub global: Arc<App>,
    pub instance_id: String,
    projects: Mutex<BTreeMap<String, Arc<App>>>,
    lifecycle: Mutex<()>,
    stopping: AtomicBool,
}

impl Workspace {
    pub fn open(home: PathBuf, url: String) -> R<Arc<Self>> {
        prepare_layout(&home)?;
        let home = fs::canonicalize(home).map_err(io_error)?;
        let url = url.trim_end_matches('/').to_owned();
        let global_home = home.join("global");
        if global_home.try_exists().map_err(io_error)? {
            require_directory(&global_home)?;
        }
        let shared = global_home.join("shared.db");
        let global = App::open_shared(global_home, url.clone(), &shared)?;
        let instance_id = {
            let st = global.lock();
            st.db.execute_batch(SCHEMA)?;
            let saved = st
                .db
                .query_row(
                    "SELECT instance_id FROM workspace_identity WHERE id=1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            match saved {
                Some(id) => {
                    validate_uuid(&id)?;
                    id
                }
                None => {
                    let id = crate::harness::try_new_uuid().map_err(io_error)?;
                    st.db
                        .execute("INSERT INTO workspace_identity VALUES(1,?)", [&id])?;
                    id
                }
            }
        };
        crate::app::private_directory(&home.join("projects")).map_err(io_error)?;
        crate::app::private_directory(&home.join("trash")).map_err(io_error)?;
        require_directory(&home.join("projects"))?;
        require_directory(&home.join("trash"))?;
        let workspace = Arc::new(Self {
            home,
            url,
            global,
            instance_id,
            projects: Mutex::new(BTreeMap::new()),
            lifecycle: Mutex::new(()),
            stopping: AtomicBool::new(false),
        });
        workspace
            .global
            .initialize_metric_origin(&workspace.instance_id, None)?;
        workspace.recover_removals()?;
        workspace.recover_imports()?;
        for project in workspace.records()? {
            validate_uuid(&project.id)?;
            validate_uuid(&project.source_instance)?;
            let directory = workspace.project_directory(&project.id);
            require_directory(&directory)?;
            if !directory.join("acom.db").is_file() {
                return Err(conflict(format!(
                    "project {} has no state database; restore it before starting",
                    project.id
                )));
            }
            let reconcile_started = now();
            let engine = App::open_shared(directory, workspace.engine_url(&project.id), &shared)?;
            let (name, path) = engine.lock().project(1)?;
            if name != project.name || path != project.path {
                return Err(conflict(format!(
                    "project {} registry and saved project identity differ",
                    project.id
                )));
            }
            let count: i64 =
                engine
                    .lock()
                    .db
                    .query_row("SELECT count(*) FROM projects", [], |row| row.get(0))?;
            if count != 1 {
                return Err(conflict(format!(
                    "project {} must contain exactly one local project",
                    project.id
                )));
            }
            engine.initialize_metric_origin(&workspace.instance_id, project.imported_at)?;
            let reconciled = crate::app::rows(
                &engine.lock().db,
                "SELECT id FROM agents WHERE state='paused' AND pause_reason='restart' AND paused_at>=?",
                [reconcile_started],
            )?;
            for agent in reconciled {
                engine.capture_agent_metrics(agent["id"].as_i64().unwrap(), true);
            }
            workspace.projects().insert(project.id, engine);
        }
        workspace
            .global
            .lock()
            .db
            .execute("UPDATE global.usage_checks SET in_flight=0", [])?;
        Ok(workspace)
    }

    fn projects(&self) -> MutexGuard<'_, BTreeMap<String, Arc<App>>> {
        self.projects
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn lifecycle(&self) -> MutexGuard<'_, ()> {
        self.lifecycle
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }

    fn require_running(&self) -> R<()> {
        if self.is_stopping() {
            Err(Fail(503, "the server is stopping".into()))
        } else {
            Ok(())
        }
    }

    fn project_directory(&self, id: &str) -> PathBuf {
        self.home.join("projects").join(id)
    }

    fn engine_url(&self, id: &str) -> String {
        format!("{}/p/{id}", self.url)
    }

    fn records(&self) -> R<Vec<Project>> {
        let st = self.global.lock();
        let mut statement=st.db.prepare("SELECT id,path,name,created_at,source_instance,imported_at FROM workspace_projects ORDER BY id")?;
        statement
            .query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    created_at: row.get(3)?,
                    source_instance: row.get(4)?,
                    imported_at: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn record(&self, id: &str) -> R<Project> {
        validate_uuid(id)?;
        self.global.lock().db.query_row(
            "SELECT id,path,name,created_at,source_instance,imported_at FROM workspace_projects WHERE id=?",[id],|row|Ok(Project {
                id:row.get(0)?,path:row.get(1)?,name:row.get(2)?,created_at:row.get(3)?,source_instance:row.get(4)?,imported_at:row.get(5)?,
            }),
        ).optional()?.ok_or_else(||not_found(format!("no project {id}")))
    }

    pub fn lookup(&self, id: &str) -> R<Arc<App>> {
        validate_uuid(id)?;
        self.projects()
            .get(id)
            .cloned()
            .ok_or_else(|| not_found(format!("no project {id}")))
    }

    pub fn engines(&self) -> Vec<(String, Arc<App>)> {
        self.projects()
            .iter()
            .map(|(id, engine)| (id.clone(), engine.clone()))
            .collect()
    }

    pub fn registry_revision(&self) -> R<i64> {
        Ok(self.global.lock().db.query_row(
            "SELECT value FROM workspace_revision WHERE id=1",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn projects_revision(&self) -> R<String> {
        let _lifecycle = self.lifecycle();
        let mut generations = format!("{}:{}", self.instance_id, self.registry_revision()?);
        for (id, engine) in self.engines() {
            generations.push_str(&format!(":{id}:{}", engine.project_revision()?));
        }
        Ok(crate::paging::fingerprint(generations))
    }

    pub fn unread_total(&self) -> R<i64> {
        self.engines()
            .into_iter()
            .try_fold(0_i64, |total, (_, engine)| {
                Ok(total.saturating_add(engine.project_view(1)?["unread"].as_i64().unwrap_or(0)))
            })
    }

    fn summary(&self, project: &Project, engine: &App) -> R<Value> {
        let mut value = engine.project_view(1)?;
        value["id"] = json!(project.id);
        value["name"] = json!(project.name);
        value["path"] = json!(project.path);
        value["created_at"] = json!(project.created_at);
        value["source_instance"] = json!(project.source_instance);
        value["imported_at"] = json!(project.imported_at);
        if let Some(config) = value["config"].as_i64() {
            value["config"] = json!(engine.config_key(config)?);
        }
        Ok(value)
    }

    pub fn project(&self, id: &str) -> R<Value> {
        let project = self.record(id)?;
        self.summary(&project, self.lookup(id)?.as_ref())
    }

    pub fn first(&self) -> R<Option<Value>> {
        let id = self
            .global
            .lock()
            .db
            .query_row(
                "SELECT id FROM workspace_projects ORDER BY name,id LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        id.map(|id| self.project(&id)).transpose()
    }

    pub fn list(&self, limit: usize, after: Option<&str>) -> R<Value> {
        let _lifecycle = self.lifecycle();
        if !(1..=PAGE_LIMIT).contains(&limit) {
            return Err(bad(format!("project page limit must be 1–{PAGE_LIMIT}")));
        }
        if let Some(after) = after {
            validate_uuid(after)?;
        }
        let (records, total) = {
            let st = self.global.lock();
            let total: i64 =
                st.db
                    .query_row("SELECT count(*) FROM workspace_projects", [], |row| {
                        row.get(0)
                    })?;
            let mut statement=st.db.prepare("SELECT id,path,name,created_at,source_instance,imported_at FROM workspace_projects WHERE id>? ORDER BY id LIMIT ?")?;
            let records = statement
                .query_map(params![after.unwrap_or(""), (limit + 1) as i64], |row| {
                    Ok(Project {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        name: row.get(2)?,
                        created_at: row.get(3)?,
                        source_instance: row.get(4)?,
                        imported_at: row.get(5)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            (records, total)
        };
        let more = records.len() > limit;
        let records: Vec<_> = records.into_iter().take(limit).collect();
        let next = more.then(|| records.last().unwrap().id.clone());
        let items = records
            .iter()
            .map(|project| self.summary(project, self.lookup(&project.id)?.as_ref()))
            .collect::<R<Vec<_>>>()?;
        Ok(json!({"items":items,"total":total,"next":next}))
    }

    pub fn at_path(&self, path: &str) -> R<Value> {
        let canonical = canonical_project(path)?;
        let ids: BTreeMap<_, _> = self
            .records()?
            .into_iter()
            .map(|project| (PathBuf::from(&project.path), project.id))
            .collect();
        for ancestor in canonical.ancestors() {
            if let Some(id) = ids.get(ancestor) {
                return self.project(id);
            }
        }
        Err(not_found(format!(
            "{} isn't in an acom project; add it with `acom project add`",
            canonical.display()
        )))
    }

    pub fn add(&self, path: &str, by: &str) -> R<Value> {
        let _lifecycle = self.lifecycle();
        self.require_running()?;
        let canonical = canonical_project(path)?;
        let path = canonical
            .to_str()
            .ok_or_else(|| bad("project paths must be valid UTF-8"))?;
        let existing = self
            .global
            .lock()
            .db
            .query_row(
                "SELECT id FROM workspace_projects WHERE path=?",
                [path],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(id) = existing {
            let mut value = self.project(&id)?;
            value["added"] = json!(false);
            return Ok(value);
        }
        let (id, directory) = self.reserve_directory()?;
        let initialized = (|| {
            let engine = App::open_shared(
                directory.clone(),
                self.engine_url(&id),
                &self.home.join("global/shared.db"),
            )?;
            // A new project's subscriptions must not replay account events from
            // before the project existed. Existing engines retain their cursor.
            engine.lock().db.execute("UPDATE account_cursor SET event_id=(SELECT coalesce(max(id),0) FROM global.account_events) WHERE id=1",[])?;
            let local = engine.add_project(path, by)?;
            if local["id"] != 1 {
                return Err(conflict("a new engine did not allocate local project 1"));
            }
            engine.initialize_metric_origin(&self.instance_id, None)?;
            let project = Project {
                id: id.clone(),
                path: path.into(),
                name: local["name"]
                    .as_str()
                    .ok_or_else(|| Fail(500, "project name missing".into()))?
                    .into(),
                created_at: now(),
                source_instance: self.instance_id.clone(),
                imported_at: None,
            };
            let mut summary = self.summary(&project, &engine)?;
            {
                let st = self.global.lock();
                let transaction = st.db.unchecked_transaction()?;
                transaction.execute("INSERT INTO workspace_projects(id,path,name,created_at,source_instance,imported_at) VALUES(?,?,?,?,?,?)",params![project.id,project.path,project.name,project.created_at,project.source_instance,project.imported_at])?;
                transaction.execute(
                    "INSERT INTO global.config_uses(project,config) VALUES(?,1)",
                    [&project.id],
                )?;
                st.log(None, by, &format!("added project {}", project.path))?;
                transaction.commit()?;
            }
            self.projects().insert(id.clone(), engine);
            summary["added"] = json!(true);
            Ok(summary)
        })();
        match initialized {
            Ok(value) => Ok(value),
            Err(error) => {
                let trash = self
                    .home
                    .join("trash")
                    .join(format!("unregistered-{id}-{}", now()));
                if let Err(move_error) = fs::rename(&directory, &trash) {
                    return Err(Fail(
                        500,
                        format!(
                            "{}. New unregistered state remains at {}: {move_error}",
                            error.1,
                            directory.display()
                        ),
                    ));
                }
                self.global
                    .lock()
                    .db
                    .execute("DELETE FROM global.config_uses WHERE project=?", [&id])?;
                Err(error)
            }
        }
    }

    fn reserve_directory(&self) -> R<(String, PathBuf)> {
        for _ in 0..16 {
            let id = crate::harness::try_new_uuid().map_err(io_error)?;
            let directory = self.project_directory(&id);
            match fs::DirBuilder::new().mode(0o700).create(&directory) {
                Ok(()) => return Ok((id, directory)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error(error)),
            }
        }
        Err(conflict("could not allocate a unique project identity"))
    }

    pub fn remove(&self, id: &str, by: &str) -> R<Value> {
        let _lifecycle = self.lifecycle();
        self.require_running()?;
        let project = self.record(id)?;
        let engine = self.lookup(id)?;
        let directory = self.project_directory(id);
        require_directory(&self.home.join("projects"))?;
        require_directory(&self.home.join("trash"))?;
        require_directory(&directory)?;
        let trash = self.home.join("trash").join(format!(
            "{id}-{}",
            crate::harness::try_new_uuid().map_err(io_error)?
        ));
        if trash.try_exists().map_err(io_error)? {
            return Err(conflict("the allocated trash destination already exists"));
        }
        {
            let mut st = engine.lock();
            let agents: i64 = st
                .db
                .query_row("SELECT count(*) FROM agents", [], |row| row.get(0))?;
            if agents > 0 || !st.procs.is_empty() || !st.stopping_agents.is_empty() {
                return Err(conflict("only a project without agents can be removed"));
            }
            st.shutting_down = true;
        }
        // The intent makes an interruption between the filesystem move and registry
        // commit recoverable. No project state is recursively deleted.
        let intent = (|| {
            let st = self.global.lock();
            st.db.execute("INSERT INTO workspace_removals(project,original_path,trash_path,requested_at,actor) VALUES(?,?,?,?,?)",params![id,directory.to_string_lossy(),trash.to_string_lossy(),now(),by])?;
            Ok(())
        })();
        if let Err(error) = intent {
            engine.lock().shutting_down = false;
            return Err(error);
        }
        if let Err(error) = fs::rename(&directory, &trash) {
            engine.lock().shutting_down = false;
            self.global
                .lock()
                .db
                .execute("DELETE FROM workspace_removals WHERE project=?", [id])?;
            return Err(io_error(error));
        }
        let committed = self
            .sync_directories()
            .and_then(|_| self.finish_removal(id, &project.path, &trash, by));
        if let Err(error) = committed {
            match fs::rename(&trash, &directory) {
                Ok(()) => {
                    engine.lock().shutting_down = false;
                    self.sync_directories()?;
                    self.global
                        .lock()
                        .db
                        .execute("DELETE FROM workspace_removals WHERE project=?", [id])?;
                    return Err(error);
                }
                Err(restore) => {
                    return Err(Fail(
                        500,
                        format!(
                            "{}. Project is unavailable; state is preserved at {} and removal will reconcile on restart: {restore}",
                            error.1,
                            trash.display()
                        ),
                    ));
                }
            }
        }
        self.projects().remove(id);
        Ok(json!({"id":id,"removed":true,"trash_path":trash,"recoverable":true}))
    }

    fn sync_directories(&self) -> R<()> {
        for directory in ["projects", "trash"] {
            fs::File::open(self.home.join(directory))
                .and_then(|file| file.sync_all())
                .map_err(io_error)?;
        }
        Ok(())
    }

    fn finish_removal(&self, id: &str, path: &str, trash: &Path, by: &str) -> R<()> {
        let st = self.global.lock();
        let transaction = st.db.unchecked_transaction()?;
        transaction.execute("DELETE FROM workspace_projects WHERE id=?", [id])?;
        transaction.execute("DELETE FROM global.config_uses WHERE project=?", [id])?;
        transaction.execute("DELETE FROM workspace_removals WHERE project=?", [id])?;
        st.log(
            None,
            by,
            &format!(
                "removed project {path}; saved state moved to {}",
                trash.display()
            ),
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn recover_removals(&self) -> R<()> {
        let pending = {
            let st = self.global.lock();
            let mut statement=st.db.prepare("SELECT project,original_path,trash_path,actor FROM workspace_removals ORDER BY project")?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, original, trash, actor) in pending {
            validate_uuid(&id)?;
            let original = PathBuf::from(original);
            let trash = PathBuf::from(trash);
            if original != self.project_directory(&id)
                || trash.parent() != Some(self.home.join("trash").as_path())
                || !trash
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(&format!("{id}-")))
            {
                return Err(conflict(
                    "invalid saved project removal paths; state has not been moved",
                ));
            }
            match (
                original.try_exists().map_err(io_error)?,
                trash.try_exists().map_err(io_error)?,
            ) {
                (true, false) => {
                    self.global
                        .lock()
                        .db
                        .execute("DELETE FROM workspace_removals WHERE project=?", [&id])?;
                }
                (false, true) => {
                    let project = self.record(&id)?;
                    self.finish_removal(&id, &project.path, &trash, &actor)?;
                }
                _ => {
                    return Err(conflict(format!(
                        "cannot reconcile removal of project {id}: expected exactly one saved state directory"
                    )));
                }
            }
        }
        Ok(())
    }

    pub fn action_counts(&self, project: Option<&str>) -> R<Value> {
        let engines = self.targets(project)?;
        let mut pause = 0_i64;
        let mut resume = 0_i64;
        let mut restart = 0_i64;
        for (_, engine) in engines {
            let counts:(i64,i64,i64)=engine.lock().db.query_row(
                "SELECT coalesce(sum(state IN ('working','idle','done')),0),coalesce(sum(state='paused'),0),coalesce(sum(state='paused' AND pause_reason='restart'),0) FROM agents",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            )?;
            pause += counts.0;
            resume += counts.1;
            restart += counts.2;
        }
        Ok(json!({"pause_eligible":pause,"resume_eligible":resume,"restart_paused":restart}))
    }

    fn targets(&self, project: Option<&str>) -> R<Vec<(String, Arc<App>)>> {
        match project {
            Some(id) => Ok(vec![(id.into(), self.lookup(id)?)]),
            None => Ok(self.engines()),
        }
    }

    fn bulk(&self, project: Option<&str>, by: &str, action: &str) -> R<Value> {
        self.require_running()?;
        let mut results = Vec::new();
        let mut errors = Vec::new();
        for (id, engine) in self.targets(project)? {
            let outcome = match action {
                "pause" => engine.pause_all(Some(1), by).map(|ids| json!({"ids":ids})),
                "resume" => engine.resume_all(Some(1), by).map(|ids| json!({"ids":ids})),
                "resume-restart" => engine.resume_restart(Some(1), by),
                _ => unreachable!(),
            };
            match outcome {
                Ok(mut value) => {
                    value["project"] = json!(id);
                    results.push(value)
                }
                Err(error) => errors.push(json!({"project":id,"status":error.0,"error":error.1})),
            }
        }
        let count = |key: &str| {
            results
                .iter()
                .map(|v| v[key].as_array().map_or(0, Vec::len))
                .sum::<usize>()
        };
        let counts = json!({"ids":count("ids"),"warnings":count("warnings"),"errors":errors.len()+count("errors")});
        Ok(json!({"results":results,"errors":errors,"counts":counts}))
    }

    pub fn pause_all(&self, project: Option<&str>, by: &str) -> R<Value> {
        self.bulk(project, by, "pause")
    }
    pub fn resume_all(&self, project: Option<&str>, by: &str) -> R<Value> {
        self.bulk(project, by, "resume")
    }
    pub fn resume_restart(&self, project: Option<&str>, by: &str) -> R<Value> {
        self.bulk(project, by, "resume-restart")
    }

    pub fn tick(&self) -> R<()> {
        if self.is_stopping() {
            return Ok(());
        }
        self.global.capture_account_metrics();
        self.global.sample_metrics();
        let mut errors = Vec::new();
        for (id, engine) in self.engines() {
            if let Err(error) = engine.sync_accounts().and_then(|_| engine.tick()) {
                errors.push(format!("project {id}: {}", error.1));
            }
            engine.sample_metrics();
        }
        combined_errors(errors)
    }

    pub fn shutdown(&self) -> R<()> {
        let _lifecycle = self.lifecycle();
        self.stopping.store(true, Ordering::Release);
        let engines = self.engines();
        for (_, engine) in &engines {
            engine.lock().shutting_down = true;
        }
        let mut errors = Vec::new();
        for (id, engine) in engines {
            if let Err(error) = engine.shutdown() {
                errors.push(format!("project {id}: {}", error.1));
            }
        }
        if let Err(error) = self.global.shutdown() {
            errors.push(format!("global state: {}", error.1));
        }
        combined_errors(errors)
    }
}

pub fn validate_uuid(id: &str) -> R<()> {
    if id.len() != 36
        || !id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
    {
        return Err(bad("project identities must be canonical UUIDs"));
    }
    Ok(())
}

fn canonical_project(path: &str) -> R<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|error| bad(format!("{path}: {error}")))?;
    if !canonical.is_dir() {
        return Err(bad(format!("{} isn't a folder", canonical.display())));
    }
    if canonical.to_str().is_none() {
        return Err(bad("project paths must be valid UTF-8"));
    }
    Ok(canonical)
}

fn require_directory(path: &Path) -> R<()> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(conflict(format!(
            "{} must be a project data directory, not a symlink",
            path.display()
        )));
    }
    Ok(())
}

fn prepare_layout(home: &Path) -> R<()> {
    if fs::symlink_metadata(home.join("acom.db")).is_ok() {
        return Err(conflict(
            "this directory contains the previous acom format; keep it as a backup and select a fresh ACOM_HOME",
        ));
    }
    let marker = home.join(LAYOUT_FILE);
    match fs::read(&marker) {
        Ok(bytes) => {
            let layout: Layout = serde_json::from_slice(&bytes)
                .map_err(|error| conflict(format!("invalid workspace layout marker: {error}")))?;
            if layout.format != "acom-workspace" || layout.version != 1 {
                return Err(conflict(
                    "unsupported workspace data format; saved data has not been changed",
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if home.try_exists().map_err(io_error)? {
                for entry in fs::read_dir(home).map_err(io_error)? {
                    let entry = entry.map_err(io_error)?;
                    if !["serve.lock", "port"]
                        .iter()
                        .any(|allowed| entry.file_name() == *allowed)
                    {
                        return Err(conflict(
                            "this directory is not an empty acom workspace; keep it as a backup and select a fresh ACOM_HOME",
                        ));
                    }
                }
            }
            crate::app::private_directory(home).map_err(io_error)?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(marker)
                .map_err(io_error)?;
            file.write_all(b"{\"format\":\"acom-workspace\",\"version\":1}\n")
                .map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
        }
        Err(error) => return Err(io_error(error)),
    }
    Ok(())
}

fn combined_errors(errors: Vec<String>) -> R<()> {
    if errors.is_empty() {
        return Ok(());
    }
    let count = errors.len();
    let mut text = errors
        .into_iter()
        .take(3)
        .map(|text| text.chars().take(500).collect::<String>())
        .collect::<Vec<_>>()
        .join("; ");
    if count > 3 {
        text.push_str(&format!("; {} additional errors", count - 3));
    }
    Err(Fail(500, text))
}

fn io_error(error: std::io::Error) -> Fail {
    Fail(500, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "acom-workspace-test-{}",
                crate::harness::new_uuid()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn home(&self) -> PathBuf {
            self.0.join("state")
        }

        fn open(&self) -> Arc<Workspace> {
            Workspace::open(self.home(), "http://127.0.0.1:0".into()).unwrap()
        }

        fn project(&self, name: &str) -> String {
            let path = self.0.join(name);
            fs::create_dir_all(&path).unwrap();
            path.to_str().unwrap().into()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn id(value: &Value) -> &str {
        value["id"].as_str().unwrap()
    }

    fn insert_idle(engine: &App) {
        engine.lock().db.execute("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(1,1,'worker','synthetic task','claude','claude-opus-5-5','medium','idle',0,0)",[]).unwrap();
    }

    #[test]
    fn new_state_directories_are_private_without_changing_existing_parents() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let fixture = Fixture::new();
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o755)).unwrap();
        let workspace = fixture.open();
        let project = workspace.add(&fixture.project("sample"), "user").unwrap();
        let engine = workspace.lookup(id(&project)).unwrap();
        for path in [
            fixture.home(),
            fixture.home().join("projects"),
            fixture.home().join("trash"),
            engine.home.clone(),
            engine.home.join("logs"),
        ] {
            assert_eq!(
                fs::metadata(&path).unwrap().mode() & 0o777,
                0o700,
                "{}",
                path.display()
            );
        }
        assert_eq!(fs::metadata(&fixture.0).unwrap().mode() & 0o777, 0o755);
        workspace.shutdown().unwrap();
    }

    #[test]
    fn independent_projects_have_stable_uuid_and_local_agent_ids() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let a = workspace.add(&fixture.project("sample-a"), "user").unwrap();
        let b = workspace.add(&fixture.project("sample-b"), "user").unwrap();
        assert_ne!(id(&a), id(&b));
        validate_uuid(id(&a)).unwrap();
        validate_uuid(id(&b)).unwrap();
        let engine_a = workspace.lookup(id(&a)).unwrap();
        let engine_b = workspace.lookup(id(&b)).unwrap();
        insert_idle(&engine_a);
        insert_idle(&engine_b);
        assert_eq!(engine_a.lock().agent(1).unwrap().name, "worker");
        assert_eq!(engine_b.lock().agent(1).unwrap().name, "worker");
        assert_ne!(engine_a.home, engine_b.home);
        assert_eq!(engine_a.url, format!("http://127.0.0.1:0/p/{}", id(&a)));
        assert_eq!(workspace.project(id(&a)).unwrap()["agents"], 1);
        assert!(!workspace.global.home.join("logs/1.txt").exists());
        assert!(workspace.remove(id(&a), "user").is_err());
        assert!(!engine_a.lock().shutting_down);
        workspace.shutdown().unwrap();
        let instance = workspace.instance_id.clone();
        drop(engine_a);
        drop(engine_b);
        drop(workspace);
        let reopened = fixture.open();
        assert_eq!(reopened.instance_id, instance);
        assert_eq!(
            reopened
                .lookup(id(&a))
                .unwrap()
                .lock()
                .agent(1)
                .unwrap()
                .name,
            "worker"
        );
        reopened.shutdown().unwrap();
    }

    #[test]
    fn path_lookup_uses_closest_registered_parent_and_add_is_idempotent() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let parent = fixture.project("sample");
        let child = fixture.project("sample/subproject");
        let a = workspace.add(&parent, "user").unwrap();
        let b = workspace.add(&child, "user").unwrap();
        let repeated = workspace.add(&format!("{parent}/."), "user").unwrap();
        assert_eq!(id(&a), id(&repeated));
        assert_eq!(repeated["added"], false);
        let nested = fixture.project("sample/subproject/nested");
        assert_eq!(id(&workspace.at_path(&nested).unwrap()), id(&b));
        assert_eq!(id(&workspace.at_path(&parent).unwrap()), id(&a));
        assert!(workspace.at_path(&fixture.project("outside")).is_err());
        workspace.shutdown().unwrap();
    }

    #[test]
    fn bounded_project_pages_and_invalid_inputs_have_no_side_effects() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        for name in ["sample-a", "sample-b", "sample-c"] {
            workspace.add(&fixture.project(name), "user").unwrap();
        }
        let first = workspace.list(2, None).unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 2);
        assert_eq!(first["total"], 3);
        let second = workspace.list(2, first["next"].as_str()).unwrap();
        assert_eq!(second["items"].as_array().unwrap().len(), 1);
        assert!(second["next"].is_null());
        assert_ne!(first["items"][1]["id"], second["items"][0]["id"]);
        assert!(workspace.list(0, None).is_err());
        assert!(workspace.list(PAGE_LIMIT + 1, None).is_err());
        assert!(workspace.lookup("../outside").is_err());
        assert!(workspace.remove("not-a-uuid", "user").is_err());
        assert_eq!(workspace.list(10, None).unwrap()["total"], 3);
        workspace.shutdown().unwrap();
    }

    #[test]
    fn removal_moves_only_an_empty_projects_state_to_recoverable_trash() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let path = fixture.project("sample");
        let added = workspace.add(&path, "user").unwrap();
        let engine = workspace.lookup(id(&added)).unwrap();
        let result = workspace.remove(id(&added), "user").unwrap();
        assert_eq!(result["recoverable"], true);
        assert_eq!(result["removed"], true);
        assert!(
            Path::new(result["trash_path"].as_str().unwrap())
                .join("acom.db")
                .is_file()
        );
        assert!(!engine.home.exists());
        assert!(engine.lock().shutting_down);
        assert!(workspace.lookup(id(&added)).is_err());
        assert_eq!(workspace.list(10, None).unwrap()["total"], 0);
        assert!(Path::new(&path).is_dir());
        let new = workspace.add(&path, "user").unwrap();
        assert_ne!(id(&new), id(&added));
        assert_ne!(workspace.lookup(id(&new)).unwrap().home, engine.home);
        workspace.shutdown().unwrap();
    }

    #[test]
    fn failed_removal_restores_registry_directory_and_engine_availability() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let added = workspace.add(&fixture.project("sample"), "user").unwrap();
        let engine = workspace.lookup(id(&added)).unwrap();
        workspace.global.lock().db.execute_batch("CREATE TRIGGER reject_project_removal BEFORE DELETE ON workspace_projects BEGIN SELECT RAISE(ABORT,'injected removal failure'); END;").unwrap();
        assert!(workspace.remove(id(&added), "user").is_err());
        assert!(engine.home.is_dir());
        assert!(!engine.lock().shutting_down);
        assert!(workspace.lookup(id(&added)).is_ok());
        assert_eq!(
            workspace
                .global
                .lock()
                .db
                .query_row("SELECT count(*) FROM workspace_removals", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        workspace.shutdown().unwrap();
    }

    #[test]
    fn invalid_removal_preconditions_do_not_shut_down_registered_engine() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let added = workspace.add(&fixture.project("sample"), "user").unwrap();
        let engine = workspace.lookup(id(&added)).unwrap();
        let saved = engine.home.with_extension("saved");
        fs::rename(&engine.home, &saved).unwrap();
        assert!(workspace.remove(id(&added), "user").is_err());
        assert!(!engine.lock().shutting_down);
        fs::rename(saved, &engine.home).unwrap();
        workspace.shutdown().unwrap();
    }

    #[test]
    fn interrupted_removal_is_completed_or_rolled_back_at_startup() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let a = workspace.add(&fixture.project("sample-a"), "user").unwrap();
        let b = workspace.add(&fixture.project("sample-b"), "user").unwrap();
        workspace.shutdown().unwrap();
        for (project, moved) in [(&a, true), (&b, false)] {
            let original = workspace.project_directory(id(project));
            let trash = workspace
                .home
                .join("trash")
                .join(format!("{}-interrupted", id(project)));
            workspace.global.lock().db.execute("INSERT INTO workspace_removals(project,original_path,trash_path,requested_at,actor) VALUES(?,?,?,?,?)",params![id(project),original.to_string_lossy(),trash.to_string_lossy(),now(),"user"]).unwrap();
            if moved {
                fs::rename(original, trash).unwrap();
            }
        }
        drop(workspace);
        let reopened = fixture.open();
        assert!(reopened.lookup(id(&a)).is_err());
        assert!(reopened.lookup(id(&b)).is_ok());
        assert_eq!(reopened.list(10, None).unwrap()["total"], 1);
        assert_eq!(
            reopened
                .global
                .lock()
                .db
                .query_row("SELECT count(*) FROM workspace_removals", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        reopened.shutdown().unwrap();
    }

    #[test]
    fn old_or_unknown_layout_is_rejected_before_creating_new_state() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.home()).unwrap();
        fs::write(fixture.home().join("acom.db"), b"old data preserved").unwrap();
        assert!(Workspace::open(fixture.home(), "http://127.0.0.1:0".into()).is_err());
        assert_eq!(
            fs::read(fixture.home().join("acom.db")).unwrap(),
            b"old data preserved"
        );
        assert!(!fixture.home().join("global").exists());
        assert!(!fixture.home().join(LAYOUT_FILE).exists());
        let fixture = Fixture::new();
        fs::create_dir(fixture.home()).unwrap();
        fs::write(
            fixture.home().join(LAYOUT_FILE),
            br#"{"format":"acom-workspace","version":999}"#,
        )
        .unwrap();
        assert!(Workspace::open(fixture.home(), "http://127.0.0.1:0".into()).is_err());
        assert!(!fixture.home().join("global").exists());
    }

    #[test]
    fn stopped_workspace_refuses_new_projects_and_bulk_actions() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        workspace.shutdown().unwrap();
        assert!(workspace.add(&fixture.project("sample"), "user").is_err());
        assert!(workspace.pause_all(None, "user").is_err());
        assert_eq!(workspace.list(10, None).unwrap()["total"], 0);
        assert!(workspace.tick().is_ok());
    }

    #[test]
    fn project_and_global_bulk_controls_preserve_project_qualification() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let a = workspace.add(&fixture.project("sample-a"), "user").unwrap();
        let b = workspace.add(&fixture.project("sample-b"), "user").unwrap();
        let first = workspace.lookup(id(&a)).unwrap();
        let second = workspace.lookup(id(&b)).unwrap();
        insert_idle(&first);
        insert_idle(&second);
        assert_eq!(workspace.action_counts(None).unwrap()["pause_eligible"], 2);
        let result = workspace.pause_all(Some(id(&a)), "user").unwrap();
        assert_eq!(result["results"][0]["project"], id(&a));
        assert_eq!(first.lock().agent(1).unwrap().state, "paused");
        assert_eq!(second.lock().agent(1).unwrap().state, "idle");
        workspace.pause_all(None, "user").unwrap();
        assert_eq!(workspace.action_counts(None).unwrap()["resume_eligible"], 2);
        let result = workspace.resume_restart(None, "user").unwrap();
        assert!(result["errors"].as_array().unwrap().is_empty());
        assert_eq!(workspace.action_counts(None).unwrap()["resume_eligible"], 2);
        let result = workspace.resume_all(Some(id(&a)), "user").unwrap();
        assert!(result["errors"].as_array().unwrap().is_empty());
        assert_eq!(first.lock().agent(1).unwrap().state, "idle");
        assert_eq!(second.lock().agent(1).unwrap().state, "paused");
        workspace.shutdown().unwrap();
    }

    fn count_events(engine: &App, kind: &str) -> i64 {
        engine
            .lock()
            .db
            .query_row("SELECT count(*) FROM events WHERE kind=?", [kind], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn cursor(engine: &App) -> i64 {
        engine
            .lock()
            .db
            .query_row(
                "SELECT event_id FROM account_cursor WHERE id=1",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn account_events_replay_once_per_project_and_retry_after_transaction_failure() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let a = workspace.add(&fixture.project("sample-a"), "user").unwrap();
        let b = workspace.add(&fixture.project("sample-b"), "user").unwrap();
        let first = workspace.lookup(id(&a)).unwrap();
        let second = workspace.lookup(id(&b)).unwrap();
        first
            .record_usage("claude", "five_hour", 90.0, None)
            .unwrap();
        assert_eq!(count_events(&first, "usage.observed"), 1);
        assert_eq!(count_events(&second, "usage.observed"), 0);
        second.sync_accounts().unwrap();
        second.sync_accounts().unwrap();
        assert_eq!(count_events(&second, "usage.observed"), 1);
        let saved_cursor = cursor(&second);
        second.lock().db.execute_batch("CREATE TRIGGER reject_account_event BEFORE INSERT ON events WHEN NEW.kind='usage.observed' BEGIN SELECT RAISE(ABORT,'injected event storage failure'); END;").unwrap();
        first
            .record_usage("claude", "five_hour", 70.0, None)
            .unwrap();
        assert!(second.sync_accounts().is_err());
        assert_eq!(cursor(&second), saved_cursor);
        assert_eq!(count_events(&second, "usage.observed"), 1);
        second
            .lock()
            .db
            .execute_batch("DROP TRIGGER reject_account_event;")
            .unwrap();
        second.sync_accounts().unwrap();
        second.sync_accounts().unwrap();
        assert_eq!(count_events(&second, "usage.observed"), 2);
        assert!(cursor(&second) > saved_cursor);
        workspace.shutdown().unwrap();
    }

    #[test]
    fn shared_usage_and_local_event_failure_roll_back_together() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let added = workspace.add(&fixture.project("sample"), "user").unwrap();
        let engine = workspace.lookup(id(&added)).unwrap();
        engine
            .record_usage("claude", "five_hour", 90.0, None)
            .unwrap();
        let before = cursor(&engine);
        engine.lock().db.execute_batch("CREATE TRIGGER reject_account_event BEFORE INSERT ON events WHEN NEW.kind='usage.observed' BEGIN SELECT RAISE(ABORT,'injected event storage failure'); END;").unwrap();
        assert!(
            engine
                .record_usage("claude", "five_hour", 70.0, None)
                .is_err()
        );
        assert_eq!(cursor(&engine), before);
        assert_eq!(count_events(&engine, "usage.observed"), 1);
        let st = workspace.global.lock();
        assert_eq!(
            st.db
                .query_row(
                    "SELECT used_pct FROM global.usage WHERE provider='claude' AND win='five_hour'",
                    [],
                    |row| row.get::<_, f64>(0)
                )
                .unwrap(),
            90.0
        );
        assert_eq!(
            st.db
                .query_row("SELECT max(id) FROM global.account_events", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            before
        );
        drop(st);
        workspace.shutdown().unwrap();
    }

    #[test]
    fn new_project_does_not_replay_preexisting_account_history() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        workspace
            .global
            .record_usage("claude", "five_hour", 90.0, None)
            .unwrap();
        let added = workspace.add(&fixture.project("sample"), "user").unwrap();
        let engine = workspace.lookup(id(&added)).unwrap();
        engine.sync_accounts().unwrap();
        assert_eq!(count_events(&engine, "usage.observed"), 0);
        workspace
            .global
            .record_usage("claude", "five_hour", 70.0, None)
            .unwrap();
        engine.sync_accounts().unwrap();
        assert_eq!(count_events(&engine, "usage.observed"), 1);
        workspace.shutdown().unwrap();
    }

    #[test]
    fn shared_config_references_protect_deletion_and_roll_back_local_changes() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let added = workspace.add(&fixture.project("sample"), "user").unwrap();
        let engine = workspace.lookup(id(&added)).unwrap();
        let config = workspace
            .global
            .add_config("Synthetic", crate::app::Settings::default(), "user")
            .unwrap();
        workspace.global.lock().db.execute_batch("CREATE TRIGGER global.reject_config_reference BEFORE INSERT ON config_uses BEGIN SELECT RAISE(ABORT,'injected reference storage failure'); END;").unwrap();
        assert!(
            engine
                .set_project_config(1, Some(config), None, "user")
                .is_err()
        );
        assert_eq!(
            engine
                .lock()
                .db
                .query_row("SELECT config FROM projects WHERE id=1", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            workspace
                .global
                .lock()
                .db
                .query_row(
                    "SELECT config FROM global.config_uses WHERE project=?",
                    [id(&added)],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        workspace
            .global
            .lock()
            .db
            .execute_batch("DROP TRIGGER global.reject_config_reference;")
            .unwrap();
        engine
            .set_project_config(1, Some(config), None, "user")
            .unwrap();
        assert!(workspace.global.remove_config(config, "user").is_err());
        assert_eq!(
            workspace.project(id(&added)).unwrap()["config"],
            engine.config_key(config).unwrap()
        );
        workspace.remove(id(&added), "user").unwrap();
        workspace.global.remove_config(config, "user").unwrap();
        workspace.shutdown().unwrap();
    }

    #[test]
    fn registry_revision_changes_only_with_registry_data() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let before = workspace.registry_revision().unwrap();
        let added = workspace.add(&fixture.project("sample"), "user").unwrap();
        let after = workspace.registry_revision().unwrap();
        assert!(after > before);
        workspace
            .global
            .lock()
            .db
            .execute(
                "UPDATE workspace_projects SET name=name WHERE id=?",
                [id(&added)],
            )
            .unwrap();
        assert_eq!(workspace.registry_revision().unwrap(), after);
        workspace
            .global
            .record_usage("claude", "five_hour", 20.0, None)
            .unwrap();
        assert_eq!(workspace.registry_revision().unwrap(), after);
        workspace.remove(id(&added), "user").unwrap();
        assert!(workspace.registry_revision().unwrap() > after);
        workspace.shutdown().unwrap();
    }

    #[test]
    fn shared_config_changes_replay_ttl_and_notices_atomically_after_restart() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let a = workspace.add(&fixture.project("sample-a"), "user").unwrap();
        let b = workspace.add(&fixture.project("sample-b"), "user").unwrap();
        let first = workspace.lookup(id(&a)).unwrap();
        let second = workspace.lookup(id(&b)).unwrap();
        insert_idle(&first);
        insert_idle(&second);
        let config = workspace
            .global
            .add_config("shared", crate::app::Settings::default(), "user")
            .unwrap();
        first
            .set_project_config(1, Some(config), None, "user")
            .unwrap();
        second
            .set_project_config(1, Some(config), None, "user")
            .unwrap();
        for engine in [&first, &second] {
            engine.lock().db.execute("INSERT INTO locks(project,name,about,created_at,holder,expires_at) VALUES(1,'shared-work','synthetic',0,1,?)",[now()+800]).unwrap();
        }
        let old_cursor = cursor(&second);
        let notices_before: i64 = second
            .lock()
            .db
            .query_row("SELECT count(*) FROM notices", [], |row| row.get(0))
            .unwrap();
        second.lock().db.execute_batch("CREATE TRIGGER reject_rule_event BEFORE INSERT ON events WHEN NEW.kind='project.rules' BEGIN SELECT RAISE(ABORT,'injected event failure'); END;").unwrap();
        let settings = crate::app::Settings {
            max_lock_ttl_secs: 30,
            ..crate::app::Settings::default()
        };
        workspace
            .global
            .put_config(config, None, settings, "user")
            .unwrap();
        first.sync_accounts().unwrap();
        let deadline: i64 = first
            .lock()
            .db
            .query_row(
                "SELECT expires_at FROM locks WHERE name='shared-work'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!((now() + 29..=now() + 30).contains(&deadline));
        assert!(second.sync_accounts().is_err());
        assert_eq!(cursor(&second), old_cursor);
        let (unchanged_deadline,unchanged_notices):(i64,i64)=second.lock().db.query_row("SELECT (SELECT expires_at FROM locks WHERE name='shared-work'),(SELECT count(*) FROM notices)",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert!(unchanged_deadline > now() + 700);
        assert_eq!(unchanged_notices, notices_before);
        second
            .lock()
            .db
            .execute_batch("DROP TRIGGER reject_rule_event;")
            .unwrap();
        drop(first);
        drop(second);
        drop(workspace);
        let workspace = fixture.open();
        let second = workspace.lookup(id(&b)).unwrap();
        second.sync_accounts().unwrap();
        let applied_cursor = cursor(&second);
        let applied_events = count_events(&second, "project.rules");
        assert_eq!(applied_events, 1);
        second.sync_accounts().unwrap();
        assert_eq!(cursor(&second), applied_cursor);
        assert_eq!(count_events(&second, "project.rules"), applied_events);
        let deadline: i64 = second
            .lock()
            .db
            .query_row(
                "SELECT expires_at FROM locks WHERE name='shared-work'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(deadline <= now() + 30);
        workspace.shutdown().unwrap();
    }

    #[test]
    fn restart_checkpoints_interrupted_usage_without_refreshing_numeric_evidence() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let project = workspace.add(&fixture.project("sample"), "user").unwrap();
        let engine = workspace.lookup(id(&project)).unwrap();
        insert_idle(&engine);
        engine
            .lock()
            .db
            .execute("UPDATE agents SET state='working' WHERE id=1", [])
            .unwrap();
        engine
            .record_tokens(
                1,
                crate::harness::TokenUsage {
                    source: crate::harness::TokenSource::ClaudeStreamStart(
                        "synthetic-message".into(),
                    ),
                    counts: [Some(10), Some(0), Some(0), Some(2)],
                    total: Some(12),
                },
            )
            .unwrap();
        let series = crate::metrics::Series {
            entity: "agent:1".into(),
            metric: "total_tokens".into(),
            kind: crate::metrics::Kind::Counter,
        };
        let before = engine.metric_latest(&series, 10, None, 16000).unwrap();
        let observed = before["items"][0]["point"]["value_observed_at"].clone();
        drop(engine);
        drop(workspace);
        let workspace = fixture.open();
        let engine = workspace.lookup(id(&project)).unwrap();
        let after = engine.metric_latest(&series, 10, None, 16000).unwrap();
        assert_eq!(after["items"][0]["point"]["quality"], "partial");
        assert_eq!(after["items"][0]["point"]["value_observed_at"], observed);
        assert_eq!(after["items"][0]["point"]["value"]["value"], "12");
        workspace.shutdown().unwrap();
    }

    #[test]
    fn concurrent_adds_allocate_one_project_and_failed_adds_stay_unregistered() {
        let fixture = Fixture::new();
        let workspace = fixture.open();
        let path = fixture.project("sample");
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let workspace = workspace.clone();
                let path = path.clone();
                std::thread::spawn(move || workspace.add(&path, "user").unwrap())
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(results.iter().all(|project| id(project) == id(&results[0])));
        assert_eq!(
            results
                .iter()
                .filter(|project| project["added"] == true)
                .count(),
            1
        );
        workspace.global.lock().db.execute_batch("CREATE TRIGGER reject_new_project BEFORE INSERT ON workspace_projects BEGIN SELECT RAISE(ABORT,'injected registry storage failure'); END;").unwrap();
        assert!(workspace.add(&fixture.project("other"), "user").is_err());
        assert_eq!(workspace.list(10, None).unwrap()["total"], 1);
        assert_eq!(
            fs::read_dir(workspace.home.join("projects"))
                .unwrap()
                .count(),
            1
        );
        assert_eq!(
            fs::read_dir(workspace.home.join("trash")).unwrap().count(),
            1
        );
        workspace.shutdown().unwrap();
    }
}
