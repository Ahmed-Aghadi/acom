use super::*;
use rusqlite::types::Value as SqlValue;

#[derive(Clone, Debug, Default)]
pub struct ThreadFilter {
    pub search: Option<String>,
    pub id: Option<i64>,
    pub members: Option<String>,
    pub member_match: Option<String>,
    pub category: Option<String>,
}

pub(super) fn csv_ids(value: &str, field: &str, allow_user: bool) -> R<Vec<i64>> {
    let mut ids = Vec::new();
    for part in value.split(',') {
        let id = part
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0 || allow_user && *id == 0)
            .ok_or_else(|| {
                bad(format!(
                    "{field} must contain comma-separated {} IDs",
                    if allow_user {
                        "nonnegative agent"
                    } else {
                        "positive"
                    }
                ))
            })?;
        ids.push(id);
        if ids.len() > 64 {
            return Err(bad(format!("{field} accepts at most 64 IDs")));
        }
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

#[derive(Clone, Copy)]
enum Sort {
    LatestMessage,
    Newest,
    Oldest,
    Title,
}

impl Sort {
    fn parse(value: &str) -> R<Self> {
        match value {
            "latest_message" => Ok(Self::LatestMessage),
            "newest" => Ok(Self::Newest),
            "oldest" => Ok(Self::Oldest),
            "title" => Ok(Self::Title),
            _ => Err(bad("sort must be latest_message, newest, oldest or title")),
        }
    }

    fn order(self) -> &'static str {
        match self {
            Self::LatestMessage => {
                "has_message DESC,coalesce(last_at,0) DESC,coalesce(last_message_id,0) DESC,id DESC"
            }
            Self::Newest => "created_at DESC,id DESC",
            Self::Oldest => "created_at ASC,id ASC",
            Self::Title => "sort_title COLLATE BINARY ASC,id ASC",
        }
    }

    fn boundary(self, row: &Value, start: usize) -> (String, Vec<SqlValue>) {
        let id = row["id"].as_i64().unwrap();
        match self {
            Self::LatestMessage => (
                format!(
                    "(has_message,coalesce(last_at,0),coalesce(last_message_id,0),id)<(?{start},?{},?{},?{})",
                    start + 1,
                    start + 2,
                    start + 3
                ),
                vec![
                    row["has_message"].as_i64().unwrap().into(),
                    row["last_at"].as_i64().unwrap_or(0).into(),
                    row["last_message_id"].as_i64().unwrap_or(0).into(),
                    id.into(),
                ],
            ),
            Self::Newest => (
                format!("(created_at,id)<(?{start},?{})", start + 1),
                vec![row["created_at"].as_i64().unwrap().into(), id.into()],
            ),
            Self::Oldest => (
                format!("(created_at,id)>(?{start},?{})", start + 1),
                vec![row["created_at"].as_i64().unwrap().into(), id.into()],
            ),
            Self::Title => (
                format!("(sort_title COLLATE BINARY,id)>(?{start},?{})", start + 1),
                vec![
                    row["sort_title"].as_str().unwrap().to_string().into(),
                    id.into(),
                ],
            ),
        }
    }
}

fn cursor(revision: &str, id: i64) -> String {
    format!("{revision}.{id:x}")
}

fn parse_cursor(value: &str) -> R<(&str, i64)> {
    let (revision, id) = value
        .split_once('.')
        .ok_or_else(|| bad("invalid thread cursor"))?;
    let valid_hex = |value: &str| {
        !value.is_empty()
            && value.len() <= 16
            && value
                .bytes()
                .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
    };
    if revision.len() != 16 || !valid_hex(revision) || !valid_hex(id) {
        return Err(bad("invalid thread cursor"));
    }
    let id = i64::from_str_radix(id, 16)
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| bad("invalid thread cursor"))?;
    Ok((revision, id))
}

