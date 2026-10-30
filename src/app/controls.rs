use super::*;

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS control_grants (
 agent INTEGER PRIMARY KEY, grants TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS control_lineage (
 agent INTEGER NOT NULL, ancestor INTEGER NOT NULL,
 PRIMARY KEY(agent,ancestor));
";

const ACTIONS: [&str; 4] = ["pause", "resume", "close", "reopen"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionGrant {
    pub action: String,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<Vec<i64>>,
    pub states: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlTargets {
    Selector(String),
    Selected(Vec<i64>),
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlRequest {
    pub agent: i64,
    pub action: String,
    pub agents: ControlTargets,
    pub if_states: Option<Vec<String>>,
    pub limit: Option<i64>,
    pub after: Option<i64>,
    pub through: Option<i64>,
}

pub(super) struct ControlGuard {
    agent: i64,
    project: i64,
    turn: i64,
    pid: Option<i64>,
    if_states: Option<Vec<String>>,
    request: String,
    actor: String,
}

fn eligible(action: &str, state: &str) -> bool {
    match action {
        "pause" => matches!(state, "working" | "idle" | "done"),
        "resume" => matches!(state, "paused" | "crashed"),
        "close" => matches!(state, "working" | "idle" | "paused" | "done" | "crashed"),
        "reopen" => state == "closed",
        _ => false,
    }
}

fn states(values: &mut Vec<String>, action: Option<&str>) -> R<()> {
    if values.is_empty()
        || values.len() > STATES.len()
        || values.iter().any(|s| !STATES.contains(&s.as_str()))
    {
        return Err(bad(
            "states must be a nonempty list of known lifecycle states",
        ));
    }
    if let Some(action) = action
        && values.iter().any(|s| !eligible(action, s))
    {
        return Err(bad(format!(
            "states contains an ineligible state for {action}"
        )));
    }
    values.sort();
    values.dedup();
    Ok(())
}

fn ids(values: &mut Vec<i64>) -> R<()> {
    if values.is_empty() || values.len() > 200 || values.iter().any(|id| *id <= 0) {
        return Err(bad("agents must contain 1–200 positive IDs"));
    }
    values.sort_unstable();
    values.dedup();
    Ok(())
}

fn normalize_rules(
    db: &Connection,
    owner: i64,
    project: i64,
    mut rules: Vec<PermissionGrant>,
) -> R<Vec<PermissionGrant>> {
    if rules.len() > 64 {
        return Err(bad("at most 64 grants are allowed"));
    }
    for rule in &mut rules {
        if !ACTIONS.contains(&rule.action.as_str()) {
            return Err(bad("unknown permission action"));
        }
        states(&mut rule.states, Some(&rule.action))?;
        match (rule.scope.as_str(), rule.agents.as_mut()) {
            ("selected", Some(targets)) => {
                ids(targets)?;
                for target in targets {
                    let target_project: Option<i64> = db
                        .query_row("SELECT project FROM agents WHERE id=?1", [*target], |row| {
                            row.get(0)
                        })
                        .optional()?;
                    let target_project =
                        target_project.ok_or_else(|| not_found(format!("no agent {target}")))?;
                    if *target == owner || target_project != project {
                        return Err(bad(
                            "selected grants require other agents in the same project",
                        ));
                    }
                }
            }
            ("launched" | "project", None) => {}
            _ => {
                return Err(bad(
                    "scope must be launched/project without agents, or selected with agent IDs",
                ));
            }
        }
    }
    rules.sort_by_cached_key(|rule| json!(rule).to_string());
    rules.dedup();
    Ok(rules)
}

pub(super) fn validate_archive(db: &Connection) -> R<()> {
    let mut statement = db.prepare(
        "SELECT g.agent,a.project,a.state,
          CASE WHEN length(CAST(g.grants AS BLOB))<=524288 THEN g.grants END
         FROM control_grants g LEFT JOIN agents a ON a.id=g.agent",
    )?;
    let mut saved = statement.query([])?;
    while let Some(row) = saved.next()? {
        let owner: i64 = row.get(0)?;
        let project: Option<i64> = row.get(1)?;
        let state: Option<String> = row.get(2)?;
        let value: Option<String> = row.get(3)?;
        let rules: Vec<PermissionGrant> =
            serde_json::from_str(&value.ok_or_else(|| bad("archive permissions exceed 512 KiB"))?)
                .map_err(|error| bad(format!("invalid archive permissions: {error}")))?;
        if !rules.is_empty() && state.as_deref() == Some("replaced") {
            return Err(bad("archive gives permissions to a replaced agent"));
        }
        normalize_rules(
            db,
            owner,
            project.ok_or_else(|| bad("archive permissions have no owning agent"))?,
            rules,
        )?;
    }
    let invalid: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM control_lineage l
          LEFT JOIN agents a ON a.id=l.agent LEFT JOIN agents p ON p.id=l.ancestor
          WHERE a.id IS NULL OR p.id IS NULL OR a.project<>p.project OR a.id=p.id
             OR p.state<>'replaced')",
        [],
        |row| row.get(0),
    )?;
    if invalid {
        return Err(bad(
            "archive contains invalid replacement permission lineage",
        ));
    }
    Ok(())
}

fn grants(st: &St, agent: i64) -> R<Vec<PermissionGrant>> {
    let stored: Option<String> = st
        .db
        .query_row(
            "SELECT grants FROM control_grants WHERE agent=?1",
            [agent],
            |row| row.get(0),
        )
        .optional()?;
    stored
        .map(|stored| {
            serde_json::from_str(&stored)
                .map_err(|error| Fail(500, format!("invalid saved permissions: {error}")))
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

// A committed replacement represents the same logical worker, not a helper.
fn launched(st: &St, manager: i64, target: i64) -> R<bool> {
    Ok(st.db.query_row(
        "WITH managers(id) AS (SELECT ?1 UNION SELECT ancestor FROM control_lineage WHERE agent=?1),
         targets(id) AS (SELECT ?2 UNION SELECT ancestor FROM control_lineage WHERE agent=?2)
         SELECT EXISTS(SELECT 1 FROM agents a JOIN targets t ON a.id=t.id
           JOIN managers m ON a.launched_by=m.id)",
        params![manager, target], |row| row.get(0),
    )?)
}

fn selected(st: &St, targets: &[i64], target: i64) -> R<bool> {
    Ok(st.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM json_each(?1) WHERE value=?2 OR value IN
          (SELECT ancestor FROM control_lineage WHERE agent=?2))",
        params![json!(targets).to_string(), target],
        |row| row.get(0),
    )?)
}

pub(super) fn check(st: &St, guard: Option<&ControlGuard>, target: i64, action: &str) -> R<()> {
    let Some(guard) = guard else { return Ok(()) };
    if guard.agent == target {
        return Err(Fail(
            403,
            "delegated controls cannot target their caller".into(),
        ));
    }
    if guard.agent != 0 {
        let current: (String, i64, Option<i64>) = st.db.query_row(
            "SELECT state,turns,pid FROM agents WHERE id=?1",
            [guard.agent],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if current != ("working".into(), guard.turn, guard.pid) {
            return Err(Fail(403, "the controlling turn is no longer active".into()));
        }
    }
    let a = st.agent(target)?;
    if a.project != guard.project {
        return Err(Fail(403, "target is outside this project".into()));
    }
    if let Some(states) = &guard.if_states
        && !states.contains(&a.state)
    {
        return Err(Fail(
            412,
            format!("agent {target} is {} (if-state did not match)", a.state),
        ));
    }
    if guard.agent != 0 {
        let mut permitted = false;
        for grant in grants(st, guard.agent)? {
            if grant.action != action || !grant.states.contains(&a.state) {
                continue;
            }
            let in_scope = match grant.scope.as_str() {
                "project" => true,
                "launched" => launched(st, guard.agent, target)?,
                "selected" => selected(st, grant.agents.as_deref().unwrap_or(&[]), target)?,
                _ => return Err(Fail(500, "invalid saved permission scope".into())),
            };
            if in_scope {
                permitted = true;
                break;
            }
        }
        if !permitted {
            return Err(Fail(
                403,
                format!(
                    "no {action} grant covers agent {target} in state {}",
                    a.state
                ),
            ));
        }
    }
    Ok(())
}

pub(super) fn audit(
    st: &St,
    guard: Option<&ControlGuard>,
    target: i64,
    action: &str,
    before: &str,
) -> R<()> {
    if let Some(guard) = guard {
        st.event(guard.project, Some(target), None, "agent.control", &guard.actor,
            json!({"request":guard.request,"controller":guard.agent,"action":action,"outcome":"applied","before":before,"after":st.agent(target)?.state}))?;
    }
    Ok(())
}

pub(super) fn inherit(st: &St, old: i64, new: i64) -> R<()> {
    st.db.execute(
        "INSERT OR IGNORE INTO control_lineage(agent,ancestor) VALUES(?1,?2)",
        params![new, old],
    )?;
    st.db.execute("INSERT OR IGNORE INTO control_lineage(agent,ancestor) SELECT ?2,ancestor FROM control_lineage WHERE agent=?1", params![old,new])?;
    let inherited = grants(st, old)?;
    st.db.execute(
        "DELETE FROM control_grants WHERE agent IN (?1,?2)",
        params![old, new],
    )?;
    if !inherited.is_empty() {
        st.db.execute(
            "INSERT INTO control_grants(agent,grants) VALUES(?1,?2)",
            params![new, json!(inherited).to_string()],
        )?;
    }
    st.event(
        st.agent(new)?.project,
        Some(new),
        None,
        "agent.permissions-transferred",
        "acom",
        json!({"predecessor":old,"grants":inherited}),
    )?;
    Ok(())
}

impl App {
    fn permission_value(&self, id: i64, project: i64, current: &[PermissionGrant]) -> Value {
        let version = fingerprint(format!(
            "{}:{project}:{id}:{}",
            self.home.display(),
            json!(current)
        ));
        json!({"agent":id,"grants":current,"version":version})
    }

    pub fn permissions(&self, id: i64, viewer: Option<i64>) -> R<Value> {
        let st = self.lock();
        let a = st.agent(id)?;
        if let Some(viewer) = viewer
            && (viewer <= 0 || st.agent(viewer)?.project != a.project)
        {
            return Err(Fail(403, "viewer is outside this project".into()));
        }
        Ok(self.permission_value(id, a.project, &grants(&st, id)?))
    }

    pub fn set_permissions_if_current(
        &self,
        id: i64,
        rules: Vec<PermissionGrant>,
        version: &str,
        by: &str,
    ) -> R<Value> {
        if version.len() != 16 || !version.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(bad(
                "version must be the permissions version returned by acom",
            ));
        }
        self.set_permissions_inner(id, rules, Some(version), by)
    }

    #[cfg(test)]
    pub fn set_permissions(&self, id: i64, rules: Vec<PermissionGrant>, by: &str) -> R<Value> {
        self.set_permissions_inner(id, rules, None, by)
    }

    fn set_permissions_inner(
        &self,
        id: i64,
        rules: Vec<PermissionGrant>,
        expected: Option<&str>,
        by: &str,
    ) -> R<Value> {
        let mut st = self.lock();
        let a = st.agent(id)?;
        if a.state == "replaced" {
            return Err(conflict("a replaced agent cannot receive permissions"));
        }
        let rules = normalize_rules(&st.db, id, a.project, rules)?;
        st.atomic(|st| {
            let previous = grants(st,id)?;
            if let Some(expected) = expected
                && self.permission_value(id,a.project,&previous)["version"] != expected {
                return Err(conflict("delegated permissions changed; reload before saving"));
            }
            if previous == rules { return Ok(()) }
            if rules.is_empty() { st.db.execute("DELETE FROM control_grants WHERE agent=?1", [id])?; }
            else { st.db.execute("INSERT INTO control_grants(agent,grants) VALUES(?1,?2) ON CONFLICT(agent) DO UPDATE SET grants=excluded.grants", params![id,json!(rules).to_string()])?; }
            st.event(a.project, Some(id), None, "agent.permissions", by, json!({"grants":rules}))?;
            st.log_for(id, by, &format!("updated agent {id} delegated permissions"))?;
            st.notice(id, "The user changed your delegated controls; read acom permissions.")?;
            Ok(())
        })?;
        self.cv.notify_all();
        Ok(self.permission_value(id, a.project, &rules))
    }

    pub fn controls(self: &Arc<Self>, mut request: ControlRequest, by: &str) -> R<Value> {
        if request.agent < 0 || !ACTIONS.contains(&request.action.as_str()) {
            return Err(bad(
                "control requires a nonnegative caller and pause/resume/close/reopen action",
            ));
        }
        if let Some(values) = &mut request.if_states {
            states(values, None)?;
        }
        match &mut request.agents {
            ControlTargets::Selected(targets) => ids(targets)?,
            ControlTargets::Selector(selector)
                if matches!(selector.as_str(), "all" | "launched") => {}
            _ => {
                return Err(bad(
                    "agents must be all, launched, or a list of positive IDs",
                ));
            }
        }
        let limit = request.limit.unwrap_or(50);
        let after = request.after.unwrap_or(0);
        if !(1..=200).contains(&limit)
            || after < 0
            || request.through.is_some_and(|n| n < 0 || n < after)
            || (after > 0 && request.through.is_none())
        {
            return Err(bad(
                "invalid control page; limit is 1–200 and continuation requires after/through",
            ));
        }
        let actor = if request.agent > 0 {
            who(request.agent)
        } else {
            by.into()
        };
        let (guard, candidates, through) = {
            let st = self.lock();
            let project = if request.agent > 0 {
                st.agent(request.agent)?.project
            } else {
                let projects = rows(&st.db, "SELECT id FROM projects LIMIT 2", [])?;
                if projects.len() != 1 {
                    return Err(bad("owner batch controls require one project context"));
                }
                projects[0]["id"].as_i64().unwrap()
            };
            let (turn, pid) = if request.agent > 0 {
                if st.agent(request.agent)?.state != "working" {
                    return Err(Fail(
                        403,
                        "delegated control requires a working caller".into(),
                    ));
                }
                st.db.query_row(
                    "SELECT turns,pid FROM agents WHERE id=?1",
                    [request.agent],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?
            } else {
                (0, None)
            };
            if matches!(&request.agents,ControlTargets::Selector(selector) if selector=="launched")
                && request.agent == 0
            {
                return Err(bad("launched selector requires an agent caller"));
            }
            let ceiling = request.through.unwrap_or(match &request.agents {
                ControlTargets::Selected(targets) => *targets.last().unwrap(),
                _ => st.db.query_row(
                    "SELECT coalesce(max(id),0) FROM agents WHERE project=?1",
                    [project],
                    |row| row.get(0),
                )?,
            });
            let mut candidates = match &request.agents {
                ControlTargets::Selected(targets) => targets.iter().copied().filter(|id| *id>after && *id<=ceiling).collect::<Vec<_>>(),
                ControlTargets::Selector(selector) => rows(&st.db,
                    "SELECT a.id FROM agents a WHERE a.project=?1 AND a.id>?2 AND a.id<=?3 AND a.id<>?4
                     AND (?5='all' OR EXISTS(SELECT 1 FROM agents source
                       WHERE (source.id=a.id OR source.id IN (SELECT ancestor FROM control_lineage WHERE agent=a.id))
                         AND (source.launched_by=?4 OR source.launched_by IN
                           (SELECT ancestor FROM control_lineage WHERE agent=?4))))
                     ORDER BY a.id LIMIT ?6",
                    params![project,after,ceiling,request.agent,selector,limit+1])?.into_iter().map(|row|row["id"].as_i64().unwrap()).collect(),
            };
            candidates.truncate(limit as usize + 1);
            (
                ControlGuard {
                    agent: request.agent,
                    project,
                    turn,
                    pid,
                    if_states: request.if_states,
                    request: crate::harness::new_uuid(),
                    actor: actor.clone(),
                },
                candidates,
                ceiling,
            )
        };
        let has_more = candidates.len() > limit as usize;
        let mut results = Vec::new();
        for target in candidates.into_iter().take(limit as usize) {
            let result = match request.action.as_str() {
                "pause" => self.pause_as(target, &actor, Some(&guard)),
                "resume" => self.resume_as(target, &actor, Some(&guard)).map(|_| ()),
                "close" => self.close_as(target, &actor, Some(&guard)),
                "reopen" => self.reopen_as(target, &actor, Some(&guard)),
                _ => unreachable!(),
            };
            let item = match result {
                Ok(()) => json!({"id":target,"outcome":"applied"}),
                Err(error) => {
                    let st = self.lock();
                    let applied: bool = st.db.query_row(
                        "SELECT EXISTS(SELECT 1 FROM events WHERE agent=?1 AND kind='agent.control'
                           AND json_extract(details,'$.request')=?2 AND json_extract(details,'$.outcome')='applied')",
                        params![target,guard.request], |row|row.get(0))?;
                    if applied {
                        st.event(guard.project, Some(target), None, "agent.control-warning", &actor,
                            json!({"request":guard.request,"action":request.action,"reason":error.1}))?;
                        results.push(json!({"id":target,"outcome":"applied","warning":error.1}));
                        continue;
                    }
                    let outcome = match error.0 {
                        409 | 412 => "skipped",
                        400..=499 => "rejected",
                        _ => "error",
                    };
                    let subject = st
                        .agent(target)
                        .ok()
                        .filter(|a| a.project == guard.project)
                        .map(|_| target)
                        .or(Some(guard.agent).filter(|id| *id > 0));
                    st.event(guard.project, subject, None,
                        "agent.control", &actor, json!({"request":guard.request,"controller":guard.agent,"target":target,"action":request.action,"outcome":outcome,"reason":error.1}))?;
                    json!({"id":target,"outcome":outcome,"reason":error.1})
                }
            };
            results.push(item);
        }
        let next_after = if has_more {
            results.last().map(|item| item["id"].clone())
        } else {
            None
        };
        Ok(
            json!({"request":guard.request,"action":request.action,"results":results,"has_more":has_more,"next_after":next_after,"through":through}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Arc<App> {
        let directory =
            std::env::temp_dir().join(format!("acom-controls-{}", crate::harness::new_uuid()));
        let app = App::open(directory, "http://127.0.0.1:0".into()).unwrap();
        app.lock().db.execute_batch(
            "INSERT INTO projects(id,path,name,created_at) VALUES(1,'/sample','Sample',0);
             INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at)
             VALUES(1,1,'Manager','Coordinate','claude','m','e','working',0,0),
                   (2,1,'Worker','Review','claude','m','e','idle',1,0),
                   (3,1,'Helper','Check','claude','m','e','idle',2,0),
                   (4,1,'Other','Review','claude','m','e','paused',0,0),
                   (5,1,'Closed','Review','claude','m','e','closed',0,0);
             UPDATE agents SET pause_from='idle',paused_at=1 WHERE id=4;"
        ).unwrap();
        app
    }

    fn rule(
        action: &str,
        scope: &str,
        targets: Option<Vec<i64>>,
        states: &[&str],
    ) -> PermissionGrant {
        PermissionGrant {
            action: action.into(),
            scope: scope.into(),
            agents: targets,
            states: states.iter().map(|s| (*s).into()).collect(),
        }
    }

    fn request(action: &str, targets: Value) -> ControlRequest {
        serde_json::from_value(json!({"agent":1,"action":action,"agents":targets})).unwrap()
    }

    fn add(st: &St, id: i64, launcher: i64) {
        st.db.execute("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at)
          VALUES(?1,1,'New','Review','claude','m','e','idle',?2,0)",params![id,launcher]).unwrap();
    }

    fn guard() -> ControlGuard {
        ControlGuard {
            agent: 1,
            project: 1,
            turn: 0,
            pid: None,
            if_states: None,
            request: "test".into(),
            actor: "agent 1".into(),
        }
    }

    #[test]
    fn archive_permissions_share_normal_validation_and_preserve_replacement_scope() {
        let app = fixture();
        app.set_permissions(
            1,
            vec![rule("close", "selected", Some(vec![2]), &["idle"])],
            "user",
        )
        .unwrap();
        let st = app.lock();
        let before = st.db.total_changes();
        validate_archive(&st.db).unwrap();
        assert_eq!(st.db.total_changes(), before);
        add(&st, 6, 1);
        inherit(&st, 1, 6).unwrap();
        st.db
            .execute("UPDATE agents SET state='replaced' WHERE id=1", [])
            .unwrap();
        validate_archive(&st.db).unwrap();
        assert!(grants(&st, 1).unwrap().is_empty());
        assert_eq!(grants(&st, 6).unwrap()[0].agents, Some(vec![2]));
    }

    #[test]
    fn archive_permissions_reject_malformed_shapes_and_references_without_writes() {
        let app = fixture();
        for value in [
            "{".into(),
            json!([rule("finish", "project", None, &["idle"])]).to_string(),
            json!([rule("close", "selected", Some(vec![999]), &["idle"])]).to_string(),
            json!([rule("close", "selected", Some(vec![1]), &["idle"])]).to_string(),
            json!([rule("pause", "project", None, &["closed"])]).to_string(),
            json!([{"action":"close","scope":"project","states":["idle"],"ignored":true}])
                .to_string(),
            "x".repeat(524289),
        ] {
            let st = app.lock();
            st.db
                .execute(
                    "INSERT OR REPLACE INTO control_grants(agent,grants) VALUES(1,?1)",
                    [value],
                )
                .unwrap();
            let before = st.db.total_changes();
            assert!(validate_archive(&st.db).is_err());
            assert_eq!(st.db.total_changes(), before);
        }
        let st = app.lock();
        st.db.execute("DELETE FROM control_grants", []).unwrap();
        st.db
            .execute(
                "INSERT INTO control_lineage(agent,ancestor) VALUES(1,1)",
                [],
            )
            .unwrap();
        assert!(validate_archive(&st.db).is_err());
    }

    #[test]
    fn default_denies_and_scope_is_direct_not_recursive() {
        let app = fixture();
        assert_eq!(app.permissions(1, Some(2)).unwrap()["grants"], json!([]));
        let denied = app
            .controls(request("close", json!([2])), "agent 1")
            .unwrap();
        assert_eq!(denied["results"][0]["outcome"], "rejected");
        assert_eq!(app.lock().agent(2).unwrap().state, "idle");
        app.set_permissions(1, vec![rule("close", "launched", None, &["idle"])], "user")
            .unwrap();
        let result = app
            .controls(request("close", json!([1, 2, 3, 4])), "agent 1")
            .unwrap();
        assert_eq!(
            result["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["outcome"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["rejected", "applied", "rejected", "rejected"]
        );
        drop(app.wait_stopped(app.lock(), &[2]));
        assert_eq!(app.lock().agent(2).unwrap().state, "closed");
        assert!(app.lock().procs.is_empty());
        assert_eq!(
            app.lock()
                .db
                .query_row("SELECT turns FROM agents WHERE id=2", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn invalid_grants_and_requests_make_no_writes() {
        let app = fixture();
        let before = app.lock().db.total_changes();
        for rules in [
            vec![rule("finish", "project", None, &["idle"])],
            vec![rule("pause", "project", None, &[])],
            vec![rule("pause", "project", None, &["closed"])],
            vec![rule("close", "selected", None, &["idle"])],
            vec![rule("close", "selected", Some(vec![0]), &["idle"])],
            vec![rule("close", "selected", Some(vec![1]), &["idle"])],
            vec![rule("close", "selected", Some(vec![999]), &["idle"])],
            vec![rule("close", "project", Some(vec![2]), &["idle"])],
        ] {
            assert!(app.set_permissions(1, rules, "user").is_err());
        }
        for value in [
            json!({"agent":1,"action":"close","agents":[]}),
            json!({"agent":1,"action":"close","agents":[0]}),
            json!({"agent":1,"action":"close","agents":"active"}),
            json!({"agent":1,"action":"close","agents":"all","if_states":[]}),
            json!({"agent":1,"action":"close","agents":"all","after":1}),
            json!({"agent":1,"action":"close","agents":"all","through":2,"after":3}),
            json!({"agent":1,"action":"close","agents":"all","limit":201}),
        ] {
            assert!(
                app.controls(serde_json::from_value(value).unwrap(), "agent 1")
                    .is_err()
            );
        }
        assert!(
            serde_json::from_value::<ControlRequest>(
                json!({"agent":1,"action":"close","agents":[2],"unexpected":true})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<PermissionGrant>(
                json!({"action":"close","scope":"project","states":["idle"],"unexpected":true})
            )
            .is_err()
        );
        assert_eq!(app.lock().db.total_changes(), before);
    }

    #[test]
    fn action_state_and_if_state_filters_do_not_wake_idle_targets() {
        let app = fixture();
        app.set_permissions(
            1,
            vec![
                rule("pause", "project", None, &["idle"]),
                rule("resume", "project", None, &["paused"]),
                rule("close", "project", None, &["idle"]),
                rule("reopen", "selected", Some(vec![5]), &["closed"]),
            ],
            "user",
        )
        .unwrap();
        let mut req = request("pause", json!([2, 3]));
        req.if_states = Some(vec!["working".into()]);
        let skipped = app.controls(req, "agent 1").unwrap();
        assert_eq!(skipped["results"][0]["outcome"], "skipped");
        assert_eq!(app.lock().agent(2).unwrap().state, "idle");
        assert_eq!(
            app.controls(request("pause", json!([2])), "agent 1")
                .unwrap()["results"][0]["outcome"],
            "applied"
        );
        drop(app.wait_stopped(app.lock(), &[2]));
        assert_eq!(
            app.controls(request("resume", json!([2, 4])), "agent 1")
                .unwrap()["results"][1]["outcome"],
            "applied"
        );
        assert_eq!(
            app.controls(request("reopen", json!([5])), "agent 1")
                .unwrap()["results"][0]["outcome"],
            "applied"
        );
        let st = app.lock();
        assert_eq!(st.agent(2).unwrap().state, "idle");
        assert_eq!(st.agent(4).unwrap().state, "idle");
        assert_eq!(st.agent(5).unwrap().state, "idle");
        assert!(st.procs.is_empty());
        assert_eq!(
            st.db
                .query_row("SELECT sum(turns) FROM agents", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn replacement_transfers_authority_and_follows_selected_and_launched_lineage() {
        let app = fixture();
        app.set_permissions(1, vec![rule("close", "launched", None, &["idle"])], "user")
            .unwrap();
        app.set_permissions(
            3,
            vec![rule("pause", "selected", Some(vec![2]), &["idle"])],
            "user",
        )
        .unwrap();
        {
            let mut st = app.lock();
            add(&st, 6, 2);
            add(&st, 7, 1);
            add(&st, 8, 0);
            st.atomic(|st| {
                App::inherit_memberships(st, 2, 6)?;
                App::inherit_memberships(st, 1, 8)?;
                st.db
                    .execute("UPDATE agents SET state='replaced' WHERE id IN (1,2)", [])?;
                st.db
                    .execute("UPDATE agents SET state='working' WHERE id=8", [])?;
                Ok(())
            })
            .unwrap();
            assert!(launched(&st, 8, 6).unwrap());
            assert!(launched(&st, 8, 7).unwrap());
            assert!(!launched(&st, 8, 3).unwrap());
            assert!(selected(&st, &[2], 6).unwrap());
            assert!(!selected(&st, &[2], 7).unwrap());
            assert_eq!(st.agent(6).unwrap().launched_by, 2);
        }
        assert_eq!(app.permissions(1, None).unwrap()["grants"], json!([]));
        assert_eq!(app.permissions(7, None).unwrap()["grants"], json!([]));
        assert_eq!(
            app.permissions(8, None).unwrap()["grants"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut req = request("close", json!("launched"));
        req.agent = 8;
        let result = app.controls(req, "agent 8").unwrap();
        let applied = result["results"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["outcome"] == "applied")
            .map(|r| r["id"].as_i64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(applied, vec![6, 7]);
        drop(app.wait_stopped(app.lock(), &[6, 7]));
        assert!(
            app.set_permissions(1, vec![rule("close", "project", None, &["idle"])], "user")
                .is_err()
        );
    }

    #[test]
    fn page_ceiling_does_not_expand_and_duplicate_selected_ids_apply_once() {
        let app = fixture();
        app.set_permissions(1, vec![rule("pause", "project", None, &["idle"])], "user")
            .unwrap();
        let mut req = request("pause", json!("all"));
        req.limit = Some(1);
        let first = app.controls(req, "agent 1").unwrap();
        assert_eq!(first["results"][0]["id"], 2);
        assert_eq!(first["through"], 5);
        assert_eq!(first["has_more"], true);
        add(&app.lock(), 6, 1);
        let mut req = request("pause", json!("all"));
        req.after = first["next_after"].as_i64();
        req.through = first["through"].as_i64();
        let rest = app.controls(req, "agent 1").unwrap();
        assert_eq!(
            rest["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["id"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
        assert_eq!(app.lock().agent(6).unwrap().state, "idle");
        let duplicate = app
            .controls(request("pause", json!([6, 6])), "agent 1")
            .unwrap();
        assert_eq!(duplicate["results"].as_array().unwrap().len(), 1);
        drop(app.wait_stopped(app.lock(), &[2, 3, 6]));
    }

    #[test]
    fn fresh_grants_caller_turn_and_state_are_rechecked_at_mutation() {
        let app = fixture();
        app.set_permissions(
            1,
            vec![rule("resume", "project", None, &["paused"])],
            "user",
        )
        .unwrap();
        let pinned = guard();
        assert!(check(&app.lock(), Some(&pinned), 4, "resume").is_ok());
        app.set_permissions(1, vec![], "user").unwrap();
        assert_eq!(
            app.resume_as(4, "agent 1", Some(&pinned)).unwrap_err().0,
            403
        );
        app.set_permissions(
            1,
            vec![rule("resume", "project", None, &["paused"])],
            "user",
        )
        .unwrap();
        for sql in [
            "UPDATE agents SET turns=turns+1 WHERE id=1",
            "UPDATE agents SET pid=99 WHERE id=1",
            "UPDATE agents SET state='replaced' WHERE id=1",
        ] {
            app.lock().db.execute(sql, []).unwrap();
            assert_eq!(
                app.resume_as(4, "agent 1", Some(&pinned)).unwrap_err().0,
                403
            );
            app.lock()
                .db
                .execute(
                    "UPDATE agents SET turns=0,pid=NULL,state='working' WHERE id=1",
                    [],
                )
                .unwrap();
        }
        assert_eq!(app.lock().agent(4).unwrap().state, "paused");
    }

    #[test]
    fn audit_failure_rolls_back_lifecycle_change_and_permissions() {
        let app = fixture();
        app.set_permissions(1, vec![rule("pause", "project", None, &["idle"])], "user")
            .unwrap();
        app.lock().db.execute_batch("CREATE TRIGGER reject_control BEFORE INSERT ON events WHEN NEW.kind='agent.control' AND json_extract(NEW.details,'$.outcome')='applied' BEGIN SELECT RAISE(ABORT,'audit failed'); END;").unwrap();
        let result = app
            .controls(request("pause", json!([2])), "agent 1")
            .unwrap();
        assert_eq!(result["results"][0]["outcome"], "error");
        assert_eq!(app.lock().agent(2).unwrap().state, "idle");
        assert!(!app.lock().stopping_agents.contains(&2));
        let before = app.permissions(1, None).unwrap();
        app.lock().db.execute_batch("CREATE TRIGGER reject_permissions BEFORE INSERT ON events WHEN NEW.kind='agent.permissions' BEGIN SELECT RAISE(ABORT,'audit failed'); END;").unwrap();
        assert!(app.set_permissions(1, vec![], "user").is_err());
        assert_eq!(app.permissions(1, None).unwrap(), before);
    }

    #[test]
    fn changed_permissions_notify_once_without_starting_a_turn() {
        let app = fixture();
        let rules = vec![rule("close", "selected", Some(vec![3, 2, 2]), &["idle"])];
        let saved = app.set_permissions(1, rules, "user").unwrap();
        let before = app.lock().db.total_changes();
        let canonical: Vec<PermissionGrant> =
            serde_json::from_value(saved["grants"].clone()).unwrap();
        app.set_permissions(1, canonical, "user").unwrap();
        assert_eq!(app.lock().db.total_changes(), before);
        assert_eq!(
            app.lock()
                .db
                .query_row("SELECT count(*) FROM notices WHERE agent_id=1", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        app.set_permissions(1, vec![], "user").unwrap();
        assert_eq!(
            app.lock()
                .db
                .query_row("SELECT count(*) FROM notices WHERE agent_id=1", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            2
        );
        assert!(app.lock().procs.is_empty());
    }

    #[test]
    fn stale_permission_edit_cannot_restore_revoked_authority() {
        let app = fixture();
        let initial = app.permissions(1, None).unwrap();
        let granted = app
            .set_permissions_if_current(
                1,
                vec![rule("close", "project", None, &["idle"])],
                initial["version"].as_str().unwrap(),
                "user",
            )
            .unwrap();
        let revoked = app
            .set_permissions_if_current(1, vec![], granted["version"].as_str().unwrap(), "user")
            .unwrap();
        assert_eq!(revoked["grants"], json!([]));
        let changes = app.lock().db.total_changes();
        let error = app
            .set_permissions_if_current(
                1,
                vec![rule("close", "project", None, &["idle"])],
                granted["version"].as_str().unwrap(),
                "user",
            )
            .unwrap_err();
        assert_eq!(error.0, 409);
        assert_eq!(app.lock().db.total_changes(), changes);
        assert_eq!(app.permissions(1, None).unwrap(), revoked);
        assert!(
            app.set_permissions_if_current(2, vec![], initial["version"].as_str().unwrap(), "user")
                .is_err()
        );
        let other = fixture();
        assert!(
            other
                .set_permissions_if_current(1, vec![], initial["version"].as_str().unwrap(), "user")
                .is_err()
        );
        assert_eq!(
            app.set_permissions_if_current(1, vec![], "invalid", "user")
                .unwrap_err()
                .0,
            400
        );
    }

    #[test]
    fn post_commit_wake_error_is_an_applied_control_with_warning() {
        let app = fixture();
        app.set_permissions(
            1,
            vec![rule("reopen", "selected", Some(vec![5]), &["closed"])],
            "user",
        )
        .unwrap();
        // Reopen's lifecycle transaction does not need continuation bookkeeping;
        // its later wake check does. Simulate that independent follow-up failing.
        app.lock()
            .db
            .execute_batch("DROP TABLE agent_continuations")
            .unwrap();
        let result = app
            .controls(request("reopen", json!([5])), "agent 1")
            .unwrap();
        assert_eq!(result["results"][0]["outcome"], "applied");
        assert!(
            result["results"][0]["warning"]
                .as_str()
                .unwrap()
                .contains("agent_continuations")
        );
        assert_eq!(app.lock().agent(5).unwrap().state, "idle");
        let st = app.lock();
        assert_eq!(st.db.query_row("SELECT count(*) FROM events WHERE kind='agent.control' AND json_extract(details,'$.request')=?1",[result["request"].as_str().unwrap()],|row|row.get::<_,i64>(0)).unwrap(),1);
        assert!(st.procs.is_empty());
    }

    #[test]
    fn revocation_or_new_caller_turn_during_cleanup_wait_prevents_resume() {
        for change in ["grant", "turn", "target-state"] {
            let app = fixture();
            app.set_permissions(
                1,
                vec![rule("resume", "project", None, &["paused"])],
                "user",
            )
            .unwrap();
            let (send, receive) = std::sync::mpsc::channel();
            {
                let mut st = app.lock();
                st.stopping_agents.insert(4);
                st.db
                    .create_scalar_function(
                        "control_observed",
                        0,
                        rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                        move |_| {
                            let _ = send.send(());
                            Ok(0)
                        },
                    )
                    .unwrap();
                st.db.execute_batch("ALTER TABLE control_grants RENAME TO saved_control_grants;
                  CREATE VIEW control_grants AS SELECT agent,grants FROM saved_control_grants WHERE control_observed()=0;
                  CREATE TRIGGER revoke_control INSTEAD OF DELETE ON control_grants BEGIN DELETE FROM saved_control_grants WHERE agent=OLD.agent; END;").unwrap();
            }
            let waiting = app.clone();
            let worker = std::thread::spawn(move || {
                waiting.controls(request("resume", json!([4])), "agent 1")
            });
            // The first grant read is inside resume's pre-wait check. Taking
            // the mutex after this signal requires the waiter to release it.
            receive.recv_timeout(Duration::from_secs(2)).unwrap();
            if change == "grant" {
                app.set_permissions(1, vec![], "user").unwrap();
            }
            {
                let mut st = app.lock();
                match change {
                    "turn" => {
                        st.db
                            .execute("UPDATE agents SET turns=turns+1 WHERE id=1", [])
                            .unwrap();
                    }
                    "target-state" => {
                        st.db
                            .execute("UPDATE agents SET state='idle' WHERE id=4", [])
                            .unwrap();
                    }
                    _ => {}
                }
                st.stopping_agents.remove(&4);
                app.cv.notify_all();
            }
            let result = worker.join().unwrap().unwrap();
            assert_eq!(
                result["results"][0]["outcome"], "rejected",
                "{change}: {result}"
            );
            assert_eq!(
                app.lock().agent(4).unwrap().state,
                if change == "target-state" {
                    "idle"
                } else {
                    "paused"
                }
            );
            assert!(app.lock().procs.is_empty());
        }
    }
}
