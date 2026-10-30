use super::*;

impl App {
    pub fn user_draft(&self, thread: i64) -> R<Value> {
        let st = self.lock();
        Self::require_thread_read(&st, thread, 0)?;
        Ok(rows(
            &st.db,
            "SELECT thread_id thread,text,version,updated_at FROM user_drafts WHERE thread_id=?",
            [thread],
        )?
        .pop()
        .unwrap_or_else(|| json!({"thread":thread,"text":"","version":"empty","updated_at":null})))
    }

    pub fn save_user_draft(&self, thread: i64, text: &str, version: &str) -> R<Value> {
        if text.len() > 1024 * 1024 {
            return Err(bad("draft text exceeds 1 MiB"));
        }
        if version != "empty"
            && (version.len() != 36 || crate::workspace::validate_uuid(version).is_err())
        {
            return Err(bad("invalid draft version"));
        }
        let mut st = self.lock();
        st.atomic(|st| {
            Self::require_thread_read(st, thread, 0)?;
            let current: Option<(String,String)> = st.db.query_row("SELECT text,version FROM user_drafts WHERE thread_id=?",[thread],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if current.as_ref().map(|(_,v)|v.as_str()).unwrap_or("empty") != version {
                return Err(conflict("draft changed elsewhere; reload before saving"));
            }
            if current.as_ref().is_some_and(|(old,_)|old == text) {
                return Ok(json!({"saved":true,"thread":thread,"version":version}));
            }
            let version = crate::harness::try_new_uuid().map_err(|e|Fail(500,e.to_string()))?;
            st.db.execute("INSERT INTO user_drafts(thread_id,text,version,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(thread_id) DO UPDATE SET text=excluded.text,version=excluded.version,updated_at=excluded.updated_at",params![thread,text,version,now()])?;
            Ok(json!({"saved":true,"thread":thread,"version":version}))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drafts_compare_and_swap_without_overwriting_another_tab() {
        let root =
            std::env::temp_dir().join(format!("acom-draft-test-{}", crate::harness::new_uuid()));
        let app = App::open(root.clone(), "http://localhost:1".into()).unwrap();
        app.lock().db.execute_batch("INSERT INTO projects(id,path,name,created_at) VALUES(1,'/example','Example',0); INSERT INTO threads VALUES(1,1,'Notes',0,0);").unwrap();
        assert_eq!(app.user_draft(1).unwrap()["version"], "empty");
        let saved = app.save_user_draft(1, "unsent text", "empty").unwrap();
        assert_eq!(
            app.save_user_draft(1, "lost write", "empty").unwrap_err().0,
            409
        );
        assert_eq!(app.user_draft(1).unwrap()["text"], "unsent text");
        assert_eq!(
            app.save_user_draft(1, "unsent text", saved["version"].as_str().unwrap())
                .unwrap()["version"],
            saved["version"]
        );
        assert_eq!(
            app.save_user_draft(2, "missing", "empty").unwrap_err().0,
            404
        );
        drop(app);
        let app = App::open(root.clone(), "http://localhost:1".into()).unwrap();
        assert_eq!(app.user_draft(1).unwrap()["text"], "unsent text");
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }
}
