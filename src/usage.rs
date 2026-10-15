// Read subscription status without running a model turn or spending reset credits.
use crate::app::{App, R, now, rows};
use rusqlite::params;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, mpsc};
use std::time::Duration;

#[derive(Debug)]
pub struct Window {
    pub name: String,
    pub used: f64,
    pub reset: Option<i64>,
}

pub fn parse(provider: &str, v: &Value) -> Result<Vec<Window>, String> {
    let mut out = Vec::new();
    let mut invalid = false;
    if provider == "claude" {
        let mut add = |name: &str, used: &Value, reset: &Value| {
            if let Some(used) = used.as_f64() {
                if !used.is_finite() || !(0.0..=100.0).contains(&used) {
                    invalid = true;
                    return;
                }
                let reset = reset
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|t| t.timestamp() + i64::from(t.timestamp_subsec_nanos() != 0));
                let name = crate::harness::claude_window_name(name);
                // Alternate provider representations can describe the same bucket.
                // Keep the highest reading instead of inserting duplicate DB keys.
                if let Some(old) = out.iter_mut().find(|w: &&mut Window| w.name == name) {
                    if used >= old.used {
                        old.used = used;
                        old.reset = reset;
                    }
                } else {
                    out.push(Window {
                        name: name.into(),
                        used,
                        reset,
                    });
                }
            }
        };
        for (name, w) in v.as_object().into_iter().flatten() {
            add(name, &w["utilization"], &w["resets_at"]);
        }
        // OAuth /usage reports model windows in limits[]; get_usage exposes
        // them as model_scoped[]. Neither omission nor null means zero usage.
        for row in v["limits"].as_array().into_iter().flatten() {
            if row["kind"] == "weekly_scoped"
                && is_fable_label(&row["scope"]["model"]["display_name"])
            {
                add("seven_day_fable", &row["percent"], &row["resets_at"]);
            }
        }
        for row in v["model_scoped"].as_array().into_iter().flatten() {
            if is_fable_label(&row["display_name"]) {
                add("seven_day_fable", &row["utilization"], &row["resets_at"]);
            }
        }
    } else {
        let buckets: Vec<(&str, &Value)> = match v["rateLimitsByLimitId"].as_object() {
            Some(m) if !m.is_empty() => m.iter().map(|(k, v)| (k.as_str(), v)).collect(),
            _ => vec![("codex", &v["rateLimits"])],
        };
        for (bucket, b) in buckets {
            for name in ["primary", "secondary"] {
                let w = &b[name];
                if let Some(used) = w["usedPercent"].as_f64() {
                    out.push(Window {
                        name: format!("{bucket} {name}"),
                        used,
                        reset: w["resetsAt"].as_i64(),
                    });
                }
            }
            let blocked = b["spendControlReached"] == true || !b["rateLimitReachedType"].is_null();
            let cleared = b["spendControlReached"] == false
                && b.get("rateLimitReachedType").is_some_and(Value::is_null);
            if blocked || cleared {
                out.push(Window {
                    name: format!("{bucket} account limit"),
                    used: if blocked { 100.0 } else { 0.0 },
                    reset: None,
                });
            }
        }
        if let Some(allowed) = v["ordinaryUsageAllowed"].as_bool() {
            out.push(Window {
                name: "account limit".into(),
                used: if allowed { 0.0 } else { 100.0 },
                reset: None,
            });
        }
    }
    if provider == "claude"
        && ["five_hour", "seven_day"]
            .iter()
            .any(|name| !out.iter().any(|w| w.name == *name))
    {
        return Err("Claude usage response omitted the five-hour or weekly window; keeping the last reading.".into());
    }
    if invalid
        || out.is_empty()
        || out
            .iter()
            .any(|w| !w.used.is_finite() || !(0.0..=100.0).contains(&w.used))
    {
        return Err(
            "Provider returned no usable subscription windows; keeping the last reading.".into(),
        );
    }
    Ok(out)
}

fn is_fable_label(value: &Value) -> bool {
    value.as_str().is_some_and(|label| {
        label.eq_ignore_ascii_case("Fable") || label.to_ascii_lowercase().starts_with("fable ")
    })
}