impl App {
    #[cfg(test)]
    pub fn sorted_threads_page(
        &self,
        project: Option<i64>,
        agent: Option<i64>,
        viewer: Option<i64>,
        sort: &str,
        continuation: Option<&str>,
        q: PageQuery,
    ) -> R<Value> {
        self.filtered_threads_page(
            project,
            agent,
            viewer,
            ThreadFilter::default(),
            sort,
            continuation,
            q,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn filtered_threads_page(
        &self,
        project: Option<i64>,
        agent: Option<i64>,
        viewer: Option<i64>,
        filter: ThreadFilter,
        sort: &str,
        continuation: Option<&str>,
        q: PageQuery,
    ) -> R<Value> {
        let order = Sort::parse(sort)?;
        if filter
            .search
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 4096)
        {
            return Err(bad("search must contain 1–4096 UTF-8 bytes"));
        }
        if filter.search.is_some() && filter.id.is_some() {
            return Err(bad("use search or id, not both"));
        }
        if filter.id.is_some_and(|id| id <= 0) {
            return Err(bad("id must be a positive thread ID"));
        }
        if filter.members.is_none() && filter.member_match.is_some() {
            return Err(bad("member_match requires members"));
        }
        if agent.is_some() && filter.members.is_some() {
            return Err(bad("use agent or members, not both"));
        }
        let members = filter
            .members
            .as_deref()
            .map(|value| csv_ids(value, "members", true))
            .transpose()?;
        let member_match = filter.member_match.as_deref().unwrap_or("all");
        if !matches!(member_match, "all" | "any") {
            return Err(bad("member_match must be all or any"));
        }
        let category = filter.category.as_deref().unwrap_or("all");
        if !matches!(category, "all" | "mine" | "unread" | "agents") {
            return Err(bad("category must be all, mine, unread or agents"));
        }
        q.validate()?;
        if q.before.is_some() || q.after.is_some() || q.through.is_some() {
            return Err(bad(
                "sorted threads use cursor, not before, after or through",
            ));
        }
        if continuation.is_some() && q.since.is_some() {
            return Err(bad("since is only for a fresh page without a cursor"));
        }
        let continuation = continuation.map(parse_cursor).transpose()?;
        if agent.is_some_and(|id| id < 0) {
            return Err(bad("agent must be 0 (user) or a positive agent ID"));
        }
        let st = self.lock();
        let snapshot = st.db.unchecked_transaction()?;
        let project = Self::viewer_project(&st, project, viewer)?;
        if let Some(id) = agent.filter(|id| *id > 0) {
            let member_project = st.agent(id)?.project;
            if project.is_some_and(|project| project != member_project) {
                return Err(bad("agent is in another project"));
            }
        }
        for id in members.iter().flatten().copied().filter(|id| *id > 0) {
            let member_project = st.agent(id)?.project;
            if project.is_some_and(|project| project != member_project) {
                return Err(bad("members contains an agent in another project"));
            }
        }
        let search = filter.search.as_deref().map(str::to_lowercase);
        let revision = self.view_revision(
            &st,
            &[
                "threads",
                "messages",
                "members",
                "thread_filters",
                "thread_access",
                "thread_owners",
                "thread_exclusions",
                "user_reads",
                "member_intervals",
            ],
            &format!(
                "sorted-threads:{project:?}:{agent:?}:{}:{sort}:{search:?}:{:?}:{members:?}:{member_match}:{category}",
                viewer.unwrap_or(0), filter.id
            ),
        )?;
        if continuation.is_some_and(|(expected, _)| expected != revision) {
            return Err(conflict(
                "collection changed; restart paging without a cursor",
            ));
        }
        if let Some(unchanged) = q.snapshot(&revision)? {
            snapshot.commit()?;
            return Ok(unchanged);
        }
        let mut source = format!(
            "SELECT t.id,t.project,t.title,t.created_by,t.created_at,
               (SELECT count(*) FROM messages m WHERE m.thread_id=t.id) messages,
               latest.at last_at,latest.id last_message_id,
               (latest.id IS NOT NULL) has_message,acom_lower(t.title) sort_title
             FROM threads t LEFT JOIN messages latest ON latest.id=(
               SELECT m.id FROM messages m WHERE m.thread_id=t.id ORDER BY m.at DESC,m.id DESC LIMIT 1)
             WHERE (?1 IS NULL OR t.project=?1)
               AND (?2 IS NULL OR EXISTS(SELECT 1 FROM members b WHERE b.thread_id=t.id AND b.agent_id=?2))
               AND {}",
            Self::thread_visible_sql("t.id", "?3")
        );
        let mut args: Vec<SqlValue> =
            vec![project.into(), agent.into(), viewer.unwrap_or(0).into()];
        if let Some(search) = search {
            args.push(search.into());
            source.push_str(&format!(
                " AND instr(acom_lower(t.title),?{})>0",
                args.len()
            ));
        }
        if let Some(id) = filter.id {
            args.push(id.into());
            source.push_str(&format!(" AND t.id=?{}", args.len()));
        }
        if let Some(members) = members {
            let alternatives: Vec<String> = members.into_iter().map(|id| {
                args.push(id.into());
                format!("EXISTS(SELECT 1 FROM members matching WHERE matching.thread_id=t.id AND matching.agent_id=?{})", args.len())
            }).collect();
            source.push_str(&format!(
                " AND ({})",
                alternatives.join(if member_match == "all" {
                    " AND "
                } else {
                    " OR "
                })
            ));
        }
        match category {
            "mine" => source.push_str(" AND EXISTS(SELECT 1 FROM members mine WHERE mine.thread_id=t.id AND mine.agent_id=0)"),
            "agents" => source.push_str(" AND NOT EXISTS(SELECT 1 FROM members mine WHERE mine.thread_id=t.id AND mine.agent_id=0)"),
            "unread" => source.push_str(" AND EXISTS(SELECT 1 FROM messages unread JOIN members mine ON mine.thread_id=unread.thread_id AND mine.agent_id=0 LEFT JOIN user_reads read ON read.thread_id=unread.thread_id WHERE unread.thread_id=t.id AND unread.sender<>0 AND unread.id>coalesce(read.message_id,0) AND EXISTS(SELECT 1 FROM member_intervals interval WHERE interval.thread_id=t.id AND interval.agent_id=0 AND unread.id>interval.start_after AND (interval.end_after IS NULL OR unread.id<=interval.end_after)))"),
            _ => (),
        }
        let total: i64 = st.db.query_row(
            &format!("SELECT count(*) FROM ({source})"),
            rusqlite::params_from_iter(&args),
            |row| row.get(0),
        )?;
        let boundary = if let Some((_, id)) = continuation {
            let mut lookup = args.clone();
            lookup.push(id.into());
            let anchor = rows(
                &st.db,
                &format!("SELECT * FROM ({source}) WHERE id=?{}", args.len() + 1),
                rusqlite::params_from_iter(lookup),
            )?
            .pop()
            .ok_or_else(|| {
                conflict("thread cursor is no longer available; restart paging without a cursor")
            })?;
            let (predicate, values) = order.boundary(&anchor, args.len() + 1);
            args.extend(values);
            predicate
        } else {
            "1".into()
        };
        let candidates = rows(
            &st.db,
            &format!(
                "SELECT * FROM ({source}) WHERE {boundary} ORDER BY {} LIMIT {}",
                order.order(),
                q.limit + 1
            ),
            rusqlite::params_from_iter(args),
        )?;
        let count = candidates.len();
        let envelope = |items: &[Value]| {
            let more = items.len() < count;
            json!({"items":items,"has_more":more,"total":total,"revision":revision,"sort":sort,
                "next_cursor":if more { items.last().map(|item|cursor(&revision,item["id"].as_i64().unwrap())) } else { None }})
        };
        let mut items = Vec::new();
        for mut item in candidates.into_iter().take(q.limit as usize) {
            let tid = item["id"].as_i64().unwrap();
            item.as_object_mut().unwrap().remove("sort_title");
            item.as_object_mut().unwrap().remove("has_message");
            item["unread"] = json!(Self::user_unread(&st, tid)?);
            let ids = rows(
                &st.db,
                "SELECT agent_id id FROM members WHERE thread_id=?1 ORDER BY agent_id",
                [tid],
            )?;
            item["members"] = json!(ids.iter().map(|row| row["id"].clone()).collect::<Vec<_>>());
            item["user_member"] = json!(ids.iter().any(|row| row["id"] == 0));
            item["watch"] = Self::thread_watch(&st, tid)?;
            Self::attach_thread_access(&st, &mut item)?;
            item = self.public_value(item);
            items.push(item.clone());
            if envelope(&items).to_string().len() > q.max_bytes as usize {
                items.pop();
                if !items.is_empty() {
                    break;
                }
                let mut stub = json!({"id":item["id"],"project":item["project"],"truncated":true});
                for key in [
                    "last_at",
                    "messages",
                    "unread",
                    "user_member",
                    "private",
                    "joinable",
                    "owner",
                    "created_by",
                ] {
                    stub[key] = item[key].clone();
                }
                items.push(stub);
                break;
            }
        }
        let page = envelope(&items);
        if page.to_string().len() > q.max_bytes as usize {
            return Err(bad("max_bytes too small for thread page metadata"));
        }
        snapshot.commit()?;
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        app: Arc<App>,
        home: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let home = std::env::temp_dir()
                .join(format!("acom-thread-sort-{}", crate::harness::new_uuid()));
            let app = App::open(home.clone(), "http://127.0.0.1:0".into()).unwrap();
            app.lock().db.execute_batch(
                "INSERT INTO projects(id,path,name,created_at) VALUES(1,'/sample-one','one',0),(2,'/sample-two','two',0);
                 INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES
                   (1,1,'Reader','test','codex','test','medium','idle',0,0),
                   (2,1,'Worker','test','codex','test','medium','idle',0,0),
                   (3,2,'Other','test','codex','test','medium','idle',0,0);
                 INSERT INTO threads(id,project,title,created_by,created_at) VALUES
                   (1,1,'Beta',0,10),(2,1,'alpha',0,20),(3,1,'Alpha',0,20),
                   (4,1,'Gamma',0,5),(5,1,'alpha',0,15),(6,1,'empty',0,30),(7,2,'Foreign',0,25);
                 INSERT INTO members(thread_id,agent_id) VALUES(1,1),(2,1),(5,2),(2,0),(6,0);
                 INSERT INTO thread_access(thread_id,private,joinable) VALUES(4,1,0);
                 INSERT INTO messages(id,thread_id,sender,text,at) VALUES
                   (1,1,0,'first',100),(2,2,0,'second',100),(3,4,0,'private',200),
                   (4,5,0,'tie',100),(5,7,0,'foreign',300);"
            ).unwrap();
            Self { app, home }
        }

        fn collect(&self, sort: &str, agent: Option<i64>, viewer: Option<i64>) -> Vec<i64> {
            let mut continuation = None;
            let mut ids = Vec::new();
            for _ in 0..20 {
                let page = self
                    .app
                    .sorted_threads_page(
                        Some(1),
                        agent,
                        viewer,
                        sort,
                        continuation.as_deref(),
                        PageQuery {
                            limit: 1,
                            max_bytes: 512,
                            ..Default::default()
                        },
                    )
                    .unwrap();
                assert!(page.to_string().len() <= 512);
                ids.extend(
                    page["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|row| row["id"].as_i64().unwrap()),
                );
                if page["has_more"] == false {
                    return ids;
                }
                let next = page["next_cursor"].as_str().unwrap().to_string();
                assert_ne!(continuation.as_deref(), Some(next.as_str()));
                continuation = Some(next);
            }
            panic!("thread traversal did not terminate");
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.home);
        }
    }

