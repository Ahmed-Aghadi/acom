use super::*;
use crate::metrics::{self, Kind, Series};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

fn parameters(q: &Query, allowed: &[&str]) -> R<BTreeMap<String, String>> {
    let mut result = BTreeMap::new();
    for field in q.0.split('&').filter(|field| !field.is_empty()) {
        let (key, value) = field
            .split_once('=')
            .ok_or_else(|| bad("query parameters require name=value"))?;
        let key = strict_decode(key)?;
        if !allowed.contains(&key.as_str()) {
            return Err(bad(format!("unknown metrics query parameter {key:?}")));
        }
        if result.insert(key.clone(), strict_decode(value)?).is_some() {
            return Err(bad(format!("query parameter {key:?} must not repeat")));
        }
    }
    Ok(result)
}

fn integer(values: &BTreeMap<String, String>, key: &str, default: i64) -> R<i64> {
    values
        .get(key)
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| bad(format!("{key} must be an integer")))
        })
        .unwrap_or(Ok(default))
}

fn budget(values: &BTreeMap<String, String>) -> R<usize> {
    let value = integer(values, "max_bytes", 16000)?;
    if !(2048..=65536).contains(&value) {
        return Err(bad("metrics max_bytes must be 2048–65536"));
    }
    Ok(value as usize)
}

fn limit(values: &BTreeMap<String, String>, maximum: i64) -> R<usize> {
    let value = integer(values, "limit", 100)?;
    if !(1..=maximum).contains(&value) {
        return Err(bad(format!("limit must be 1–{maximum}")));
    }
    Ok(value as usize)
}

fn descending(values: &BTreeMap<String, String>) -> R<bool> {
    match values.get("order").map(String::as_str).unwrap_or("asc") {
        "asc" => Ok(false),
        "desc" => Ok(true),
        _ => Err(bad("order must be asc or desc")),
    }
}

fn series(entity: &str, metric: &str) -> R<Series> {
    let kind = match metric {
        "fresh_in" | "cache_write" | "cache_read" | "output" | "total_tokens" => Kind::Counter,
        "context_tokens" | "usage_pct" | "check_attempt_at" | "check_success_at" => Kind::Gauge,
        _ => return Err(bad(format!("unknown metric {metric:?}"))),
    };
    let valid = if let Some(agent) = entity.strip_prefix("agent:") {
        agent
            .parse::<i64>()
            .is_ok_and(|id| id > 0 && id.to_string() == agent)
            && metric != "usage_pct"
            && !metric.starts_with("check_")
    } else if let Some(account) = entity.strip_prefix("account:") {
        account.split_once(':').is_some_and(|(provider, window)| {
            matches!(provider, "claude" | "codex") && !window.is_empty()
        }) && metric == "usage_pct"
    } else {
        matches!(entity, "check:claude" | "check:codex") && metric.starts_with("check_")
    };
    if !valid {
        return Err(bad("metric and entity do not match"));
    }
    Ok(Series {
        entity: entity.into(),
        metric: metric.into(),
        kind,
    })
}

fn selection(values: &BTreeMap<String, String>) -> R<Vec<Series>> {
    let entity = values
        .get("entity")
        .ok_or_else(|| bad("entity is required"))?;
    let metrics = values
        .get("metric")
        .ok_or_else(|| bad("metric is required"))?;
    let result = metrics
        .split(',')
        .map(|metric| {
            let mut selected = series(if entity == "all" { "agent:1" } else { entity }, metric)?;
            if entity == "all" {
                selected.entity = "agent:*".into();
            }
            Ok(selected)
        })
        .collect::<R<Vec<_>>>()?;
    if result.is_empty() || result.len() > 32 {
        return Err(bad("select 1–32 metrics"));
    }
    Ok(result)
}

