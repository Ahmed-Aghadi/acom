//! Disposable chart history. Accounting and coordination must never depend on this database.

use rusqlite::functions::{Aggregate, Context, FunctionFlags};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::Duration;

pub const DEFAULT_INTERVAL_SECS: u32 = 5;
pub const MAX_INTERVAL_SECS: u32 = 3_600;
pub const MAX_PAGE: usize = 2_000;
const SCHEMA_VERSION: i64 = 4;
const APPLICATION_ID: i64 = 0x41434d4d;
const SCHEMA: &str = "PRAGMA foreign_keys=ON;
             PRAGMA journal_mode=WAL;
             BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS metric_meta(epoch INTEGER NOT NULL,store_id TEXT NOT NULL);
             INSERT INTO metric_meta SELECT 0,lower(hex(randomblob(16))) WHERE NOT EXISTS(SELECT 1 FROM metric_meta);
             CREATE TABLE IF NOT EXISTS metric_origins(
               id TEXT PRIMARY KEY, source_instance TEXT NOT NULL, imported_at INTEGER);
             CREATE TABLE IF NOT EXISTS metric_series(
               id INTEGER PRIMARY KEY, entity TEXT NOT NULL, metric TEXT NOT NULL,
               kind TEXT NOT NULL, UNIQUE(entity,metric));
             CREATE TABLE IF NOT EXISTS metric_latest(
               series_id INTEGER NOT NULL REFERENCES metric_series(id),
               origin_id TEXT NOT NULL REFERENCES metric_origins(id),
               point TEXT NOT NULL, changed_at INTEGER NOT NULL,
               last_known TEXT, last_sampled_at INTEGER, pending TEXT,
               PRIMARY KEY(series_id,origin_id));
             CREATE TABLE IF NOT EXISTS metric_samples(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               series_id INTEGER NOT NULL REFERENCES metric_series(id),
               origin_id TEXT NOT NULL REFERENCES metric_origins(id),
               start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
               envelope TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS metric_samples_range
               ON metric_samples(series_id,start_at,end_at);
             CREATE INDEX IF NOT EXISTS metric_samples_origin
               ON metric_samples(origin_id,series_id,id);
             PRAGMA application_id=1094929741;
             PRAGMA user_version=4;
             COMMIT;";

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Counter,
    Gauge,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    rename_all = "snake_case",
    tag = "kind",
    content = "value",
    deny_unknown_fields
)]
pub enum Number {
    Counter(#[serde(with = "decimal_counter")] u64),
    Gauge(f64),
}

mod decimal_counter {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        value: &u64,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        let value = text.parse::<u64>().map_err(serde::de::Error::custom)?;
        if text != value.to_string() {
            return Err(serde::de::Error::custom(
                "counter must be a canonical unsigned decimal string",
            ));
        }
        Ok(value)
    }
}

impl Number {
    fn kind(&self) -> Kind {
        match self {
            Self::Counter(_) => Kind::Counter,
            Self::Gauge(_) => Kind::Gauge,
        }
    }

