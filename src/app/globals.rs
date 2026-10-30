use super::*;

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS global.global_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL
);";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GlobalSettings {
    pub usage_poll_secs: u64,
    pub metrics_sample_secs: u64,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            usage_poll_secs: 120,
            metrics_sample_secs: u64::from(crate::metrics::DEFAULT_INTERVAL_SECS),
        }
    }
}

impl GlobalSettings {
    pub fn check(&self) -> R<()> {
        if !(15..=3600).contains(&self.usage_poll_secs) {
            return Err(bad("usage check interval must be 15–3600 seconds"));
        }
        if !(1..=3600).contains(&self.metrics_sample_secs) {
            return Err(bad("metrics sampling interval must be 1–3600 seconds"));
        }
        Ok(())
    }
}

impl St {
    pub(crate) fn global_settings(&self) -> R<GlobalSettings> {
        let saved: Option<String> = self
            .db
            .query_row(
                "SELECT settings FROM global.global_settings WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let settings = match saved {
            Some(saved) => serde_json::from_str::<GlobalSettings>(&saved)
                .map_err(|e| Fail(500, format!("invalid stored global settings: {e}")))?,
            None => GlobalSettings::default(),
        };
        settings
            .check()
            .map_err(|error| Fail(500, format!("invalid stored global settings: {}", error.1)))?;
        Ok(settings)
    }
}

impl App {
    pub fn global_settings(&self) -> R<GlobalSettings> {
        self.lock().global_settings()
    }