/// Called before the ordinary engine route validator, for both scoped and account endpoints.
pub(super) fn route_metrics(
    app: &Arc<App>,
    method: &str,
    path: &[&str],
    q: &Query,
    b: &Value,
) -> Option<R<Reply>> {
    if path.first() != Some(&"metrics") {
        return None;
    }
    Some(route(app, method, path, q, b).map(Reply::Json))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectCursor {
    query: String,
    project: usize,
    to: i64,
    inner: Option<metrics::Cursor>,
}

pub(super) fn route_project_metrics(
    ws: &Arc<Workspace>,
    method: &str,
    path: &[&str],
    q: &Query,
    b: &Value,
) -> Option<R<Reply>> {
    if path != ["metrics", "projects"] {
        return None;
    }
    Some((|| {
        if method != "GET" {
            return Err(not_found("no such metrics endpoint"));
        }
        if b.as_object().is_none_or(|object| !object.is_empty()) {
            return Err(bad("GET requests do not accept body fields"));
        }
        project_samples(ws, q).map(Reply::Json)
    })())
}

fn project_samples(ws: &Arc<Workspace>, q: &Query) -> R<Value> {
    let mut p = parameters(
        q,
        &[
            "projects",
            "entity",
            "metric",
            "from",
            "to",
            "scope",
            "resolution_secs",
            "order",
            "cursor",
            "limit",
            "max_bytes",
        ],
    )?;
    let projects = p
        .get("projects")
        .ok_or_else(|| bad("projects is required"))?
        .split(',')
        .map(str::to_string)
        .collect::<Vec<_>>();
    if projects.is_empty() || projects.len() > 16 {
        return Err(bad("select 1–16 project UUIDs"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for project in &projects {
        crate::workspace::validate_uuid(project)?;
        if !seen.insert(project) {
            return Err(bad("project selection must not contain duplicates"));
        }
    }
    p.entry("entity".into()).or_insert_with(|| "all".into());
    let selected = selection(&p)?;
    if selected
        .iter()
        .any(|series| !series.entity.starts_with("agent:"))
    {
        return Err(bad("project charts contain agent metrics only"));
    }
    let limit = limit(&p, 2000)?;
    let max_bytes = budget(&p)?;
    if max_bytes < 4096 {
        return Err(bad("cross-project metrics max_bytes must be 4096–65536"));
    }
    let scope = p
        .get("scope")
        .map(String::as_str)
        .unwrap_or("recorded_here");
    let saved = p
        .get("cursor")
        .map(|value| {
            serde_json::from_str::<ProjectCursor>(value)
                .map_err(|error| bad(format!("invalid project metrics cursor: {error}")))
        })
        .transpose()?;
    let from = integer(&p, "from", 0)?;
    let to = integer(
        &p,
        "to",
        saved
            .as_ref()
            .map_or_else(|| crate::app::now() + 1, |cursor| cursor.to),
    )?;
    if from < 0 || to <= from {
        return Err(bad("metrics range must be nonnegative with from < to"));
    }
    let resolution = p
        .get("resolution_secs")
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| bad("resolution_secs must be a positive integer"))
        })
        .transpose()?;
    if resolution.is_some_and(|value| value == 0 || value > 31_536_000) {
        return Err(bad("resolution_secs must be 1–31536000"));
    }
    let descending = descending(&p)?;
    let signature = fingerprint(
        &json!([
            ws.instance_id,
            projects,
            selected,
            from,
            to,
            scope,
            resolution,
            descending
        ])
        .to_string(),
    );
    let mut cursor = saved.unwrap_or(ProjectCursor {
        query: signature.clone(),
        project: 0,
        to,
        inner: None,
    });
    if cursor.query != signature || cursor.project >= projects.len() || cursor.to != to {
        return Err(bad("project metrics cursor does not match this query"));
    }
    let engines = projects
        .iter()
        .map(|project| ws.lookup(project))
        .collect::<R<Vec<_>>>()?;
    let scopes = engines
        .iter()
        .map(|engine| engine.metric_scope(scope))
        .collect::<R<Vec<_>>>()?;
    let agent = p
        .get("entity")
        .filter(|entity| entity.as_str() != "all")
        .map(|entity| {
            entity
                .strip_prefix("agent:")
                .unwrap()
                .parse::<i64>()
                .unwrap()
        });
    let mut result =
        json!({"items":[],"summaries":[],"next":null,"range":{"from":from,"to":to},"scope":scope});
    while cursor.project < projects.len() {
        let index = cursor.project;
        let project = &projects[index];
        let engine = &engines[index];
        let summary = json!({"project":project,"values":engine.metric_totals(&scopes[index],agent,&selected)?,"status":engine.metric_status()});
        result["summaries"].as_array_mut().unwrap().push(summary);
        result["next"] = json!(cursor);
        let remaining = max_bytes.saturating_sub(result.to_string().len() + 512);
        let available = limit - result["items"].as_array().unwrap().len();
        let query_limit = available.min((remaining / 1100).max(1));
        let query_budget = remaining.saturating_sub(query_limit * 52);
        if query_budget < 2048 {
            result["summaries"].as_array_mut().unwrap().pop();
            if result["summaries"].as_array().unwrap().is_empty() {
                return Err(bad(
                    "selected metrics exceed max_bytes; increase the response budget",
                ));
            }
            break;
        }
        let query = metrics::Query {
            series: selected.clone(),
            all_agents: p["entity"] == "all",
            descending,
            from,
            to,
            scope: scopes[index].clone(),
            limit: query_limit,
            resolution_secs: resolution,
            cursor: cursor.inner.clone(),
        };
        let page = match engine.metric_samples(&query, query_budget) {
            Ok(page) => page,
            Err(Fail(503, error)) => {
                result["summaries"]
                    .as_array_mut()
                    .unwrap()
                    .last_mut()
                    .unwrap()["history_error"] = json!(error);
                cursor.project += 1;
                cursor.inner = None;
                result["next"] = if cursor.project < projects.len() {
                    json!(cursor)
                } else {
                    Value::Null
                };
                continue;
            }
            Err(error) => return Err(error),
        };
        for mut item in page["items"].as_array().unwrap().iter().cloned() {
            item["project"] = json!(project);
            result["items"].as_array_mut().unwrap().push(item);
        }
        cursor.inner = if page["next"].is_null() {
            None
        } else {
            Some(
                serde_json::from_value(page["next"].clone())
                    .map_err(|error| Fail(500, error.to_string()))?,
            )
        };
        if cursor.inner.is_none() {
            cursor.project += 1;
        }
        result["next"] = if cursor.project < projects.len() {
            json!(cursor)
        } else {
            Value::Null
        };
        if cursor.inner.is_some() || result["items"].as_array().unwrap().len() >= limit {
            break;
        }
    }
    if result.to_string().len() > max_bytes {
        return Err(bad(
            "selected metric metadata exceeds max_bytes; increase the response budget",
        ));
    }
    Ok(result)
}

fn route(app: &Arc<App>, method: &str, path: &[&str], q: &Query, b: &Value) -> R<Value> {
    if app.lock().shutting_down {
        return Err(Fail(503, "the server is stopping".into()));
    }
    if method == "GET" && b.as_object().is_none_or(|object| !object.is_empty()) {
        return Err(bad("GET requests do not accept body fields"));
    }
    match (method, path) {
        ("POST", ["metrics", "reset"]) => {
            parameters(q, &[])?;
            let object = b
                .as_object()
                .ok_or_else(|| bad("metrics reset body must be an object"))?;
            for key in object.keys() {
                if !["confirm", "agent", "via"].contains(&key.as_str()) {
                    return Err(bad(format!("unknown metrics reset field {key:?}")));
                }
            }
            if identity(b, "agent")? != 0 || identity(b, "via")? != 0 {
                return Err(Fail(403, "only the user can reset metric history".into()));
            }
            app.reset_unavailable_metric_history(boolean(b, "confirm", false)?)
        }
        ("GET", ["metrics"]) => {
            let p = parameters(
                q,
                &[
                    "entity",
                    "metric",
                    "from",
                    "to",
                    "scope",
                    "resolution_secs",
                    "order",
                    "cursor",
                    "limit",
                    "max_bytes",
                ],
            )?;
            let cursor = p
                .get("cursor")
                .map(|value| {
                    serde_json::from_str::<metrics::Cursor>(value)
                        .map_err(|error| bad(format!("invalid metrics cursor: {error}")))
                })
                .transpose()?;
            let query = metrics::Query {
                series: selection(&p)?,
                all_agents: p.get("entity").is_some_and(|entity| entity == "all"),
                descending: descending(&p)?,
                from: integer(&p, "from", 0)?,
                to: integer(
                    &p,
                    "to",
                    cursor.as_ref().map_or_else(
                        || crate::app::now().saturating_add(1),
                        metrics::Cursor::upper_time,
                    ),
                )?,
                scope: app.metric_scope(
                    p.get("scope")
                        .map(String::as_str)
                        .unwrap_or("recorded_here"),
                )?,
                limit: limit(&p, 2000)?,
                resolution_secs: p
                    .get("resolution_secs")
                    .map(|value| {
                        value
                            .parse::<u32>()
                            .map_err(|_| bad("resolution_secs must be a positive integer"))
                    })
                    .transpose()?,
                cursor,
            };
            let project_metric = query
                .series
                .iter()
                .all(|series| series.entity.starts_with("agent:"));
            if project_metric != app.project_key().is_some() {
                return Err(bad(
                    "agent metrics require a project route; account metrics use the server route",
                ));
            }
            app.metric_samples(&query, budget(&p)?)
        }
        ("GET", ["metrics", "series"]) => {
            let p = parameters(q, &["entity", "after", "limit", "max_bytes"])?;
            app.metric_series(
                p.get("entity").map(String::as_str),
                limit(&p, 200)?,
                p.get("after")
                    .map(|_| integer(&p, "after", 0))
                    .transpose()?,
                budget(&p)?,
            )
        }
        ("GET", ["metrics", "latest"]) => {
            let p = parameters(q, &["entity", "metric", "after", "limit", "max_bytes"])?;
            let selected = selection(&p)?;
            if selected.len() != 1 || selected[0].entity == "agent:*" {
                return Err(bad("latest observations require one entity and one metric"));
            }
            if selected[0].entity.starts_with("agent:") != app.project_key().is_some() {
                return Err(bad(
                    "agent metrics require a project route; account metrics use the server route",
                ));
            }
            app.metric_latest(
                &selected[0],
                limit(&p, 200)?,
                p.get("after").map(String::as_str),
                budget(&p)?,
            )
        }
        ("GET", ["metrics", "summary"]) => {
            let p = parameters(q, &["scope", "agent", "after", "limit", "max_bytes"])?;
            app.metric_summary(
                &app.metric_scope(
                    p.get("scope")
                        .map(String::as_str)
                        .unwrap_or("recorded_here"),
                )?,
                p.get("agent")
                    .map(|_| integer(&p, "agent", 0))
                    .transpose()?,
                integer(&p, "after", 0)?,
                limit(&p, 200)?,
                budget(&p)?,
            )
        }
        ("POST", ["metrics", "maintenance"]) => {
            parameters(q, &[])?;
            let object = b
                .as_object()
                .ok_or_else(|| bad("metrics maintenance body must be an object"))?;
            for key in object.keys() {
                if ![
                    "action",
                    "selection",
                    "resolution_secs",
                    "confirm",
                    "agent",
                    "via",
                ]
                .contains(&key.as_str())
                {
                    return Err(bad(format!("unknown metrics maintenance field {key:?}")));
                }
            }
            if identity(b, "agent")? != 0 || identity(b, "via")? != 0 {
                return Err(Fail(403, "only the user can discard metric history".into()));
            }
            let selection = serde_json::from_value::<metrics::Selection>(b["selection"].clone())
                .map_err(|error| bad(format!("invalid metric selection: {error}")))?;
            for item in &selection.series {
                let mut expected = series(
                    if item.entity == "agent:*" {
                        "agent:1"
                    } else {
                        &item.entity
                    },
                    &item.metric,
                )?;
                expected.entity = item.entity.clone();
                if expected != *item {
                    return Err(bad("metric kind does not match the selected metric"));
                }
            }
            let resolution = b
                .get("resolution_secs")
                .map(|value| {
                    value
                        .as_u64()
                        .and_then(|value| u32::try_from(value).ok())
                        .ok_or_else(|| bad("resolution_secs must be a positive integer"))
                })
                .transpose()?;
            app.metric_maintenance(
                &text(b, "action")?,
                &selection,
                resolution,
                boolean(b, "confirm", false)?,
            )
        }
        _ => Err(not_found("no such metrics endpoint")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::{TokenSource, TokenUsage};
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    struct Fixture {
        directory: PathBuf,
        workspace: Arc<Workspace>,
        projects: Vec<String>,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "acom-metrics-api-test-{}",
                crate::harness::new_uuid()
            ));
            std::fs::create_dir(&directory).unwrap();
            let workspace =
                Workspace::open(directory.join("state"), "http://127.0.0.1:0".into()).unwrap();
            let mut projects = Vec::new();
            for name in ["sample-a", "sample-b"] {
                let path = directory.join(name);
                std::fs::create_dir(&path).unwrap();
                let project = workspace.add(path.to_str().unwrap(), "user").unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_string();
                let engine = workspace.lookup(&project).unwrap();
                for id in [1, 2] {
                    engine.lock().db.execute("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(?,1,'worker','synthetic task','claude','test','medium','idle',0,0)",[id]).unwrap();
                }
                engine
                    .record_tokens(
                        1,
                        TokenUsage {
                            source: TokenSource::ClaudeResult { trusted: true },
                            counts: [Some(u64::MAX), Some(0), Some(0), Some(0)],
                            total: Some(u64::MAX),
                        },
                    )
                    .unwrap();
                engine.capture_agent_metrics(1, true);
                projects.push(project);
            }
            Self {
                directory,
                workspace,
                projects,
            }
        }
        fn params(&self) -> String {
            format!(
                "projects={}&metric=total_tokens&from=0&to={}&limit=1&max_bytes=6000",
                self.projects.join(","),
                crate::app::now() + 1
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.workspace.shutdown();
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn cross_project_pages_qualify_local_ids_and_preserve_unknown_accounting() {
        let fixture = Fixture::new();
        let base = fixture.params();
        let mut query = base.clone();
        let mut seen = BTreeSet::new();
        let mut summaries = BTreeMap::new();
        let mut pages = 0;
        loop {
            let response = project_samples(&fixture.workspace, &Query(&query)).unwrap();
            assert!(response.to_string().len() <= 6000);
            for item in response["items"].as_array().unwrap() {
                assert!(seen.insert((
                    item["project"].as_str().unwrap().to_string(),
                    item["id"].as_i64().unwrap()
                )));
            }
            for summary in response["summaries"].as_array().unwrap() {
                summaries.insert(
                    summary["project"].as_str().unwrap().to_string(),
                    summary.clone(),
                );
            }
            pages += 1;
            assert!(pages < 20);
            if response["next"].is_null() {
                break;
            }
            query = format!(
                "{base}&cursor={}",
                crate::encode(&response["next"].to_string())
            );
        }
        assert!(
            seen.iter()
                .any(|(project, _)| project == &fixture.projects[0])
        );
        assert!(
            seen.iter()
                .any(|(project, _)| project == &fixture.projects[1])
        );
        assert_eq!(summaries.len(), 2);
        for summary in summaries.values() {
            assert_eq!(
                summary["values"]["total_tokens"]["known_subtotal"],
                u64::MAX.to_string()
            );
            assert_eq!(summary["values"]["total_tokens"]["unknown_series"], 1);
            assert_eq!(summary["values"]["total_tokens"]["quality"], "partial");
        }
        let first = project_samples(&fixture.workspace, &Query(&base)).unwrap();
        let altered = format!(
            "{base}&scope=all&cursor={}",
            crate::encode(&first["next"].to_string())
        );
        assert!(project_samples(&fixture.workspace, &Query(&altered)).is_err());
    }

    #[test]
    fn rejected_metric_requests_and_maintenance_have_no_history_side_effects() {
        let fixture = Fixture::new();
        let engine = fixture.workspace.lookup(&fixture.projects[0]).unwrap();
        let query = format!(
            "entity=agent:1&metric=total_tokens&from=0&to={}",
            crate::app::now() + 1
        );
        let before = route(&engine, "GET", &["metrics"], &Query(&query), &json!({})).unwrap();
        for bad_query in [
            format!("{query}&surprise=1"),
            format!("{query}&limit=0"),
            format!("{query}&limit=1&limit=2"),
            "entity=agent:1&metric=tokenz".into(),
            "entity=account:claude:five_hour&metric=usage_pct".into(),
        ] {
            assert!(route(&engine, "GET", &["metrics"], &Query(&bad_query), &json!({})).is_err());
        }
        let mut body = json!({"action":"clear","selection":{"series":[{"entity":"agent:1","metric":"total_tokens","kind":"counter"}],"from":0,"to":crate::app::now()+1}});
        assert!(
            route(
                &engine,
                "POST",
                &["metrics", "maintenance"],
                &Query(""),
                &body
            )
            .is_err()
        );
        body["confirm"] = json!(true);
        body["agent"] = json!(1);
        assert!(
            route(
                &engine,
                "POST",
                &["metrics", "maintenance"],
                &Query(""),
                &body
            )
            .is_err()
        );
        body["agent"] = json!(0);
        body["surprise"] = json!(true);
        assert!(
            route(
                &engine,
                "POST",
                &["metrics", "maintenance"],
                &Query(""),
                &body
            )
            .is_err()
        );
        let after = route(&engine, "GET", &["metrics"], &Query(&query), &json!({})).unwrap();
        assert_eq!(before["items"], after["items"]);
        assert!(
            project_samples(
                &fixture.workspace,
                &Query(&format!(
                    "{}&projects={}",
                    fixture.params(),
                    fixture.projects[0]
                ))
            )
            .is_err()
        );
    }

    #[test]
    fn actual_workspace_routes_keep_chart_scope_and_exact_counts() {
        let fixture = Fixture::new();
        let local = workspace_api::route_workspace(
            &fixture.workspace,
            "GET",
            &["p", &fixture.projects[0], "metrics"],
            &Query("entity=agent:1&metric=total_tokens"),
            &json!({}),
        )
        .unwrap();
        let Reply::Json(local) = local else {
            panic!("expected JSON")
        };
        assert_eq!(
            local["items"][0]["envelope"]["last"]["value"]["value"],
            u64::MAX.to_string()
        );
        let aggregate = route_project_metrics(
            &fixture.workspace,
            "GET",
            &["metrics", "projects"],
            &Query(&fixture.params()),
            &json!({}),
        )
        .unwrap()
        .unwrap();
        assert!(matches!(aggregate, Reply::Json(_)));
    }

    #[test]
    fn omitted_range_end_on_continuation_uses_the_cursor_snapshot_time() {
        let fixture = Fixture::new();
        let engine = fixture.workspace.lookup(&fixture.projects[0]).unwrap();
        let upper = crate::app::now() + 1000;
        let first = route(
            &engine,
            "GET",
            &["metrics"],
            &Query(&format!(
                "entity=agent:1&metric=fresh_in,output&limit=1&to={upper}"
            )),
            &json!({}),
        )
        .unwrap();
        assert!(first["next"].is_object());
        let second = route(
            &engine,
            "GET",
            &["metrics"],
            &Query(&format!(
                "entity=agent:1&metric=fresh_in,output&limit=1&cursor={}",
                crate::encode(&first["next"].to_string())
            )),
            &json!({}),
        )
        .unwrap();
        assert_eq!(second["range"]["to"], upper);
        assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);
        let latest = route(
            &engine,
            "GET",
            &["metrics", "latest"],
            &Query("entity=agent:1&metric=total_tokens&limit=1"),
            &json!({}),
        )
        .unwrap();
        assert_eq!(
            latest["items"][0]["last_known"]["value"]["value"],
            u64::MAX.to_string()
        );
        assert!(
            route(
                &fixture.workspace.global,
                "GET",
                &["metrics"],
                &Query("entity=account:claude:unknown_window&metric=usage_pct"),
                &json!({})
            )
            .is_err()
        );
    }
}
