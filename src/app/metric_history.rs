use super::*;
use crate::metrics::{self, Kind, Number, Observation, Origin, Point, Quality, Series};
use std::path::{Path, PathBuf};

pub(super) const SCHEMA:&str="CREATE TABLE IF NOT EXISTS context_observations(
  agent_id INTEGER PRIMARY KEY,value TEXT NOT NULL,observed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recording_origins(
  id TEXT PRIMARY KEY,source_instance TEXT NOT NULL,started_at INTEGER NOT NULL,imported_at INTEGER);
CREATE TABLE IF NOT EXISTS active_recording_origin(id INTEGER PRIMARY KEY CHECK(id=1),origin_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counter_origins(
  origin_id TEXT NOT NULL,agent_id INTEGER NOT NULL,metric TEXT NOT NULL,
  baseline TEXT,latest TEXT,observed_at INTEGER,quality TEXT NOT NULL,
  PRIMARY KEY(origin_id,agent_id,metric));
CREATE TABLE IF NOT EXISTS metric_dirty(
  agent_id INTEGER PRIMARY KEY,generation INTEGER NOT NULL,recorded_generation INTEGER NOT NULL,
  checkpoint_generation INTEGER NOT NULL,queued_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS metric_dirty_pending ON metric_dirty(queued_at,agent_id)
  WHERE generation>recorded_generation OR checkpoint_generation>0;";

pub struct History {
    pub(crate) store: Option<metrics::Metrics>,
    path: Option<PathBuf>,
    pub(crate) origin: Option<Origin>,
    pub error: Option<String>,
    pub error_at: Option<i64>,
    pending: BTreeMap<(String, String), Observation>,
    emitted: BTreeMap<(String, String), Point>,
    sampled_at: Option<i64>,
    captured_generations: BTreeMap<i64, (i64, bool)>,
}

impl History {
    pub fn open_optional(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        match metrics::Metrics::open(&path) {
            Ok(store) => Self::new(Some(store), Some(path), None),
            Err(error) => Self::new(None, Some(path), Some(error)),
        }
    }

    fn new(store: Option<metrics::Metrics>, path: Option<PathBuf>, error: Option<String>) -> Self {
        let error = error.map(|error| error.chars().take(500).collect());
        Self {
            store,
            path,
            origin: None,
            error_at: error.as_ref().map(|_| now()),
            error,
            pending: BTreeMap::new(),
            emitted: BTreeMap::new(),
            sampled_at: None,
            captured_generations: BTreeMap::new(),
        }
    }

    fn require_store(&mut self) -> Result<&mut metrics::Metrics, String> {
        self.store.as_mut().ok_or_else(|| {
            format!(
                "metrics history unavailable: {}",
                self.error.as_deref().unwrap_or("store is not open")
            )
        })
    }

    fn pending_agent(&self, id: i64) -> bool {
        let entity = format!("agent:{id}");
        self.pending
            .range((entity.clone(), String::new())..)
            .next()
            .is_some_and(|((key, _), _)| key == &entity)
    }

    fn enqueue(
        &mut self,
        observations: Vec<Observation>,
        interval: u32,
        checkpoint: bool,
    ) -> Result<(), String> {
        self.require_store()?;
        let Some(origin) = self.origin.clone() else {
            return Ok(());
        };
        let mut force = checkpoint;
        let mut keys = Vec::new();
        for mut observation in observations {
            let key = (
                observation.series.entity.clone(),
                observation.series.metric.clone(),
            );
            if let Some(previous) = self
                .pending
                .get(&key)
                .map(|entry| &entry.point)
                .or_else(|| self.emitted.get(&key))
            {
                force |= previous.quality != observation.point.quality
                    || previous.value.is_some() != observation.point.value.is_some()
                    || matches!((&previous.value,&observation.point.value),(Some(Number::Counter(old)),Some(Number::Counter(new))) if new<old);
            }
            observation.coverage_gap |= self
                .pending
                .get(&key)
                .is_some_and(|pending| pending.coverage_gap);
            force |= observation.coverage_gap;
            keys.push(key.clone());
            self.pending.insert(key, observation);
        }
        if force {
            self.flush_keys(&origin, &keys, interval, true)?;
        }
        self.flush_due(interval)
    }

    fn flush_due(&mut self, interval: u32) -> Result<(), String> {
        self.require_store()?;
        let Some(origin) = self.origin.clone() else {
            return Ok(());
        };
        if !self.pending.is_empty()
            && self
                .sampled_at
                .is_none_or(|last| now() - last >= i64::from(interval))
        {
            let keys = self.pending.keys().cloned().collect::<Vec<_>>();
            self.flush_keys(&origin, &keys, interval, false)?;
            self.sampled_at = Some(now());
        }
        self.require_store()?.flush(now(), interval)?;
        Ok(())
    }

    fn flush_keys(
        &mut self,
        origin: &Origin,
        keys: &[(String, String)],
        interval: u32,
        checkpoint: bool,
    ) -> Result<(), String> {
        for chunk in keys.chunks(metrics::MAX_PAGE) {
            let observations = chunk
                .iter()
                .filter_map(|key| self.pending.get(key).cloned())
                .collect::<Vec<_>>();
            if observations.is_empty() {
                continue;
            }
            self.require_store()?
                .record(origin, &observations, now(), interval, checkpoint)?;
            for key in chunk {
                if let Some(observation) = self.pending.remove(key) {
                    self.emitted.insert(key.clone(), observation.point);
                }
            }
        }
        Ok(())
    }
}

pub(super) fn mark_dirty(st: &St, id: i64, checkpoint: bool) -> R<()> {
    st.db.execute("INSERT INTO metric_dirty(agent_id,generation,recorded_generation,checkpoint_generation,queued_at) VALUES(?1,1,0,?2,?3) ON CONFLICT(agent_id) DO UPDATE SET generation=generation+1,checkpoint_generation=CASE WHEN ?2 THEN generation+1 ELSE checkpoint_generation END,queued_at=CASE WHEN generation=recorded_generation THEN ?3 ELSE queued_at END",params![id,checkpoint,now()])?;
    Ok(())
}

fn request_checkpoint(st: &St, id: i64) -> R<()> {
    let changed=st.db.execute("INSERT INTO metric_dirty(agent_id,generation,recorded_generation,checkpoint_generation,queued_at) SELECT ?1,1,0,1,?2 WHERE EXISTS(SELECT 1 FROM agents WHERE id=?1) ON CONFLICT(agent_id) DO UPDATE SET generation=generation+CASE WHEN generation=recorded_generation THEN 1 ELSE 0 END,checkpoint_generation=generation+CASE WHEN generation=recorded_generation THEN 1 ELSE 0 END,queued_at=CASE WHEN generation=recorded_generation THEN ?2 ELSE queued_at END",params![id,now()])?;
    if changed == 0 {
        return Err(not_found("no agent for metric checkpoint"));
    }
    Ok(())
}

fn acknowledge_captured(st: &St, captured: &[(i64, i64, bool)]) -> R<()> {
    for &(id, generation, checkpoint) in captured {
        st.db.execute("UPDATE metric_dirty SET recorded_generation=max(recorded_generation,?2),checkpoint_generation=CASE WHEN ?3 AND checkpoint_generation<=?2 THEN 0 ELSE checkpoint_generation END WHERE agent_id=?1",params![id,generation,checkpoint])?;
    }
    Ok(())
}

pub(super) fn record_counter_summaries(
    st: &St,
    id: i64,
    observations: &[Observation],
    checkpoint: bool,
) -> R<()> {
    mark_dirty(st, id, checkpoint)?;
    let origin = st
        .db
        .query_row(
            "SELECT origin_id FROM active_recording_origin WHERE id=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(origin) = origin else { return Ok(()) };
    for observation in observations {
        if observation.series.kind != Kind::Counter {
            continue;
        }
        let value = match observation.point.value {
            Some(Number::Counter(value)) => Some(value.to_string()),
            _ => None,
        };
        st.db.execute("INSERT INTO counter_origins(origin_id,agent_id,metric,baseline,latest,observed_at,quality) VALUES(?,?,?,'0',?,?,?) ON CONFLICT(origin_id,agent_id,metric) DO UPDATE SET latest=coalesce(excluded.latest,counter_origins.latest),observed_at=coalesce(excluded.observed_at,counter_origins.observed_at),quality=excluded.quality WHERE counter_origins.latest IS NOT coalesce(excluded.latest,counter_origins.latest) OR counter_origins.observed_at IS NOT coalesce(excluded.observed_at,counter_origins.observed_at) OR counter_origins.quality IS NOT excluded.quality",params![origin,id,observation.series.metric,value,observation.point.value_observed_at,quality_name(observation.point.quality)])?;
    }
    Ok(())
}

pub(super) fn record_context(st: &St, id: i64, value: u64) -> R<()> {
    st.db.execute("INSERT INTO context_observations(agent_id,value,observed_at) VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at",params![id,value.to_string(),now()])?;
    mark_dirty(st, id, false)?;
    Ok(())
}

pub(super) fn context_value(st: &St, id: i64) -> R<Option<u64>> {
    let value = st
        .db
        .query_row(
            "SELECT value FROM context_observations WHERE agent_id=?",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    value
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|error| Fail(500, format!("invalid stored context: {error}")))
        })
        .transpose()
}

impl App {
    pub fn pin_metric_snapshot(&self) -> R<metrics::Metrics> {
        metrics::Metrics::pin_snapshot(&self.home.join("metrics.db")).map_err(|error| {
            Fail(
                503,
                format!("optional metric snapshot unavailable: {error}"),
            )
        })
    }

    pub fn reset_unavailable_metric_history(&self, confirm: bool) -> R<Value> {
        if !confirm {
            return Err(bad(
                "confirm=true is required to reset unavailable metric history",
            ));
        }
        let mut history = self
            .metric_history
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if history.store.is_some() {
            return Err(conflict(
                "history is available; use a selected clear instead",
            ));
        }
        let trash = self.home.join("history-trash");
        match std::fs::create_dir(&trash) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata = std::fs::symlink_metadata(&trash)
                    .map_err(|error| Fail(500, error.to_string()))?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(conflict("history-trash must be a real directory"));
                }
            }
            Err(error) => return Err(Fail(500, error.to_string())),
        }
        let backup = trash
            .join(crate::harness::try_new_uuid().map_err(|error| Fail(500, error.to_string()))?);
        std::fs::create_dir(&backup).map_err(|error| Fail(500, error.to_string()))?;
        let mut files = Vec::new();
        for name in ["metrics.db", "metrics.db-wal", "metrics.db-shm"] {
            let source = self.home.join(name);
            match std::fs::symlink_metadata(&source) {
                Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
                    files.push((source, backup.join(name)))
                }
                Ok(_) => {
                    return Err(conflict(
                        "metrics files must be regular files or links, not directories or devices",
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(Fail(500, error.to_string())),
            }
        }
        let mut moved = Vec::new();
        for (source, destination) in files {
            if let Err(error) = std::fs::rename(&source, &destination) {
                for (source, destination) in moved.iter().rev() {
                    let _ = std::fs::rename(destination, source);
                }
                return Err(Fail(
                    500,
                    format!(
                        "could not preserve old metric history: {error}; any moved files remain in {}",
                        backup.display()
                    ),
                ));
            }
            moved.push((source, destination));
        }
        match metrics::Metrics::open(&self.home.join("metrics.db")) {
            Ok(store) => {
                history.store = Some(store);
                history.pending.clear();
                history.emitted.clear();
                history.sampled_at = None;
                history.captured_generations.clear();
                history.error = None;
                history.error_at = None;
            }
            Err(error) => {
                history.error = Some(format!(
                    "reset failed: {error}; preserved history: {}",
                    backup.display()
                ));
                history.error_at = Some(now());
                return Err(Fail(503, history.error.clone().unwrap()));
            }
        }
        drop(history);
        let warning = self
            .lock()
            .log(
                self.project_key().map(|_| 1),
                "user",
                "reset unavailable metrics history; old files moved to history-trash",
            )
            .err()
            .map(|error| {
                format!(
                    "History was reset, but the activity record could not be saved: {}",
                    error.1
                )
            });
        Ok(json!({"reset":true,"preserved_at":backup,"warning":warning}))
    }

    #[cfg(test)]
    pub fn snapshot_metric_history(&self, path: &Path) -> R<()> {
        let history = self
            .metric_history
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let store = history.store.as_ref().ok_or_else(|| {
            Fail(
                503,
                format!(
                    "metrics history unavailable: {}",
                    history.error.as_deref().unwrap_or("store is not open")
                ),
            )
        })?;
        crate::archive::snapshot(store.connection(), path)
    }

    pub fn initialize_metric_origin(&self, instance: &str, imported_at: Option<i64>) -> R<()> {
        crate::workspace::validate_uuid(instance)?;
        if imported_at.is_some_and(|at| at < 0) {
            return Err(bad("imported_at must be nonnegative"));
        }
        let origin = {
            let mut st = self.lock();
            st.atomic(|st|{
                let current=rows(&st.db,"SELECT o.id,o.source_instance,o.imported_at FROM recording_origins o JOIN active_recording_origin a ON a.origin_id=o.id WHERE a.id=1",[])?.pop();
                if let Some(current)=current && current["source_instance"]==instance && current["imported_at"].as_i64()==imported_at {
                    return Ok(Origin{id:current["id"].as_str().unwrap().into(),source_instance:instance.into(),imported_at});
                }
                let origin=Origin{id:crate::harness::try_new_uuid().map_err(|error|Fail(500,error.to_string()))?,source_instance:instance.into(),imported_at};
                st.db.execute("INSERT INTO recording_origins(id,source_instance,started_at,imported_at) VALUES(?,?,?,?)",params![origin.id,origin.source_instance,now(),origin.imported_at])?;
                st.db.execute("INSERT INTO active_recording_origin(id,origin_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET origin_id=excluded.origin_id",[&origin.id])?;
                st.db.execute("UPDATE metric_dirty SET recorded_generation=generation,checkpoint_generation=0",[])?;
                for agent in rows(&st.db,"SELECT id FROM agents ORDER BY id",[])? {
                    let id=agent["id"].as_i64().unwrap();
                    for observation in tokens::observations(st,id)? {
                        let baseline=match observation.point.value {Some(Number::Counter(value))=>Some(value.to_string()),_=>None};
                        st.db.execute("INSERT INTO counter_origins(origin_id,agent_id,metric,baseline,latest,observed_at,quality) VALUES(?,?,?,?,?,?,?)",params![origin.id,id,observation.series.metric,baseline,baseline,observation.point.value_observed_at,quality_name(observation.point.quality)])?;
                    }
                }
                Ok(origin)
            })?
        };
        let mut history = self
            .metric_history
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if history.origin.as_ref() != Some(&origin) {
            history.pending.clear();
            history.emitted.clear();
            history.sampled_at = None;
            history.captured_generations.clear();
        }
        history.origin = Some(origin);
        Ok(())
    }

    pub fn metric_scope(&self, scope: &str) -> R<metrics::Scope> {
        let history = self
            .metric_history
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match scope {
            "all" => Ok(metrics::Scope::All),
            "recorded_here" => history
                .origin
                .as_ref()
                .map(|origin| metrics::Scope::RecordedHere {
                    source_instance: origin.source_instance.clone(),
                })
                .ok_or_else(|| Fail(503, "metrics recording origin is not initialized".into())),
            "since_import" => history
                .origin
                .as_ref()
                .filter(|origin| origin.imported_at.is_some())
                .map(|origin| metrics::Scope::SinceImport {
                    origin_id: origin.id.clone(),
                })
                .ok_or_else(|| bad("since_import requires an imported project")),
            _ => Err(bad("scope must be recorded_here, all or since_import")),
        }
    }

    pub fn metric_status(&self) -> Value {
        let history = self
            .metric_history
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        json!({"available":history.store.is_some(),"origin":history.origin,"last_error":history.error,"error_at":history.error_at})
    }

    pub fn validate_metric_entity(&self, entity: &str) -> R<()> {
        if let Some(agent) = entity.strip_prefix("agent:") {
            if self.project_key().is_none() {
                return Err(bad("agent metrics require a project route"));
            }
            if agent == "*" || agent == "all" {
                return Ok(());
            }
            let id = agent
                .parse::<i64>()
                .ok()
                .filter(|id| *id > 0 && id.to_string() == agent)
                .ok_or_else(|| bad("invalid metric agent ID"))?;
            self.agent_project(id)?;
        } else if let Some(account) = entity.strip_prefix("account:") {
            if self.project_key().is_some() {
                return Err(bad("account metrics require the server route"));
            }
            let (provider, window) = account
                .split_once(':')
                .ok_or_else(|| bad("invalid metric account entity"))?;
            if !matches!(provider, "claude" | "codex")
                || !subscriptions::known_windows(&self.lock(), provider)?
                    .iter()
                    .any(|known| known == window)
            {
                return Err(bad(
                    "unknown metric usage window; use the metrics series catalog or acom limits for canonical IDs",
                ));
            }
        } else if self.project_key().is_some() || !matches!(entity, "check:claude" | "check:codex")
        {
            return Err(bad("unknown metric entity"));
        }
        Ok(())
    }

    pub fn metric_samples(&self, query: &metrics::Query, max_bytes: usize) -> R<Value> {
        for series in &query.series {
            self.validate_metric_entity(&series.entity)?;
        }
        if !(2048..=65536).contains(&max_bytes) {
            return Err(bad("metrics max_bytes must be 2048–65536"));
        }
        let status = self.metric_status();
        let range = json!({"from":query.from,"to":query.to});
        let overhead = json!({"status":status,"range":range}).to_string().len() + 1;
        let budget = max_bytes
            .checked_sub(overhead)
            .filter(|budget| *budget >= 512)
            .ok_or_else(|| bad("metrics status exceeds max_bytes; increase the response budget"))?;
        let page = self.read_metrics(|store| store.query_bounded(query, budget))?;
        Ok(json!({"items":page.items,"next":page.next,"status":status,"range":range}))
    }

    fn read_metrics<T>(&self, read: impl FnOnce(&metrics::Metrics) -> Result<T, String>) -> R<T> {
        let history = self
            .metric_history
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if history.store.is_none() {
            return Err(Fail(
                503,
                format!(
                    "metrics history unavailable: {}",
                    history.error.as_deref().unwrap_or("store is not open")
                ),
            ));
        }
        if let Some(path) = history.path.clone() {
            drop(history);
            let reader = metrics::Metrics::read_only(&path).map_err(|error| Fail(503, error))?;
            read(&reader).map_err(bad)
        } else {
            read(history.store.as_ref().unwrap()).map_err(bad)
        }
    }

    pub fn metric_series(
        &self,
        entity: Option<&str>,
        limit: usize,
        after: Option<i64>,
        max_bytes: usize,
    ) -> R<Value> {
        if let Some(entity) = entity {
            self.validate_metric_entity(entity)?;
        }
        if !(2048..=65536).contains(&max_bytes) {
            return Err(bad("metrics max_bytes must be 2048–65536"));
        }
        let page = self.read_metrics(|store| store.series(entity, limit, after))?;
        bounded_history_page(
            page.items.into_iter().map(|item| json!(item)).collect(),
            page.next.is_some(),
            self.metric_status(),
            max_bytes,
            |item| item["id"].clone(),
        )
    }

    pub fn metric_latest(
        &self,
        series: &Series,
        limit: usize,
        after: Option<&str>,
        max_bytes: usize,
    ) -> R<Value> {
        self.validate_metric_entity(&series.entity)?;
        if !(2048..=65536).contains(&max_bytes) {
            return Err(bad("metrics max_bytes must be 2048–65536"));
        }
        let page = self.read_metrics(|store| store.latest(series, limit, after))?;
        bounded_history_page(
            page.items.into_iter().map(|item| json!(item)).collect(),
            page.next.is_some(),
            self.metric_status(),
            max_bytes,
            |item| item["origin"]["id"].clone(),
        )
    }

    pub fn metric_summary(
        &self,
        scope: &metrics::Scope,
        agent: Option<i64>,
        after: i64,
        limit: usize,
        max_bytes: usize,
    ) -> R<Value> {
        if !(1..=200).contains(&limit) || after < 0 || agent.is_some_and(|id| id <= 0) {
            return Err(bad("invalid metric summary page"));
        }
        if !(2048..=65536).contains(&max_bytes) {
            return Err(bad("metrics max_bytes must be 2048–65536"));
        }
        let (source, since) = match scope {
            metrics::Scope::All => (None, None),
            metrics::Scope::RecordedHere { source_instance } => {
                (Some(source_instance.as_str()), None)
            }
            metrics::Scope::SinceImport { origin_id } => (None, Some(origin_id.as_str())),
        };
        let st = self.lock();
        let mut values = rows(
            &st.db,
            "SELECT c.rowid id,c.agent_id agent,c.metric,c.baseline,c.latest,c.observed_at,c.quality,o.id origin,o.source_instance,o.imported_at FROM counter_origins c JOIN recording_origins o ON o.id=c.origin_id WHERE c.rowid>?1 AND (?2 IS NULL OR c.agent_id=?2) AND (?3 IS NULL OR o.source_instance=?3) AND (?4 IS NULL OR o.id=?4) ORDER BY c.rowid LIMIT ?5",
            params![after, agent, source, since, (limit + 1) as i64],
        )?;
        drop(st);
        let more = values.len() > limit;
        values.truncate(limit);
        let mut response = json!({"items":[],"next":null,"status":self.metric_status()});
        let count = values.len();
        for (index, mut item) in values.into_iter().enumerate() {
            let baseline = item["baseline"]
                .as_str()
                .and_then(|value| value.parse::<u64>().ok());
            let latest = item["latest"]
                .as_str()
                .and_then(|value| value.parse::<u64>().ok());
            item["delta"] = baseline
                .zip(latest)
                .and_then(|(baseline, latest)| latest.checked_sub(baseline))
                .map(|value| json!(value.to_string()))
                .unwrap_or(Value::Null);
            item["has_correction"] = json!(
                baseline
                    .zip(latest)
                    .is_some_and(|(baseline, latest)| latest < baseline)
            );
            let previous = response["next"].clone();
            response["next"] = if more || index + 1 < count {
                item["id"].clone()
            } else {
                Value::Null
            };
            response["items"].as_array_mut().unwrap().push(item);
            if response.to_string().len() > max_bytes {
                response["items"].as_array_mut().unwrap().pop();
                response["next"] = previous;
                if response["items"].as_array().unwrap().is_empty() {
                    return Err(bad(
                        "one metric summary exceeds max_bytes; increase the response budget",
                    ));
                }
                break;
            }
        }
        Ok(response)
    }

    pub fn metric_totals(
        &self,
        scope: &metrics::Scope,
        agent: Option<i64>,
        selected: &[Series],
    ) -> R<Value> {
        let (source, since) = match scope {
            metrics::Scope::All => (None, None),
            metrics::Scope::RecordedHere { source_instance } => {
                (Some(source_instance.as_str()), None)
            }
            metrics::Scope::SinceImport { origin_id } => (None, Some(origin_id.as_str())),
        };
        let st = self.lock();
        let mut totals = serde_json::Map::new();
        for metric in selected
            .iter()
            .filter(|metric| metric.kind == Kind::Counter)
        {
            let mut statement=st.db.prepare("SELECT c.baseline,c.latest,c.quality,c.origin_id FROM agents a LEFT JOIN (SELECT c.* FROM counter_origins c JOIN recording_origins o ON o.id=c.origin_id WHERE c.metric=?1 AND (?3 IS NULL OR o.source_instance=?3) AND (?4 IS NULL OR o.id=?4)) c ON c.agent_id=a.id WHERE (?2 IS NULL OR a.id=?2) ORDER BY c.origin_id,a.id")?;
            let mut rows = statement.query(params![metric.metric, agent, source, since])?;
            let (mut total, mut known, mut unknown, mut corrections, mut origins) =
                (0_u128, 0_u64, 0_u64, 0_u64, 0_u64);
            let (mut partial, mut provisional, mut previous_origin) = (false, false, String::new());
            while let Some(row) = rows.next()? {
                let baseline: Option<String> = row.get(0)?;
                let latest: Option<String> = row.get(1)?;
                let quality: Option<String> = row.get(2)?;
                let origin: Option<String> = row.get(3)?;
                if let Some(origin) = origin
                    && origin != previous_origin
                {
                    origins += 1;
                    previous_origin = origin;
                }
                let parse = |value: Option<String>| {
                    value
                        .map(|value| {
                            value.parse::<u64>().map_err(|error| {
                                Fail(500, format!("invalid durable metric counter: {error}"))
                            })
                        })
                        .transpose()
                };
                let baseline = parse(baseline)?;
                let latest = parse(latest)?;
                if let Some(delta) = baseline
                    .zip(latest)
                    .and_then(|(baseline, latest)| latest.checked_sub(baseline))
                {
                    total = total
                        .checked_add(u128::from(delta))
                        .ok_or_else(|| Fail(500, "aggregate counter overflow".into()))?;
                    known += 1;
                } else {
                    unknown += 1;
                    corrections += u64::from(
                        baseline
                            .zip(latest)
                            .is_some_and(|(baseline, latest)| latest < baseline),
                    );
                }
                partial |= matches!(quality.as_deref(), None | Some("unknown" | "partial"));
                provisional |= quality.as_deref() == Some("provisional");
            }
            let quality = if known == 0 {
                "unknown"
            } else if unknown > 0 || partial {
                "partial"
            } else if provisional {
                "provisional"
            } else {
                "final"
            };
            totals.insert(metric.metric.clone(),json!({"known_subtotal":if known>0{Some(total.to_string())}else{None},"quality":quality,"known_series":known,"unknown_series":unknown,"corrections":corrections,"origins":origins}));
        }
        Ok(Value::Object(totals))
    }

    pub fn metric_maintenance(
        &self,
        action: &str,
        selection: &metrics::Selection,
        resolution: Option<u32>,
        confirm: bool,
    ) -> R<Value> {
        for series in &selection.series {
            self.validate_metric_entity(&series.entity)?;
        }
        if !matches!(
            action,
            "preview_clear" | "clear" | "preview_downsample" | "downsample"
        ) {
            return Err(bad("unknown metric maintenance action"));
        }
        let downsample = action.ends_with("downsample");
        if downsample != resolution.is_some() {
            return Err(bad("resolution_secs is required only for downsampling"));
        }
        let preview = action.starts_with("preview_");
        if !preview && !confirm {
            return Err(bad("confirm=true is required to discard metric history"));
        }
        if preview && confirm {
            return Err(bad("preview does not accept confirmation"));
        }
        let mut history = self
            .metric_history
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let store = history.require_store().map_err(|error| Fail(503, error))?;
        let outcome = if downsample {
            let result = if preview {
                store.preview_downsample(selection, resolution.unwrap())
            } else {
                store.downsample(selection, resolution.unwrap())
            }
            .map_err(bad)?;
            json!(result)
        } else {
            let result = if preview {
                store.preview_clear(selection)
            } else {
                store.clear_history(selection)
            }
            .map_err(bad)?;
            json!(result)
        };
        if !preview && !downsample {
            history.pending.retain(|_, observation| {
                !selection.series.iter().any(|series| {
                    series.metric == observation.series.metric
                        && (series.entity == observation.series.entity
                            || series.entity == "agent:*"
                                && observation.series.entity.starts_with("agent:"))
                }) || observation.point.observed_at < selection.from
                    || observation.point.observed_at >= selection.to
            });
        }
        let mut warnings = Vec::new();
        if !preview
            && let Err(error) = history
                .require_store()
                .and_then(|store| store.reclaim_space())
        {
            warnings.push(format!(
                "History was changed, but space reclamation failed: {error}"
            ));
        }
        drop(history);
        if !preview
            && let Err(error) = self.lock().log(
                self.project_key().map(|_| 1),
                "user",
                &format!(
                    "metrics {action}: {} selected series, {}–{}",
                    selection.series.len(),
                    selection.from,
                    selection.to
                ),
            )
        {
            warnings.push(format!(
                "History was changed, but its activity record could not be saved: {}",
                error.1
            ));
        }
        Ok(json!({"action":action,"preview":preview,"result":outcome,"warnings":warnings}))
    }

    pub fn capture_agent_metrics(&self, id: i64, checkpoint: bool) {
        let outcome = self.capture_agent_metrics_inner(id, checkpoint);
        self.save_metric_error(outcome);
    }

    fn capture_agent_metrics_inner(&self, id: i64, checkpoint: bool) -> R<()> {
        let (mut observations, interval, generation, checkpoint, recorded, origin_id) = {
            let st = self.lock();
            if checkpoint {
                request_checkpoint(&st, id)?;
            }
            let dirty=st.db.query_row("SELECT generation,recorded_generation,checkpoint_generation FROM metric_dirty WHERE agent_id=? AND (generation>recorded_generation OR checkpoint_generation>0)",[id],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?))).optional()?;
            let Some((generation, recorded, checkpoint_generation)) = dirty else {
                return Ok(());
            };
            let mut observations = tokens::observations(&st, id)?;
            if let Some(row) = rows(
                &st.db,
                "SELECT value,observed_at FROM context_observations WHERE agent_id=?",
                [id],
            )?
            .pop()
            {
                let value = row["value"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .map_err(|error| Fail(500, error.to_string()))?;
                let at = row["observed_at"].as_i64().unwrap();
                observations.push(Observation {
                    series: Series {
                        entity: format!("agent:{id}"),
                        metric: "context_tokens".into(),
                        kind: Kind::Gauge,
                    },
                    point: Point {
                        observed_at: at,
                        value_observed_at: Some(at),
                        value: Some(Number::Gauge(value as f64)),
                        quality: Quality::Final,
                    },
                    correction: false,
                    coverage_gap: false,
                });
            }
            (
                observations,
                st.global_settings()?.metrics_sample_secs as u32,
                generation,
                checkpoint_generation > 0,
                recorded,
                st.db
                    .query_row(
                        "SELECT origin_id FROM active_recording_origin WHERE id=1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?,
            )
        };
        let mut history = match self.metric_history.try_lock() {
            Ok(history) => history,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return Ok(()),
        };
        if history.origin.is_none() || history.store.is_none() {
            return Ok(());
        }
        if history.origin.as_ref().map(|origin| &origin.id) != origin_id.as_ref() {
            return Ok(());
        }
        if let Some((seen, forced)) = history.captured_generations.get(&id).copied()
            && (generation < seen || generation == seen && (!checkpoint || forced))
        {
            return Ok(());
        }
        let previous = history
            .captured_generations
            .get(&id)
            .map_or(recorded, |(seen, _)| *seen);
        let gap = generation - previous > 1;
        for observation in &mut observations {
            observation.coverage_gap = gap;
        }
        history
            .enqueue(observations, interval, checkpoint || gap)
            .map_err(|error| Fail(500, error))?;
        history
            .captured_generations
            .insert(id, (generation, checkpoint || gap));
        drop(history);
        Ok(())
    }

    pub fn capture_account_metrics(&self) {
        if self.project_key().is_some() {
            return;
        }
        let outcome = self.capture_account_metrics_inner();
        self.save_metric_error(outcome);
    }

    fn capture_account_metrics_inner(&self) -> R<()> {
        let (observations, interval) = {
            let st = self.lock();
            let mut observations = Vec::new();
            for row in rows(
                &st.db,
                "SELECT provider,win,used_pct,at FROM global.usage_observations ORDER BY provider,win",
                [],
            )? {
                let at = row["at"].as_i64().unwrap();
                observations.push(Observation {
                    series: Series {
                        entity: format!(
                            "account:{}:{}",
                            row["provider"].as_str().unwrap(),
                            row["win"].as_str().unwrap()
                        ),
                        metric: "usage_pct".into(),
                        kind: Kind::Gauge,
                    },
                    point: Point {
                        observed_at: at,
                        value_observed_at: Some(at),
                        value: Some(Number::Gauge(row["used_pct"].as_f64().unwrap())),
                        quality: Quality::Final,
                    },
                    correction: false,
                    coverage_gap: false,
                });
            }
            for row in rows(
                &st.db,
                "SELECT provider,attempted_at,checked_at FROM global.usage_checks ORDER BY provider",
                [],
            )? {
                for (field, metric) in [
                    ("attempted_at", "check_attempt_at"),
                    ("checked_at", "check_success_at"),
                ] {
                    let Some(at) = row[field].as_i64() else {
                        continue;
                    };
                    observations.push(Observation {
                        series: Series {
                            entity: format!("check:{}", row["provider"].as_str().unwrap()),
                            metric: metric.into(),
                            kind: Kind::Gauge,
                        },
                        point: Point {
                            observed_at: at,
                            value_observed_at: Some(at),
                            value: Some(Number::Gauge(at as f64)),
                            quality: Quality::Final,
                        },
                        correction: false,
                        coverage_gap: false,
                    });
                }
            }
            (
                observations,
                st.global_settings()?.metrics_sample_secs as u32,
            )
        };
        let mut history = match self.metric_history.try_lock() {
            Ok(history) => history,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return Ok(()),
        };
        if history.store.is_none() {
            return Ok(());
        }
        history
            .enqueue(observations, interval, false)
            .map_err(|error| Fail(500, error))?;
        Ok(())
    }

    pub fn sample_metrics(&self) {
        let dirty = rows(
            &self.lock().db,
            "SELECT agent_id FROM metric_dirty WHERE generation>recorded_generation OR checkpoint_generation>0 ORDER BY queued_at,agent_id LIMIT 64",
            [],
        );
        let dirty = match dirty {
            Ok(dirty) => dirty,
            Err(error) => {
                self.save_metric_error(Err(error));
                return;
            }
        };
        for row in &dirty {
            self.capture_agent_metrics(row["agent_id"].as_i64().unwrap(), false);
        }
        let interval = self
            .lock()
            .global_settings()
            .map(|settings| settings.metrics_sample_secs as u32);
        let result = interval.and_then(|interval| {
            let mut history = match self.metric_history.try_lock() {
                Ok(history) => history,
                Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => return Ok(()),
            };
            if history.store.is_none() {
                return Ok(());
            }
            history
                .flush_due(interval)
                .map_err(|error| Fail(500, error))?;
            let acknowledgements = dirty
                .iter()
                .filter_map(|row| {
                    let id = row["agent_id"].as_i64().unwrap();
                    history
                        .captured_generations
                        .get(&id)
                        .filter(|_| !history.pending_agent(id))
                        .map(|(generation, checkpoint)| (id, *generation, *checkpoint))
                })
                .collect::<Vec<_>>();
            drop(history);
            if acknowledgements.is_empty() {
                return Ok(());
            }
            self.lock()
                .atomic(|st| acknowledge_captured(st, &acknowledgements))
        });
        self.save_metric_error(result);
    }

    fn save_metric_error(&self, result: R<()>) {
        let Err(error) = result else { return };
        let mut history = match self.metric_history.try_lock() {
            Ok(history) => history,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return,
        };
        if history.store.is_some() {
            history.error = Some(error.1.chars().take(500).collect());
            history.error_at = Some(now());
        }
    }
}

