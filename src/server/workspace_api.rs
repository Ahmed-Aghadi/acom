use super::*;
use crate::app::{conflict, rows};
use rusqlite::{OptionalExtension, params};

fn query_values(q: &Query) -> R<Vec<(String, String)>> {
    let mut values = Vec::new();
    for part in q.0.split('&').filter(|v| !v.is_empty()) {
        let (key, value) = part
            .split_once('=')
            .ok_or_else(|| bad("query parameters must use name=value"))?;
        let key = strict_decode(key)?;
        if values.iter().any(|(previous, _)| previous == &key) {
            return Err(bad(format!("query parameter {key:?} must not be repeated")));
        }
        values.push((key, strict_decode(value)?));
    }
    Ok(values)
}

fn encode_query(values: &[(String, String)]) -> String {
    values
        .iter()
        .map(|(k, v)| format!("{}={}", crate::encode(k), crate::encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn local_input(
    method: &str,
    path: &[&str],
    q: &Query,
    b: &Value,
    project: &str,
) -> R<(String, Value)> {
    let mut query = query_values(q)?;
    for (key, value) in &mut query {
        if key == "project" {
            if value != project {
                return Err(bad("project must match the project in the request path"));
            }
            *value = "1".into();
        }
    }
    let mut body = b.clone();
    if let Some(value) = body.get_mut("project") {
        if value.as_str() != Some(project) {
            return Err(bad("project must match the project in the request path"));
        }
        *value = json!(1);
    }
    if method == "GET"
        && matches!(
            path,
            ["agents"]
                | ["threads"]
                | ["locks"]
                | ["locks", _]
                | ["activity", ..]
                | ["history", ..]
                | ["settings"]
                | ["limits"]
        )
        && !query.iter().any(|(k, _)| k == "project")
    {
        query.push(("project".into(), "1".into()));
    }
    if method == "POST"
        && matches!(
            path,
            ["agents"] | ["threads"] | ["locks"] | ["locks", "free"]
        )
        && body.get("project").is_none()
        && body["agent"].as_i64().unwrap_or(0) == 0
    {
        body["project"] = json!(1);
    }
    Ok((encode_query(&query), body))
}

fn allowed_query(q: &Query, allowed: &str) -> R<()> {
    for (key, _) in query_values(q)? {
        if !allowed.split_ascii_whitespace().any(|v| v == key) {
            return Err(bad(format!("unknown query parameter {key:?}")));
        }
    }
    Ok(())
}

fn config_public(ws: &Workspace, mut value: Value) -> R<Value> {
    let id = value["id"]
        .as_i64()
        .ok_or_else(|| Fail(500, "configuration identity missing".into()))?;
    value["id"] = json!(ws.global.config_key(id)?);
    value["projects"] = json!(
        rows(
            &ws.global.lock().db,
            "SELECT project FROM global.config_uses WHERE config=?1 ORDER BY project",
            [id]
        )?
        .into_iter()
        .map(|r| r["project"].clone())
        .collect::<Vec<_>>()
    );
    Ok(value)
}

fn list_page(ws: &Workspace, kind: &str, q: &Query) -> R<Value> {
    allowed_query(q, "cursor revision since limit max_bytes")?;
    let limit = q.int("limit")?.unwrap_or(50);
    let max_bytes = q.int("max_bytes")?.unwrap_or(16000);
    crate::paging::validate_budget(max_bytes)?;
    if !(1..=200).contains(&limit) {
        return Err(bad("limit must be 1–200"));
    }
    if q.get("cursor").is_some() && q.get("since").is_some() {
        return Err(bad("since is only for a fresh page without a cursor"));
    }
    let base = if kind == "projects" {
        ws.projects_revision()?
    } else {
        ws.registry_revision()?.to_string()
    };
    let shared: i64 = ws.global.lock().db.query_row(
        "SELECT coalesce(sum(value),0) FROM global.view_revisions WHERE name IN ('configs','config_uses')",[],|r|r.get(0))?;
    let revision = fingerprint(&format!("{}:{kind}:{base}:{shared}", ws.instance_id));
    if q.get("since").as_deref() == Some(&revision) {
        return Ok(json!({"unchanged":true,"revision":revision}));
    }
    if q.get("revision").is_some_and(|r| r != revision) {
        return Err(conflict(
            "collection changed; restart paging without a cursor",
        ));
    }
    let cursor = q.get("cursor");
    let after = match cursor.as_deref() {
        None => None,
        Some(cursor) => {
            let (saved, key) = cursor
                .split_once('.')
                .ok_or_else(|| bad("invalid collection cursor"))?;
            if saved != revision {
                return Err(conflict(
                    "collection changed; restart paging without a cursor",
                ));
            }
            let valid = if kind == "projects" {
                crate::workspace::validate_uuid(key).is_ok()
            } else {
                key == "default"
                    || key.len() == 32
                        && key
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            };
            if !valid {
                return Err(bad("invalid collection cursor"));
            }
            Some(key)
        }
    };
    let (candidates, total) = if kind == "projects" {
        let page = ws.list((limit as usize + 1).min(200), after)?;
        let mut items = page["items"].as_array().unwrap().clone();
        // At the maximum page length retain an extra candidate as evidence that
        // another page exists without exposing an unbounded registry read.
        if limit == 200 && page["next"].is_string() {
            items.push(json!({"id":page["next"],"truncated":true}));
        }
        (items, page["total"].as_i64().unwrap())
    } else {
        let st = ws.global.lock();
        let sql =
            "SELECT uuid id,name FROM global.configs UNION ALL SELECT 'default' id,'Default' name";
        let count: i64 = st
            .db
            .query_row(&format!("SELECT count(*) FROM ({sql})"), [], |r| r.get(0))?;
        let items = rows(
            &st.db,
            &format!("SELECT * FROM ({sql}) WHERE id>?1 ORDER BY id LIMIT ?2"),
            params![after.unwrap_or(""), limit + 1],
        )?;
        drop(st);
        let items = items
            .into_iter()
            .map(|item| {
                let id = ws.global.config_rowid(item["id"].as_str().unwrap())?;
                config_public(ws, ws.global.config_view(id)?)
            })
            .collect::<R<Vec<_>>>()?;
        (items, count)
    };
    let current = if kind == "projects" {
        ws.projects_revision()?
    } else {
        ws.registry_revision()?.to_string()
    };
    let shared_now: i64 = ws.global.lock().db.query_row(
        "SELECT coalesce(sum(value),0) FROM global.view_revisions WHERE name IN ('configs','config_uses')",[],|r|r.get(0))?;
    if current != base || shared_now != shared {
        return Err(conflict(
            "collection changed; restart paging without a cursor",
        ));
    }
    let count = candidates.len();
    let envelope = |items: &[Value]| {
        let more = items.len() < count;
        json!({"items":items,"total":total,"revision":revision,"has_more":more,
            "next_cursor":if more { items.last().and_then(|v|v["id"].as_str()).map(|id|format!("{revision}.{id}")) } else { None }})
    };
    let mut items = Vec::new();
    for item in candidates.into_iter().take(limit as usize) {
        items.push(item.clone());
        if envelope(&items).to_string().len() > max_bytes as usize {
            items.pop();
            if items.is_empty() {
                items.push(json!({"id":item["id"],"truncated":true}));
            }
            break;
        }
    }
    let value = envelope(&items);
    if value.to_string().len() > max_bytes as usize {
        return Err(bad("max_bytes too small for collection metadata"));
    }
    Ok(value)
}

fn overview(ws: &Workspace, q: &Query) -> R<Value> {
    allowed_query(q, "project since offset version max_bytes")?;
    let project = match q.get("project") {
        Some(id) => Some(ws.project(&id)?),
        None => ws.first()?,
    };
    let (mut value, engine) = if let Some(project) = project {
        let engine = ws.lookup(project["id"].as_str().unwrap())?;
        let mut value = engine.public_value(engine.overview(Some(1), None)?);
        value["project"] = project;
        (value, engine)
    } else {
        (ws.global.overview(None, None)?, ws.global.clone())
    };
    let counts = ws.action_counts(None)?;
    for key in ["pause_eligible", "resume_eligible", "restart_paused"] {
        value[key] = counts[key].clone();
    }
    let registry = ws.projects_revision()?;
    value["unread_total"] = json!(ws.unread_total()?);
    value["revisions"]["projects"] =
        json!(fingerprint(&format!("{registry}:{}", value["revision"])));
    let revision = fingerprint(&format!("{}:{registry}:{counts}", value["revision"]));
    value["revision"] = json!(revision);
    if q.get("since").as_deref() == Some(&revision) {
        return Ok(json!({"unchanged":true,"revision":revision}));
    }
    record(&engine, value, q)
}

pub(super) fn route_workspace(
    ws: &Arc<Workspace>,
    method: &str,
    p: &[&str],
    q: &Query,
    b: &Value,
) -> R<Reply> {
    let mut body = b.clone();
    if b["via"].as_i64().is_some_and(|id| id > 0) {
        let origin = b["via_project"]
            .as_str()
            .or(match p {
                ["p", id, ..] => Some(*id),
                _ => None,
            })
            .ok_or_else(|| {
                bad("via requires via_project so agent IDs are not ambiguous across projects")
            })?;
        ws.lookup(origin)?
            .agent_project(b["via"].as_i64().unwrap())?;
        body["via_project"] = json!(origin);
    }
    let reply = route_inner(ws, method, p, q, &body)?;
    if method != "GET"
        && !matches!(p, ["p", ..])
        && let Reply::Json(value) = reply
    {
        return Ok(Reply::Json(compact_global(ws, value)));
    }
    Ok(reply)
}

fn compact_global(ws: &Workspace, value: Value) -> Value {
    if value.to_string().len() <= 16000 {
        return value;
    }
    let mut compact = json!({"result_truncated":true,"counts":value.get("counts").filter(|v|v.is_object()).cloned().unwrap_or_else(||json!({}))});
    for (key, item) in value.as_object().into_iter().flatten() {
        if let Some(items) = item.as_array() {
            if compact["counts"].get(key).is_none() {
                compact["counts"][key] = json!(items.len());
            }
        } else if item.to_string().len() < 512 {
            compact[key] = item.clone();
        }
    }
    let stored: R<i64> = (|| {
        let st = ws.global.lock();
        st.db.execute(
            "INSERT INTO global.command_receipts(at,response) VALUES(?1,?2)",
            params![crate::app::now(), value.to_string()],
        )?;
        Ok(st.db.last_insert_rowid())
    })();
    match stored {
        Ok(id) => {
            compact["receipt_event"] = json!(id);
            compact["receipt_path"] = json!(format!("/global-receipts/{id}"));
        }
        Err(error) => {
            compact["receipt_error"] = json!(format!(
                "Action completed but full receipt could not be saved: {}. Inspect state before retrying.",
                error.1.chars().take(300).collect::<String>()
            ))
        }
    }
    compact
}

fn route_inner(ws: &Arc<Workspace>, method: &str, p: &[&str], q: &Query, b: &Value) -> R<Reply> {
    use Reply::Json as J;
    if ws.is_stopping() {
        return Err(Fail(503, "the server is stopping".into()));
    }
    if method == "GET" && b.as_object().is_none_or(|v| !v.is_empty()) {
        return Err(bad("GET requests do not accept body fields"));
    }
    if method == "GET" && p.is_empty() {
        allowed_query(q, "project")?;
        if let Some(project) = q.get("project") {
            crate::workspace::validate_uuid(&project)?;
        }
        return Ok(Reply::Html(UI));
    }
    if let ["p", project, local @ ..] = p {
        let engine = ws.lookup(project)?;
        if local.is_empty()
            || matches!(
                local,
                ["configs", ..]
                    | ["global-settings"]
                    | ["projects", ..]
                    | ["pause-all"]
                    | ["resume-all"]
                    | ["resume-restart"]
            )
        {
            return Err(bad("this is a server-wide route; omit the project prefix"));
        }
        let (query, body) = local_input(method, local, q, b, project)?;
        let reply = route(&engine, method, local, &Query(&query), &body)?;
        return Ok(match reply {
            J(value) => J(engine.public_value(value)),
            other => other,
        });
    }
    if let Some(reply) = metrics_api::route_project_metrics(ws, method, p, q, b) {
        return reply;
    }
    if let Some(reply) = metrics_api::route_metrics(&ws.global, method, p, q, b) {
        return reply;
    }
    match (method, p) {
        ("GET", ["storage"]) => {
            allowed_query(q, "project")?;
            Ok(J(ws.storage_usage(q.get("project").as_deref())?))
        }
        ("POST", ["projects", project, "cleanup"]) => {
            archive_body(
                q,
                b,
                &["category", "confirm", "permanent", "via", "via_project"],
            )?;
            Ok(J(ws.clean_logs(
                project,
                &text(b, "category")?,
                archive_bool(b, "confirm", false)?,
                archive_bool(b, "permanent", false)?,
                &user(b),
            )?))
        }
        ("POST", ["projects", project, "export"]) => {
            archive_body(
                q,
                b,
                &["destination", "logs", "native", "via", "via_project"],
            )?;
            Ok(J(ws.export_project(
                project,
                &text(b, "destination")?,
                archive_bool(b, "logs", false)?,
                archive_bool(b, "native", false)?,
                &user(b),
            )?))
        }
        ("POST", ["projects", "inspect-archive"]) => {
            archive_body(q, b, &["source", "via", "via_project"])?;
            Ok(J(ws.inspect_archive(&text(b, "source")?)?))
        }
        ("POST", ["projects", "import"]) => {
            archive_body(
                q,
                b,
                &[
                    "source",
                    "path",
                    "accept_default_change",
                    "version",
                    "via",
                    "via_project",
                ],
            )?;
            Ok(J(ws.import_project(
                &text(b, "source")?,
                &text(b, "path")?,
                archive_bool(b, "accept_default_change", false)?,
                &user(b),
                &text(b, "version")?,
            )?))
        }
        ("GET", ["global-receipts", receipt]) => {
            allowed_query(q, "offset version max_bytes")?;
            let st = ws.global.lock();
            let saved: Option<String> = st
                .db
                .query_row(
                    "SELECT response FROM global.command_receipts WHERE id=?1",
                    [id(receipt)?],
                    |r| r.get(0),
                )
                .optional()?;
            drop(st);
            let value = serde_json::from_str(&saved.ok_or_else(|| not_found("no global receipt"))?)
                .map_err(|e| Fail(500, e.to_string()))?;
            Ok(J(record(&ws.global, value, q)?))
        }
        ("GET", ["overview"]) => Ok(J(overview(ws, q)?)),
        ("GET", ["projects"]) if q.get("path").is_some() => {
            validate_request(method, p, q, b)?;
            Ok(J(record(
                &ws.global,
                ws.at_path(&q.get("path").unwrap())?,
                q,
            )?))
        }
        ("GET", [kind @ ("projects" | "configs")]) => Ok(J(list_page(ws, kind, q)?)),
        ("POST", ["projects"]) => {
            validate_request(method, p, q, b)?;
            Ok(J(ws.add(&text(b, "path")?, &user(b))?))
        }
        ("GET", ["projects", project]) => {
            validate_request(method, &["projects", "1"], q, b)?;
            Ok(J(record(&ws.global, ws.project(project)?, q)?))
        }
        ("POST", ["projects", project, "remove"]) => {
            validate_request(method, &["projects", "1", "remove"], q, b)?;
            Ok(J(ws.remove(project, &user(b))?))
        }
        ("PUT", ["projects", project, "config"]) => {
            let engine = ws.lookup(project)?;
            let mut body = b.clone();
            if let Some(key) = b.get("config").filter(|v| !v.is_null()) {
                body["config"] = json!(
                    ws.global.config_rowid(
                        key.as_str()
                            .ok_or_else(|| bad("config must be a saved configuration ID"))?
                    )?
                );
            }
            route(&engine, method, &["projects", "1", "config"], q, &body)
        }
        ("GET", ["configs", key]) => {
            validate_request(method, &["configs", "1"], q, b)?;
            let id = ws.global.config_rowid(key)?;
            Ok(J(record(
                &ws.global,
                config_public(ws, ws.global.config_view(id)?)?,
                q,
            )?))
        }
        ("POST", ["configs"]) => {
            validate_request(method, p, q, b)?;
            let id = ws
                .global
                .add_config(&text(b, "name")?, settings(b, "settings")?, &user(b))?;
            Ok(J(json!({"id":ws.global.config_key(id)?})))
        }
        ("PUT", ["configs", key]) => {
            validate_request(method, &["configs", "1"], q, b)?;
            ws.global.put_config(
                ws.global.config_rowid(key)?,
                opt_text(b, "name").as_deref(),
                settings(b, "settings")?,
                &user(b),
            )?;
            Ok(J(json!({"saved":true})))
        }
        ("POST", ["configs", key, "remove"]) => {
            validate_request(method, &["configs", "1", "remove"], q, b)?;
            ws.global
                .remove_config(ws.global.config_rowid(key)?, &user(b))?;
            Ok(J(json!({"removed":true})))
        }
        ("POST", [action @ ("pause-all" | "resume-all" | "resume-restart")]) => {
            let project = b
                .get("project")
                .map(|p| {
                    p.as_str()
                        .ok_or_else(|| bad("project must be a project UUID"))
                })
                .transpose()?;
            let mut body = b.clone();
            if project.is_some() {
                body["project"] = json!(1);
            }
            validate_request(method, p, q, &body)?;
            let result = match *action {
                "pause-all" => ws.pause_all(project, &user(b)),
                "resume-all" => ws.resume_all(project, &user(b)),
                _ => ws.resume_restart(project, &user(b)),
            }?;
            Ok(J(result))
        }
        (
            _,
            []
            | ["assets", ..]
            | ["models"]
            | ["catalog"]
            | ["agent-query"]
            | ["global-settings"]
            | ["folders"]
            | ["usage", "check"],
        ) => route(&ws.global, method, p, q, b),
        ("GET", ["settings"] | ["limits"]) if q.get("project").is_none() => {
            route(&ws.global, method, p, q, b)
        }
        _ => Err(bad(
            "project-owned commands require /p/<project UUID>/ in the URL",
        )),
    }
}

fn archive_body(q: &Query, b: &Value, allowed: &[&str]) -> R<()> {
    allowed_query(q, "")?;
    let object = b
        .as_object()
        .ok_or_else(|| bad("request body must be an object"))?;
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(bad(format!("unknown body field {key:?}")));
        }
    }
    for key in ["destination", "source", "path"] {
        if let Some(value) = b.get(key)
            && value.as_str().is_none_or(|s| s.trim().is_empty())
        {
            return Err(bad(format!("{key} must be a nonempty string")));
        }
    }
    if let Some(via) = b.get("via")
        && via.as_i64().is_none_or(|n| n < 0)
    {
        return Err(bad("via must be a nonnegative agent ID"));
    }
    if let Some(project) = b.get("via_project")
        && project
            .as_str()
            .is_none_or(|id| crate::workspace::validate_uuid(id).is_err())
    {
        return Err(bad("via_project must be a project UUID"));
    }
    Ok(())
}

fn archive_bool(b: &Value, key: &str, default: bool) -> R<bool> {
    b.get(key)
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| bad(format!("{key} must be boolean")))
        })
        .unwrap_or(Ok(default))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        root: PathBuf,
        ws: Arc<Workspace>,
        ids: Vec<String>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "acom-workspace-api-test-{}",
                crate::harness::new_uuid()
            ));
            std::fs::create_dir(&root).unwrap();
            let ws = Workspace::open(root.join("data"), "http://localhost:1".into()).unwrap();
            let mut ids = Vec::new();
            for name in ["one", "two"] {
                let path = root.join(name);
                std::fs::create_dir(&path).unwrap();
                let project = ws.add(path.to_str().unwrap(), "user").unwrap();
                let id = project["id"].as_str().unwrap().to_owned();
                ws.lookup(&id).unwrap().lock().db.execute_batch("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(1,1,'Worker','Synthetic task','codex','gpt-6-sol','medium','closed',0,0); INSERT INTO threads VALUES(1,1,'Notes',0,0); INSERT INTO members(thread_id,agent_id) VALUES(1,0); INSERT INTO messages VALUES(1,1,1,'Synthetic message',0);").unwrap();
                ids.push(id);
            }
            Self { root, ws, ids }
        }
        fn request(&self, method: &str, path: &str, query: &str, body: Value) -> R<Value> {
            let parts = path
                .trim_matches('/')
                .split('/')
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            match route_workspace(&self.ws, method, &parts, &Query(query), &body)? {
                Reply::Json(value) => Ok(value),
                _ => Err(bad("expected JSON")),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn scoped_routes_disambiguate_reused_ids_and_reject_mismatches_before_writes() {
        let f = Fixture::new();
        for id in &f.ids {
            let agent = f
                .request("GET", &format!("/p/{id}/agents/1"), "", json!({}))
                .unwrap();
            assert_eq!(agent["project"], *id);
            let draft = f
                .request(
                    "PUT",
                    &format!("/p/{id}/threads/1/draft"),
                    "",
                    json!({"text":id,"version":"empty"}),
                )
                .unwrap();
            assert_eq!(draft["saved"], true);
        }
        for id in &f.ids {
            assert_eq!(
                f.request("GET", &format!("/p/{id}/threads/1/draft"), "", json!({}))
                    .unwrap()["text"],
                *id
            );
        }
        assert_eq!(
            f.request("GET", "/agents/1", "", json!({})).unwrap_err().0,
            400
        );
        assert_eq!(
            f.request(
                "GET",
                &format!("/p/{}/agents", f.ids[0]),
                &format!("project={}", f.ids[1]),
                json!({})
            )
            .unwrap_err()
            .0,
            400
        );
        let before = f.ws.lookup(&f.ids[0]).unwrap().lock().db.total_changes();
        assert_eq!(
            f.request(
                "PUT",
                &format!("/p/{}/threads/1/draft", f.ids[0]),
                "",
                json!({"text":"rejected","version":"empty","unknown":true})
            )
            .unwrap_err()
            .0,
            400
        );
        assert_eq!(
            f.ws.lookup(&f.ids[0]).unwrap().lock().db.total_changes(),
            before
        );
    }

    #[test]
    fn collection_cursors_bind_store_scope_and_live_project_content() {
        let f = Fixture::new();
        let first = f.request("GET", "/projects", "limit=1", json!({})).unwrap();
        assert_eq!(first["has_more"], true);
        let cursor = first["next_cursor"].as_str().unwrap();
        let next = f
            .request(
                "GET",
                "/projects",
                &format!("cursor={cursor}&limit=1"),
                json!({}),
            )
            .unwrap();
        assert_ne!(first["items"][0]["id"], next["items"][0]["id"]);
        assert_eq!(next["has_more"], false);
        assert_eq!(
            f.request("GET", "/configs", &format!("cursor={cursor}"), json!({}))
                .unwrap_err()
                .0,
            409
        );
        let revision = first["revision"].as_str().unwrap();
        assert_eq!(
            f.request("GET", "/projects", &format!("since={revision}"), json!({}))
                .unwrap()["unchanged"],
            true
        );
        f.ws.lookup(&f.ids[0])
            .unwrap()
            .lock()
            .db
            .execute("UPDATE agents SET state='idle' WHERE id=1", [])
            .unwrap();
        assert_ne!(
            f.request("GET", "/projects", &format!("since={revision}"), json!({}))
                .unwrap()["revision"],
            revision
        );
        assert_eq!(
            f.request("GET", "/projects", &format!("cursor={cursor}"), json!({}))
                .unwrap_err()
                .0,
            409
        );
    }

    #[test]
    fn global_receipts_keep_nested_failure_counts_and_recoverable_scope() {
        let f = Fixture::new();
        let value = json!({"results":[{"project":f.ids[0],"ids":[1],"errors":["synthetic error"],"extra":"x".repeat(20000)}],"errors":[],"counts":{"ids":1,"errors":1,"warnings":0}});
        let compact = compact_global(&f.ws, value.clone());
        assert_eq!(compact["counts"]["errors"], 1);
        let path = compact["receipt_path"].as_str().unwrap();
        assert!(path.starts_with("/global-receipts/"));
        let saved = f
            .request("GET", path, "max_bytes=65536", json!({}))
            .unwrap();
        assert_eq!(saved, value);
        assert_eq!(
            f.request("GET", &format!("/p/{}{}", f.ids[0], path), "", json!({}))
                .unwrap_err()
                .0,
            404
        );
    }

    #[test]
    fn permissions_cas_and_cleanup_are_enforced_by_the_direct_api() {
        let f = Fixture::new();
        let id = &f.ids[0];
        let path = format!("/p/{id}/agents/1/permissions");
        let initial = f.request("GET", &path, "", json!({})).unwrap();
        let granted=f.request("PUT",&path,"",json!({"version":initial["version"],"grants":[{"action":"close","scope":"project","states":["idle"]}]})).unwrap();
        assert_eq!(granted["grants"].as_array().unwrap().len(), 1);
        assert_eq!(
            f.request(
                "PUT",
                &path,
                "",
                json!({"version":initial["version"],"grants":[]})
            )
            .unwrap_err()
            .0,
            409
        );
        let engine = f.ws.lookup(id).unwrap();
        std::fs::write(engine.home.join("logs/1.txt"), b"Synthetic output").unwrap();
        let cleanup = format!("/projects/{id}/cleanup");
        let preview = f
            .request(
                "POST",
                &cleanup,
                "",
                json!({"category":"logs","confirm":false}),
            )
            .unwrap();
        assert_eq!(preview["files"], 1);
        assert!(engine.home.join("logs/1.txt").exists());
        assert!(
            f.request(
                "POST",
                &cleanup,
                "",
                json!({"category":"core","confirm":true})
            )
            .is_err()
        );
        assert!(
            f.request(
                "POST",
                &cleanup,
                "",
                json!({"category":"logs","confirm":"yes"})
            )
            .is_err()
        );
        let removed = f
            .request(
                "POST",
                &cleanup,
                "",
                json!({"category":"logs","confirm":true,"permanent":true}),
            )
            .unwrap();
        assert_eq!(removed["deleted"], true);
        assert!(!engine.home.join("logs/1.txt").exists());
        assert_eq!(engine.agent_view(1).unwrap()["state"], "closed");
        assert_eq!(
            engine
                .lock()
                .db
                .query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