    pub fn put_global_settings(&self, settings: GlobalSettings, by: &str) -> R<GlobalSettings> {
        settings.check()?;
        let mut st = self.lock();
        st.atomic(|st| {
            let previous = st.global_settings()?;
            if previous == settings {
                return Ok(());
            }
            st.db.execute(
                "INSERT INTO global.global_settings(id,settings) VALUES(1,?1)
                 ON CONFLICT(id) DO UPDATE SET settings=excluded.settings",
                [json!(settings).to_string()],
            )?;
            if previous.usage_poll_secs != settings.usage_poll_secs {
                let checks = rows(&st.db, "SELECT provider,attempted_at FROM global.usage_checks", [])?;
                for check in checks {
                    let provider = check["provider"].as_str().unwrap();
                    let resets = rows(
                        &st.db,
                        "SELECT resets_at FROM global.usage WHERE provider=?1 AND resets_at IS NOT NULL",
                        [provider],
                    )?;
                    let next = check["attempted_at"]
                        .as_i64()
                        .map_or_else(now, |attempted| {
                            crate::usage::next_check(
                                attempted,
                                settings.usage_poll_secs,
                                resets.iter().filter_map(|r| r["resets_at"].as_i64()),
                            )
                        });
                    st.db.execute(
                        "UPDATE global.usage_checks SET next_check=?2 WHERE provider=?1",
                        params![provider, next],
                    )?;
                }
            }
            st.log(None, by, "changed global server settings")?;
            Ok(())
        })?;
        self.cv.notify_all();
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestHome(PathBuf);

    impl TestHome {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "acom-global-settings-{}",
                crate::harness::new_uuid()
            )))
        }

        fn open(&self) -> Arc<App> {
            App::open(self.0.clone(), "http://127.0.0.1:0".into()).unwrap()
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn checks(app: &App) -> Value {
        json!(rows(
            &app.lock().db,
            "SELECT provider,checked_at,attempted_at,next_check,error,in_flight FROM global.usage_checks ORDER BY provider",
            [],
        )
        .unwrap())
    }

    #[test]
    fn global_intervals_are_explicit_and_bounded() {
        assert_eq!(GlobalSettings::default().usage_poll_secs, 120);
        assert_eq!(GlobalSettings::default().metrics_sample_secs, 5);
        for usage_poll_secs in [0, 14, 3601, u64::MAX] {
            assert!(
                GlobalSettings {
                    usage_poll_secs,
                    ..GlobalSettings::default()
                }
                .check()
                .is_err()
            );
        }
        for metrics_sample_secs in [0, 3601, u64::MAX] {
            assert!(
                GlobalSettings {
                    metrics_sample_secs,
                    ..GlobalSettings::default()
                }
                .check()
                .is_err()
            );
        }
        for json in [
            r#"{"usage_poll_secs":120,"metrics_sample_secs":5,"project":1}"#,
            r#"{"usage_poll_secs":120}"#,
            r#"{"usage_poll_secs":120,"metrics_sample_secs":1.5}"#,
        ] {
            assert!(serde_json::from_str::<GlobalSettings>(json).is_err());
        }
    }

    #[test]
    fn global_settings_persist_and_repeated_saves_are_noops() {
        let home = TestHome::new();
        let app = home.open();
        assert_eq!(app.global_settings().unwrap(), GlobalSettings::default());
        let initial_changes = app.lock().db.total_changes();
        app.put_global_settings(GlobalSettings::default(), "user")
            .unwrap();
        assert_eq!(app.lock().db.total_changes(), initial_changes);
        let saved = GlobalSettings {
            usage_poll_secs: 300,
            metrics_sample_secs: 2,
        };
        assert_eq!(
            app.put_global_settings(saved.clone(), "user").unwrap(),
            saved
        );
        let changed = app.lock().db.total_changes();
        app.put_global_settings(saved.clone(), "user").unwrap();
        assert_eq!(app.lock().db.total_changes(), changed);
        assert_eq!(
            app.lock()
                .db
                .query_row("SELECT count(*) FROM activity", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(app);
        let reopened = home.open();
        assert_eq!(reopened.global_settings().unwrap(), saved);
        assert!(
            !json!(reopened.settings(None))
                .as_object()
                .unwrap()
                .contains_key("usage_poll_secs")
        );
    }

    #[test]
    fn rejected_global_settings_leave_saved_state_and_schedules_unchanged() {
        let home = TestHome::new();
        let app = home.open();
        app.lock()
            .db
            .execute_batch(
                "INSERT INTO global.usage_checks(provider,next_check) VALUES('claude',17)",
            )
            .unwrap();
        let before = checks(&app);
        let changes = app.lock().db.total_changes();
        for invalid in [
            GlobalSettings {
                usage_poll_secs: 0,
                metrics_sample_secs: 5,
            },
            GlobalSettings {
                usage_poll_secs: 120,
                metrics_sample_secs: 0,
            },
            GlobalSettings {
                usage_poll_secs: 3601,
                metrics_sample_secs: 5,
            },
            GlobalSettings {
                usage_poll_secs: 120,
                metrics_sample_secs: 3601,
            },
        ] {
            assert_eq!(app.put_global_settings(invalid, "user").unwrap_err().0, 400);
            assert_eq!(app.global_settings().unwrap(), GlobalSettings::default());
            assert_eq!(checks(&app), before);
            assert_eq!(app.lock().db.total_changes(), changes);
        }
    }

    #[test]
    fn initial_checks_stay_due_and_reset_estimates_bound_rescheduling() {
        let home = TestHome::new();
        let app = home.open();
        let at = now();
        app.lock().db.execute(
            "INSERT INTO global.usage_checks(provider,attempted_at,next_check,in_flight) VALUES('claude',NULL,?1,0),('codex',?2,?3,1)",
            params![at,at-10,at+110],
        ).unwrap();
        app.lock().db.execute(
            "INSERT INTO global.usage(provider,win,used_pct,resets_at,at) VALUES('codex','codex primary',80,?1,?2)",
            params![at+20,at-10],
        ).unwrap();
        app.put_global_settings(
            GlobalSettings {
                usage_poll_secs: 3600,
                metrics_sample_secs: 5,
            },
            "user",
        )
        .unwrap();
        let value = checks(&app);
        assert!(
            value[0]["next_check"].as_i64().unwrap() <= now(),
            "a first check must not be postponed"
        );
        assert_eq!(value[1]["next_check"], at + 20);
        assert_eq!(value[1]["in_flight"], 1);
    }

    #[test]
    fn failed_global_settings_transaction_rolls_back_schedules_and_history() {
        let home = TestHome::new();
        let app = home.open();
        app.lock().db.execute_batch(
            "INSERT INTO global.usage_checks(provider,attempted_at,next_check) VALUES('claude',10,130);
             CREATE TRIGGER fail_global_log BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT,'injected log failure'); END;",
        ).unwrap();
        let before = checks(&app);
        let error = app
            .put_global_settings(
                GlobalSettings {
                    usage_poll_secs: 300,
                    metrics_sample_secs: 2,
                },
                "user",
            )
            .unwrap_err();
        assert!(error.1.contains("injected log failure"));
        assert_eq!(app.global_settings().unwrap(), GlobalSettings::default());
        assert_eq!(checks(&app), before);
        assert_eq!(
            app.lock()
                .db
                .query_row("SELECT count(*) FROM activity", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn in_flight_checks_finish_using_the_latest_global_interval() {
        for interval in [15, 3600] {
            for succeeds in [true, false] {
                let home = TestHome::new();
                let app = home.open();
                let at = now();
                app.lock().db.execute(
                    "INSERT INTO global.usage_checks(provider,checked_at,attempted_at,next_check,in_flight) VALUES('claude',?1,?2,?3,1)",
                    params![at-120,at-1,at+119],
                ).unwrap();
                app.lock().db.execute(
                    "INSERT INTO global.usage(provider,win,used_pct,at) VALUES('claude','five_hour',70,?1)",
                    [at-120],
                ).unwrap();
                app.put_global_settings(
                    GlobalSettings {
                        usage_poll_secs: interval,
                        metrics_sample_secs: 5,
                    },
                    "user",
                )
                .unwrap();
                assert_eq!(checks(&app)[0]["in_flight"], 1);
                let before = now();
                let result = if succeeds {
                    Ok(vec![crate::usage::Window {
                        name: "five_hour".into(),
                        used: 60.0,
                        reset: None,
                    }])
                } else {
                    Err("synthetic offline check".into())
                };
                crate::usage::finish(&app, "claude", result).unwrap();
                let after = now();
                let value = checks(&app);
                let next = value[0]["next_check"].as_i64().unwrap();
                assert!(
                    next >= before + interval as i64 && next <= after + interval as i64,
                    "interval {interval}, success {succeeds}: next={next}, before={before}, after={after}"
                );
                assert_eq!(value[0]["in_flight"], 0);
                assert_eq!(
                    value[0]["error"],
                    if succeeds {
                        Value::Null
                    } else {
                        json!("synthetic offline check")
                    }
                );
                if !succeeds {
                    assert_eq!(value[0]["checked_at"], at - 120);
                    assert_eq!(app.lock().db.query_row("SELECT used_pct FROM global.usage WHERE provider='claude' AND win='five_hour'",[],|row|row.get::<_,f64>(0)).unwrap(),70.0);
                }
            }
        }
    }

    #[test]
    fn completed_checks_keep_retained_window_deadlines_even_after_errors() {
        for succeeds in [true, false] {
            let home = TestHome::new();
            let app = home.open();
            let at = now();
            app.lock().db.execute(
                "INSERT INTO global.usage_checks(provider,checked_at,attempted_at,next_check,in_flight) VALUES('codex',?1,?2,?3,1)",
                params![at-120,at-1,at+119],
            ).unwrap();
            app.lock().db.execute(
                "INSERT INTO global.usage(provider,win,used_pct,resets_at,at) VALUES('codex','codex secondary',80,?1,?2)",
                params![at+300,at-120],
            ).unwrap();
            app.put_global_settings(
                GlobalSettings {
                    usage_poll_secs: 3600,
                    metrics_sample_secs: 5,
                },
                "user",
            )
            .unwrap();
            let result = if succeeds {
                Ok(vec![crate::usage::Window {
                    name: "codex primary".into(),
                    used: 20.0,
                    reset: None,
                }])
            } else {
                Err("synthetic offline check".into())
            };
            crate::usage::finish(&app, "codex", result).unwrap();
            assert_eq!(checks(&app)[0]["next_check"], at + 300);
            assert_eq!(
                app.lock()
                    .db
                    .query_row(
                        "SELECT at FROM global.usage WHERE provider='codex' AND win='codex secondary'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                at - 120
            );
        }
    }

    #[test]
    fn invalid_stored_global_settings_fail_without_falling_back_to_defaults() {
        let home = TestHome::new();
        let app = home.open();
        for settings in [
            r#"{"usage_poll_secs":120}"#,
            r#"{"usage_poll_secs":0,"metrics_sample_secs":5}"#,
            r#"{"usage_poll_secs":120,"metrics_sample_secs":5,"project":1}"#,
        ] {
            app.lock().db.execute(
                "INSERT INTO global.global_settings(id,settings) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings",
                [settings],
            ).unwrap();
            let before = app.lock().db.total_changes();
            let error = app.global_settings().unwrap_err();
            assert_eq!(error.0, 500);
            assert!(error.1.contains("invalid stored global settings"));
            assert_eq!(app.lock().db.total_changes(), before);
        }
    }
}