    #[test]
    fn filtered_threads_cover_full_collection_and_bind_every_predicate() {
        let f = Fixture::new();
        f.app
            .lock()
            .db
            .execute("INSERT INTO members(thread_id,agent_id) VALUES(1,2)", [])
            .unwrap();
        let filter = ThreadFilter {
            members: Some("2,1,1".into()),
            ..Default::default()
        };
        let page = f
            .app
            .filtered_threads_page(
                Some(1),
                None,
                None,
                filter.clone(),
                "title",
                None,
                PageQuery::default(),
            )
            .unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["id"], 1);
        let filter = ThreadFilter {
            member_match: Some("any".into()),
            ..filter
        };
        for sort in ["latest_message", "newest", "oldest", "title"] {
            let mut cursor = None;
            let mut ids = Vec::new();
            loop {
                let page = f
                    .app
                    .filtered_threads_page(
                        Some(1),
                        None,
                        Some(1),
                        filter.clone(),
                        sort,
                        cursor.as_deref(),
                        PageQuery {
                            limit: 1,
                            ..Default::default()
                        },
                    )
                    .unwrap();
                assert_eq!(page["total"], 3);
                ids.push(page["items"][0]["id"].as_i64().unwrap());
                if page["has_more"] == false {
                    break;
                }
                cursor = page["next_cursor"].as_str().map(str::to_owned);
                for different in [
                    ThreadFilter {
                        search: Some("Beta".into()),
                        ..filter.clone()
                    },
                    ThreadFilter {
                        category: Some("mine".into()),
                        ..filter.clone()
                    },
                    ThreadFilter {
                        member_match: Some("all".into()),
                        ..filter.clone()
                    },
                    ThreadFilter {
                        members: Some("1".into()),
                        ..filter.clone()
                    },
                    ThreadFilter {
                        id: Some(1),
                        ..filter.clone()
                    },
                ] {
                    assert_eq!(
                        f.app
                            .filtered_threads_page(
                                Some(1),
                                None,
                                Some(1),
                                different,
                                sort,
                                cursor.as_deref(),
                                PageQuery::default()
                            )
                            .unwrap_err()
                            .0,
                        409
                    );
                }
            }
            ids.sort_unstable();
            assert_eq!(ids, vec![1, 2, 5]);
        }
        for (filter, expected) in [
            (
                ThreadFilter {
                    search: Some("ALPHA".into()),
                    ..Default::default()
                },
                vec![2, 3, 5],
            ),
            (
                ThreadFilter {
                    id: Some(6),
                    ..Default::default()
                },
                vec![6],
            ),
            (
                ThreadFilter {
                    category: Some("mine".into()),
                    ..Default::default()
                },
                vec![2, 6],
            ),
            (
                ThreadFilter {
                    category: Some("agents".into()),
                    ..Default::default()
                },
                vec![1, 3, 4, 5],
            ),
            (
                ThreadFilter {
                    members: Some("0".into()),
                    ..Default::default()
                },
                vec![2, 6],
            ),
        ] {
            let page = f
                .app
                .filtered_threads_page(
                    Some(1),
                    None,
                    None,
                    filter,
                    "title",
                    None,
                    PageQuery::default(),
                )
                .unwrap();
            let mut ids: Vec<_> = page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_i64().unwrap())
                .collect();
            ids.sort_unstable();
            assert_eq!(ids, expected);
        }
        f.app.lock().db.execute_batch("INSERT INTO member_intervals(thread_id,agent_id,start_after) VALUES(2,0,0); INSERT INTO messages(id,thread_id,sender,text,at) VALUES(6,2,1,'Unread',100);").unwrap();
        let before = f.app.lock().db.total_changes();
        let unread = f
            .app
            .filtered_threads_page(
                Some(1),
                None,
                None,
                ThreadFilter {
                    category: Some("unread".into()),
                    ..Default::default()
                },
                "title",
                None,
                PageQuery::default(),
            )
            .unwrap();
        assert_eq!(unread["total"], 1);
        assert_eq!(unread["items"][0]["id"], 2);
        assert_eq!(f.app.lock().db.total_changes(), before);
    }

    #[test]
    fn thread_search_literals_privacy_and_invalid_filter_rejections() {
        let f = Fixture::new();
        f.app
            .lock()
            .db
            .execute(
                "UPDATE threads SET title='Private %_ `code` İSTANBUL' WHERE id=4",
                [],
            )
            .unwrap();
        for search in ["%_", "`CODE`", "i\u{307}stanbul"] {
            let filter = ThreadFilter {
                search: Some(search.into()),
                ..Default::default()
            };
            assert_eq!(
                f.app
                    .filtered_threads_page(
                        Some(1),
                        None,
                        None,
                        filter.clone(),
                        "title",
                        None,
                        PageQuery::default()
                    )
                    .unwrap()["total"],
                1
            );
            assert_eq!(
                f.app
                    .filtered_threads_page(
                        Some(1),
                        None,
                        Some(1),
                        filter,
                        "title",
                        None,
                        PageQuery::default()
                    )
                    .unwrap()["total"],
                0
            );
        }
        let before = f.app.lock().db.total_changes();
        for filter in [
            ThreadFilter {
                search: Some("".into()),
                ..Default::default()
            },
            ThreadFilter {
                search: Some("é".repeat(2049)),
                ..Default::default()
            },
            ThreadFilter {
                id: Some(0),
                ..Default::default()
            },
            ThreadFilter {
                members: Some("".into()),
                ..Default::default()
            },
            ThreadFilter {
                members: Some("1,,2".into()),
                ..Default::default()
            },
            ThreadFilter {
                members: Some("-1".into()),
                ..Default::default()
            },
            ThreadFilter {
                members: Some(vec!["1"; 65].join(",")),
                ..Default::default()
            },
            ThreadFilter {
                members: Some("3".into()),
                ..Default::default()
            },
            ThreadFilter {
                member_match: Some("all".into()),
                ..Default::default()
            },
            ThreadFilter {
                members: Some("1".into()),
                member_match: Some("ALL".into()),
                ..Default::default()
            },
            ThreadFilter {
                category: Some("bogus".into()),
                ..Default::default()
            },
        ] {
            assert_eq!(
                f.app
                    .filtered_threads_page(
                        Some(1),
                        None,
                        None,
                        filter,
                        "title",
                        None,
                        PageQuery::default()
                    )
                    .unwrap_err()
                    .0,
                400
            );
            assert_eq!(f.app.lock().db.total_changes(), before);
        }
        assert_eq!(
            f.app
                .filtered_threads_page(
                    Some(1),
                    Some(1),
                    None,
                    ThreadFilter {
                        members: Some("1".into()),
                        ..Default::default()
                    },
                    "title",
                    None,
                    PageQuery::default()
                )
                .unwrap_err()
                .0,
            400
        );
    }

    #[test]
    fn large_member_filters_keep_sort_parameters_distinct_on_every_page() {
        let f = Fixture::new();
        f.app.lock().db.execute_batch("WITH RECURSIVE ids(id) AS (SELECT 4 UNION ALL SELECT id+1 FROM ids WHERE id<65) INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) SELECT id,1,'Member','test','codex','test','medium','idle',0,0 FROM ids;").unwrap();
        for count in [36, 40, 64] {
            let members = std::iter::once(1)
                .chain(std::iter::once(2))
                .chain(4..=65)
                .take(count)
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(",");
            for sort in ["latest_message", "newest", "oldest", "title"] {
                let filter = ThreadFilter {
                    search: Some("a".into()),
                    members: Some(members.clone()),
                    member_match: Some("any".into()),
                    ..Default::default()
                };
                let mut continuation = None;
                let mut found = Vec::new();
                loop {
                    let page = f
                        .app
                        .filtered_threads_page(
                            Some(1),
                            None,
                            None,
                            filter.clone(),
                            sort,
                            continuation.as_deref(),
                            PageQuery {
                                limit: 1,
                                ..Default::default()
                            },
                        )
                        .unwrap();
                    assert_eq!(page["total"], 3);
                    found.push(page["items"][0]["id"].as_i64().unwrap());
                    if page["has_more"] == false {
                        break;
                    }
                    continuation = page["next_cursor"].as_str().map(str::to_owned);
                }
                found.sort_unstable();
                assert_eq!(found, vec![1, 2, 5]);
            }
        }
    }

    #[test]
    fn each_sort_traverses_equal_keys_and_empty_threads_without_duplicates() {
        let f = Fixture::new();
        for (sort, expected) in [
            ("latest_message", vec![4, 5, 2, 1, 6, 3]),
            ("newest", vec![6, 3, 2, 5, 1, 4]),
            ("oldest", vec![4, 1, 5, 2, 3, 6]),
            ("title", vec![2, 3, 5, 1, 6, 4]),
        ] {
            assert_eq!(f.collect(sort, None, None), expected, "{sort}");
        }
        assert_eq!(
            f.collect("latest_message", None, Some(1)),
            vec![5, 2, 1, 6, 3]
        );
        assert_eq!(f.collect("latest_message", Some(1), None), vec![2, 1]);
        let page = f
            .app
            .sorted_threads_page(
                None,
                None,
                None,
                "latest_message",
                None,
                PageQuery::default(),
            )
            .unwrap();
        assert_eq!(page["items"][0]["id"], 7);
        assert_eq!(page["total"], 7);
    }

    #[test]
    fn cursor_binds_sort_scope_and_mutable_snapshot() {
        let f = Fixture::new();
        let first = f
            .app
            .sorted_threads_page(
                Some(1),
                None,
                None,
                "latest_message",
                None,
                PageQuery {
                    limit: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        let cursor = first["next_cursor"].as_str();
        for (project, agent, viewer, sort) in [
            (Some(1), None, None, "newest"),
            (None, None, None, "latest_message"),
            (Some(1), Some(1), None, "latest_message"),
            (Some(1), None, Some(1), "latest_message"),
        ] {
            assert_eq!(
                f.app
                    .sorted_threads_page(project, agent, viewer, sort, cursor, PageQuery::default())
                    .unwrap_err()
                    .0,
                409
            );
        }
        let unchanged = f
            .app
            .sorted_threads_page(
                Some(1),
                None,
                None,
                "latest_message",
                None,
                PageQuery {
                    since: Some(first["revision"].as_str().unwrap().into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(unchanged["unchanged"], true);
        f.app
            .lock()
            .db
            .execute("UPDATE threads SET title='Changed' WHERE id=2", [])
            .unwrap();
        assert_eq!(
            f.app
                .sorted_threads_page(
                    Some(1),
                    None,
                    None,
                    "latest_message",
                    cursor,
                    PageQuery::default()
                )
                .unwrap_err()
                .0,
            409
        );
    }

    #[test]
    fn oversized_thread_advances_with_a_small_cursor_not_its_title() {
        let f = Fixture::new();
        f.app
            .lock()
            .db
            .execute(
                "UPDATE threads SET title=?1 WHERE id=4",
                ["a".repeat(20000)],
            )
            .unwrap();
        let page = f
            .app
            .sorted_threads_page(
                Some(1),
                None,
                None,
                "title",
                None,
                PageQuery {
                    max_bytes: 512,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(page["items"][0]["id"], 4);
        assert_eq!(page["items"][0]["truncated"], true);
        assert_eq!(page["items"][0]["created_by"], 0);
        assert!(page["next_cursor"].as_str().unwrap().len() <= 33);
        assert!(page.to_string().len() <= 512);
        assert_eq!(f.collect("title", None, None), vec![4, 2, 3, 5, 1, 6]);
    }

    #[test]
    fn malformed_sort_cursor_and_ranges_reject_without_writes() {
        let f = Fixture::new();
        let before = f.app.lock().db.total_changes();
        assert_eq!(
            f.app
                .sorted_threads_page(Some(1), None, None, "latest", None, PageQuery::default())
                .unwrap_err()
                .0,
            400
        );
        for cursor in [
            "",
            "invalid",
            "0123456789abcdef.0",
            "0123456789abcdef.-1",
            "0123456789abcdef.8000000000000000",
            "0123456789abcdef.1.extra",
            "0123456789abcdeg.1",
        ] {
            assert_eq!(
                f.app
                    .sorted_threads_page(
                        Some(1),
                        None,
                        None,
                        "title",
                        Some(cursor),
                        PageQuery::default()
                    )
                    .unwrap_err()
                    .0,
                400,
                "{cursor}"
            );
        }
        for q in [
            PageQuery {
                before: Some(1),
                ..Default::default()
            },
            PageQuery {
                after: Some(0),
                ..Default::default()
            },
            PageQuery {
                through: Some(1),
                ..Default::default()
            },
            PageQuery {
                limit: 0,
                ..Default::default()
            },
            PageQuery {
                max_bytes: 511,
                ..Default::default()
            },
        ] {
            assert_eq!(
                f.app
                    .sorted_threads_page(Some(1), None, None, "title", None, q)
                    .unwrap_err()
                    .0,
                400
            );
        }
        assert_eq!(
            f.app
                .sorted_threads_page(Some(1), Some(3), None, "title", None, PageQuery::default())
                .unwrap_err()
                .0,
            400
        );
        assert_eq!(
            f.app
                .sorted_threads_page(Some(1), None, Some(3), "title", None, PageQuery::default())
                .unwrap_err()
                .0,
            400
        );
        assert_eq!(f.app.lock().db.total_changes(), before);
    }
}
