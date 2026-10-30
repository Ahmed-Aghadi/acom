use super::*;
use rusqlite::types::Value as SqlValue;

#[derive(Clone, Debug, Default)]
pub struct MessageSearch {
    pub text: Option<String>,
    pub id: Option<i64>,
    pub thread: Option<i64>,
    pub threads: Option<String>,
    pub sender: Option<i64>,
    pub from: Option<i64>,
    pub to: Option<i64>,
}

pub(super) fn snippet(text: &str, needle: &str) -> String {
    let lower = text.to_lowercase();
    let position = if needle.is_empty() {
        0
    } else {
        lower.find(needle).unwrap_or(0)
    };
    // Unicode lowercase can expand a character (for example İ). Map back to
    // original text rather than using a folded byte offset to slice UTF-8.
    let mut folded = 0;
    let mut original = 0;
    for (at, ch) in text.char_indices() {
        original = at;
        let width = ch.to_lowercase().map(char::len_utf8).sum::<usize>();
        if folded + width > position {
            break;
        }
        folded += width;
    }
    let start = text[..original]
        .char_indices()
        .rev()
        .nth(79)
        .map_or(0, |(at, _)| at);
    let mut end = text.len().min(start + 512);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        &text[start..end],
        if end < text.len() { "…" } else { "" }
    )
}