fn read(provider: &str) -> Result<Vec<Window>, String> {
    let value = if provider == "claude" {
        claude()?
    } else {
        codex()?
    };
    parse(provider, &value)
}

fn claude() -> Result<Value, String> {
    let home = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude")
        });
    let load = || -> Result<Value, String> {
        let bytes = std::fs::read(home.join(".credentials.json")).map_err(|_| "Claude subscription credentials unavailable. Sign in with claude; API-key-only usage cannot be checked.".to_string())?;
        serde_json::from_slice(&bytes)
            .map_err(|_| "Cannot read Claude subscription credentials.".to_string())
    };
    let token = if let Ok(token) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
        token
    } else {
        let mut credentials = load()?;
        if credentials["claudeAiOauth"]["expiresAt"]
            .as_i64()
            .is_some_and(|t| t <= (now() + 60) * 1000)
        {
            refresh_claude(&credentials["claudeAiOauth"], "claude")?;
            credentials = load()?;
        }
        credentials["claudeAiOauth"]["accessToken"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Claude OAuth access token unavailable.")?
            .to_string()
    };
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(12)))
            .build(),
    );
    let mut response = agent.get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20").call()
        .map_err(|_| "Claude usage check failed. The login may have expired or the provider is unavailable; agents stay paused until usage is confirmed.".to_string())?;
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|_| "Cannot read Claude usage response.".to_string())?;
    serde_json::from_str(&body).map_err(|_| "Invalid Claude usage response.".to_string())
}

// Let the installed CLI renew its own login instead of maintaining another token store.
fn refresh_claude(oauth: &Value, program: &str) -> Result<(), String> {
    let token = oauth["refreshToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Claude login expired. Run claude auth login.")?;
    let scopes = oauth["scopes"]
        .as_array()
        .ok_or("Claude login scopes unavailable. Run claude auth login.")?
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    if scopes.is_empty() {
        return Err("Claude login scopes unavailable. Run claude auth login.".into());
    }
    let mut child = Command::new(program)
        .args(["auth", "login"])
        .env("CLAUDE_CODE_OAUTH_REFRESH_TOKEN", token)
        .env("CLAUDE_CODE_OAUTH_SCOPES", scopes)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|_| "Cannot refresh Claude login. Run claude auth login.".to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(12);
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err("Claude login refresh failed. Run claude auth login.".into())
                };
            }
            Err(_) => break Err("Cannot check Claude login refresh.".into()),
            _ if std::time::Instant::now() >= deadline => {
                break Err(
                    "Claude login refresh timed out; keeping the last usage reading.".into(),
                );
            }
            _ => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    crate::run::kill_group(child.id(), libc::SIGKILL);
    let _ = child.wait();
    result
}

fn codex() -> Result<Value, String> {
    let mut child = Command::new("codex")
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|_| "Cannot start codex app-server for the subscription check.".to_string())?;
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line)
                && tx.send(v).is_err()
            {
                break;
            }
        }
    });
    let result = (|| {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(stdin, "{}", json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"acom","title":"acom","version":env!("CARGO_PKG_VERSION")}}}))
            .map_err(|_| "Codex usage check pipe closed.".to_string())?;
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let v = rx.recv_timeout(remaining).map_err(|_| {
                "Codex usage check timed out; keeping the last reading.".to_string()
            })?;
            if v["id"] == 1 {
                if !v["error"].is_null() {
                    return Err("Codex app-server initialization failed.".into());
                }
                writeln!(
                    stdin,
                    "{}\n{}",
                    json!({"method":"initialized"}),
                    json!({"id":2,"method":"account/rateLimits/read"})
                )
                .map_err(|_| "Codex usage check pipe closed.".to_string())?;
            } else if v["id"] == 2 {
                return if v["error"].is_null() {
                    Ok(v["result"].clone())
                } else {
                    Err("Codex could not read subscription usage. Check sign-in; API-key-only usage is unavailable.".into())
                };
            }
        }
    })();
    drop(child.stdin.take());
    crate::run::kill_group(child.id(), libc::SIGKILL);
    let _ = child.wait();
    let _ = reader.join();
    result
}