    fn compare(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Counter(a), Self::Counter(b)) => a.cmp(b),
            (Self::Gauge(a), Self::Gauge(b)) => a.total_cmp(b),
            _ => unreachable!("series kinds are validated before storage"),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    Unknown,
    Provisional,
    Partial,
    Final,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Series {
    pub entity: String,
    pub metric: String,
    pub kind: Kind,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Origin {
    pub id: String,
    pub source_instance: String,
    pub imported_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub observed_at: i64,
    pub value_observed_at: Option<i64>,
    pub value: Option<Number>,
    pub quality: Quality,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub series: Series,
    pub point: Point,
    pub correction: bool,
    pub coverage_gap: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub first: Point,
    pub last: Point,
    pub minimum: Option<Point>,
    pub maximum: Option<Point>,
    pub observations: u64,
    pub qualities: BTreeSet<Quality>,
    pub has_gap: bool,
    pub coverage_gap: bool,
    pub has_correction: bool,
    pub checkpoint: bool,
    pub resolution_secs: u32,
    pub sampled_at: i64,
}

impl Envelope {
    fn point(
        point: Point,
        correction: bool,
        checkpoint: bool,
        sampled_at: i64,
        coverage_gap: bool,
    ) -> Self {
        let numeric = point.value.is_some().then(|| point.clone());
        Self {
            minimum: numeric.clone(),
            maximum: numeric,
            has_gap: point.value.is_none(),
            coverage_gap,
            qualities: BTreeSet::from([point.quality]),
            first: point.clone(),
            last: point,
            observations: 1,
            has_correction: correction,
            checkpoint,
            resolution_secs: 0,
            sampled_at,
        }
    }

    fn merge(&mut self, next: Self) -> Result<()> {
        if self.kind().zip(next.kind()).is_some_and(|(a, b)| a != b) {
            return Err("mixed numeric kinds in stored metrics".into());
        }
        if next.first.observed_at < self.first.observed_at {
            self.first = next.first.clone();
        }
        if next.last.observed_at >= self.last.observed_at {
            self.last = next.last.clone();
        }
        for (current, candidate, ordering) in [
            (&mut self.minimum, next.minimum, Ordering::Less),
            (&mut self.maximum, next.maximum, Ordering::Greater),
        ] {
            if let Some(candidate) = candidate {
                let replace = current.as_ref().is_none_or(|old| {
                    let compared = candidate
                        .value
                        .as_ref()
                        .unwrap()
                        .compare(old.value.as_ref().unwrap());
                    compared == ordering
                        || (compared == Ordering::Equal && candidate.observed_at < old.observed_at)
                });
                if replace {
                    *current = Some(candidate);
                }
            }
        }
        self.observations = self.observations.saturating_add(next.observations);
        self.qualities.extend(next.qualities);
        self.has_gap |= next.has_gap;
        self.coverage_gap |= next.coverage_gap;
        self.has_correction |= next.has_correction;
        self.checkpoint |= next.checkpoint;
        self.resolution_secs = self.resolution_secs.max(next.resolution_secs);
        self.sampled_at = self.sampled_at.max(next.sampled_at);
        Ok(())
    }

    fn kind(&self) -> Option<Kind> {
        self.minimum
            .as_ref()
            .and_then(|point| point.value.as_ref().map(Number::kind))
    }

    fn validate(&self) -> Result<()> {
        if self.observations == 0
            || self.first.observed_at > self.last.observed_at
            || self.sampled_at < self.last.observed_at
            || self.qualities.is_empty()
            || self.has_gap != self.qualities.contains(&Quality::Unknown)
            || self.minimum.is_some() != self.maximum.is_some()
        {
            return Err("invalid stored metrics envelope".into());
        }
        if self.resolution_secs > 0 {
            validate_resolution(self.resolution_secs)?;
        }
        let kind = self.kind().unwrap_or(Kind::Counter);
        for point in [&self.first, &self.last]
            .into_iter()
            .chain(self.minimum.as_ref())
            .chain(self.maximum.as_ref())
        {
            validate_point_kind(kind, point)?;
            if point.observed_at < self.first.observed_at
                || point.observed_at > self.last.observed_at
                || !self.qualities.contains(&point.quality)
            {
                return Err("invalid stored metrics point bounds".into());
            }
        }
        if let (Some(minimum), Some(maximum)) = (&self.minimum, &self.maximum) {
            let minimum = minimum.value.as_ref().ok_or("unavailable stored minimum")?;
            let maximum = maximum.value.as_ref().ok_or("unavailable stored maximum")?;
            if minimum.compare(maximum) == Ordering::Greater {
                return Err("invalid stored metrics extrema".into());
            }
            for point in [&self.first, &self.last] {
                if let Some(value) = &point.value
                    && (value.compare(minimum) == Ordering::Less
                        || value.compare(maximum) == Ordering::Greater)
                {
                    return Err("stored endpoint exceeds metrics extrema".into());
                }
            }
        } else if self
            .qualities
            .iter()
            .any(|quality| *quality != Quality::Unknown)
        {
            return Err("known stored metrics lack extrema".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Latest {
    pub series: Series,
    pub origin: Origin,
    pub point: Point,
    pub last_known: Option<Point>,
    pub changed_at: i64,
    pub last_sampled_at: Option<i64>,
    pub pending: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LatestPage {
    pub items: Vec<Latest>,
    pub next: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct RecordResult {
    pub observed: usize,
    pub stale: usize,
    pub samples: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "scope", deny_unknown_fields)]
pub enum Scope {
    All,
    RecordedHere { source_instance: String },
    SinceImport { origin_id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    store_id: String,
    epoch: i64,
    upper_id: i64,
    after_id: i64,
    query: String,
    to: i64,
}

impl Cursor {
    pub fn upper_time(&self) -> i64 {
        self.to
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub series: Vec<Series>,
    pub all_agents: bool,
    pub descending: bool,
    pub from: i64,
    pub to: i64,
    pub scope: Scope,
    pub limit: usize,
    pub resolution_secs: Option<u32>,
    pub cursor: Option<Cursor>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Sample {
    pub id: i64,
    pub series: Series,
    pub origin: Origin,
    pub envelope: Envelope,
    pub crosses_range: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Page {
    pub items: Vec<Sample>,
    pub next: Option<Cursor>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SeriesEntry {
    pub id: i64,
    pub series: Series,
    pub first_at: Option<i64>,
    pub last_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SeriesPage {
    pub items: Vec<SeriesEntry>,
    pub next: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub series: Vec<Series>,
    pub from: i64,
    pub to: i64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct DownsampleResult {
    pub before: u64,
    pub after: u64,
    pub skipped_boundary: u64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct ClearResult {
    pub removed: u64,
    pub skipped_boundary: u64,
}

pub struct Metrics {
    db: Connection,
    store_id: String,
}

struct MergeEnvelopes;

impl Aggregate<Option<Envelope>, Option<String>> for MergeEnvelopes {
    fn init(&self, _: &mut Context<'_>) -> rusqlite::Result<Option<Envelope>> {
        Ok(None)
    }

    fn step(
        &self,
        context: &mut Context<'_>,
        state: &mut Option<Envelope>,
    ) -> rusqlite::Result<()> {
        let json = context.get::<String>(0)?;
        let envelope = decode_envelope(&json).map_err(sql_function_error)?;
        if let Some(state) = state {
            state.merge(envelope).map_err(sql_function_error)?;
        } else {
            *state = Some(envelope);
        }
        Ok(())
    }

    fn finalize(
        &self,
        _: &mut Context<'_>,
        state: Option<Option<Envelope>>,
    ) -> rusqlite::Result<Option<String>> {
        state
            .flatten()
            .map(|state| {
                serde_json::to_string(&state)
                    .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
            })
            .transpose()
    }
}

impl Metrics {
    pub(crate) fn connection(&self) -> &Connection {
        &self.db
    }

    pub fn validate_snapshot(path: &Path) -> Result<()> {
        let db =
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error)?;
        db.execute_batch("PRAGMA trusted_schema=OFF;")
            .map_err(error)?;
        let expected = Self::initialize(Connection::open_in_memory().map_err(error)?)?;
        type SchemaObject = (String, String, String, Option<String>);
        let schema = |db: &Connection| -> Result<Vec<SchemaObject>> {
            let mut statement=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name LIMIT 32").map_err(error)?;
            statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)
        };
        if schema(&db)? != schema(&expected.db)? {
            return Err("metrics snapshot schema does not match this version".into());
        }
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(error)?;
        let application: i64 = db
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .map_err(error)?;
        if version != SCHEMA_VERSION || application != APPLICATION_ID {
            return Err("unsupported metrics snapshot format".into());
        }
        let check: String = db
            .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
            .map_err(error)?;
        if check != "ok" {
            return Err(format!("metrics snapshot failed integrity check: {check}"));
        }
        let meta: bool = db
            .query_row(
                "SELECT count(*)=1 AND min(epoch)>=0 FROM metric_meta",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        if !meta {
            return Err("metrics snapshot has invalid metadata".into());
        }
        validate_snapshot_rows(&db)
            .map_err(|error| format!("invalid metrics snapshot data: {error}"))?;
        Self::from_connection(db)?;
        Ok(())
    }

    #[cfg(test)]
    pub fn memory() -> Result<Self> {
        Self::initialize(Connection::open_in_memory().map_err(error)?)
    }

    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).map_err(error)?;
        Self::initialize(db)
    }

    pub fn read_only(path: &Path) -> Result<Self> {
        Self::read_only_with_timeout(path, Duration::from_secs(5))
    }

    pub fn pin_snapshot(path: &Path) -> Result<Self> {
        let store = Self::read_only_with_timeout(path, Duration::from_millis(50))?;
        store.db.execute_batch("BEGIN;").map_err(error)?;
        store
            .db
            .query_row("SELECT epoch FROM metric_meta", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(error)?;
        Ok(store)
    }

    fn read_only_with_timeout(path: &Path, timeout: Duration) -> Result<Self> {
        let db =
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error)?;
        Self::prepare(&db)?;
        db.busy_timeout(timeout).map_err(error)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(error)?;
        let application: i64 = db
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .map_err(error)?;
        if version != SCHEMA_VERSION || application != APPLICATION_ID {
            return Err("unsupported or invalid metrics database".into());
        }
        Self::from_connection(db)
    }

    fn initialize(db: Connection) -> Result<Self> {
        Self::prepare(&db)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(error)?;
        let application: i64 = db
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .map_err(error)?;
        let has_tables: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        if (application != 0 || has_tables) && application != APPLICATION_ID {
            return Err("this file is not an acom metrics database".into());
        }
        if version != 0 && version != SCHEMA_VERSION {
            return Err(format!("unsupported metrics schema {version}"));
        }
        db.execute_batch(SCHEMA).map_err(error)?;
        Self::from_connection(db)
    }

    fn prepare(db: &Connection) -> Result<()> {
        db.busy_timeout(Duration::from_secs(5)).map_err(error)?;
        db.create_aggregate_function(
            c"metric_envelope",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            MergeEnvelopes,
        )
        .map_err(error)?;
        Ok(())
    }

    fn from_connection(db: Connection) -> Result<Self> {
        let store_id: String = db
            .query_row("SELECT store_id FROM metric_meta", [], |row| row.get(0))
            .map_err(error)?;
        if store_id.len() != 32
            || !store_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid metrics store identity".into());
        }
        Ok(Self { db, store_id })
    }

    /// `observed_at` is source evidence; `sampled_at` is only the local sampling clock.
    pub fn record(
        &mut self,
        origin: &Origin,
        observations: &[Observation],
        sampled_at: i64,
        interval_secs: u32,
        checkpoint: bool,
    ) -> Result<RecordResult> {
        validate_origin(origin)?;
        validate_interval(interval_secs)?;
        validate_time(sampled_at)?;
        if observations.len() > MAX_PAGE {
            return Err(format!("at most {MAX_PAGE} observations per record"));
        }
        let mut keys = BTreeSet::new();
        for observation in observations {
            validate_series(&observation.series)?;
            validate_point(&observation.series, &observation.point)?;
            if observation.point.observed_at > sampled_at {
                return Err("an observation cannot be newer than the sampling clock".into());
            }
            if !keys.insert((&observation.series.entity, &observation.series.metric)) {
                return Err("duplicate series in observation batch".into());
            }
        }
        let tx = self.db.transaction().map_err(error)?;
        ensure_origin(&tx, origin)?;
        let mut result = RecordResult::default();
        for observation in observations {
            let series_id = ensure_series(&tx, &observation.series)?;
            let old = tx
                .query_row(
                    "SELECT point,changed_at,last_known,last_sampled_at,pending
                     FROM metric_latest WHERE series_id=? AND origin_id=?",
                    params![series_id, origin.id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(error)?;
            let (changed_at, last_known, last_sampled_at, mut pending) = if let Some((
                point,
                changed_at,
                last_known,
                last_sampled_at,
                pending,
            )) = old
            {
                let previous: Point = decode(&point)?;
                if observation.point.observed_at < previous.observed_at {
                    result.stale += 1;
                    continue;
                }
                if observation.point == previous
                    && !observation.correction
                    && !checkpoint
                    && !observation.coverage_gap
                {
                    continue;
                }
                let changed = previous.value != observation.point.value
                    || previous.quality != observation.point.quality
                    || observation.correction
                    || observation.coverage_gap;
                let known: Option<Point> = last_known.map(|v| decode(&v)).transpose()?;
                if let Some(point) = &known {
                    validate_point(&observation.series, point)?;
                }
                let correction = observation.correction
                    || matches!(
                        (known.as_ref().and_then(|point|point.value.as_ref()), &observation.point.value),
                        (Some(Number::Counter(old)), Some(Number::Counter(new))) if new < old
                    );
                let mut pending = pending.map(|v| decode_envelope(&v)).transpose()?;
                if changed || checkpoint {
                    let next = Envelope::point(
                        observation.point.clone(),
                        correction,
                        checkpoint,
                        sampled_at,
                        observation.coverage_gap,
                    );
                    if let Some(pending) = &mut pending {
                        pending.merge(next)?;
                    } else {
                        pending = Some(next);
                    }
                }
                (
                    if changed {
                        observation.point.observed_at
                    } else {
                        changed_at
                    },
                    observation
                        .point
                        .value
                        .as_ref()
                        .map(|_| observation.point.clone())
                        .or(known),
                    last_sampled_at,
                    pending,
                )
            } else {
                (
                    observation.point.observed_at,
                    observation
                        .point
                        .value
                        .as_ref()
                        .map(|_| observation.point.clone()),
                    None,
                    Some(Envelope::point(
                        observation.point.clone(),
                        observation.correction,
                        checkpoint,
                        sampled_at,
                        observation.coverage_gap,
                    )),
                )
            };
            result.observed += 1;
            let due = checkpoint
                || last_sampled_at.is_none_or(|last| sampled_at - last >= i64::from(interval_secs));
            let mut sampled = last_sampled_at;
            if due && let Some(mut envelope) = pending.take() {
                envelope.sampled_at = sampled_at;
                insert_sample(&tx, series_id, &origin.id, &envelope)?;
                result.samples += 1;
                sampled = Some(sampled_at);
            }
            tx.execute(
                "INSERT INTO metric_latest(series_id,origin_id,point,changed_at,last_known,last_sampled_at,pending)
                 VALUES(?,?,?,?,?,?,?) ON CONFLICT(series_id,origin_id) DO UPDATE SET
                 point=excluded.point,changed_at=excluded.changed_at,last_known=excluded.last_known,
                 last_sampled_at=excluded.last_sampled_at,pending=excluded.pending",
                params![
                    series_id,
                    origin.id,
                    encode(&observation.point)?,
                    changed_at,
                    last_known.as_ref().map(encode).transpose()?,
                    sampled,
                    pending.as_ref().map(encode).transpose()?,
                ],
            )
            .map_err(error)?;
        }
        tx.commit().map_err(error)?;
        Ok(result)
    }

    pub fn flush(&mut self, sampled_at: i64, interval_secs: u32) -> Result<usize> {
        validate_time(sampled_at)?;
        validate_interval(interval_secs)?;
        let tx = self.db.transaction().map_err(error)?;
        let pending = {
            let mut stmt = tx
                .prepare(
                    "SELECT series_id,origin_id,pending FROM metric_latest WHERE pending IS NOT NULL
                     AND (last_sampled_at IS NULL OR last_sampled_at<=?)",
                )
                .map_err(error)?;
            stmt.query_map([sampled_at - i64::from(interval_secs)], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?
        };
        for (series_id, origin_id, json) in &pending {
            let mut envelope = decode_envelope(json)?;
            envelope.sampled_at = sampled_at;
            insert_sample(&tx, *series_id, origin_id, &envelope)?;
            tx.execute(
                "UPDATE metric_latest SET pending=NULL,last_sampled_at=?
                 WHERE series_id=? AND origin_id=?",
                params![sampled_at, series_id, origin_id],
            )
            .map_err(error)?;
        }
        tx.commit().map_err(error)?;
        Ok(pending.len())
    }

    pub fn latest(&self, series: &Series, limit: usize, after: Option<&str>) -> Result<LatestPage> {
        validate_series(series)?;
        validate_limit(limit)?;
        if let Some(after) = after {
            validate_id(after)?;
        }
        let mut stmt = self
            .db
            .prepare(
                "SELECT o.id,o.source_instance,o.imported_at,l.point,l.changed_at,
                 l.last_sampled_at,l.pending IS NOT NULL,l.last_known
                 FROM metric_latest l JOIN metric_series s ON s.id=l.series_id
                 JOIN metric_origins o ON o.id=l.origin_id
                 WHERE s.entity=? AND s.metric=? AND s.kind=? AND o.id>? ORDER BY o.id LIMIT ?",
            )
            .map_err(error)?;
        let rows = stmt
            .query_map(
                params![
                    series.entity,
                    series.metric,
                    kind_name(series.kind),
                    after.unwrap_or(""),
                    (limit + 1) as i64
                ],
                |row| {
                    Ok((
                        origin_row(row, 0)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .map_err(error)?;
        let mut items = rows
            .map(|row| {
                let (origin, point, changed_at, last_sampled_at, pending, last_known) =
                    row.map_err(error)?;
                let point: Point = decode(&point)?;
                validate_point(series, &point)?;
                let last_known = last_known.as_deref().map(decode::<Point>).transpose()?;
                if let Some(point) = &last_known {
                    validate_point(series, point)?;
                }
                Ok(Latest {
                    series: series.clone(),
                    origin,
                    point,
                    last_known,
                    changed_at,
                    last_sampled_at,
                    pending,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let more = items.len() > limit;
        items.truncate(limit);
        let next = more.then(|| items.last().unwrap().origin.id.clone());
        Ok(LatestPage { items, next })
    }

    #[cfg(test)]
    pub fn query(&self, query: &Query) -> Result<Page> {
        self.query_inner(query, None)
    }

    pub fn query_bounded(&self, query: &Query, max_bytes: usize) -> Result<Page> {
        if !(512..=65_536).contains(&max_bytes) {
            return Err("max_bytes must be 512–65536".into());
        }
        self.query_inner(query, Some(max_bytes))
    }

    fn query_inner(&self, query: &Query, max_bytes: Option<usize>) -> Result<Page> {
        validate_selection(&query.series, query.from, query.to)?;
        if query.all_agents && query.series.iter().any(|series| series.entity != "agent:*") {
            return Err("all-agent queries require the agent:* series selector".into());
        }
        validate_limit(query.limit)?;
        if let Some(resolution) = query.resolution_secs {
            validate_resolution(resolution)?;
        }
        match &query.scope {
            Scope::RecordedHere { source_instance } => validate_id(source_instance)?,
            Scope::SinceImport { origin_id } => validate_id(origin_id)?,
            Scope::All => {}
        }
        let signature = encode(&(
            &query.series,
            query.all_agents,
            query.descending,
            query.from,
            query.to,
            &query.scope,
            query.resolution_secs,
        ))?;
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        signature.hash(&mut hash);
        let signature = format!("{:016x}", hash.finish());
        let tx = self.db.unchecked_transaction().map_err(error)?;
        let epoch: i64 = tx
            .query_row("SELECT epoch FROM metric_meta", [], |row| row.get(0))
            .map_err(error)?;
        let upper_id: i64 = tx
            .query_row(
                "SELECT coalesce(max(id),0) FROM metric_samples",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        let cursor = if let Some(cursor) = &query.cursor {
            if cursor.store_id != self.store_id
                || cursor.epoch != epoch
                || cursor.query != signature
                || cursor.to != query.to
            {
                return Err("metrics cursor no longer matches this query; restart paging".into());
            }
            if cursor.after_id < 0
                || cursor.upper_id < cursor.after_id
                || cursor.upper_id > upper_id
            {
                return Err("invalid metrics cursor".into());
            }
            cursor.clone()
        } else {
            Cursor {
                store_id: self.store_id.clone(),
                epoch,
                upper_id,
                after_id: 0,
                query: signature,
                to: query.to,
            }
        };
        let raw = select_samples(&tx, query, &cursor)?;
        let candidate_count = raw.len();
        let mut page = Page {
            items: Vec::new(),
            next: None,
        };
        for sample in raw.into_iter().take(query.limit) {
            let next = (page.items.len() + 1 < candidate_count).then(|| Cursor {
                after_id: sample.id,
                ..cursor.clone()
            });
            page.items.push(sample);
            let previous = std::mem::replace(&mut page.next, next);
            if let Some(max_bytes) = max_bytes
                && encode(&page)?.len() > max_bytes
            {
                page.items.pop();
                page.next = previous;
                if page.items.is_empty() {
                    return Err(
                        "one metric envelope exceeds max_bytes; increase the response budget"
                            .into(),
                    );
                }
                break;
            }
        }
        tx.commit().map_err(error)?;
        Ok(page)
    }

    pub fn series(
        &self,
        entity: Option<&str>,
        limit: usize,
        after: Option<i64>,
    ) -> Result<SeriesPage> {
        validate_limit(limit)?;
        if let Some(entity) = entity {
            validate_id(entity)?;
        }
        if after.is_some_and(|after| after < 0) {
            return Err("series cursor must be nonnegative".into());
        }
        let mut statement = self.db.prepare(
            "SELECT s.id,s.entity,s.metric,s.kind,min(p.start_at),max(p.end_at) FROM metric_series s
             LEFT JOIN metric_samples p ON p.series_id=s.id
             WHERE s.id>?1 AND (?2 IS NULL OR s.entity=?2) GROUP BY s.id ORDER BY s.id LIMIT ?3"
        ).map_err(error)?;
        let mut items = statement
            .query_map(
                params![after.unwrap_or(0), entity, (limit + 1) as i64],
                |row| {
                    let kind: String = row.get(3)?;
                    let kind = match kind.as_str() {
                        "counter" => Kind::Counter,
                        "gauge" => Kind::Gauge,
                        _ => return Err(rusqlite::Error::InvalidQuery),
                    };
                    Ok(SeriesEntry {
                        id: row.get(0)?,
                        series: Series {
                            entity: row.get(1)?,
                            metric: row.get(2)?,
                            kind,
                        },
                        first_at: row.get(4)?,
                        last_at: row.get(5)?,
                    })
                },
            )
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        let more = items.len() > limit;
        items.truncate(limit);
        let next = more.then(|| items.last().unwrap().id);
        Ok(SeriesPage { items, next })
    }

    /// Explicitly discards detail, retaining envelope endpoints, extrema and uncertainty.
    pub fn preview_downsample(
        &self,
        selection: &Selection,
        resolution_secs: u32,
    ) -> Result<DownsampleResult> {
        validate_selection(&selection.series, selection.from, selection.to)?;
        validate_resolution(resolution_secs)?;
        let tx = self.db.unchecked_transaction().map_err(error)?;
        let selection = resolve_selection(&tx, selection)?;
        let result = downsample_plan(&tx, &selection, resolution_secs)?;
        tx.commit().map_err(error)?;
        Ok(result)
    }

    pub fn downsample(
        &mut self,
        selection: &Selection,
        resolution_secs: u32,
    ) -> Result<DownsampleResult> {
        validate_selection(&selection.series, selection.from, selection.to)?;
        validate_resolution(resolution_secs)?;
        let tx = self.db.transaction().map_err(error)?;
        let selection = resolve_selection(&tx, selection)?;
        let result = downsample_plan(&tx, &selection, resolution_secs)?;
        let mut changed = false;
        for series in &selection.series {
            let Some(series_id) = series_id(&tx, series)? else {
                continue;
            };
            let mut after_origin = String::new();
            let mut after_bucket = -1;
            loop {
                let buckets = {
                    let mut stmt = tx
                        .prepare(
                            "SELECT origin_id,start_at/? FROM metric_samples
                         WHERE series_id=? AND start_at>=? AND end_at<?
                         AND (origin_id>? OR (origin_id=? AND start_at/?>?))
                         GROUP BY origin_id,start_at/? ORDER BY origin_id,start_at/? LIMIT 256",
                        )
                        .map_err(error)?;
                    stmt.query_map(
                        params![
                            resolution_secs,
                            series_id,
                            selection.from,
                            selection.to,
                            after_origin,
                            after_origin,
                            resolution_secs,
                            after_bucket,
                            resolution_secs,
                            resolution_secs
                        ],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(error)?
                };
                if buckets.is_empty() {
                    break;
                }
                for (origin, bucket) in buckets {
                    let (count, mut envelope) = read_bucket(
                        &tx,
                        series_id,
                        &origin,
                        selection.from,
                        selection.to,
                        resolution_secs,
                        bucket,
                    )?;
                    after_origin = origin.clone();
                    after_bucket = bucket;
                    if count == 1 && envelope.resolution_secs == resolution_secs {
                        continue;
                    }
                    envelope.resolution_secs = resolution_secs;
                    changed = true;
                    tx.execute(
                        "DELETE FROM metric_samples WHERE series_id=? AND origin_id=?
                     AND start_at>=? AND end_at<? AND start_at/?=?",
                        params![
                            series_id,
                            origin,
                            selection.from,
                            selection.to,
                            resolution_secs,
                            bucket
                        ],
                    )
                    .map_err(error)?;
                    insert_sample(&tx, series_id, &origin, &envelope)?;
                }
            }
        }
        if changed {
            tx.execute("UPDATE metric_meta SET epoch=epoch+1", [])
                .map_err(error)?;
        }
        tx.commit().map_err(error)?;
        Ok(result)
    }

    /// Clears only chart history/freshness. Durable accounting belongs elsewhere.
    #[cfg(test)]
    pub fn clear(&mut self) -> Result<()> {
        let tx = self.db.transaction().map_err(error)?;
        tx.execute_batch(
            "DELETE FROM metric_samples;
                 DELETE FROM metric_latest;
                 DELETE FROM metric_series;
                 DELETE FROM metric_origins;
                 UPDATE metric_meta SET epoch=epoch+1;",
        )
        .map_err(error)?;
        tx.commit().map_err(error)
    }

    pub fn preview_clear(&self, selection: &Selection) -> Result<ClearResult> {
        validate_selection(&selection.series, selection.from, selection.to)?;
        let tx = self.db.unchecked_transaction().map_err(error)?;
        let selection = resolve_selection(&tx, selection)?;
        let result = clear_plan(&tx, &selection)?;
        tx.commit().map_err(error)?;
        Ok(result)
    }

    /// Retains current observations so unchanged source readings cannot recreate cleared history.
    pub fn clear_history(&mut self, selection: &Selection) -> Result<ClearResult> {
        validate_selection(&selection.series, selection.from, selection.to)?;
        let tx = self.db.transaction().map_err(error)?;
        let selection = resolve_selection(&tx, selection)?;
        let result = clear_plan(&tx, &selection)?;
        let mut changed = false;
        for series in &selection.series {
            let Some(id) = series_id(&tx, series)? else {
                continue;
            };
            changed |= tx
                .execute(
                    "DELETE FROM metric_samples WHERE series_id=?1 AND start_at>=?2 AND end_at<?3",
                    params![id, selection.from, selection.to],
                )
                .map_err(error)?
                > 0;
            changed |= tx.execute("UPDATE metric_latest SET pending=NULL WHERE series_id=?1 AND json_extract(pending,'$.first.observed_at')>=?2 AND json_extract(pending,'$.last.observed_at')<?3",
                params![id,selection.from,selection.to]).map_err(error)? > 0;
        }
        if changed {
            tx.execute("UPDATE metric_meta SET epoch=epoch+1", [])
                .map_err(error)?;
        }
        tx.commit().map_err(error)?;
        Ok(result)
    }

    /// Reclaims pages after an explicit clear/downsample; not an automatic polling task.
    pub fn reclaim_space(&self) -> Result<()> {
        self.db
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
            .map_err(error)
    }
}

fn clear_plan(tx: &Transaction<'_>, selection: &Selection) -> Result<ClearResult> {
    let mut result = ClearResult::default();
    for series in &selection.series {
        let Some(id) = series_id(tx, series)? else {
            continue;
        };
        let (removed, boundary): (i64,i64) = tx.query_row(
            "SELECT count(*) FILTER(WHERE start_at>=?2 AND end_at<?3),count(*) FILTER(WHERE start_at<?2 OR end_at>=?3)
             FROM metric_samples WHERE series_id=?1 AND end_at>=?2 AND start_at<?3",
             params![id,selection.from,selection.to], |row| Ok((row.get(0)?,row.get(1)?))
        ).map_err(error)?;
        result.removed += removed as u64;
        result.skipped_boundary += boundary as u64;
    }
    Ok(result)
}

fn resolve_selection(db: &Connection, selection: &Selection) -> Result<Selection> {
    let mut selected = Vec::new();
    let mut seen = BTreeSet::new();
    for series in &selection.series {
        let expanded = if series.entity == "agent:*" {
            let mut statement=db.prepare("SELECT entity FROM metric_series WHERE entity GLOB 'agent:[0-9]*' AND metric=?1 AND kind=?2 ORDER BY id LIMIT 2001").map_err(error)?;
            statement
                .query_map(params![series.metric, kind_name(series.kind)], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(error)?
        } else {
            vec![series.entity.clone()]
        };
        for entity in expanded {
            if !seen.insert((entity.clone(), series.metric.clone())) {
                return Err("metric selections overlap".into());
            }
            selected.push(Series {
                entity,
                metric: series.metric.clone(),
                kind: series.kind,
            });
            if selected.len() > MAX_PAGE {
                return Err(
                    "maintenance selects more than 2000 series; choose a narrower selection".into(),
                );
            }
        }
    }
    Ok(Selection {
        series: selected,
        from: selection.from,
        to: selection.to,
    })
}

fn validate_snapshot_rows(db: &Connection) -> Result<()> {
    let started = std::time::Instant::now();
    let check_time = || {
        if started.elapsed() > Duration::from_secs(60) {
            Err("metrics snapshot validation exceeded 60 seconds".to_string())
        } else {
            Ok(())
        }
    };
    // Check lengths before materializing JSON or identifiers from an archive.
    for (table, fields) in [
        ("metric_meta", &[("store_id", 32)][..]),
        (
            "metric_origins",
            &[("id", 512), ("source_instance", 512)][..],
        ),
        (
            "metric_series",
            &[("entity", 512), ("metric", 512), ("kind", 16)][..],
        ),
        (
            "metric_latest",
            &[
                ("origin_id", 512),
                ("point", 65536),
                ("last_known", 65536),
                ("pending", 65536),
            ][..],
        ),
        (
            "metric_samples",
            &[("origin_id", 512), ("envelope", 65536)][..],
        ),
    ] {
        let invalid = fields.iter().map(|(field, limit)| format!("({field} IS NOT NULL AND (typeof({field})<>'text' OR length(CAST({field} AS BLOB))>{limit}))")).collect::<Vec<_>>().join(" OR ");
        let invalid: bool = db
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {invalid})"),
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        if invalid {
            return Err(format!(
                "{table} contains an invalid or oversized text field"
            ));
        }
        check_time()?;
    }
    let epoch: i64 = db
        .query_row("SELECT epoch FROM metric_meta", [], |row| row.get(0))
        .map_err(error)?;
    if epoch < 0 {
        return Err("invalid metrics epoch".into());
    }
    let mut foreign_keys = db.prepare("PRAGMA foreign_key_check").map_err(error)?;
    if foreign_keys
        .query([])
        .map_err(error)?
        .next()
        .map_err(error)?
        .is_some()
    {
        return Err("dangling metrics reference".into());
    }
    let mut origins = db
        .prepare("SELECT id,source_instance,imported_at FROM metric_origins")
        .map_err(error)?;
    let mut rows = origins.query([]).map_err(error)?;
    while let Some(row) = rows.next().map_err(error)? {
        check_time()?;
        validate_origin(&origin_row(row, 0).map_err(error)?)?;
    }
    let mut series = db
        .prepare("SELECT id,entity,metric,kind FROM metric_series")
        .map_err(error)?;
    let mut rows = series.query([]).map_err(error)?;
    while let Some(row) = rows.next().map_err(error)? {
        check_time()?;
        if row.get::<_, i64>(0).map_err(error)? <= 0 {
            return Err("invalid metric series identity".into());
        }
        validate_series(&Series {
            entity: row.get(1).map_err(error)?,
            metric: row.get(2).map_err(error)?,
            kind: parse_kind(&row.get::<_, String>(3).map_err(error)?)?,
        })?;
    }
    let mut latest = db.prepare("SELECT s.kind,l.point,l.changed_at,l.last_known,l.last_sampled_at,l.pending FROM metric_latest l JOIN metric_series s ON s.id=l.series_id").map_err(error)?;
    let mut rows = latest.query([]).map_err(error)?;
    while let Some(row) = rows.next().map_err(error)? {
        check_time()?;
        let kind = parse_kind(&row.get::<_, String>(0).map_err(error)?)?;
        let point: Point = decode(&row.get::<_, String>(1).map_err(error)?)?;
        validate_point_kind(kind, &point)?;
        let changed_at: i64 = row.get(2).map_err(error)?;
        validate_time(changed_at)?;
        if changed_at > point.observed_at {
            return Err("metrics change timestamp exceeds its latest observation".into());
        }
        let known: Option<String> = row.get(3).map_err(error)?;
        let known = known.as_deref().map(decode::<Point>).transpose()?;
        if let Some(known) = &known {
            validate_point_kind(kind, known)?;
            if known.value.is_none() || known.observed_at > point.observed_at {
                return Err("invalid last-known metric observation".into());
            }
        }
        if point.value.is_some() && known.as_ref() != Some(&point) {
            return Err("numeric latest metric disagrees with its last-known observation".into());
        }
        if let Some(at) = row.get::<_, Option<i64>>(4).map_err(error)? {
            validate_time(at)?;
        }
        if let Some(pending) = row.get::<_, Option<String>>(5).map_err(error)? {
            let pending = decode_envelope(&pending)?;
            validate_envelope_kind(kind, &pending)?;
            if pending.last.observed_at > point.observed_at {
                return Err("pending metrics exceed their latest observation".into());
            }
        }
    }
    let mut samples = db.prepare("SELECT p.id,s.kind,p.start_at,p.end_at,p.envelope FROM metric_samples p JOIN metric_series s ON s.id=p.series_id").map_err(error)?;
    let mut rows = samples.query([]).map_err(error)?;
    while let Some(row) = rows.next().map_err(error)? {
        check_time()?;
        if row.get::<_, i64>(0).map_err(error)? <= 0 {
            return Err("invalid metric sample identity".into());
        }
        let kind = parse_kind(&row.get::<_, String>(1).map_err(error)?)?;
        let envelope = decode_envelope(&row.get::<_, String>(4).map_err(error)?)?;
        validate_envelope_kind(kind, &envelope)?;
        if row.get::<_, i64>(2).map_err(error)? != envelope.first.observed_at
            || row.get::<_, i64>(3).map_err(error)? != envelope.last.observed_at
        {
            return Err("metric sample range disagrees with its envelope".into());
        }
    }
    Ok(())
}

fn validate_envelope_kind(kind: Kind, envelope: &Envelope) -> Result<()> {
    for point in [&envelope.first, &envelope.last]
        .into_iter()
        .chain(envelope.minimum.as_ref())
        .chain(envelope.maximum.as_ref())
    {
        validate_point_kind(kind, point)?;
    }
    Ok(())
}

fn select_samples(tx: &Transaction<'_>, query: &Query, cursor: &Cursor) -> Result<Vec<Sample>> {
    let series = &query.series;
    let from = query.from;
    let to = query.to;
    let after_id = cursor.after_id;
    let upper_id = cursor.upper_id;
    let resolution = query.resolution_secs;
    let series_json = encode(series)?;
    let (source, import_origin) = match &query.scope {
        Scope::All => (None, None),
        Scope::RecordedHere { source_instance } => (Some(source_instance.as_str()), None),
        Scope::SinceImport { origin_id } => (None, Some(origin_id.as_str())),
    };
    let select = if resolution.is_some() {
        "max(p.id),s.entity,s.metric,s.kind,o.id,o.source_instance,o.imported_at,
         metric_envelope(p.envelope ORDER BY p.start_at,p.id)"
    } else {
        "p.id,s.entity,s.metric,s.kind,o.id,o.source_instance,o.imported_at,p.envelope"
    };
    let after = if resolution.is_some() {
        ""
    } else if query.descending {
        "AND (:after=0 OR p.id<:after)"
    } else {
        "AND p.id>:after"
    };
    let group = if resolution.is_some() && query.descending {
        "GROUP BY s.id,o.id,p.start_at/:resolution HAVING :after=0 OR max(p.id)<:after"
    } else if resolution.is_some() {
        "GROUP BY s.id,o.id,p.start_at/:resolution HAVING max(p.id)>:after"
    } else {
        ""
    };
    let order = if query.descending { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT {select}
         FROM json_each(:series) j
         JOIN metric_series s ON (s.entity=json_extract(j.value,'$.entity') OR (:all_agents=1 AND s.entity GLOB 'agent:[0-9]*'))
              AND s.metric=json_extract(j.value,'$.metric')
              AND s.kind=json_extract(j.value,'$.kind')
         JOIN metric_samples p ON p.series_id=s.id
         JOIN metric_origins o ON o.id=p.origin_id
         WHERE p.id<=:upper AND p.end_at>=:from AND p.start_at<:to {after}
         AND (:source IS NULL OR o.source_instance=:source)
         AND (:import_origin IS NULL OR o.id=:import_origin)
         {group} ORDER BY 1 {order} LIMIT :limit"
    );
    let mut stmt = tx.prepare(&sql).map_err(error)?;
    let resolution_parameter = resolution.map_or(0, i64::from);
    let sql_limit = (query.limit + 1) as i64;
    let all_agents = query.all_agents;
    let named = [
        (":after", &after_id as &dyn rusqlite::ToSql),
        (":upper", &upper_id),
        (":from", &from),
        (":to", &to),
        (":source", &source),
        (":import_origin", &import_origin),
        (":series", &series_json),
        (":limit", &sql_limit),
        (":all_agents", &all_agents),
    ];
    for (name, value) in named {
        let index = stmt.parameter_index(name).map_err(error)?.unwrap();
        stmt.raw_bind_parameter(index, value).map_err(error)?;
    }
    if resolution.is_some() {
        let index = stmt.parameter_index(":resolution").map_err(error)?.unwrap();
        stmt.raw_bind_parameter(index, resolution_parameter)
            .map_err(error)?;
    }
    let mut rows = stmt.raw_query();
    let mut result: Vec<Sample> = Vec::new();
    while let Some(row) = rows.next().map_err(error)? {
        let envelope = decode_envelope(&row.get::<_, String>(7).map_err(error)?)?;
        let series = Series {
            entity: row.get(1).map_err(error)?,
            metric: row.get(2).map_err(error)?,
            kind: parse_kind(&row.get::<_, String>(3).map_err(error)?)?,
        };
        let origin = origin_row(row, 4).map_err(error)?;
        let id = row.get(0).map_err(error)?;
        let crosses_range = envelope.first.observed_at < from || envelope.last.observed_at >= to;
        result.push(Sample {
            id,
            series,
            origin,
            envelope,
            crosses_range,
        });
    }
    if let Some(resolution) = resolution {
        for sample in &mut result {
            sample.envelope.resolution_secs = sample.envelope.resolution_secs.max(resolution);
        }
    }
    Ok(result)
}

fn downsample_plan(
    db: &Connection,
    selection: &Selection,
    resolution: u32,
) -> Result<DownsampleResult> {
    let mut result = DownsampleResult::default();
    for series in &selection.series {
        let Some(id) = series_id(db, series)? else {
            continue;
        };
        let incompatible: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM metric_samples WHERE series_id=? AND start_at>=? AND end_at<?
             AND json_extract(envelope,'$.resolution_secs')>0
             AND (?%json_extract(envelope,'$.resolution_secs'))<>0)",
            params![id, selection.from, selection.to, resolution],
            |row| row.get(0),
        ).map_err(error)?;
        if incompatible {
            return Err("resolution must be a multiple of existing downsampled resolution; discarded detail cannot be recovered".into());
        }
        let (before, after): (i64,i64) = db.query_row(
            "SELECT coalesce(sum(n),0),count(*) FROM
             (SELECT count(*) AS n FROM metric_samples WHERE series_id=? AND start_at>=? AND end_at<?
              GROUP BY origin_id,start_at/?)",
            params![id,selection.from,selection.to,resolution],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).map_err(error)?;
        let boundary: i64 = db
            .query_row(
                "SELECT count(*) FROM metric_samples WHERE series_id=? AND end_at>=? AND start_at<?
             AND (start_at<? OR end_at>=?)",
                params![
                    id,
                    selection.from,
                    selection.to,
                    selection.from,
                    selection.to
                ],
                |row| row.get(0),
            )
            .map_err(error)?;
        result.before += u64::try_from(before).map_err(error)?;
        result.after += u64::try_from(after).map_err(error)?;
        result.skipped_boundary += u64::try_from(boundary).map_err(error)?;
    }
    Ok(result)
}

fn read_bucket(
    tx: &Transaction<'_>,
    series_id: i64,
    origin: &str,
    from: i64,
    to: i64,
    resolution: u32,
    bucket: i64,
) -> Result<(u64, Envelope)> {
    let mut stmt = tx
        .prepare(
            "SELECT id,envelope FROM metric_samples WHERE series_id=? AND origin_id=?
             AND start_at>=? AND end_at<? AND start_at/?=? ORDER BY start_at,id",
        )
        .map_err(error)?;
    let mut rows = stmt
        .query(params![series_id, origin, from, to, resolution, bucket])
        .map_err(error)?;
    let mut count = 0;
    let mut combined: Option<Envelope> = None;
    while let Some(row) = rows.next().map_err(error)? {
        count += 1;
        let envelope = decode_envelope(&row.get::<_, String>(1).map_err(error)?)?;
        if let Some(combined) = &mut combined {
            combined.merge(envelope)?;
        } else {
            combined = Some(envelope);
        }
    }
    Ok((count, combined.ok_or("metrics bucket disappeared")?))
}

fn ensure_origin(tx: &Transaction<'_>, origin: &Origin) -> Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO metric_origins(id,source_instance,imported_at) VALUES(?,?,?)",
        params![origin.id, origin.source_instance, origin.imported_at],
    )
    .map_err(error)?;
    let stored = tx
        .query_row(
            "SELECT id,source_instance,imported_at FROM metric_origins WHERE id=?",
            [&origin.id],
            |row| origin_row(row, 0),
        )
        .map_err(error)?;
    if stored != *origin {
        return Err("metrics origin identity cannot be silently changed".into());
    }
    Ok(())
}

fn ensure_series(tx: &Transaction<'_>, series: &Series) -> Result<i64> {
    tx.execute(
        "INSERT OR IGNORE INTO metric_series(entity,metric,kind) VALUES(?,?,?)",
        params![series.entity, series.metric, kind_name(series.kind)],
    )
    .map_err(error)?;
    series_id(tx, series)?.ok_or_else(|| "metric kind cannot change within a series".into())
}

fn series_id(tx: &Connection, series: &Series) -> Result<Option<i64>> {
    tx.query_row(
        "SELECT id FROM metric_series WHERE entity=? AND metric=? AND kind=?",
        params![series.entity, series.metric, kind_name(series.kind)],
        |row| row.get(0),
    )
    .optional()
    .map_err(error)
}

fn insert_sample(
    tx: &Transaction<'_>,
    series_id: i64,
    origin: &str,
    envelope: &Envelope,
) -> Result<()> {
    tx.execute(
        "INSERT INTO metric_samples(series_id,origin_id,start_at,end_at,envelope)
         VALUES(?,?,?,?,?)",
        params![
            series_id,
            origin,
            envelope.first.observed_at,
            envelope.last.observed_at,
            encode(envelope)?
        ],
    )
    .map_err(error)?;
    Ok(())
}

fn origin_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Origin> {
    Ok(Origin {
        id: row.get(offset)?,
        source_instance: row.get(offset + 1)?,
        imported_at: row.get(offset + 2)?,
    })
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
        return Err("metric identifiers must be 1–512 bytes without control characters".into());
    }
    Ok(())
}

fn validate_series(series: &Series) -> Result<()> {
    validate_id(&series.entity)?;
    validate_id(&series.metric)
}

fn validate_origin(origin: &Origin) -> Result<()> {
    validate_id(&origin.id)?;
    validate_id(&origin.source_instance)?;
    if let Some(at) = origin.imported_at {
        validate_time(at)?;
    }
    Ok(())
}

fn validate_point(series: &Series, point: &Point) -> Result<()> {
    validate_point_kind(series.kind, point)
}

fn validate_point_kind(kind: Kind, point: &Point) -> Result<()> {
    validate_time(point.observed_at)?;
    if let Some(value) = &point.value {
        if point
            .value_observed_at
            .is_none_or(|at| at < 0 || at > point.observed_at)
        {
            return Err(
                "numeric metrics need an observation timestamp no newer than their state".into(),
            );
        }
        if value.kind() != kind {
            return Err("metric value has the wrong kind".into());
        }
        if matches!(value, Number::Gauge(value) if !value.is_finite()) {
            return Err("metric gauges must be finite".into());
        }
        if point.quality == Quality::Unknown {
            return Err("a numeric observation needs a known accounting quality".into());
        }
    } else if point.quality != Quality::Unknown {
        return Err("unavailable observations need unknown quality".into());
    } else if point.value_observed_at.is_some() {
        return Err("unavailable observations cannot claim a numeric observation timestamp".into());
    }
    Ok(())
}

fn validate_time(at: i64) -> Result<()> {
    if at < 0 {
        return Err("metric timestamps must be nonnegative Unix seconds".into());
    }
    Ok(())
}

pub fn validate_interval(interval: u32) -> Result<()> {
    if !(1..=MAX_INTERVAL_SECS).contains(&interval) {
        return Err(format!(
            "metrics sampling interval must be 1–{MAX_INTERVAL_SECS} seconds"
        ));
    }
    Ok(())
}

fn validate_resolution(resolution: u32) -> Result<()> {
    if !(1..=31_536_000).contains(&resolution) {
        return Err("metrics resolution must be 1–31536000 seconds".into());
    }
    Ok(())
}

fn validate_limit(limit: usize) -> Result<()> {
    if !(1..=MAX_PAGE).contains(&limit) {
        return Err(format!("metrics page limit must be 1–{MAX_PAGE}"));
    }
    Ok(())
}

fn validate_selection(series: &[Series], from: i64, to: i64) -> Result<()> {
    validate_time(from)?;
    if to <= from {
        return Err("metrics range must have to greater than from".into());
    }
    if series.is_empty() || series.len() > 32 {
        return Err("select 1–32 metric series".into());
    }
    let mut keys = BTreeSet::new();
    for series in series {
        validate_series(series)?;
        if !keys.insert((&series.entity, &series.metric)) {
            return Err("duplicate selected metric series".into());
        }
    }
    Ok(())
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Counter => "counter",
        Kind::Gauge => "gauge",
    }
}

fn parse_kind(kind: &str) -> Result<Kind> {
    match kind {
        "counter" => Ok(Kind::Counter),
        "gauge" => Ok(Kind::Gauge),
        _ => Err("unknown stored metric kind".into()),
    }
}

fn encode<T: Serialize + ?Sized>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(error)
}

fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(error)
}

fn decode_envelope(value: &str) -> Result<Envelope> {
    let envelope: Envelope = decode(value)?;
    envelope.validate()?;
    Ok(envelope)
}

fn sql_function_error(message: String) -> rusqlite::Error {
    rusqlite::Error::UserFunctionError(Box::new(std::io::Error::other(message)))
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics() -> Metrics {
        Metrics::memory().unwrap()
    }

    fn origin() -> Origin {
        Origin {
            id: "segment-a".into(),
            source_instance: "installation-a".into(),
            imported_at: None,
        }
    }

    fn series() -> Series {
        Series {
            entity: "agent:1".into(),
            metric: "total_tokens".into(),
            kind: Kind::Counter,
        }
    }

    fn observation(at: i64, value: Option<u64>) -> Observation {
        Observation {
            series: series(),
            point: Point {
                observed_at: at,
                value_observed_at: value.map(|_| at),
                value: value.map(Number::Counter),
                quality: if value.is_some() {
                    Quality::Provisional
                } else {
                    Quality::Unknown
                },
            },
            correction: false,
            coverage_gap: false,
        }
    }

    fn query() -> Query {
        Query {
            series: vec![series()],
            all_agents: false,
            descending: false,
            from: 0,
            to: 1_000,
            scope: Scope::All,
            limit: 100,
            resolution_secs: None,
            cursor: None,
        }
    }

    fn put(metrics: &mut Metrics, at: i64, value: Option<u64>) {
        metrics
            .record(&origin(), &[observation(at, value)], at, 5, false)
            .unwrap();
    }

    #[test]
    fn unchanged_reports_refresh_evidence_without_new_history() {
        let mut metrics = metrics();
        put(&mut metrics, 10, Some(100));
        put(&mut metrics, 40, Some(100));
        let latest = metrics.latest(&series(), 10, None).unwrap().items.remove(0);
        assert_eq!(latest.point.observed_at, 40);
        assert_eq!(latest.changed_at, 10);
        assert_eq!(latest.last_sampled_at, Some(10));
        assert!(!latest.pending);
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 1);
    }

    #[test]
    fn latest_keeps_last_numeric_evidence_through_an_unknown_gap() {
        let mut metrics = metrics();
        put(&mut metrics, 10, Some(7));
        put(&mut metrics, 20, None);
        let page = metrics.latest(&series(), 10, None).unwrap();
        let latest = &page.items[0];
        assert!(latest.point.value.is_none());
        assert_eq!(latest.point.observed_at, 20);
        let known = latest.last_known.as_ref().unwrap();
        assert_eq!(known.value, Some(Number::Counter(7)));
        assert_eq!(known.value_observed_at, Some(10));
    }

    #[test]
    fn sampling_retains_intermediate_extrema_and_real_observation_time() {
        let mut metrics = metrics();
        put(&mut metrics, 10, Some(100));
        put(&mut metrics, 11, Some(150));
        put(&mut metrics, 12, Some(120));
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 1);
        assert_eq!(metrics.flush(14, 5).unwrap(), 0);
        assert_eq!(metrics.flush(20, 5).unwrap(), 1);
        let page = metrics.query(&query()).unwrap();
        let envelope = &page.items[1].envelope;
        assert_eq!(envelope.first.observed_at, 11);
        assert_eq!(envelope.last.observed_at, 12);
        assert_eq!(envelope.sampled_at, 20);
        assert_eq!(
            envelope.maximum.as_ref().unwrap().value,
            Some(Number::Counter(150))
        );
        assert!(envelope.has_correction);
        assert_eq!(envelope.observations, 2);
    }

    #[test]
    fn null_zero_quality_and_checkpoint_remain_distinct() {
        let mut metrics = metrics();
        put(&mut metrics, 10, None);
        put(&mut metrics, 11, Some(0));
        let mut final_report = observation(12, Some(0));
        final_report.point.quality = Quality::Final;
        metrics
            .record(&origin(), &[final_report], 12, 5, true)
            .unwrap();
        let page = metrics.query(&query()).unwrap();
        assert_eq!(page.items.len(), 2);
        assert!(page.items[0].envelope.has_gap);
        let final_sample = &page.items[1].envelope;
        assert!(final_sample.checkpoint);
        assert_eq!(final_sample.last.value, Some(Number::Counter(0)));
        assert_eq!(final_sample.last.quality, Quality::Final);
        assert!(final_sample.qualities.contains(&Quality::Provisional));
        assert!(final_sample.qualities.contains(&Quality::Final));
    }

    #[test]
    fn counts_are_exact_above_javascript_integer_precision() {
        let mut metrics = metrics();
        put(&mut metrics, 10, Some(u64::MAX - 1));
        put(&mut metrics, 20, Some(u64::MAX));
        let page = metrics.query(&query()).unwrap();
        assert_eq!(
            page.items[1].envelope.last.value,
            Some(Number::Counter(u64::MAX))
        );
        metrics
            .downsample(
                &Selection {
                    series: vec![series()],
                    from: 0,
                    to: 100,
                },
                60,
            )
            .unwrap();
        let page = metrics.query(&query()).unwrap();
        assert_eq!(
            page.items[0].envelope.minimum.as_ref().unwrap().value,
            Some(Number::Counter(u64::MAX - 1))
        );
        assert_eq!(
            page.items[0].envelope.maximum.as_ref().unwrap().value,
            Some(Number::Counter(u64::MAX))
        );
    }

    #[test]
    fn rejected_batches_have_no_side_effects_and_stale_reports_are_ignored() {
        let mut metrics = metrics();
        let mut bad = observation(11, Some(1));
        bad.series.kind = Kind::Gauge;
        assert!(
            metrics
                .record(&origin(), &[observation(10, Some(100)), bad], 20, 5, false)
                .is_err()
        );
        assert!(
            metrics
                .latest(&series(), 10, None)
                .unwrap()
                .items
                .is_empty()
        );
        put(&mut metrics, 20, Some(100));
        let result = metrics
            .record(&origin(), &[observation(10, Some(50))], 21, 5, false)
            .unwrap();
        assert_eq!(result.stale, 1);
        assert_eq!(result.observed, 0);
        assert_eq!(
            metrics.latest(&series(), 10, None).unwrap().items[0]
                .point
                .value,
            Some(Number::Counter(100))
        );
    }

    #[test]
    fn origins_and_kind_cannot_be_reassigned() {
        let mut metrics = metrics();
        put(&mut metrics, 10, Some(1));
        let mut changed_origin = origin();
        changed_origin.source_instance = "other".into();
        assert!(
            metrics
                .record(&changed_origin, &[observation(20, Some(2))], 20, 5, false)
                .is_err()
        );
        let mut changed_kind = observation(20, Some(2));
        changed_kind.series.kind = Kind::Gauge;
        changed_kind.point.value = Some(Number::Gauge(2.0));
        assert!(
            metrics
                .record(&origin(), &[changed_kind], 20, 5, false)
                .is_err()
        );
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 1);
    }

    #[test]
    fn origin_scopes_do_not_treat_imported_history_as_local_work() {
        let mut metrics = metrics();
        let mut imported = origin();
        imported.id = "foreign-segment".into();
        imported.source_instance = "other-installation".into();
        imported.imported_at = Some(50);
        metrics
            .record(&imported, &[observation(10, Some(100))], 50, 5, false)
            .unwrap();
        put(&mut metrics, 60, Some(20));
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 2);
        let mut here = query();
        here.scope = Scope::RecordedHere {
            source_instance: "installation-a".into(),
        };
        assert_eq!(metrics.query(&here).unwrap().items.len(), 1);
        let mut since = query();
        since.scope = Scope::SinceImport {
            origin_id: origin().id,
        };
        let items = metrics.query(&since).unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].origin.source_instance, "installation-a");
    }

    #[test]
    fn since_import_uses_origin_identity_not_future_or_same_second_timestamps() {
        let mut metrics = metrics();
        let mut archived = origin();
        archived.id = "archived".into();
        archived.imported_at = Some(50);
        metrics
            .record(&archived, &[observation(500, Some(999))], 500, 5, false)
            .unwrap();
        let current = Origin {
            id: "current".into(),
            ..archived.clone()
        };
        metrics
            .record(&current, &[observation(50, Some(10))], 500, 5, false)
            .unwrap();
        let mut q = query();
        q.scope = Scope::SinceImport {
            origin_id: current.id.clone(),
        };
        let page = metrics.query(&q).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].origin.id, current.id);
    }

    #[test]
    fn appended_samples_do_not_break_snapshot_paging_or_duplicate_items() {
        let mut metrics = metrics();
        for at in [10, 20, 30] {
            put(&mut metrics, at, Some(at as u64));
        }
        let mut q = query();
        q.limit = 1;
        let first = metrics.query(&q).unwrap();
        put(&mut metrics, 40, Some(40));
        q.cursor = first.next;
        let second = metrics.query(&q).unwrap();
        q.cursor = second.next;
        let third = metrics.query(&q).unwrap();
        assert!(third.next.is_none());
        assert_eq!(
            [first.items[0].id, second.items[0].id, third.items[0].id],
            [1, 2, 3]
        );
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 4);
    }

    #[test]
    fn changed_query_or_destructive_operation_invalidates_cursor() {
        let mut metrics = metrics();
        put(&mut metrics, 10, Some(10));
        put(&mut metrics, 20, Some(20));
        let mut q = query();
        q.limit = 1;
        q.cursor = metrics.query(&q).unwrap().next;
        let mut changed = q.clone();
        changed.from = 11;
        assert!(metrics.query(&changed).is_err());
        metrics
            .downsample(
                &Selection {
                    series: vec![series()],
                    from: 0,
                    to: 100,
                },
                60,
            )
            .unwrap();
        assert!(metrics.query(&q).is_err());
    }

    #[test]
    fn downsampling_preserves_extrema_endpoints_gaps_and_quality() {
        let mut metrics = metrics();
        for (at, value) in [
            (10, Some(100)),
            (20, Some(200)),
            (30, None),
            (40, Some(150)),
            (50, Some(175)),
        ] {
            put(&mut metrics, at, value);
        }
        let before = metrics.latest(&series(), 10, None).unwrap();
        let result = metrics
            .downsample(
                &Selection {
                    series: vec![series()],
                    from: 0,
                    to: 60,
                },
                60,
            )
            .unwrap();
        assert_eq!(
            result,
            DownsampleResult {
                before: 5,
                after: 1,
                skipped_boundary: 0
            }
        );
        let page = metrics.query(&query()).unwrap();
        let envelope = &page.items[0].envelope;
        assert_eq!(envelope.first.observed_at, 10);
        assert_eq!(envelope.last.observed_at, 50);
        assert_eq!(envelope.minimum.as_ref().unwrap().observed_at, 10);
        assert_eq!(envelope.maximum.as_ref().unwrap().observed_at, 20);
        assert!(envelope.has_gap);
        assert!(envelope.has_correction);
        assert_eq!(envelope.resolution_secs, 60);
        assert_eq!(before, metrics.latest(&series(), 10, None).unwrap());
        assert!(
            metrics
                .downsample(
                    &Selection {
                        series: vec![series()],
                        from: 0,
                        to: 60
                    },
                    30
                )
                .is_err()
        );
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 1);
    }

    #[test]
    fn coarse_queries_report_envelopes_crossing_requested_boundaries() {
        let mut metrics = metrics();
        for at in [10, 20, 30, 70] {
            put(&mut metrics, at, Some(at as u64));
        }
        let mut q = query();
        q.resolution_secs = Some(60);
        assert_eq!(metrics.query(&q).unwrap().items.len(), 2);
        metrics
            .downsample(
                &Selection {
                    series: vec![series()],
                    from: 0,
                    to: 60,
                },
                60,
            )
            .unwrap();
        q.from = 15;
        q.to = 25;
        let page = metrics.query(&q).unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.items[0].crosses_range);
        assert_eq!(page.items[0].envelope.first.observed_at, 10);
        assert_eq!(page.items[0].envelope.last.observed_at, 30);
    }

    #[test]
    fn clear_only_removes_optional_metrics_and_restarts_cleanly() {
        let mut metrics = metrics();
        put(&mut metrics, 10, Some(99));
        metrics.clear().unwrap();
        assert!(metrics.query(&query()).unwrap().items.is_empty());
        assert!(
            metrics
                .latest(&series(), 10, None)
                .unwrap()
                .items
                .is_empty()
        );
        put(&mut metrics, 20, Some(100));
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 1);
    }

    #[test]
    fn coarsened_paging_keeps_whole_interleaved_origin_buckets() {
        let mut metrics = metrics();
        let mut other = origin();
        other.id = "segment-b".into();
        put(&mut metrics, 10, Some(10));
        metrics
            .record(&other, &[observation(20, Some(20))], 20, 5, false)
            .unwrap();
        metrics
            .record(&other, &[observation(30, Some(30))], 30, 5, false)
            .unwrap();
        put(&mut metrics, 40, Some(40));
        let mut q = query();
        q.resolution_secs = Some(60);
        q.limit = 1;
        let first = metrics.query(&q).unwrap();
        assert_eq!(first.items[0].origin.id, "segment-b");
        assert_eq!(first.items[0].envelope.first.observed_at, 20);
        assert_eq!(first.items[0].envelope.last.observed_at, 30);
        // Append to a bucket after the cursor's snapshot; it must not leak into this scan.
        metrics
            .record(&other, &[observation(50, Some(50))], 50, 5, false)
            .unwrap();
        q.cursor = first.next;
        let second = metrics.query(&q).unwrap();
        assert_eq!(second.items[0].origin.id, "segment-a");
        assert_eq!(second.items[0].envelope.first.observed_at, 10);
        assert_eq!(second.items[0].envelope.last.observed_at, 40);
        assert!(second.next.is_none());
    }

    #[test]
    fn downsample_preview_is_read_only_and_respects_metric_selection_and_edges() {
        let mut metrics = metrics();
        for at in [10, 20, 30] {
            let mut other = observation(at, Some(at as u64));
            other.series.metric = "output".into();
            metrics
                .record(
                    &origin(),
                    &[observation(at, Some(at as u64)), other],
                    at,
                    5,
                    false,
                )
                .unwrap();
        }
        let selection = Selection {
            series: vec![series()],
            from: 0,
            to: 60,
        };
        let preview = metrics.preview_downsample(&selection, 60).unwrap();
        assert_eq!(preview.before, 3);
        assert_eq!(preview.after, 1);
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 3);
        assert_eq!(metrics.downsample(&selection, 60).unwrap(), preview);
        let mut output = query();
        output.series[0].metric = "output".into();
        assert_eq!(metrics.query(&output).unwrap().items.len(), 3);
        let edges = metrics
            .preview_downsample(
                &Selection {
                    series: vec![series()],
                    from: 15,
                    to: 25,
                },
                120,
            )
            .unwrap();
        assert_eq!(edges.before, 0);
        assert_eq!(edges.after, 0);
        assert_eq!(edges.skipped_boundary, 1);
        assert!(metrics.downsample(&selection, 90).is_err());
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 1);
    }

    #[test]
    fn freshness_pages_have_explicit_continuation() {
        let mut metrics = metrics();
        for id in ["a", "b", "c"] {
            let mut source = origin();
            source.id = id.into();
            metrics
                .record(&source, &[observation(10, Some(1))], 10, 5, false)
                .unwrap();
        }
        let first = metrics.latest(&series(), 2, None).unwrap();
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.next.as_deref(), Some("b"));
        let second = metrics.latest(&series(), 2, first.next.as_deref()).unwrap();
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].origin.id, "c");
        assert!(second.next.is_none());
    }