fn quality_name(quality: Quality) -> &'static str {
    match quality {
        Quality::Unknown => "unknown",
        Quality::Provisional => "provisional",
        Quality::Partial => "partial",
        Quality::Final => "final",
    }
}

fn bounded_history_page(
    items: Vec<Value>,
    more: bool,
    status: Value,
    max_bytes: usize,
    cursor: impl Fn(&Value) -> Value,
) -> R<Value> {
    let count = items.len();
    let mut response = json!({"items":[],"next":null,"status":status});
    for (index, item) in items.into_iter().enumerate() {
        let previous = response["next"].clone();
        response["next"] = if more || index + 1 < count {
            cursor(&item)
        } else {
            Value::Null
        };
        response["items"].as_array_mut().unwrap().push(item);
        if response.to_string().len() > max_bytes {
            response["items"].as_array_mut().unwrap().pop();
            response["next"] = previous;
            if response["items"].as_array().unwrap().is_empty() {
                return Err(bad(
                    "one metric record exceeds max_bytes; increase the response budget",
                ));
            }
            break;
        }
    }
    if response.to_string().len() > max_bytes {
        return Err(bad(
            "metrics metadata exceeds max_bytes; increase the response budget",
        ));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::{TokenSource, TokenUsage};
    use std::fs;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "acom-metric-history-test-{}",
                crate::harness::new_uuid()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn app(&self) -> Arc<App> {
            let app = App::open(
                self.0.join("state"),
                "http://127.0.0.1:0/p/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            )
            .unwrap();
            app.initialize_metric_origin("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", None)
                .unwrap();
            fs::create_dir_all(self.0.join("sample")).unwrap();
            app.add_project(self.0.join("sample").to_str().unwrap(), "user")
                .unwrap();
            app.lock().db.execute("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(1,1,'worker','synthetic task','claude','test','medium','working',0,0)",[]).unwrap();
            app
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn query() -> metrics::Query {
        metrics::Query {
            series: vec![Series {
                entity: "agent:1".into(),
                metric: "total_tokens".into(),
                kind: Kind::Counter,
            }],
            all_agents: false,
            descending: false,
            from: 0,
            to: now() + 1,
            scope: metrics::Scope::All,
            limit: 100,
            resolution_secs: None,
            cursor: None,
        }
    }

    fn record(app: &App, count: u64) {
        app.record_tokens(
            1,
            TokenUsage {
                source: TokenSource::ClaudeResult { trusted: true },
                counts: [Some(count), Some(0), Some(0), Some(0)],
                total: Some(count),
            },
        )
        .unwrap();
        app.capture_agent_metrics(1, true);
    }

    #[test]
    fn unknown_values_and_observed_zero_are_distinct_and_core_survives_history_clear() {
        let fixture = Fixture::new();
        let app = fixture.app();
        let mut agent = json!({"id":1,"state":"working"});
        tokens::attach(&app.lock(), &mut agent).unwrap();
        assert!(agent["total_tokens"].is_null());
        assert!(agent["context"].is_null());
        app.record_context(1, 0).unwrap();
        record(&app, 0);
        tokens::attach(&app.lock(), &mut agent).unwrap();
        assert_eq!(agent["total_tokens"], 0);
        assert_eq!(agent["context"], 0);
        let samples = app.metric_samples(&query(), 16000).unwrap();
        assert_eq!(
            samples["items"][0]["envelope"]["last"]["value"]["value"],
            "0"
        );
        let summary = app
            .metric_summary(&metrics::Scope::All, Some(1), 0, 100, 16000)
            .unwrap();
        let selection = metrics::Selection {
            series: query().series,
            from: 0,
            to: now() + 1,
        };
        assert!(
            app.metric_maintenance("clear", &selection, None, false)
                .is_err()
        );
        app.metric_maintenance("clear", &selection, None, true)
            .unwrap();
        assert!(
            app.metric_samples(&query(), 16000).unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            app.metric_summary(&metrics::Scope::All, Some(1), 0, 100, 16000)
                .unwrap()["items"],
            summary["items"]
        );
        tokens::attach(&app.lock(), &mut agent).unwrap();
        assert_eq!(agent["total_tokens"], 0);
    }

    #[test]
    fn unavailable_history_never_blocks_core_or_alters_rejected_files() {
        for future in [false, true] {
            let fixture = Fixture::new();
            let home = fixture.0.join("state");
            fs::create_dir(&home).unwrap();
            let path = home.join("metrics.db");
            if future {
                let db = Connection::open(&path).unwrap();
                db.execute_batch("PRAGMA application_id=1094929741;PRAGMA user_version=999;CREATE TABLE sentinel(value);INSERT INTO sentinel VALUES('retained');").unwrap();
            } else {
                fs::write(&path, b"not a SQLite database").unwrap();
            }
            let before = fs::read(&path).unwrap();
            let app = fixture.app();
            assert_eq!(app.metric_status()["available"], false);
            let first = app.metric_status()["last_error"].clone();
            record(&app, 7);
            app.sample_metrics();
            assert!(app.metric_samples(&query(), 16000).is_err());
            assert_eq!(app.metric_status()["last_error"], first);
            let summary = app
                .metric_summary(&metrics::Scope::All, Some(1), 0, 100, 16000)
                .unwrap();
            assert!(
                summary["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["metric"] == "total_tokens" && item["latest"] == "7")
            );
            assert_eq!(fs::read(&path).unwrap(), before);
            assert!(app.metric_history.lock().unwrap().pending.is_empty());
        }
    }

    #[test]
    fn checkpoints_and_periodic_sampling_do_not_fabricate_source_freshness() {
        let fixture = Fixture::new();
        let app = fixture.app();
        record(&app, 9);
        let before = app.metric_samples(&query(), 16000).unwrap();
        let observed = before["items"][0]["envelope"]["last"]["value_observed_at"].clone();
        {
            let mut history = app.metric_history.lock().unwrap();
            history.sampled_at = Some(0);
        }
        app.capture_agent_metrics(1, true);
        app.sample_metrics();
        let after = app.metric_samples(&query(), 16000).unwrap();
        for item in after["items"].as_array().unwrap() {
            assert_eq!(item["envelope"]["last"]["value_observed_at"], observed);
        }
    }

    #[test]
    fn account_history_is_global_only_and_retains_raw_window_names() {
        let fixture = Fixture::new();
        let app = fixture.app();
        app.lock().db.execute("INSERT INTO global.usage_observations(provider,win,used_pct,resets_at,at) VALUES('codex','codex primary',70,NULL,?)",[now()]).unwrap();
        app.capture_account_metrics();
        assert!(
            app.metric_series(None, 100, None, 16000).unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let global = App::open(fixture.0.join("global"), "http://127.0.0.1:0".into()).unwrap();
        global
            .initialize_metric_origin("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", None)
            .unwrap();
        global.lock().db.execute("INSERT INTO global.usage_observations(provider,win,used_pct,resets_at,at) VALUES('codex','codex primary',70,NULL,?)",[now()]).unwrap();
        global.capture_account_metrics();
        let catalog = global.metric_series(None, 100, None, 16000).unwrap();
        assert!(
            catalog["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["series"]["entity"] == "account:codex:codex primary")
        );
    }

    #[test]
    fn snapshots_reject_existing_destinations_and_optional_recovery_preserves_old_files() {
        let fixture = Fixture::new();
        let app = fixture.app();
        record(&app, 7);
        let snapshot = fixture.0.join("snapshot.db");
        app.snapshot_metric_history(&snapshot).unwrap();
        metrics::Metrics::validate_snapshot(&snapshot).unwrap();
        let before = std::fs::read(&snapshot).unwrap();
        assert!(app.snapshot_metric_history(&snapshot).is_err());
        assert_eq!(std::fs::read(&snapshot).unwrap(), before);
        assert!(app.reset_unavailable_metric_history(true).is_err());
        drop(app);
        let fixture = Fixture::new();
        let home = fixture.0.join("state");
        fs::create_dir(&home).unwrap();
        let invalid = b"retained invalid historical file";
        fs::write(home.join("metrics.db"), invalid).unwrap();
        let app = fixture.app();
        record(&app, 8);
        assert!(app.reset_unavailable_metric_history(false).is_err());
        let recovered = app.reset_unavailable_metric_history(true).unwrap();
        let backup = PathBuf::from(recovered["preserved_at"].as_str().unwrap());
        assert_eq!(fs::read(backup.join("metrics.db")).unwrap(), invalid);
        assert_eq!(app.metric_status()["available"], true);
        let summary = app
            .metric_summary(&metrics::Scope::All, Some(1), 0, 100, 16000)
            .unwrap();
        assert!(
            summary["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["metric"] == "total_tokens" && row["latest"] == "8")
        );
    }

    #[test]
    fn since_import_totals_and_history_exclude_archived_segments_in_the_same_second() {
        let fixture = Fixture::new();
        let app = fixture.app();
        record(&app, 7);
        let old = app.metric_history.lock().unwrap().origin.clone().unwrap();
        let imported_at = now();
        app.initialize_metric_origin(&old.source_instance, Some(imported_at))
            .unwrap();
        app.capture_agent_metrics(1, true);
        let current = app.metric_history.lock().unwrap().origin.clone().unwrap();
        assert_ne!(old.id, current.id);
        app.lock()
            .db
            .execute(
                "UPDATE recording_origins SET started_at=? WHERE id=?",
                params![imported_at, old.id],
            )
            .unwrap();
        let scope = app.metric_scope("since_import").unwrap();
        let summary = app.metric_summary(&scope, Some(1), 0, 100, 16000).unwrap();
        assert!(
            summary["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["origin"] == current.id)
        );
        assert_eq!(
            app.metric_totals(&scope, Some(1), &query().series).unwrap()["total_tokens"]["known_subtotal"],
            "0"
        );
        let mut q = query();
        q.scope = scope;
        let samples = app.metric_samples(&q, 16000).unwrap();
        assert!(
            samples["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["origin"]["id"] == current.id)
        );
        app.lock()
            .db
            .execute("DELETE FROM active_recording_origin", [])
            .unwrap();
        app.initialize_metric_origin(&old.source_instance, Some(imported_at))
            .unwrap();
        assert_ne!(
            app.metric_history
                .lock()
                .unwrap()
                .origin
                .as_ref()
                .unwrap()
                .id,
            current.id
        );
    }

    #[test]
    fn optional_history_lock_never_blocks_core_source_writes_and_pending_checkpoint_drains() {
        let fixture = Fixture::new();
        let app = fixture.app();
        let guard = app.metric_history.lock().unwrap();
        let writer = app.clone();
        let (sent, received) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            for value in [10, 12] {
                writer
                    .record_tokens(
                        1,
                        TokenUsage {
                            source: TokenSource::ClaudeResult { trusted: true },
                            counts: [Some(value), Some(0), Some(0), Some(0)],
                            total: Some(value),
                        },
                    )
                    .unwrap();
            }
            writer.record_context(1, 500).unwrap();
            writer.capture_agent_metrics(1, true);
            sent.send(()).unwrap();
        });
        let completed = received.recv_timeout(std::time::Duration::from_secs(1));
        drop(guard);
        thread.join().unwrap();
        assert!(
            completed.is_ok(),
            "core source writes must not wait on optional chart maintenance"
        );
        let pending:(i64,i64,i64)=app.lock().db.query_row("SELECT generation,recorded_generation,checkpoint_generation FROM metric_dirty WHERE agent_id=1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert!(pending.0 > pending.1);
        assert!(pending.2 > 0);
        app.sample_metrics();
        let after = app.metric_samples(&query(), 16000).unwrap();
        assert_eq!(
            after["items"][0]["envelope"]["last"]["value"]["value"],
            "12"
        );
        assert_eq!(after["items"][0]["envelope"]["coverage_gap"], true);
        assert_eq!(after["items"][0]["envelope"]["last"]["quality"], "final");
        let (generation,recorded,checkpoint):(i64,i64,i64)=app.lock().db.query_row("SELECT generation,recorded_generation,checkpoint_generation FROM metric_dirty WHERE agent_id=1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(generation, recorded);
        assert_eq!(checkpoint, 0);
        assert_eq!(context_value(&app.lock(), 1).unwrap(), Some(500));
    }

    #[test]
    fn pinned_optional_snapshots_ignore_writer_mutex_and_remain_at_the_pinned_prefix() {
        let fixture = Fixture::new();
        let app = fixture.app();
        record(&app, 9);
        let guard = app.metric_history.lock().unwrap();
        let before = std::time::Instant::now();
        let pinned = {
            let _core = app.lock();
            app.pin_metric_snapshot().unwrap()
        };
        assert!(before.elapsed() < std::time::Duration::from_secs(1));
        let writer = app.clone();
        let (sent, received) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            writer.record_context(1, 501).unwrap();
            sent.send(()).unwrap();
        });
        let completed = received.recv_timeout(std::time::Duration::from_secs(1));
        drop(guard);
        worker.join().unwrap();
        assert!(
            completed.is_ok(),
            "a pinned optional snapshot must not retain the core lock"
        );
        record(&app, 10);
        let snapshot = fixture.0.join("pinned.db");
        crate::archive::snapshot(pinned.connection(), &snapshot).unwrap();
        let old = metrics::Metrics::read_only(&snapshot)
            .unwrap()
            .query(&query())
            .unwrap();
        assert!(
            old.items
                .iter()
                .all(|sample| sample.envelope.last.value == Some(Number::Counter(9)))
        );
        assert!(
            app.metric_samples(&query(), 16000).unwrap()["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|sample| sample["envelope"]["last"]["value"]["value"] == "10")
        );
    }

    #[test]
    fn stale_acknowledgments_do_not_clear_new_source_or_checkpoint_generations() {
        let fixture = Fixture::new();
        let app = fixture.app();
        app.record_context(1, 400).unwrap();
        let (old_generation, forced) = app.metric_history.lock().unwrap().captured_generations[&1];
        assert!(!forced);
        {
            let st = app.lock();
            request_checkpoint(&st, 1).unwrap();
            acknowledge_captured(&st, &[(1, old_generation, false)]).unwrap();
            let (generation, recorded, checkpoint): (i64, i64, i64) = st.db.query_row(
                "SELECT generation,recorded_generation,checkpoint_generation FROM metric_dirty WHERE agent_id=1",
                [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).unwrap();
            assert_eq!(generation, old_generation);
            assert_eq!(recorded, old_generation);
            assert_eq!(checkpoint, old_generation);
            mark_dirty(&st, 1, true).unwrap();
            acknowledge_captured(&st, &[(1, old_generation, true)]).unwrap();
            let (generation, recorded, checkpoint): (i64, i64, i64) = st.db.query_row(
                "SELECT generation,recorded_generation,checkpoint_generation FROM metric_dirty WHERE agent_id=1",
                [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).unwrap();
            assert_eq!(generation, old_generation + 1);
            assert_eq!(recorded, old_generation);
            assert_eq!(checkpoint, old_generation + 1);
        }
        app.sample_metrics();
        let (generation, recorded, checkpoint): (i64, i64, i64) = app.lock().db.query_row(
            "SELECT generation,recorded_generation,checkpoint_generation FROM metric_dirty WHERE agent_id=1",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(generation, recorded);
        assert_eq!(checkpoint, 0);
    }
}