/// Earliest of the periodic check and a provider-reported reset not already checked.
pub fn next_check(at: i64, interval: u64, resets: impl Iterator<Item = i64>) -> i64 {
    resets
        .filter(|r| *r > at)
        .fold(at + interval as i64, |n, r| n.min(r))
}

pub fn schedule(app: &Arc<App>) -> R<()> {
    let mut due = Vec::new();
    {
        let st = app.lock();
        let projects = rows(&st.db, "SELECT id FROM projects", [])?;
        let interval = projects
            .iter()
            .map(|p| st.settings_for(p["id"].as_i64()).usage_poll_secs)
            .min()
            .unwrap_or_else(|| st.settings_for(None).usage_poll_secs);
        for provider in crate::harness::KNOWN {
            st.db.execute(
                "INSERT OR IGNORE INTO usage_checks(provider,next_check) VALUES(?1,?2)",
                params![provider, now()],
            )?;
            let (attempt, next, busy): (Option<i64>, i64, bool) = st.db.query_row("SELECT attempted_at, coalesce(next_check,0),in_flight FROM usage_checks WHERE provider=?1", [provider], |r| Ok((r.get(0)?, r.get(1)?,r.get(2)?)))?;
            if busy {
                continue;
            }
            let resets = rows(
                &st.db,
                "SELECT resets_at FROM usage WHERE provider=?1 AND resets_at IS NOT NULL",
                [provider],
            )?;
            let reset_due = resets.iter().any(|r| {
                r["resets_at"]
                    .as_i64()
                    .is_some_and(|t| t <= now() && t > attempt.unwrap_or(0))
            });
            if next <= now() || reset_due || attempt.is_some_and(|t| t + interval as i64 <= now()) {
                // Reserve before releasing the mutex; at most one request per provider at a time.
                st.db.execute("UPDATE usage_checks SET attempted_at=?2,next_check=?3,in_flight=1 WHERE provider=?1", params![provider, now(), now()+interval as i64])?;
                due.push((provider.to_string(), interval));
            }
        }
    }
    for (provider, interval) in due {
        let app = app.clone();
        std::thread::spawn(move || {
            let result = read(&provider);
            if let Err(e) = finish(&app, &provider, interval, result) {
                let st = app.lock();
                let _ = st.db.execute(
                    "UPDATE usage_checks SET in_flight=0,error=?2 WHERE provider=?1",
                    params![
                        provider,
                        "Could not save usage status; keeping the last reading."
                    ],
                );
                eprintln!("usage check: {}", e.1);
            }
        });
    }
    Ok(())
}

