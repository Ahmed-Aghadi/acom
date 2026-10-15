use super::*;
use std::collections::BTreeSet;

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS diagnostic_patterns (
  project INTEGER NOT NULL, pattern TEXT NOT NULL, last_event INTEGER NOT NULL, last_at INTEGER NOT NULL,
  PRIMARY KEY(project,pattern));
CREATE INDEX IF NOT EXISTS subscription_wake_times ON events(at,project,id) WHERE kind='subscription.wake';
";

struct Wake {
    id: i64,
    at: i64,
    target: i64,
    sources: BTreeSet<i64>,
    subscriptions: Vec<i64>,
    events: Vec<i64>,
}

struct Pattern {
    cycle: Vec<i64>,
    wakes: Vec<usize>,
}

fn ids(value: &Value) -> Vec<i64> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_i64)
        .filter(|id| *id > 0)
        .take(200)
        .collect()
}

fn repeated_cycle(cycle: &[i64], wakes: &[Wake]) -> Option<Vec<usize>> {
    let mut latest: Option<Vec<usize>> = None;
    for offset in 0..cycle.len() {
        let mut matched = Vec::new();
        for (index, wake) in wakes.iter().enumerate() {
            let step = (matched.len() + offset) % cycle.len();
            let source = cycle[step];
            let target = cycle[(step + 1) % cycle.len()];
            if wake.target == target && wake.sources.contains(&source) {
                matched.push(index);
            }
        }
        if matched.len() >= cycle.len() * 3
            && latest
                .as_ref()
                .is_none_or(|old| old.last() < matched.last())
        {
            latest = Some(matched.split_off(matched.len() - cycle.len() * 3));
        }
    }
    latest
}

fn patterns(wakes: &[Wake]) -> Vec<Pattern> {
    let mut counts = BTreeMap::<(i64, i64), usize>::new();
    for wake in wakes {
        for source in &wake.sources {
            *counts.entry((*source, wake.target)).or_default() += 1;
        }
    }
    let mut edges = BTreeMap::<i64, Vec<i64>>::new();
    for ((source, target), count) in counts {
        if count >= 3 && source != target {
            edges.entry(source).or_default().push(target);
        }
    }

    fn visit(
        path: &mut Vec<i64>,
        edges: &BTreeMap<i64, Vec<i64>>,
        wakes: &[Wake],
        found: &mut Vec<Pattern>,
        budget: &mut usize,
    ) {
        if *budget == 0 || found.len() >= 8 {
            return;
        }
        let start = path[0];
        let Some(next) = edges.get(path.last().unwrap()) else {
            return;
        };
        for target in next {
            if *budget == 0 || found.len() >= 8 {
                break;
            }
            *budget -= 1;
            if *target == start && path.len() >= 2 {
                if let Some(indices) = repeated_cycle(path, wakes) {
                    found.push(Pattern {
                        cycle: path.clone(),
                        wakes: indices,
                    });
                }
            } else if *target > start && path.len() < 6 && !path.contains(target) {
                path.push(*target);
                visit(path, edges, wakes, found, budget);
                path.pop();
            }
        }
    }

    let mut found = Vec::new();
    let mut budget = 4096;
    for start in edges.keys() {
        visit(&mut vec![*start], &edges, wakes, &mut found, &mut budget);
    }
    found
}

pub(super) fn check(st: &St) -> R<()> {
    st.db.execute_batch("SAVEPOINT diagnostic_warnings")?;
    match check_inner(st) {
        Ok(()) => {
            st.db.execute_batch("RELEASE diagnostic_warnings")?;
            Ok(())
        }
        Err(error) => {
            st.db
                .execute_batch("ROLLBACK TO diagnostic_warnings; RELEASE diagnostic_warnings")?;
            Err(error)
        }
    }
}