    #[test]
    fn byte_limited_pages_preserve_every_envelope_once() {
        let mut metrics = metrics();
        for at in (10..=300).step_by(10) {
            put(&mut metrics, at, Some(at as u64));
        }
        let mut q = query();
        let mut ids = Vec::new();
        loop {
            let page = metrics.query_bounded(&q, 2048).unwrap();
            assert!(serde_json::to_string(&page).unwrap().len() <= 2048);
            ids.extend(page.items.iter().map(|item| item.id));
            q.cursor = page.next;
            if q.cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids, (1..=30).collect::<Vec<_>>());
        assert!(metrics.query_bounded(&query(), 512).is_err());
    }

    #[test]
    fn descending_and_all_agent_pages_remain_snapshot_bound() {
        let mut metrics = metrics();
        for at in [10, 20, 30] {
            let first = observation(at, Some(at as u64));
            let mut second = first.clone();
            second.series.entity = "agent:2".into();
            metrics
                .record(&origin(), &[first, second], at, 5, false)
                .unwrap();
        }
        let mut q = query();
        q.all_agents = true;
        q.series[0].entity = "agent:*".into();
        q.descending = true;
        q.limit = 2;
        let first = metrics.query_bounded(&q, 4096).unwrap();
        assert_eq!(
            first
                .items
                .iter()
                .map(|sample| sample.id)
                .collect::<Vec<_>>(),
            vec![6, 5]
        );
        q.cursor = first.next;
        put(&mut metrics, 40, Some(40));
        let mut ids = vec![6, 5];
        while q.cursor.is_some() {
            let page = metrics.query_bounded(&q, 4096).unwrap();
            ids.extend(page.items.iter().map(|sample| sample.id));
            q.cursor = page.next;
        }
        assert_eq!(ids, vec![6, 5, 4, 3, 2, 1]);
        q.cursor = None;
        q.resolution_secs = Some(60);
        q.limit = 1;
        let first = metrics.query(&q).unwrap();
        assert_eq!(first.items.len(), 1);
        q.cursor = first.next;
        let last = metrics.query(&q).unwrap();
        assert_eq!(last.items.len(), 1);
        assert_ne!(first.items[0].series.entity, last.items[0].series.entity);
    }