pub fn finish(
    app: &Arc<App>,
    provider: &str,
    interval: u64,
    result: Result<Vec<Window>, String>,
) -> R<()> {
    let st = app.lock();
    match result {
        Ok(mut windows) => {
            let marker = rows(
                &st.db,
                "SELECT at FROM usage WHERE provider=?1 AND win='limit' AND at>=coalesce((SELECT attempted_at FROM usage_checks WHERE provider=?1),0)",
                [provider],
            )?;
            if !marker.is_empty()
                && windows
                    .iter()
                    .filter(|w| w.name != "seven_day_fable")
                    .all(|w| w.used < 100.0)
            {
                windows.push(Window {
                    name: "limit".into(),
                    used: 100.0,
                    reset: None,
                });
            }
            // A check begun before a Fable exhaustion event cannot clear it.
            let fable_marker = rows(&st.db, "SELECT at FROM usage WHERE provider=?1 AND win='seven_day_fable'
                AND used_pct>=100 AND at>=coalesce((SELECT attempted_at FROM usage_checks WHERE provider=?1),0)", [provider])?;
            if !fable_marker.is_empty() {
                windows.retain(|w| w.name != "seven_day_fable");
            }
            let tx = st.db.unchecked_transaction()?;
            // An omitted optional Fable bucket is unknown, not proof of reset.
            // Retain its last confirmed reading until a new one replaces it.
            for w in &windows {
                st.observe_usage(provider, &w.name, w.used, w.reset)?;
            }
            let names: Vec<_> = windows.iter().map(|w| w.name.as_str()).collect();
            tx.execute("DELETE FROM usage WHERE provider=?1 AND NOT (provider='claude' AND win='seven_day_fable') AND NOT EXISTS(SELECT 1 FROM json_each(?2) WHERE value=usage.win)",params![provider,serde_json::json!(names).to_string()])?;
            let next = next_check(now(), interval, windows.iter().filter_map(|w| w.reset));
            tx.execute("INSERT INTO usage_checks(provider,checked_at,attempted_at,next_check,error) VALUES(?1,?2,?2,?3,NULL)
                ON CONFLICT(provider) DO UPDATE SET checked_at=?2,next_check=?3,error=NULL,in_flight=0", params![provider,now(),next])?;
            tx.commit()?;
        }
        Err(error) => {
            st.db.execute(
                "UPDATE usage_checks SET next_check=?2,error=?3,in_flight=0 WHERE provider=?1",
                params![provider, now() + interval as i64, error],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resets_and_poll_interval_both_schedule_checks() {
        assert_eq!(next_check(100, 120, [150, 900].into_iter()), 150);
        assert_eq!(next_check(100, 120, [90, 900].into_iter()), 220);
    }
    #[test]
    fn provider_responses_and_unknowns() {
        let a = parse(
            "claude",
            &json!({"five_hour":{"utilization":100,"resets_at":"2026-10-08T11:30:00Z"},"seven_day":{"utilization":0}}),
        )
        .unwrap();
        assert_eq!(a[0].used, 100.0);
        assert!(a[0].reset.is_some());
        let b = parse("codex", &json!({"rateLimits":{"primary":{"usedPercent":12,"resetsAt":99}},"ordinaryUsageAllowed":false})).unwrap();
        assert_eq!(b[1].used, 100.0);
        assert!(parse("claude", &json!({})).is_err());
        assert!(parse("claude", &json!({"five_hour":{"utilization":0}})).is_err());
    }

    #[test]
    fn usage_windows_are_complete_and_invalid_readings_do_not_clear_limits() {
        let value = json!({"rateLimits":{"primary":{"usedPercent":0}},"rateLimitsByLimitId":{
            "codex":{"primary":{"usedPercent":10},"secondary":{"usedPercent":100,"resetsAt":999}},
            "other":{"primary":{"usedPercent":20}}
        }});
        let windows = parse("codex", &value).unwrap();
        assert_eq!(windows.len(), 3);
        assert!(
            windows
                .iter()
                .any(|w| w.name == "codex secondary" && w.used == 100.0)
        );
        assert!(
            parse(
                "codex",
                &json!({"rateLimits":{"primary":{"usedPercent":-1}}})
            )
            .is_err()
        );
        assert!(
            parse(
                "codex",
                &json!({"rateLimits":{"primary":{"usedPercent":null}}})
            )
            .is_err()
        );
        let windows = parse("claude", &json!({"five_hour":{"utilization":100,"resets_at":"2026-10-08T17:00:00+05:30"},"seven_day":{"utilization":56}})).unwrap();
        assert_eq!(
            windows
                .iter()
                .find(|w| w.name == "five_hour")
                .unwrap()
                .reset,
            Some(1791459000)
        );
        assert_eq!(windows.len(), 2);
        assert_eq!(
            parse(
                "claude",
                &json!({"five_hour":{"utilization":100,"resets_at":"2026-10-08T11:30:00.254Z"},"seven_day":{"utilization":0}})
            )
            .unwrap()[0]
                .reset,
            Some(1791459001)
        );
    }

    #[test]
    fn codex_derived_account_windows_require_explicit_clear_evidence() {
        let windows = parse(
            "codex",
            &json!({"rateLimits":{
            "primary":{"usedPercent":10},"spendControlReached":false,"rateLimitReachedType":null
        },"ordinaryUsageAllowed":true}),
        )
        .unwrap();
        for name in ["codex account limit", "account limit"] {
            assert!(
                windows
                    .iter()
                    .any(|window| window.name == name && window.used == 0.0)
            );
        }
        for flags in [
            json!({}),
            json!({"spendControlReached":false}),
            json!({"rateLimitReachedType":null}),
        ] {
            let mut bucket = flags;
            bucket["primary"] = json!({"usedPercent":10});
            let windows = parse("codex", &json!({"rateLimits":bucket})).unwrap();
            assert!(
                windows
                    .iter()
                    .all(|window| !window.name.contains("account limit")),
                "missing flags are not evidence of availability"
            );
        }
        let windows = parse("codex",&json!({"rateLimitsByLimitId":{
            "other":{"primary":{"usedPercent":10},"spendControlReached":false,"rateLimitReachedType":null}
        },"ordinaryUsageAllowed":true})).unwrap();
        assert!(
            !windows
                .iter()
                .any(|window| window.name == "codex account limit"),
            "an absent bucket is not recovered"
        );
        let windows = parse(
            "codex",
            &json!({"rateLimits":{
            "primary":{"usedPercent":10},"spendControlReached":false,"rateLimitReachedType":"weekly"
        },"ordinaryUsageAllowed":false}),
        )
        .unwrap();
        assert_eq!(
            windows
                .iter()
                .filter(|window| window.name.contains("account limit") && window.used == 100.0)
                .count(),
            2
        );
    }

    #[test]
    fn fable_weekly_usage_handles_oauth_and_cli_representations() {
        let mut value = json!({
            "five_hour":{"utilization":10}, "seven_day":{"utilization":20},
            "limits":[
                {"kind":"weekly_scoped","percent":87,"resets_at":"2026-10-08T11:30:00Z","scope":{"model":{"display_name":"Fable 5.1"}}},
                {"kind":"weekly_scoped","percent":100,"scope":{"model":{"display_name":"Other"}}},
                {"kind":"daily_scoped","percent":100,"scope":{"model":{"display_name":"Fable"}}}
            ]
        });
        let windows = parse("claude", &value).unwrap();
        assert_eq!(windows.len(), 3);
        let fable = windows
            .iter()
            .find(|w| w.name == "seven_day_fable")
            .unwrap();
        assert_eq!(fable.used, 87.0);
        assert_eq!(fable.reset, Some(1791459000));
        value["model_scoped"] = json!([{"display_name":"fable","utilization":90}]);
        value["seven_day_fable"] = json!({"utilization":0});
        value["seven_day_overage_included"] = json!({"utilization":80});
        let windows = parse("claude", &value).unwrap();
        assert_eq!(windows.len(), 3);
        assert_eq!(
            windows
                .iter()
                .find(|w| w.name == "seven_day_fable")
                .unwrap()
                .used,
            90.0
        );
        value["model_scoped"][0]["utilization"] = json!(-1);
        assert!(parse("claude", &value).is_err());
    }

    #[test]
    fn fable_window_is_optional_but_zero_is_a_real_reading() {
        let mut value = json!({"five_hour":{"utilization":10},"seven_day":{"utilization":20}});
        for optional in [Value::Null, json!({"utilization":null})] {
            value["seven_day_fable"] = optional;
            assert_eq!(parse("claude", &value).unwrap().len(), 2);
        }
        value["limits"] = json!([{"kind":"weekly_scoped","percent":null,"scope":{"model":{"display_name":"Fable"}}}]);
        value["model_scoped"] = json!([{"display_name":"Fable","utilization":null}]);
        assert_eq!(parse("claude", &value).unwrap().len(), 2);
        value["seven_day_fable"] = json!({"utilization":0});
        let windows = parse("claude", &value).unwrap();
        assert_eq!(
            windows
                .iter()
                .find(|w| w.name == "seven_day_fable")
                .unwrap()
                .used,
            0.0
        );
        value.as_object_mut().unwrap().remove("seven_day");
        assert!(parse("claude", &value).is_err());
    }

    #[test]
    fn login_renewal_requires_refresh_credentials_and_a_successful_cli() {
        assert!(refresh_claude(&json!({}), "/usr/bin/true").is_err());
        assert!(
            refresh_claude(
                &json!({"refreshToken":"example","scopes":[]}),
                "/usr/bin/true"
            )
            .is_err()
        );
        let oauth = json!({"refreshToken":"example","scopes":["user:profile","user:inference"]});
        assert!(refresh_claude(&oauth, "/usr/bin/true").is_ok());
        assert!(refresh_claude(&oauth, "/usr/bin/false").is_err());
    }
}