impl App {
    pub fn search_messages(
        &self,
        project: Option<i64>,
        viewer: Option<i64>,
        filter: MessageSearch,
        q: PageQuery,
    ) -> R<Value> {
        q.validate()?;
        if filter.text.is_some() == filter.id.is_some() {
            return Err(bad("supply exactly one of text or id"));
        }
        if filter
            .text
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 4096)
        {
            return Err(bad("text must contain 1–4096 UTF-8 bytes"));
        }
        if filter.id.is_some_and(|id| id <= 0) || filter.thread.is_some_and(|id| id <= 0) {
            return Err(bad("id and thread must be positive IDs"));
        }
        if filter.thread.is_some() && filter.threads.is_some() {
            return Err(bad("use thread or threads, not both"));
        }
        if filter.sender.is_some_and(|id| id < 0) {
            return Err(bad("sender must be 0 (user) or a positive agent ID"));
        }
        if filter.from.is_some_and(|at| at < 0)
            || filter.to.is_some_and(|at| at < 0)
            || matches!((filter.from, filter.to), (Some(from), Some(to)) if from > to)
        {
            return Err(bad(
                "from/to must be nonnegative Unix seconds with from <= to",
            ));
        }
        let threads = filter
            .threads
            .as_deref()
            .map(|value| thread_sort::csv_ids(value, "threads", false))
            .transpose()?
            .or_else(|| filter.thread.map(|thread| vec![thread]));
        let text = filter.text.as_deref().unwrap_or("").to_lowercase();
        let st = self.lock();
        let snapshot = st.db.unchecked_transaction()?;
        let project = Self::viewer_project(&st, project, viewer)?;
        if let Some(sender) = filter.sender.filter(|id| *id > 0) {
            let sender_project = st.agent(sender)?.project;
            if project.is_some_and(|project| project != sender_project) {
                return Err(bad("sender is in another project"));
            }
        }
        for thread in threads.iter().flatten() {
            let own = Self::require_thread_read(&st, *thread, viewer.unwrap_or(0))?;
            if project.is_some_and(|project| project != own) {
                return Err(bad("thread is in another project"));
            }
        }
        let scope = format!(
            "message-search:{project:?}:{}:{text:?}:{:?}:{threads:?}:{:?}:{:?}:{:?}",
            viewer.unwrap_or(0),
            filter.id,
            filter.sender,
            filter.from,
            filter.to
        );
        let mut args: Vec<SqlValue> = vec![
            project.into(),
            viewer.unwrap_or(0).into(),
            text.clone().into(),
        ];
        let mut sql = format!(
            "SELECT m.id,m.thread_id thread,t.title,m.sender,m.at,acom_snippet(m.text,?3) snippet FROM messages m JOIN threads t ON t.id=m.thread_id WHERE (?1 IS NULL OR t.project=?1) AND {}",
            Self::thread_visible_sql("t.id", "?2")
        );
        if filter.text.is_some() {
            sql.push_str(" AND instr(acom_lower(m.text),?3)>0");
        }
        if let Some(id) = filter.id {
            args.push(id.into());
            sql.push_str(&format!(" AND m.id=?{}", args.len()));
        }
        if let Some(threads) = threads {
            let placeholders = threads
                .into_iter()
                .map(|thread| {
                    args.push(thread.into());
                    format!("?{}", args.len())
                })
                .collect::<Vec<_>>()
                .join(",");
            sql.push_str(&format!(" AND m.thread_id IN ({placeholders})"));
        }
        for (value, column, operator) in [
            (filter.sender, "m.sender", "="),
            (filter.from, "m.at", ">="),
            (filter.to, "m.at", "<="),
        ] {
            if let Some(value) = value {
                args.push(value.into());
                sql.push_str(&format!(" AND {column}{operator}?{}", args.len()));
            }
        }
        let mut page = self.select_page(
            &st,
            &q,
            &[
                "threads",
                "messages",
                "members",
                "member_intervals",
                "thread_access",
                "marks",
            ],
            &scope,
            &sql,
            &args,
            true,
        )?;
        for item in &mut page.items {
            Self::message_context(&st, item, Some(viewer.unwrap_or(0)))?;
        }
        let result = page.finish(&q)?;
        snapshot.commit()?;
        Ok(result)
    }

    pub fn message_context_page(
        &self,
        tid: i64,
        target: i64,
        viewer: Option<i64>,
        limit: i64,
        max_bytes: i64,
    ) -> R<Value> {
        PageQuery {
            limit,
            max_bytes,
            ..Default::default()
        }
        .validate()?;
        if target <= 0 {
            return Err(bad("message must be a positive message ID"));
        }
        let st = self.lock();
        let snapshot = st.db.unchecked_transaction()?;
        let actor = viewer.unwrap_or(0);
        Self::require_thread_read(&st, tid, actor)?;
        let exists: bool = st.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE thread_id=?1 AND id=?2)",
            params![tid, target],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(not_found(format!(
                "message {target} is not in thread {tid}"
            )));
        }
        let revision = self.view_revision(
            &st,
            &[
                "messages",
                "members",
                "member_intervals",
                "thread_access",
                "user_reads",
                "marks",
            ],
            &format!("messages:{tid}:{actor}"),
        )?;
        let (total, through, first): (i64, i64, i64) = st.db.query_row(
            "SELECT count(*),max(id),min(id) FROM messages WHERE thread_id=?1",
            [tid],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let fields = format!(
            "SELECT id,thread_id thread,sender,at,CASE WHEN length(CAST(text AS BLOB))>{max_bytes} THEN NULL ELSE text END text,length(CAST(text AS BLOB))>{max_bytes} truncated FROM messages WHERE thread_id=?1"
        );
        let mut older = rows(
            &st.db,
            &format!("{fields} AND id<?2 ORDER BY id DESC LIMIT ?3"),
            params![tid, target, limit - 1],
        )?;
        let mut newer = rows(
            &st.db,
            &format!("{fields} AND id>?2 ORDER BY id ASC LIMIT ?3"),
            params![tid, target, limit - 1],
        )?;
        let desired_older = ((limit - 1) / 2) as usize;
        let keep_newer = newer
            .len()
            .min((limit - 1) as usize - older.len().min(desired_older));
        newer.truncate(keep_newer);
        older.truncate(((limit - 1) as usize - newer.len()).min(older.len()));
        older.reverse();
        let mut items = older;
        items.extend(rows(
            &st.db,
            &format!("{fields} AND id=?2"),
            params![tid, target],
        )?);
        items.extend(newer);
        for item in &mut items {
            if item["truncated"] == 0 {
                item.as_object_mut().unwrap().remove("truncated");
            } else {
                item["truncated"] = json!(true);
                item.as_object_mut().unwrap().remove("text");
            }
            Self::message_context(&st, item, Some(actor))?;
        }
        let envelope = |items: &[Value]| {
            let oldest = items.first().unwrap()["id"].as_i64().unwrap();
            let newest = items.last().unwrap()["id"].as_i64().unwrap();
            let has_older = oldest > first;
            let has_newer = newest < through;
            Ok::<Value, Fail>(
                json!({"items":items,"target":target,"total":total,"through":through,"revision":revision,"oldest":oldest,"newest":newest,"has_older":has_older,"has_newer":has_newer}),
            )
        };
        while envelope(&items)?.to_string().len() > max_bytes as usize {
            if items.len() == 1 {
                let item = &mut items[0];
                if item.get("text").is_none() {
                    return Err(bad("max_bytes too small for context metadata"));
                }
                item.as_object_mut().unwrap().remove("text");
                item["truncated"] = json!(true);
            } else {
                let index = items.iter().position(|item| item["id"] == target).unwrap();
                if index > items.len() - index - 1 {
                    items.remove(0);
                } else {
                    items.pop();
                }
            }
        }
        let result = self.public_value(envelope(&items)?);
        snapshot.commit()?;
        Ok(result)
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
            let home = std::env::temp_dir().join(format!(
                "acom-message-search-{}",
                crate::harness::new_uuid()
            ));
            let app = App::open(home.clone(), "http://127.0.0.1:0".into()).unwrap();
            app.lock().db.execute_batch("INSERT INTO projects(id,path,name,created_at) VALUES(1,'/sample-one','one',0),(2,'/sample-two','two',0);
            INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at) VALUES(1,1,'Reader','test','codex','test','medium','idle',0,0),(2,1,'Worker','test','codex','test','medium','idle',0,0),(3,2,'Foreign','test','codex','test','medium','idle',0,0);
            INSERT INTO threads(id,project,title,created_by,created_at) VALUES(1,1,'Discussion',0,0),(2,1,'Private',0,0),(3,2,'Foreign',0,0);
            INSERT INTO thread_access(thread_id,private,joinable) VALUES(2,1,0);
            INSERT INTO members(thread_id,agent_id) VALUES(1,0),(1,1),(2,2);
            INSERT INTO member_intervals(thread_id,agent_id,start_after) VALUES(1,0,0),(1,1,0),(2,2,0);
            INSERT INTO messages(id,thread_id,sender,text,at) VALUES(1,1,1,'First needle literal %_ and `CODE`',10),(2,2,2,'private needle',20),(3,1,0,'Second NEEDLE and 83',30),(4,1,2,'İSTANBUL needle',40),(5,3,3,'foreign needle',50);
            INSERT INTO marks(agent_id,message_id,mark) VALUES(1,1,'in-progress');").unwrap();
            Self { app, home }
        }
        fn text(value: &str) -> MessageSearch {
            MessageSearch {
                text: Some(value.into()),
                ..Default::default()
            }
        }
        fn search(&self, filter: MessageSearch, viewer: Option<i64>, q: PageQuery) -> R<Value> {
            self.app.search_messages(Some(1), viewer, filter, q)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.home);
        }
    }
    fn ids(page: &Value) -> Vec<i64> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_i64().unwrap())
            .collect()
    }

    #[test]
    fn search_literal_full_history_scope_privacy_and_no_read_side_effects() {
        let f = Fixture::new();
        let before = f.app.lock().db.total_changes();
        assert_eq!(
            ids(&f
                .search(Fixture::text("needle"), None, PageQuery::default())
                .unwrap()),
            vec![4, 3, 2, 1]
        );
        assert_eq!(
            ids(&f
                .search(Fixture::text("NEEDLE"), Some(1), PageQuery::default())
                .unwrap()),
            vec![4, 3, 1]
        );
        assert_eq!(
            ids(&f
                .search(Fixture::text("needle"), Some(2), PageQuery::default())
                .unwrap()),
            vec![4, 3, 2, 1]
        );
        for (text, wanted) in [
            ("%_", vec![1]),
            ("`code`", vec![1]),
            ("83", vec![3]),
            ("i\u{307}stanbul", vec![4]),
            ("'; DROP TABLE messages;--", vec![]),
        ] {
            let page = f
                .search(Fixture::text(text), None, PageQuery::default())
                .unwrap();
            assert_eq!(ids(&page), wanted);
            for row in page["items"].as_array().unwrap() {
                assert!(row.get("text").is_none());
                assert!(row["snippet"].as_str().unwrap().len() <= 518);
            }
        }
        let filtered = f
            .search(
                MessageSearch {
                    thread: Some(1),
                    sender: Some(0),
                    from: Some(30),
                    to: Some(30),
                    ..Fixture::text("needle")
                },
                None,
                PageQuery::default(),
            )
            .unwrap();
        assert_eq!(ids(&filtered), vec![3]);
        assert_eq!(
            f.search(
                MessageSearch {
                    id: Some(2),
                    ..Default::default()
                },
                Some(1),
                PageQuery::default()
            )
            .unwrap()["total"],
            0
        );
        assert_eq!(
            f.search(
                MessageSearch {
                    id: Some(1),
                    thread: Some(2),
                    ..Default::default()
                },
                None,
                PageQuery::default()
            )
            .unwrap()["total"],
            0
        );
        assert_eq!(
            f.app.message_for_thread(1, None, Some(2)).unwrap_err().0,
            404
        );
        assert_eq!(
            f.search(Fixture::text("needle"), Some(3), PageQuery::default())
                .unwrap_err()
                .0,
            400
        );
        assert_eq!(f.app.lock().db.total_changes(), before);
        assert_eq!(
            f.app.message_for(1, Some(1)).unwrap()["mark"],
            "in-progress"
        );
        assert_eq!(f.app.thread_metadata(1, None).unwrap()["last_read"], 0);
    }

    #[test]
    fn search_pages_are_bounded_exclusive_and_query_snapshot_bound() {
        let f = Fixture::new();
        for ascending in [false, true] {
            let mut q = PageQuery {
                after: ascending.then_some(0),
                limit: 1,
                max_bytes: 512,
                ..Default::default()
            };
            let mut all = Vec::new();
            loop {
                let page = f.search(Fixture::text("needle"), None, q.clone()).unwrap();
                assert!(page.to_string().len() <= 512);
                assert_eq!(page["total"], 4);
                all.extend(ids(&page));
                if page["has_more"] == false {
                    break;
                }
                q.before = page["next_before"].as_i64();
                q.after = page["next_after"].as_i64();
                q.through = page["through"].as_i64();
                q.revision = page["revision"].as_str().map(str::to_owned);
                for other in [
                    MessageSearch {
                        thread: Some(1),
                        ..Fixture::text("needle")
                    },
                    MessageSearch {
                        sender: Some(0),
                        ..Fixture::text("needle")
                    },
                    Fixture::text("other"),
                    MessageSearch {
                        from: Some(1),
                        ..Fixture::text("needle")
                    },
                    MessageSearch {
                        to: Some(30),
                        ..Fixture::text("needle")
                    },
                ] {
                    assert_eq!(f.search(other, None, q.clone()).unwrap_err().0, 409);
                }
            }
            assert_eq!(
                all,
                if ascending {
                    vec![1, 2, 3, 4]
                } else {
                    vec![4, 3, 2, 1]
                }
            );
        }
        let first = f
            .search(
                Fixture::text("needle"),
                None,
                PageQuery {
                    limit: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        let q = PageQuery {
            before: first["next_before"].as_i64(),
            through: first["through"].as_i64(),
            revision: first["revision"].as_str().map(str::to_owned),
            ..Default::default()
        };
        f.app
            .lock()
            .db
            .execute("UPDATE threads SET title='Changed' WHERE id=1", [])
            .unwrap();
        assert_eq!(
            f.search(Fixture::text("needle"), None, q).unwrap_err().0,
            409
        );
        let fresh = f
            .search(Fixture::text("needle"), None, PageQuery::default())
            .unwrap();
        assert_eq!(
            f.search(
                Fixture::text("needle"),
                None,
                PageQuery {
                    since: fresh["revision"].as_str().map(str::to_owned),
                    ..Default::default()
                }
            )
            .unwrap()["unchanged"],
            true
        );
    }

    #[test]
    fn invalid_search_filters_and_context_reject_without_writes() {
        let f = Fixture::new();
        let before = f.app.lock().db.total_changes();
        for filter in [
            MessageSearch::default(),
            MessageSearch {
                id: Some(1),
                ..Fixture::text("needle")
            },
            Fixture::text(""),
            Fixture::text(&"é".repeat(2049)),
            MessageSearch {
                id: Some(0),
                ..Default::default()
            },
            MessageSearch {
                thread: Some(0),
                ..Fixture::text("needle")
            },
            MessageSearch {
                threads: Some("".into()),
                ..Fixture::text("needle")
            },
            MessageSearch {
                threads: Some("1,,2".into()),
                ..Fixture::text("needle")
            },
            MessageSearch {
                threads: Some("0".into()),
                ..Fixture::text("needle")
            },
            MessageSearch {
                threads: Some(vec!["1"; 65].join(",")),
                ..Fixture::text("needle")
            },
            MessageSearch {
                thread: Some(1),
                threads: Some("1".into()),
                ..Fixture::text("needle")
            },
            MessageSearch {
                sender: Some(-1),
                ..Fixture::text("needle")
            },
            MessageSearch {
                sender: Some(3),
                ..Fixture::text("needle")
            },
            MessageSearch {
                thread: Some(3),
                ..Fixture::text("needle")
            },
            MessageSearch {
                from: Some(-1),
                ..Fixture::text("needle")
            },
            MessageSearch {
                to: Some(-1),
                ..Fixture::text("needle")
            },
            MessageSearch {
                from: Some(20),
                to: Some(10),
                ..Fixture::text("needle")
            },
        ] {
            assert_eq!(
                f.search(filter, None, PageQuery::default()).unwrap_err().0,
                400
            );
            assert_eq!(f.app.lock().db.total_changes(), before);
        }
        assert_eq!(
            f.search(
                MessageSearch {
                    thread: Some(2),
                    ..Fixture::text("needle")
                },
                Some(1),
                PageQuery::default()
            )
            .unwrap_err()
            .0,
            404
        );
        assert_eq!(
            f.search(
                MessageSearch {
                    threads: Some("999".into()),
                    ..Fixture::text("needle")
                },
                None,
                PageQuery::default()
            )
            .unwrap_err()
            .0,
            404
        );
        for (tid, target, viewer, limit, bytes, code) in [
            (1, 0, None, 50, 16000, 400),
            (1, 2, None, 50, 16000, 404),
            (2, 2, Some(1), 50, 16000, 404),
            (1, 1, None, 0, 16000, 400),
            (1, 1, None, 50, 511, 400),
        ] {
            assert_eq!(
                f.app
                    .message_context_page(tid, target, viewer, limit, bytes)
                    .unwrap_err()
                    .0,
                code
            );
        }
        assert_eq!(f.app.lock().db.total_changes(), before);
    }

    #[test]
    fn context_keeps_target_and_neighbors_and_can_page_without_duplicates() {
        let f = Fixture::new();
        for target in [1, 3, 4] {
            let page = f
                .app
                .message_context_page(1, target, Some(1), 2, 16000)
                .unwrap();
            assert!(ids(&page).contains(&target));
            assert_eq!(page["total"], 3);
            assert_eq!(page["through"], 4);
            assert_eq!(page["has_older"], page["oldest"] != 1);
            assert_eq!(page["has_newer"], page["newest"] != 4);
        }
        let middle = f.app.message_context_page(1, 3, None, 1, 16000).unwrap();
        assert_eq!(ids(&middle), vec![3]);
        assert_eq!(middle["has_older"], true);
        assert_eq!(middle["has_newer"], true);
        let old = f
            .app
            .messages_page(
                1,
                None,
                PageQuery {
                    before: Some(3),
                    through: Some(4),
                    ..Default::default()
                },
            )
            .unwrap();
        let new = f
            .app
            .messages_page(
                1,
                None,
                PageQuery {
                    after: Some(3),
                    through: Some(4),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(ids(&old), vec![1]);
        assert_eq!(ids(&new), vec![4]);
        assert_eq!(middle["revision"], new["revision"]);
        f.app
            .lock()
            .db
            .execute(
                "UPDATE messages SET text=?1 WHERE id=3",
                [format!("{} needle {}", "İ".repeat(5000), "🤖".repeat(5000))],
            )
            .unwrap();
        let before = f.app.lock().db.total_changes();
        let page = f.app.message_context_page(1, 3, None, 50, 512).unwrap();
        assert!(page.to_string().len() <= 512);
        assert!(ids(&page).contains(&3));
        assert_eq!(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == 3)
                .unwrap()["truncated"],
            true
        );
        let search = f
            .search(
                Fixture::text("needle"),
                None,
                PageQuery {
                    limit: 1,
                    after: Some(1),
                    max_bytes: 2048,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(
            search["items"][0]["snippet"]
                .as_str()
                .unwrap()
                .contains("needle")
        );
        assert_eq!(f.app.lock().db.total_changes(), before);
    }

    #[test]
    fn snippets_preserve_original_unicode_and_literal_markup() {
        assert_eq!(
            snippet("İSTANBUL `Code` <tag>", "i\u{307}stanbul"),
            "İSTANBUL `Code` <tag>"
        );
        let text = format!("{}MATCH{}", "İ".repeat(5000), "🤖".repeat(5000));
        let value = snippet(&text, "match");
        assert!(value.contains("MATCH"));
        assert!(value.len() <= 518);
    }
}