fn check_inner(st: &St) -> R<()> {
    let cutoff = now() - 60;
    let projects = rows(
        &st.db,
        "SELECT DISTINCT project FROM events WHERE kind='subscription.wake' AND at>=?1",
        [cutoff],
    )?;
    for project in projects {
        let project = project["project"].as_i64().unwrap();
        let peers: HashSet<i64> =
            rows(&st.db, "SELECT id FROM agents WHERE project=?1", [project])?
                .iter()
                .filter_map(|agent| agent["id"].as_i64())
                .collect();
        let recent = rows(
            &st.db,
            "SELECT id,at,agent,details FROM events WHERE project=?1 AND kind='subscription.wake' AND at>=?2 ORDER BY id DESC LIMIT 30",
            params![project, cutoff],
        )?;
        let mut wakes = Vec::new();
        for row in recent.into_iter().rev() {
            let Some(target) = row["agent"].as_i64().filter(|id| peers.contains(id)) else {
                continue;
            };
            let details: Value =
                serde_json::from_str(row["details"].as_str().unwrap_or("")).unwrap_or(Value::Null);
            wakes.push(Wake {
                id: row["id"].as_i64().unwrap(),
                at: row["at"].as_i64().unwrap(),
                target,
                sources: ids(&details["sources"])
                    .into_iter()
                    .filter(|id| *id != target && peers.contains(id))
                    .collect(),
                subscriptions: ids(&details["subscriptions"]),
                events: ids(&details["events"]),
            });
        }
        for pattern in patterns(&wakes) {
            let key = pattern
                .cycle
                .iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(",");
            let latest = &wakes[*pattern.wakes.last().unwrap()];
            let previous: Option<(i64, i64)> = st
                .db
                .query_row(
                    "SELECT last_event,last_at FROM diagnostic_patterns WHERE project=?1 AND pattern=?2",
                    params![project, key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if previous.is_some_and(|(event, _)| event >= latest.id) {
                continue;
            }
            st.db.execute(
                "INSERT INTO diagnostic_patterns(project,pattern,last_event,last_at) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(project,pattern) DO UPDATE SET last_event=excluded.last_event,last_at=excluded.last_at",
                params![project, key, latest.id, latest.at],
            )?;
            if previous.is_some_and(|(_, at)| at >= cutoff) {
                continue;
            }
            let bounded_ids = |key: fn(&Wake) -> &[i64], limit: usize| -> Vec<i64> {
                pattern
                    .wakes
                    .iter()
                    .flat_map(|i| key(&wakes[*i]).iter().copied())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .take(limit)
                    .collect()
            };
            let subscriptions = bounded_ids(|wake| &wake.subscriptions, 30);
            let events = bounded_ids(|wake| &wake.events, 60);
            let wake_events: Vec<i64> = pattern.wakes.iter().map(|i| wakes[*i].id).collect();
            let mut cycle = pattern.cycle.clone();
            cycle.push(cycle[0]);
            let path = cycle
                .iter()
                .map(i64::to_string)
                .collect::<Vec<_>>()
                .join(" → ");
            let summary = format!(
                "Suspected subscription wake loop: agents {path} repeated three times within 60s. Review subscriptions {subscriptions:?} and wake history events {wake_events:?}; no subscriptions changed."
            );
            let details = json!({"summary":summary,"agents":pattern.cycle,"subscriptions":subscriptions,"events":events,"wake_events":wake_events});
            for agent in &pattern.cycle {
                st.event(
                    project,
                    Some(*agent),
                    None,
                    "coordination.suspected-loop",
                    "acom",
                    details.clone(),
                )?;
                st.notice(*agent, &summary)?;
            }
            st.log_for(pattern.cycle[0], "acom", &summary)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> St {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(super::super::SCHEMA).unwrap();
        db.execute_batch(SCHEMA).unwrap();
        initialize_views(&db).unwrap();
        db.execute_batch("INSERT INTO projects(id,path,name,created_at) VALUES(1,'/one','one',0),(2,'/two','two',0);
            INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at)
            VALUES(1,1,'one','task','claude','m','e','idle',0,0),(2,1,'two','task','claude','m','e','idle',0,0),
                  (3,1,'three','task','claude','m','e','idle',0,0),(4,2,'four','task','claude','m','e','idle',0,0);").unwrap();
        St {
            db,
            shutting_down: false,
            waiting_updates: HashMap::new(),
            stopping_agents: HashSet::new(),
            queues: HashMap::new(),
            procs: HashMap::new(),
            reaped: HashSet::new(),
        }
    }

    fn wake(st: &St, source: i64, target: i64) {
        st.event(
            1,
            Some(target),
            None,
            "subscription.wake",
            "acom",
            json!({
                "sources":[source],"subscriptions":[target*10],"events":[source*100]
            }),
        )
        .unwrap();
    }

    fn warnings(st: &St) -> i64 {
        st.db
            .query_row(
                "SELECT count(*) FROM events WHERE kind='coordination.suspected-loop'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn repeated_reciprocal_wakes_warn_once_and_rearm_after_quiet() {
        let st = state();
        for _ in 0..3 {
            wake(&st, 1, 2);
            wake(&st, 2, 1);
        }
        check(&st).unwrap();
        assert_eq!(warnings(&st), 2);
        assert_eq!(
            st.db
                .query_row("SELECT count(*) FROM notices", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            st.db
                .query_row("SELECT count(*) FROM activity", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        check(&st).unwrap();
        wake(&st, 1, 2);
        wake(&st, 2, 1);
        check(&st).unwrap();
        assert_eq!(warnings(&st), 2);
        assert_eq!(
            st.db
                .query_row("SELECT last_event FROM diagnostic_patterns", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            st.db
                .query_row(
                    "SELECT max(id) FROM events WHERE kind='subscription.wake'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap()
        );
        st.db
            .execute(
                "UPDATE events SET at=?1 WHERE kind='subscription.wake'",
                [now() - 121],
            )
            .unwrap();
        st.db
            .execute("UPDATE diagnostic_patterns SET last_at=?1", [now() - 121])
            .unwrap();
        for _ in 0..3 {
            wake(&st, 1, 2);
            wake(&st, 2, 1);
        }
        check(&st).unwrap();
        assert_eq!(warnings(&st), 4);
    }

    #[test]
    fn a_three_agent_cycle_keeps_bounded_causal_evidence() {
        let st = state();
        for _ in 0..3 {
            wake(&st, 1, 2);
            wake(&st, 2, 3);
            wake(&st, 3, 1);
        }
        check(&st).unwrap();
        assert_eq!(warnings(&st), 3);
        let text: String = st
            .db
            .query_row(
                "SELECT details FROM events WHERE kind='coordination.suspected-loop' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let details: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(details["agents"], json!([1, 2, 3]));
        assert_eq!(details["subscriptions"], json!([10, 20, 30]));
        assert_eq!(details["wake_events"].as_array().unwrap().len(), 9);
        assert!(details["summary"].as_str().unwrap().contains("Suspected"));
        assert!(!text.contains("task"));
    }

    #[test]
    fn edge_counts_alone_and_unrelated_notifications_are_not_loops() {
        let st = state();
        for _ in 0..3 {
            wake(&st, 1, 2);
        }
        for _ in 0..3 {
            wake(&st, 2, 1);
        }
        for _ in 0..10 {
            st.event(
                1,
                Some(1),
                None,
                "message.sent",
                "user",
                json!({"sources":[2]}),
            )
            .unwrap();
        }
        check(&st).unwrap();
        assert_eq!(warnings(&st), 0);
    }

    #[test]
    fn self_cross_project_and_stale_edges_do_not_form_cycles() {
        let st = state();
        for _ in 0..4 {
            wake(&st, 1, 1);
            wake(&st, 1, 4);
            wake(&st, 4, 1);
        }
        check(&st).unwrap();
        assert_eq!(warnings(&st), 0);
        for _ in 0..3 {
            wake(&st, 1, 2);
            wake(&st, 2, 1);
        }
        st.db
            .execute(
                "UPDATE events SET at=?1 WHERE kind='subscription.wake'",
                [now() - 61],
            )
            .unwrap();
        check(&st).unwrap();
        assert_eq!(warnings(&st), 0);
    }
}