    #[test]
    fn wildcard_maintenance_applies_to_all_selected_agent_series_only() {
        let mut metrics = metrics();
        for at in [10, 20] {
            let mut rows = Vec::new();
            for entity in ["agent:1", "agent:2"] {
                let mut item = observation(at, Some(at as u64));
                item.series.entity = entity.into();
                rows.push(item);
            }
            metrics.record(&origin(), &rows, at, 5, false).unwrap();
        }
        let selection = Selection {
            series: vec![Series {
                entity: "agent:*".into(),
                ..series()
            }],
            from: 0,
            to: 60,
        };
        assert_eq!(metrics.preview_downsample(&selection, 60).unwrap().after, 2);
        metrics.downsample(&selection, 60).unwrap();
        assert_eq!(metrics.preview_clear(&selection).unwrap().removed, 2);
        metrics.clear_history(&selection).unwrap();
        assert!(metrics.query(&query()).unwrap().items.is_empty());
    }

    #[test]
    fn snapshot_validation_rejects_added_triggers_without_mutating_the_snapshot() {
        let directory = temporary_directory();
        let path = directory.join("metrics.db");
        let metrics = Metrics::open(&path).unwrap();
        Metrics::validate_snapshot(&path).unwrap();
        metrics.db.execute_batch("CREATE TRIGGER extra_trigger AFTER INSERT ON metric_samples BEGIN DELETE FROM metric_samples; END;").unwrap();
        drop(metrics);
        let before = std::fs::read(&path).unwrap();
        assert!(Metrics::validate_snapshot(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn snapshot_validation_rejects_corrupt_typed_rows_and_references() {
        for corruption in [
            "UPDATE metric_samples SET envelope='{}'",
            "UPDATE metric_latest SET point='{}'",
            "UPDATE metric_latest SET last_known='{}'",
            "UPDATE metric_latest SET pending='{}'",
            "UPDATE metric_samples SET envelope=json_set(envelope,'$.unexpected',true)",
            "UPDATE metric_samples SET start_at=start_at+1",
            "UPDATE metric_samples SET envelope=json_set(envelope,'$.first.value.kind','gauge')",
            "UPDATE metric_series SET kind='gauge'",
            "UPDATE metric_series SET kind='unknown'",
            "UPDATE metric_series SET id=-1",
            "UPDATE metric_origins SET imported_at=-1",
            "UPDATE metric_latest SET changed_at=-1",
            "UPDATE metric_latest SET point=CAST(point AS BLOB)",
            "UPDATE metric_latest SET point=printf('%070000d',0)",
            "UPDATE metric_latest SET last_known=NULL",
            "UPDATE metric_latest SET point=json_set(point,'$.value.value','00100')",
            "UPDATE metric_latest SET pending=json_set((SELECT envelope FROM metric_samples LIMIT 1),'$.last.observed_at',20,'$.sampled_at',20)",
            "UPDATE metric_meta SET epoch=0.5",
            "UPDATE metric_samples SET series_id=999",
            "UPDATE metric_latest SET origin_id='missing'",
        ] {
            let directory = temporary_directory();
            let path = directory.join("metrics.db");
            let mut metrics = Metrics::open(&path).unwrap();
            put(&mut metrics, 10, Some(100));
            metrics.db.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
            metrics.db.execute_batch(corruption).unwrap();
            drop(metrics);
            let before = std::fs::read(&path).unwrap();
            assert!(
                Metrics::validate_snapshot(&path).is_err(),
                "accepted corruption: {corruption}"
            );
            assert_eq!(std::fs::read(&path).unwrap(), before);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn snapshot_validation_accepts_real_pending_corrected_and_maintained_history() {
        let directory = temporary_directory();
        let path = directory.join("metrics.db");
        let mut metrics = Metrics::open(&path).unwrap();
        put(&mut metrics, 10, Some(100));
        put(&mut metrics, 11, None);
        put(&mut metrics, 12, Some(90));
        Metrics::validate_snapshot(&path).unwrap();
        metrics.flush(20, 5).unwrap();
        let other_origin = Origin {
            id: "imported-segment".into(),
            source_instance: "other-installation".into(),
            imported_at: Some(20),
        };
        metrics
            .record(&other_origin, &[observation(21, Some(120))], 25, 5, true)
            .unwrap();
        let mut gauge = observation(26, None);
        gauge.series = Series {
            entity: "account:claude:five_hour".into(),
            metric: "usage_pct".into(),
            kind: Kind::Gauge,
        };
        metrics
            .record(&origin(), &[gauge.clone()], 26, 5, true)
            .unwrap();
        gauge.point = Point {
            observed_at: 27,
            value_observed_at: Some(27),
            value: Some(Number::Gauge(75.0)),
            quality: Quality::Final,
        };
        metrics.record(&origin(), &[gauge], 28, 5, true).unwrap();
        Metrics::validate_snapshot(&path).unwrap();
        let selection = Selection {
            series: vec![series()],
            from: 0,
            to: 60,
        };
        metrics.downsample(&selection, 60).unwrap();
        Metrics::validate_snapshot(&path).unwrap();
        metrics.clear_history(&selection).unwrap();
        Metrics::validate_snapshot(&path).unwrap();
        drop(metrics);
        Metrics::open(&path).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn clearing_selected_history_does_not_resurrect_unchanged_observations() {
        let mut metrics = metrics();
        for at in [10, 20, 30] {
            put(&mut metrics, at, Some(at as u64));
        }
        let selection = Selection {
            series: vec![series()],
            from: 15,
            to: 25,
        };
        let preview = metrics.preview_clear(&selection).unwrap();
        assert_eq!(preview.removed, 1);
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 3);
        assert_eq!(metrics.clear_history(&selection).unwrap(), preview);
        let all = Selection {
            series: vec![series()],
            from: 0,
            to: 1000,
        };
        metrics.clear_history(&all).unwrap();
        metrics
            .record(&origin(), &[observation(40, Some(30))], 40, 5, false)
            .unwrap();
        metrics.flush(50, 5).unwrap();
        assert!(metrics.query(&query()).unwrap().items.is_empty());
        assert_eq!(
            metrics.latest(&series(), 1, None).unwrap().items[0]
                .point
                .observed_at,
            40
        );
        metrics
            .record(&origin(), &[observation(60, Some(31))], 60, 5, false)
            .unwrap();
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 1);
    }

    #[test]
    fn catalog_accepts_raw_window_names_and_readers_do_not_create_files() {
        let directory = temporary_directory();
        let path = directory.join("metrics.db");
        assert!(Metrics::read_only(&path).is_err());
        assert!(!path.exists());
        let mut metrics = Metrics::open(&path).unwrap();
        let mut usage = observation(10, Some(1));
        usage.series.entity = "account:codex:codex primary".into();
        metrics.record(&origin(), &[usage], 10, 5, false).unwrap();
        let reader = Metrics::read_only(&path).unwrap();
        let page = reader.series(None, 1, None).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].series.entity, "account:codex:codex primary");
        assert!(page.next.is_none());
        drop(reader);
        drop(metrics);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn invalid_limits_options_numbers_and_unknown_fields_are_rejected() {
        let mut metrics = metrics();
        for interval in [0, MAX_INTERVAL_SECS + 1] {
            assert!(
                metrics
                    .record(&origin(), &[observation(10, Some(1))], 10, interval, false)
                    .is_err()
            );
        }
        let mut future = observation(11, Some(1));
        assert!(
            metrics
                .record(&origin(), &[future.clone()], 10, 5, false)
                .is_err()
        );
        future.series.kind = Kind::Gauge;
        future.point.value = Some(Number::Gauge(f64::NAN));
        assert!(metrics.record(&origin(), &[future], 11, 5, false).is_err());
        for limit in [0, MAX_PAGE + 1] {
            let mut q = query();
            q.limit = limit;
            assert!(metrics.query(&q).is_err());
        }
        let mut q = query();
        q.to = q.from;
        assert!(metrics.query(&q).is_err());
        let mut q = query();
        q.resolution_secs = Some(0);
        assert!(metrics.query(&q).is_err());
        assert!(
            serde_json::from_value::<Series>(
                serde_json::json!({"entity":"a","metric":"b","kind":"counter","extra":true})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<Number>(serde_json::json!({"kind":"counter","value":"01"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<Number>(serde_json::json!({"kind":"counter","value":1}))
                .is_err()
        );
        assert!(metrics.query(&query()).unwrap().items.is_empty());
    }

    #[test]
    fn checkpoint_clock_does_not_claim_fresh_source_evidence() {
        let mut metrics = metrics();
        put(&mut metrics, 10, Some(100));
        metrics
            .record(&origin(), &[observation(10, Some(100))], 30, 5, true)
            .unwrap();
        let latest = metrics.latest(&series(), 1, None).unwrap();
        assert_eq!(latest.items[0].point.observed_at, 10);
        let samples = metrics.query(&query()).unwrap().items;
        assert_eq!(samples[1].envelope.last.observed_at, 10);
        assert_eq!(samples[1].envelope.sampled_at, 30);
        assert!(samples[1].envelope.checkpoint);
        assert_eq!(
            serde_json::to_value(Number::Counter(u64::MAX)).unwrap()["value"],
            u64::MAX.to_string()
        );
    }

    fn temporary_directory() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "acom-metrics-{}-{stamp}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn separate_file_reopens_pending_observations_and_reclaims_only_its_pages() {
        let directory = temporary_directory();
        let path = directory.join("metrics.db");
        let other = directory.join("core.db");
        let core = Connection::open(&other).unwrap();
        core.execute_batch("CREATE TABLE totals(value TEXT); INSERT INTO totals VALUES('123');")
            .unwrap();
        let mut metrics = Metrics::open(&path).unwrap();
        assert_eq!(DEFAULT_INTERVAL_SECS, 5);
        put(&mut metrics, 10, Some(100));
        put(&mut metrics, 11, Some(110));
        drop(metrics);
        let mut metrics = Metrics::open(&path).unwrap();
        assert!(metrics.latest(&series(), 1, None).unwrap().items[0].pending);
        assert_eq!(metrics.flush(20, 5).unwrap(), 1);
        assert_eq!(metrics.query(&query()).unwrap().items.len(), 2);
        metrics.clear().unwrap();
        metrics.reclaim_space().unwrap();
        assert_eq!(
            core.query_row("SELECT value FROM totals", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "123"
        );
        drop(metrics);
        drop(core);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn foreign_and_future_schema_are_rejected_without_altering_existing_data() {
        let directory = temporary_directory();
        let foreign = directory.join("foreign.db");
        let db = Connection::open(&foreign).unwrap();
        db.execute_batch(
            "CREATE TABLE private_state(value INTEGER);INSERT INTO private_state VALUES(42);",
        )
        .unwrap();
        drop(db);
        assert!(Metrics::open(&foreign).is_err());
        let db = Connection::open(&foreign).unwrap();
        assert_eq!(
            db.query_row("SELECT value FROM private_state", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            42
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name LIKE 'metric_%'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        drop(db);
        let future = directory.join("future.db");
        let metrics = Metrics::open(&future).unwrap();
        metrics
            .db
            .execute_batch("PRAGMA user_version=999;")
            .unwrap();
        drop(metrics);
        assert!(Metrics::open(&future).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupted_envelopes_fail_reads_without_panicking_or_mutating_history() {
        let mut metrics = metrics();
        put(&mut metrics, 10, Some(100));
        put(&mut metrics, 20, Some(200));
        let mut payload: Envelope = decode(
            &metrics
                .db
                .query_row(
                    "SELECT envelope FROM metric_samples WHERE id=2",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        payload.minimum.as_mut().unwrap().value = None;
        metrics
            .db
            .execute(
                "UPDATE metric_samples SET envelope=? WHERE id=2",
                [encode(&payload).unwrap()],
            )
            .unwrap();
        assert!(metrics.query(&query()).is_err());
        let mut coarse = query();
        coarse.resolution_secs = Some(60);
        assert!(metrics.query(&coarse).is_err());
        assert!(
            metrics
                .downsample(
                    &Selection {
                        series: vec![series()],
                        from: 0,
                        to: 60
                    },
                    60
                )
                .is_err()
        );
        assert_eq!(
            metrics
                .db
                .query_row("SELECT count(*) FROM metric_samples", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn cursor_cannot_be_reused_for_an_unrelated_metrics_store() {
        let mut a = metrics();
        let mut b = metrics();
        for at in [10, 20] {
            put(&mut a, at, Some(at as u64));
            put(&mut b, at, Some(at as u64));
        }
        let mut q = query();
        q.limit = 1;
        q.cursor = a.query(&q).unwrap().next;
        assert!(b.query(&q).is_err());
        assert!(a.query(&q).is_ok());
    }

    #[test]
    fn no_op_downsampling_preserves_existing_snapshot_cursors() {
        let mut metrics = metrics();
        for at in [10, 20, 70, 80] {
            put(&mut metrics, at, Some(at as u64));
        }
        let selection = Selection {
            series: vec![series()],
            from: 0,
            to: 100,
        };
        metrics.downsample(&selection, 60).unwrap();
        let mut q = query();
        q.limit = 1;
        q.cursor = metrics.query(&q).unwrap().next;
        let result = metrics.downsample(&selection, 60).unwrap();
        assert_eq!(result.before, 2);
        assert_eq!(result.after, 2);
        assert!(metrics.query(&q).is_ok());
    }

    #[test]
    #[ignore = "manual synthetic scale benchmark; no provider or live data"]
    fn metrics_scale_benchmark() {
        let mut metrics = metrics();
        let started = std::time::Instant::now();
        let series: Vec<_> = (1..=4)
            .map(|id| Series {
                entity: format!("agent:{id}"),
                metric: "total_tokens".into(),
                kind: Kind::Counter,
            })
            .collect();
        for i in 0..5_000 {
            let at = 100_000 + i * 5;
            let observations: Vec<_> = series
                .iter()
                .enumerate()
                .map(|(index, series)| Observation {
                    series: series.clone(),
                    point: Point {
                        observed_at: at,
                        value_observed_at: Some(at),
                        value: Some(Number::Counter((i as u64 + 1) * (index as u64 + 1))),
                        quality: Quality::Provisional,
                    },
                    correction: false,
                    coverage_gap: false,
                })
                .collect();
            metrics
                .record(&origin(), &observations, at, 5, false)
                .unwrap();
        }
        let recorded = started.elapsed();
        let mut q = Query {
            series: series.clone(),
            all_agents: false,
            descending: false,
            from: 100_000,
            to: 125_000,
            scope: Scope::All,
            limit: MAX_PAGE,
            resolution_secs: None,
            cursor: None,
        };
        let start = std::time::Instant::now();
        let raw = metrics.query(&q).unwrap();
        let raw_elapsed = start.elapsed();
        assert_eq!(raw.items.len(), MAX_PAGE);
        assert!(raw.next.is_some());
        q.resolution_secs = Some(300);
        let start = std::time::Instant::now();
        let coarse = metrics.query(&q).unwrap();
        let coarse_elapsed = start.elapsed();
        assert_eq!(coarse.items.len(), 336);
        assert!(coarse.next.is_none());
        let selection = Selection {
            series,
            from: 100_000,
            to: 125_000,
        };
        let start = std::time::Instant::now();
        let plan = metrics.preview_downsample(&selection, 300).unwrap();
        let plan_elapsed = start.elapsed();
        let start = std::time::Instant::now();
        let compacted = metrics.downsample(&selection, 300).unwrap();
        let compact_elapsed = start.elapsed();
        assert_eq!(compacted, plan);
        assert_eq!(compacted.before, 20_000);
        assert_eq!(compacted.after, 336);
        let start = std::time::Instant::now();
        let coarse_after = metrics.query(&q).unwrap();
        let after_elapsed = start.elapsed();
        assert_eq!(coarse_after.items.len(), coarse.items.len());
        println!(
            "20,000 samples / 4 series: record={recorded:?}; raw 2,000-point page={raw_elapsed:?}; 336-envelope query={coarse_elapsed:?}; preview={plan_elapsed:?}; explicit downsample={compact_elapsed:?}; compacted query={after_elapsed:?}"
        );
    }
}
