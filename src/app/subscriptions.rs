use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageWatch {
    pub provider: String,
    pub window: String,
    pub condition: String,
    pub percent: Option<f64>,
}

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS subscriptions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, agent INTEGER NOT NULL, project INTEGER NOT NULL,
 mode TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', watch TEXT NOT NULL,
 created_at INTEGER NOT NULL, deadline INTEGER, cursor INTEGER NOT NULL,
 completed_at INTEGER, completion TEXT);
CREATE INDEX IF NOT EXISTS subscriptions_owner ON subscriptions(agent,state,id);
CREATE TABLE IF NOT EXISTS subscription_updates (
 id INTEGER PRIMARY KEY AUTOINCREMENT, subscription INTEGER NOT NULL, agent INTEGER NOT NULL,
 at INTEGER NOT NULL, event_key TEXT NOT NULL, cause TEXT NOT NULL,
 delivered INTEGER NOT NULL DEFAULT 0, delivery_id INTEGER,
 UNIQUE(subscription,event_key));
CREATE INDEX IF NOT EXISTS subscription_pending ON subscription_updates(agent,delivered,id);
CREATE TABLE IF NOT EXISTS subscription_starts (agent INTEGER PRIMARY KEY, at INTEGER NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS usage_reset_notices (
 provider TEXT NOT NULL, win TEXT NOT NULL, resets_at INTEGER NOT NULL,
 PRIMARY KEY(provider,win,resets_at));
CREATE TABLE IF NOT EXISTS usage_observations (
 provider TEXT NOT NULL, win TEXT NOT NULL, used_pct REAL NOT NULL, resets_at INTEGER, at INTEGER NOT NULL,
 PRIMARY KEY(provider,win));
INSERT OR IGNORE INTO usage_observations(provider,win,used_pct,resets_at,at)
 SELECT provider,win,used_pct,resets_at,at FROM usage;
";

fn standard_windows(provider: &str) -> &'static [&'static str] {
    match provider {
        "claude" => &["five_hour", "seven_day", "seven_day_fable"],
        "codex" => &[
            "codex primary",
            "codex secondary",
            "codex account limit",
            "account limit",
        ],
        _ => &[],
    }
}

pub(super) fn known_windows(st: &St, provider: &str) -> R<Vec<String>> {
    let mut names: BTreeSet<String> = standard_windows(provider)
        .iter()
        .map(|name| (*name).into())
        .collect();
    for row in rows(
        &st.db,
        "SELECT win FROM usage WHERE provider=?1 UNION SELECT win FROM usage_observations WHERE provider=?1",
        [provider],
    )? {
        names.insert(row["win"].as_str().unwrap().into());
    }
    Ok(names.into_iter().collect())
}

pub(super) fn normalize_usage(st: &St, watch: &UsageWatch) -> R<UsageWatch> {
    if !crate::harness::KNOWN.contains(&watch.provider.as_str()) {
        return Err(bad("usage provider must be claude or codex"));
    }
    if watch.window.trim().is_empty() || watch.window.len() > 256 {
        return Err(bad("usage window must contain 1–256 bytes"));
    }
    match watch.condition.as_str() {
        "above" | "below"
            if watch
                .percent
                .is_some_and(|n| n.is_finite() && (0.0..=100.0).contains(&n)) => {}
        "reset" | "reset-due" if watch.percent.is_none() => {}
        _ => {
            return Err(bad(
                "usage condition is above/below with percent 0–100, or reset/reset-due without percent",
            ));
        }
    }
    let mut watch = watch.clone();
    if watch.provider == "claude" {
        watch.window = match watch.window.as_str() {
            "five-hour" => "five_hour",
            "weekly" => "seven_day",
            "weekly Fable" => "seven_day_fable",
            window => window,
        }
        .into();
    }
    let builtins = standard_windows(&watch.provider);
    let known = builtins.contains(&watch.window.as_str())
        || st.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM usage WHERE provider=?1 AND win=?2 UNION ALL SELECT 1 FROM usage_observations WHERE provider=?1 AND win=?2)",
            params![watch.provider, watch.window],
            |row| row.get::<_, bool>(0),
        )?;
    if !known {
        let mut choices: BTreeSet<String> = builtins.iter().map(|s| (*s).into()).collect();
        for row in rows(
            &st.db,
            "SELECT win FROM usage WHERE provider=?1 UNION SELECT win FROM usage_observations WHERE provider=?1 ORDER BY win LIMIT 13",
            [&watch.provider],
        )? {
            choices.insert(row["win"].as_str().unwrap().into());
        }
        let more = choices.len() > 12;
        let choices = choices
            .into_iter()
            .take(12)
            .map(|name| {
                let short: String = name.chars().take(64).collect();
                json!(if short.len() < name.len() {
                    format!("{short}…")
                } else {
                    short
                })
                .to_string()
            })
            .collect::<Vec<_>>()
            .join(", ");
        return Err(bad(format!(
            "unknown usage window {:?} for {}; recognized IDs: {choices}{}. Use acom limits for current window IDs",
            watch.window,
            watch.provider,
            if more { ", …" } else { "" }
        )));
    }
    Ok(watch)
}

fn ceiling(st: &St) -> R<i64> {
    Ok(st
        .db
        .query_row("SELECT coalesce(max(id),0) FROM events", [], |r| r.get(0))?)
}

pub(super) fn events(
    st: &St,
    owner: i64,
    watch: &AgentWatch,
    after: i64,
    through: i64,
    limit: i64,
    deadline: Option<i64>,
) -> R<Vec<Value>> {
    let (all, ids) = match &watch.agents {
        Some(WaitAgents::All(_)) => (true, json!([])),
        Some(WaitAgents::Selected(ids)) => (false, json!(ids)),
        None => (false, json!([])),
    };
    let u = watch.usage.as_ref();
    App::event_rows(st, "SELECT id,at,kind,agent,thread,
      CASE WHEN length(CAST(details AS BLOB))>4096 THEN json_object('summary','Details shortened; read this event with acom history') ELSE details END details
      FROM events WHERE project=?1 AND id>?2 AND id<=?3 AND (?13 IS NULL OR at<?13) AND (
       (((?4 AND agent<>?5) OR EXISTS(SELECT 1 FROM json_each(?6) WHERE value=events.agent)) AND (
         (kind='agent.state' AND EXISTS(SELECT 1 FROM json_each(?7) WHERE value=json_extract(details,'$.to')))
         OR (kind='agent.created' AND EXISTS(SELECT 1 FROM json_each(?7) WHERE value=json_extract(details,'$.state')))
         OR (kind='agent.failed' AND EXISTS(SELECT 1 FROM json_each(?7) WHERE value='crashed'))
         OR (kind='agent.replaced' AND EXISTS(SELECT 1 FROM json_each(?7) WHERE value='replaced'))
         OR (kind='agent.status' AND ?8)))
       OR (json_extract(details,'$.provider')=?9 AND json_extract(details,'$.window')=?10 AND (
         (kind='usage.reset-due' AND ?11='reset-due') OR (kind='usage.observed' AND (
          (?11='reset' AND json_extract(details,'$.reset')=1)
          OR (?11='above' AND json_extract(details,'$.used')>?12 AND (json_extract(details,'$.before_used') IS NULL OR json_extract(details,'$.before_used')<=?12))
          OR (?11='below' AND json_extract(details,'$.used')<?12 AND (json_extract(details,'$.before_used') IS NULL OR json_extract(details,'$.before_used')>=?12)))))))
      ORDER BY id LIMIT ?14",
      params![st.agent(owner)?.project,after,through,all,owner,ids.to_string(),json!(watch.states).to_string(),watch.status_text,
        u.map(|u|u.provider.as_str()),u.map(|u|u.window.as_str()),u.map(|u|u.condition.as_str()),u.and_then(|u|u.percent),deadline,limit])
}

pub(super) fn event_cause(event: &Value) -> Value {
    let details = event["details"].to_string();
    let excerpt: String = details.chars().take(300).collect();
    let actor = event["agent"]
        .as_i64()
        .map(|id| format!("agent {id} "))
        .unwrap_or_default();
    json!({"kind":"event","event":event["id"],"agent":event["agent"],"event_kind":event["kind"],
      "summary":format!("Event #{}: {}{} {}{}",event["id"],actor,event["kind"].as_str().unwrap_or(""),excerpt,if details.chars().count()>300 {"…; read acom history"}else{""})})
}

pub(super) fn initial_usage(st: &St, watch: &UsageWatch) -> R<Option<Value>> {
    let current = rows(
        &st.db,
        "SELECT used_pct used,resets_at,at FROM usage WHERE provider=?1 AND win=?2",
        params![watch.provider, watch.window],
    )?
    .pop();
    let missing = current.is_none();
    let current = match current {
        Some(value) => Some(value),
        None => rows(&st.db,"SELECT used_pct used,resets_at,at FROM usage_observations WHERE provider=?1 AND win=?2",params![watch.provider,watch.window])?.pop(),
    };
    let Some(current) = current else {
        return Ok(None);
    };
    let used = current["used"].as_f64().unwrap_or(0.0);
    let matches = match watch.condition.as_str() {
        "above" => used > watch.percent.unwrap(),
        "below" => used < watch.percent.unwrap(),
        "reset-due" => current["resets_at"].as_i64().is_some_and(|at| at <= now()),
        _ => false,
    };
    Ok(matches.then(||json!({"kind":"usage","provider":watch.provider,"window":watch.window,"used":used,"observed_at":current["at"],"stale":missing,
        "summary":format!("{} {}: last observed usage {}%{}{}",watch.provider,watch.window,used,if missing {"; window absent from latest status"}else{""},if watch.condition=="reset-due" {"; estimated reset is due, recovery is not confirmed"}else{""})})))
}

fn enqueue(st: &St, sub: &Value, key: &str, cause: Value) -> R<()> {
    let id = sub["id"].as_i64().unwrap();
    let agent = sub["agent"].as_i64().unwrap();
    if sub["mode"] == "once" {
        let changed = st.db.execute("UPDATE subscriptions SET state='resolved',completed_at=?2,completion=?3 WHERE id=?1 AND state='active'",params![id,now(),cause.to_string()])?;
        if changed == 0 {
            return Ok(());
        }
    }
    let inserted = st.db.execute("INSERT OR IGNORE INTO subscription_updates(subscription,agent,at,event_key,cause) VALUES(?1,?2,?3,?4,?5)",params![id,agent,now(),key,cause.to_string()])?;
    if inserted > 0 {
        st.event(sub["project"].as_i64().unwrap(),Some(agent),cause["thread"].as_i64(),
            if sub["mode"]=="once" {"subscription.resolved"}else{"subscription.matched"},"acom",
            json!({"subscription":id,"cause":cause,"timeout_canceled":sub["mode"]=="once" && cause["kind"]!="timeout"}))?;
    }
    Ok(())
}

fn row(st: &St, id: i64) -> R<Value> {
    let mut row = rows(&st.db, "SELECT * FROM subscriptions WHERE id=?1", [id])?
        .pop()
        .ok_or_else(|| not_found(format!("no subscription {id}")))?;
    row["watch"] = serde_json::from_str(row["watch"].as_str().unwrap())
        .map_err(|_| bad("invalid saved subscription"))?;
    if let Some(value) = row["completion"].as_str() {
        row["completion"] =
            serde_json::from_str(value).map_err(|_| bad("invalid saved completion"))?;
    }
    Ok(row)
}

pub(super) fn pending(st: &St, agent: i64) -> R<bool> {
    Ok(st.db.query_row("SELECT EXISTS(SELECT 1 FROM subscription_updates u LEFT JOIN update_deliveries d ON d.id=u.delivery_id WHERE u.agent=?1 AND (u.delivered=0 OR d.text IS NOT NULL))",[agent],|r|r.get(0))?)
}

pub(super) fn process(st: &St) -> R<()> {
    reset_due(st)?;
    super::diagnostics::check(st)?;
    let through = ceiling(st)?;
    for sub in rows(
        &st.db,
        "SELECT * FROM subscriptions WHERE state='active' ORDER BY id",
        [],
    )? {
        let id = sub["id"].as_i64().unwrap();
        let owner = sub["agent"].as_i64().unwrap();
        if st.agent(owner)?.state == "replaced" {
            continue;
        }
        let watch: AgentWatch = serde_json::from_str(sub["watch"].as_str().unwrap())
            .map_err(|_| bad("invalid saved subscription"))?;
        let deadline = sub["deadline"].as_i64();
        if sub["mode"] == "once" {
            let message=rows(&st.db,"SELECT m.id,m.thread_id,m.sender FROM messages m JOIN members b ON b.thread_id=m.thread_id AND b.agent_id=?1
             WHERE m.id>b.last_notified AND m.sender<>?1 AND (?2 IS NULL OR m.at<?2)
             AND EXISTS(SELECT 1 FROM member_intervals i WHERE i.thread_id=m.thread_id AND i.agent_id=?1 AND m.id>i.start_after AND (i.end_after IS NULL OR m.id<=i.end_after)) ORDER BY m.id LIMIT 1",params![owner,deadline])?.pop();
            let cause=if let Some(message)=message {
                Some(json!({"kind":"message","message":message["id"],"thread":message["thread_id"],"agent":message["sender"],"summary":format!("message #{} in thread #{}",message["id"],message["thread_id"])}))
            } else if let Some(notice)=rows(&st.db,"SELECT id FROM notices WHERE agent_id=?1 AND shown=0 AND (?2 IS NULL OR at<?2) ORDER BY id LIMIT 1",params![owner,deadline])?.pop() {
                Some(json!({"kind":"notice","notice":notice["id"],"summary":format!("notice #{}",notice["id"])}))
            } else if let Some(change)=rows(&st.db,"SELECT id,kind,thread FROM events WHERE agent=?1 AND id>coalesce((SELECT event_id FROM summary_cursors WHERE agent_id=?1),0) AND kind LIKE 'lock.%' AND (?2 IS NULL OR at<?2) ORDER BY id LIMIT 1",params![owner,deadline])?.pop() {
                Some(json!({"kind":"coordination","event":change["id"],"thread":change["thread"],"summary":format!("your {} update (event #{})",change["kind"].as_str().unwrap_or("coordination"),change["id"])}))
            } else {
                rows(&st.db,"SELECT id FROM update_deliveries WHERE agent_id=?1 AND text IS NOT NULL ORDER BY id LIMIT 1",[owner])?.pop().filter(|_| deadline.is_none_or(|at| now()<at)).map(|receipt|
                    json!({"kind":"delivery","delivery":receipt["id"],"summary":format!("pending notification delivery #{}",receipt["id"])}))
            };
            if let Some(cause) = cause {
                enqueue(st, &sub, "resolved", cause)?;
                continue;
            }
        }
        let candidates = events(
            st,
            owner,
            &watch,
            sub["cursor"].as_i64().unwrap(),
            through,
            51,
            deadline,
        )?;
        let mut cursor = through;
        for event in candidates.iter().take(50) {
            enqueue(
                st,
                &sub,
                &format!("event:{}", event["id"]),
                event_cause(event),
            )?;
            if sub["mode"] == "once" {
                break;
            }
        }
        if candidates.len() > 50 {
            cursor = candidates[49]["id"].as_i64().unwrap();
        }
        st.db.execute(
            "UPDATE subscriptions SET cursor=?2 WHERE id=?1 AND cursor<>?2",
            params![id, cursor],
        )?;
        if sub["mode"] == "once" && candidates.is_empty() {
            let other=rows(&st.db,"SELECT cause FROM subscription_updates WHERE agent=?1 AND subscription<>?2 AND delivered=0 AND (?3 IS NULL OR at<?3) ORDER BY id LIMIT 1",params![owner,id,deadline])?.pop();
            if let Some(other) = other {
                let cause = serde_json::from_str(other["cause"].as_str().unwrap())
                    .map_err(|_| bad("invalid saved update"))?;
                enqueue(st, &sub, "resolved", cause)?;
            } else if deadline.is_some_and(|at| at <= now()) {
                enqueue(
                    st,
                    &sub,
                    "resolved",
                    json!({"kind":"timeout","summary":"its timeout"}),
                )?;
            }
        }
    }
    Ok(())
}

pub(super) fn foreground_updates(st: &St, agent: i64, issued_at: i64) -> R<()> {
    for sub in rows(
        &st.db,
        "SELECT * FROM subscriptions WHERE agent=?1 AND mode='once' AND state='active' ORDER BY id",
        [agent],
    )? {
        let cause = if sub["deadline"].as_i64().is_some_and(|at| issued_at >= at) {
            json!({"kind":"timeout","summary":"its timeout"})
        } else {
            json!({"kind":"foreground-wait","at":issued_at,"summary":"updates returned by acom wait"})
        };
        enqueue(st, &sub, "resolved", cause)?;
    }
    Ok(())
}

pub(super) fn take(st: &St, agent: i64, budget: usize) -> R<(String, Vec<i64>)> {
    if budget < 256 {
        return Ok((String::new(), Vec::new()));
    }
    let mut lines = Vec::new();
    let mut ids = Vec::new();
    for update in rows(
        &st.db,
        "SELECT u.*,s.mode FROM subscription_updates u JOIN subscriptions s ON s.id=u.subscription WHERE u.agent=?1 AND u.delivered=0 ORDER BY u.id LIMIT 26",
        [agent],
    )? {
        let cause: Value = serde_json::from_str(update["cause"].as_str().unwrap())
            .map_err(|_| bad("invalid saved update"))?;
        let cause = visible_cause(st, cause, agent);
        let summary = cause["summary"].as_str().unwrap_or("an update");
        let text = if update["mode"] == "once" {
            format!(
                "[acom] Deferred wait #{} resolved {}by {}; {}.",
                update["subscription"],
                if cause["kind"] == "timeout" {
                    ""
                } else {
                    "early "
                },
                summary,
                if cause["kind"] == "timeout" {
                    "deadline reached"
                } else {
                    "timeout canceled"
                }
            )
        } else {
            format!(
                "[acom] Subscription #{}: {}.",
                update["subscription"], summary
            )
        };
        lines.push(text);
        if ids.len() >= 25 || json!({"text":lines.join("\n")}).to_string().len() > budget - 220 {
            lines.pop();
            break;
        }
        let id = update["id"].as_i64().unwrap();
        st.db.execute(
            "UPDATE subscription_updates SET delivered=1 WHERE id=?1",
            [id],
        )?;
        ids.push(id);
    }
    let remaining: i64 = st.db.query_row(
        "SELECT count(*) FROM subscription_updates WHERE agent=?1 AND delivered=0",
        [agent],
        |r| r.get(0),
    )?;
    if remaining > 0 {
        lines.push(format!("[acom] {remaining} subscription updates remain; subsequent hooks or turns deliver them. Inspect `acom subscriptions` and `acom history`."));
    }
    Ok((lines.join("\n"), ids))
}

pub(super) fn record_wake(st: &St, agent: i64, ids: &[i64]) -> R<()> {
    st.db
        .execute("DELETE FROM subscription_starts WHERE agent=?1", [agent])?;
    if ids.is_empty() {
        return Ok(());
    }
    let mut subscriptions = Vec::new();
    let mut events = Vec::new();
    let mut sources = Vec::new();
    for update in rows(
        &st.db,
        "SELECT subscription,cause FROM subscription_updates WHERE agent=?1 AND EXISTS(SELECT 1 FROM json_each(?2) WHERE value=subscription_updates.id)",
        params![agent, json!(ids).to_string()],
    )? {
        subscriptions.push(update["subscription"].clone());
        let cause: Value = serde_json::from_str(update["cause"].as_str().unwrap())
            .map_err(|_| bad("invalid saved update"))?;
        if cause["kind"] == "event" {
            events.extend(cause["event"].as_i64());
            if cause["event_kind"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("agent."))
            {
                sources.extend(cause["agent"].as_i64().filter(|id| *id > 0 && *id != agent));
            }
        }
    }
    subscriptions.sort_by_key(|v| v.as_i64());
    subscriptions.dedup();
    events.sort();
    events.dedup();
    sources.sort();
    sources.dedup();
    st.event(
        st.agent(agent)?.project,
        Some(agent),
        None,
        "subscription.wake",
        "acom",
        json!({"subscriptions":subscriptions,"events":events,"sources":sources}),
    )
}

pub(super) fn observe_usage(
    st: &St,
    provider: &str,
    win: &str,
    used: f64,
    resets_at: Option<i64>,
) -> R<()> {
    let previous = rows(
        &st.db,
        "SELECT used_pct used,resets_at FROM usage_observations WHERE provider=?1 AND win=?2",
        params![provider, win],
    )?
    .pop();
    let previous = match previous {
        Some(value) => Some(value),
        None => rows(
            &st.db,
            "SELECT used_pct used,resets_at FROM usage WHERE provider=?1 AND win=?2",
            params![provider, win],
        )?
        .pop(),
    };
    let observed_at = now();
    for table in ["usage", "usage_observations"] {
        st.db.execute(&format!("INSERT OR REPLACE INTO {table}(provider,win,used_pct,resets_at,at) VALUES(?1,?2,?3,?4,?5)"),params![provider,win,used,resets_at,observed_at])?;
    }
    if previous
        .as_ref()
        .is_some_and(|p| p["used"].as_f64() == Some(used) && p["resets_at"].as_i64() == resets_at)
    {
        return Ok(());
    }
    let before = previous.as_ref().and_then(|p| p["used"].as_f64());
    let before_reset = previous.as_ref().and_then(|p| p["resets_at"].as_i64());
    let reset = before.is_some_and(|old| old >= 100.0 && used < 100.0)
        || before_reset.zip(resets_at).is_some_and(|(old, new)| {
            new > old && (old <= now() || before.is_some_and(|old_used| used < old_used))
        });
    for project in rows(&st.db, "SELECT id FROM projects", [])? {
        st.event(project["id"].as_i64().unwrap(),None,None,"usage.observed","acom",json!({"provider":provider,"window":win,"before_used":before,"used":used,"before_reset":before_reset,"resets_at":resets_at,"reset":reset}))?;
    }
    Ok(())
}

fn reset_due(st: &St) -> R<()> {
    for usage in rows(&st.db,"SELECT provider,win,resets_at,used_pct,at,stale FROM (
      SELECT provider,win,resets_at,used_pct,at,0 stale FROM usage
      UNION ALL SELECT provider,win,resets_at,used_pct,at,1 stale FROM usage_observations o
        WHERE NOT EXISTS(SELECT 1 FROM usage u WHERE u.provider=o.provider AND u.win=o.win)
      ) known WHERE resets_at<=?1 AND resets_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM usage_reset_notices n WHERE n.provider=known.provider AND n.win=known.win AND n.resets_at=known.resets_at)",[now()])? {
        st.db.execute("INSERT INTO usage_reset_notices(provider,win,resets_at) VALUES(?1,?2,?3)",params![usage["provider"].as_str(),usage["win"].as_str(),usage["resets_at"].as_i64()])?;
        for project in rows(&st.db,"SELECT id FROM projects",[])? {
            st.event(project["id"].as_i64().unwrap(),None,None,"usage.reset-due","acom",json!({"provider":usage["provider"],"window":usage["win"],"resets_at":usage["resets_at"],"used":usage["used_pct"],"observed_at":usage["at"],"stale":usage["stale"]==1,"confirmed":false}))?;
        }
    }
    Ok(())
}

fn visible_cause(st: &St, cause: Value, viewer: i64) -> Value {
    if let Some(thread) = cause["thread"].as_i64()
        && App::require_thread_read(st, thread, viewer).is_err()
    {
        return json!({"kind":cause["kind"],"summary":"a private notification"});
    }
    cause
}

fn visible(st: &St, mut value: Value, viewer: i64) -> R<Value> {
    if viewer < 0 {
        return Err(bad("viewer must be 0 (user) or a positive agent ID"));
    }
    if viewer > 0 && st.agent(viewer)?.project != value["project"] {
        return Err(not_found("no subscription in your project"));
    }
    value["completion"] = visible_cause(st, value["completion"].take(), viewer);
    Ok(value)
}

pub(super) fn summaries(st: &St, agent: i64, viewer: i64) -> R<Value> {
    let active: i64 = st.db.query_row(
        "SELECT count(*) FROM subscriptions WHERE agent=?1 AND state='active'",
        [agent],
        |r| r.get(0),
    )?;
    let pending:i64=st.db.query_row("SELECT count(*) FROM subscription_updates u LEFT JOIN update_deliveries d ON d.id=u.delivery_id WHERE u.agent=?1 AND (u.delivered=0 OR d.text IS NOT NULL)",[agent],|r|r.get(0))?;
    let ids = rows(
        &st.db,
        "SELECT id FROM subscriptions WHERE agent=?1 ORDER BY id DESC LIMIT 5",
        [agent],
    )?;
    let mut items = Vec::new();
    for id in ids {
        let item = visible(st, row(st, id["id"].as_i64().unwrap())?, viewer)?;
        items.push(if item.to_string().len()>1500 {json!({"id":item["id"],"mode":item["mode"],"state":item["state"],"deadline":item["deadline"],"truncated":true})}else{item});
    }
    let total: i64 = st.db.query_row(
        "SELECT count(*) FROM subscriptions WHERE agent=?1",
        [agent],
        |r| r.get(0),
    )?;
    Ok(json!({"active":active,"pending":pending,"items":items,"has_more":total>items.len() as i64}))
}

impl App {
    pub fn subscribe(&self, id: i64, timeout: Option<u64>, options: WaitOptions) -> R<Value> {
        if timeout.is_some_and(|s| !(1..=3600).contains(&s)) {
            return Err(bad("deferred timeout must be 1–3600 seconds"));
        }
        let mut st = self.lock();
        if st.shutting_down || st.agent(id)?.state != "working" {
            return Err(conflict(
                "subscribe requires a working turn and a running server",
            ));
        }
        let watch = Self::normalize_watch(&st, id, &options)?;
        if watch.is_none() && timeout.is_none() {
            return Err(bad(
                "persistent subscriptions need an agent or usage filter",
            ));
        }
        let watch = watch.unwrap_or(AgentWatch {
            agents: None,
            states: Vec::new(),
            status_text: false,
            usage: None,
        });
        let project = st.agent(id)?.project;
        let created = now();
        let mode = if timeout.is_some() {
            "once"
        } else {
            "persistent"
        };
        let result=st.atomic(|st| {
            reset_due(st)?;
            let through=ceiling(st)?;
            if options.after.is_some_and(|after|after<0 || after>through) {return Err(bad("after must be between 0 and the latest event ID"));}
            st.db.execute("INSERT INTO subscriptions(agent,project,mode,watch,created_at,deadline,cursor) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,project,mode,json!(watch).to_string(),created,timeout.map(|s|created+s as i64),options.after.unwrap_or(through)])?;
            let subscription=st.db.last_insert_rowid();
            st.event(project,Some(id),None,"subscription.created",&who(id),json!({"subscription":subscription,"mode":mode,"deadline":timeout.map(|s|created+s as i64)}))?;
            if let Some(usage)=&watch.usage
                && let Some(cause)=initial_usage(st,usage)? {
                enqueue(st,&row(st,subscription)?,"initial",cause)?;
            }
            process(st)?;
            row(st,subscription)
        })?;
        self.cv.notify_all();
        Ok(result)
    }

    pub fn subscriptions_page(&self, agent: i64, viewer: Option<i64>, q: PageQuery) -> R<Value> {
        let st = self.lock();
        let viewer = viewer.unwrap_or(0);
        if viewer < 0 {
            return Err(bad("viewer must be 0 (user) or a positive agent ID"));
        }
        if viewer > 0 && st.agent(viewer)?.project != st.agent(agent)?.project {
            return Err(not_found("no agent in your project"));
        }
        st.agent(agent)?;
        let mut page = self.select_page(
            &st,
            &q,
            &[
                "subscriptions",
                "subscription_updates",
                "thread_access",
                "members",
            ],
            &format!("subscriptions:{agent}:{viewer}"),
            "SELECT * FROM subscriptions WHERE agent=?1",
            &[agent.into()],
            true,
        )?;
        for item in &mut page.items {
            *item = visible(&st, row(&st, item["id"].as_i64().unwrap())?, viewer)?;
        }
        page.finish(&q)
    }

    pub fn subscription_view(&self, id: i64, viewer: Option<i64>) -> R<Value> {
        let st = self.lock();
        visible(&st, row(&st, id)?, viewer.unwrap_or(0))
    }

    pub fn cancel_subscription(&self, id: i64, actor: i64) -> R<Value> {
        let mut st = self.lock();
        let sub = row(&st, id)?;
        if actor > 0 && (sub["agent"] != actor || st.agent(actor)?.state == "replaced") {
            return Err(not_found("only your own subscriptions can be canceled"));
        }
        let result=st.atomic(|st| {
            let canceled=st.db.execute("UPDATE subscription_updates SET delivered=1 WHERE subscription=?1 AND delivered=0",[id])?;
            if sub["state"]=="active" {
                st.db.execute("UPDATE subscriptions SET state='canceled',completed_at=?2,completion=?3 WHERE id=?1",params![id,now(),json!({"kind":"canceled","summary":format!("canceled by {}",who(actor))}).to_string()])?;
            }
            if sub["state"]=="active" || canceled>0 {
                st.event(sub["project"].as_i64().unwrap(),sub["agent"].as_i64(),None,"subscription.canceled",&who(actor),json!({"subscription":id,"canceled_pending":canceled}))?;
            }
            let mut result=row(st,id)?;
            result["canceled_pending"]=json!(canceled);
            visible(st,result,actor)
        })?;
        self.cv.notify_all();
        Ok(result)
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;

    fn app() -> Arc<App> {
        let home = std::env::temp_dir().join(format!(
            "acom-usage-watch-test-{}",
            crate::harness::new_uuid()
        ));
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        app.lock().db.execute_batch("INSERT INTO projects(id,path,name,created_at) VALUES(1,'/usage-test','usage-test',0);
            INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at)
              VALUES(1,1,'watcher','usage watch fixture','codex','gpt-6-sol','medium','working',0,0);").unwrap();
        app
    }

    fn watch(condition: &str, percent: Option<f64>) -> UsageWatch {
        UsageWatch {
            provider: "codex".into(),
            window: "codex primary".into(),
            condition: condition.into(),
            percent,
        }
    }

    fn usage_options(provider: &str, window: &str) -> WaitOptions {
        WaitOptions {
            usage: Some(UsageWatch {
                provider: provider.into(),
                window: window.into(),
                condition: "above".into(),
                percent: Some(80.0),
            }),
            ..WaitOptions::default()
        }
    }

    #[test]
    fn claude_display_aliases_match_registered_and_foreground_usage_events() {
        for (alias, canonical) in [
            ("five-hour", "five_hour"),
            ("weekly", "seven_day"),
            ("weekly Fable", "seven_day_fable"),
        ] {
            for timeout in [None, Some(60)] {
                let app = app();
                app.record_usage("claude", canonical, 70.0, None).unwrap();
                let sub = app
                    .subscribe(1, timeout, usage_options("claude", alias))
                    .unwrap();
                assert_eq!(sub["watch"]["usage"]["window"], canonical);
                app.record_usage("claude", canonical, 90.0, None).unwrap();
                let text = app.hook(1).unwrap();
                assert!(text.contains(&format!("#{}", sub["id"])));
                assert!(text.contains(canonical));
                assert!(app.hook(1).unwrap().is_empty());
                assert_eq!(
                    app.subscription_view(sub["id"].as_i64().unwrap(), None)
                        .unwrap()["state"],
                    if timeout.is_some() {
                        "resolved"
                    } else {
                        "active"
                    }
                );
            }

            let app = app();
            app.record_usage("claude", canonical, 70.0, None).unwrap();
            let options = usage_options("claude", alias);
            let normalized = App::normalize_watch(&app.lock(), 1, &options)
                .unwrap()
                .unwrap();
            assert_eq!(normalized.usage.as_ref().unwrap().window, canonical);
            assert_eq!(
                json!(normalized),
                json!(
                    App::normalize_watch(&app.lock(), 1, &usage_options("claude", canonical))
                        .unwrap()
                        .unwrap()
                )
            );
            let foreground = app.clone();
            let worker = std::thread::spawn(move || foreground.wait_for(1, 5, options));
            let deadline = Instant::now() + Duration::from_secs(3);
            while !app.lock().waiting_updates.contains_key(&1) {
                assert!(
                    Instant::now() < deadline,
                    "foreground wait did not register"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            app.record_usage("claude", canonical, 90.0, None).unwrap();
            let batch = worker.join().unwrap().unwrap();
            assert_eq!(batch["timed_out"], false);
            assert!(batch["text"].as_str().unwrap().contains(canonical));
            app.ack_updates(1, batch["delivery_id"].as_i64().unwrap())
                .unwrap();
            let st = app.lock();
            let filters = rows(&st.db, "SELECT filter FROM wait_watch_cursors", []).unwrap();
            assert_eq!(filters.len(), 1);
            let filter: Value =
                serde_json::from_str(filters[0]["filter"].as_str().unwrap()).unwrap();
            assert_eq!(filter["usage"]["window"], canonical);
        }
    }

    #[test]
    fn known_absent_windows_and_exact_provider_scoped_observations_remain_valid() {
        let app = app();
        for (provider, window) in [
            ("claude", "five_hour"),
            ("claude", "seven_day"),
            ("claude", "seven_day_fable"),
            ("codex", "codex primary"),
            ("codex", "codex secondary"),
            ("codex", "codex account limit"),
            ("codex", "account limit"),
        ] {
            let sub = app
                .subscribe(1, None, usage_options(provider, window))
                .unwrap();
            assert_eq!(sub["watch"]["usage"]["window"], window);
            assert_eq!(sub["state"], "active");
        }
        for window in ["custom_Bucket primary", "unusual-window", "limit"] {
            app.record_usage("codex", window, 70.0, None).unwrap();
            app.lock().db.execute("DELETE FROM usage", []).unwrap();
            let sub = app
                .subscribe(1, None, usage_options("codex", window))
                .unwrap();
            assert_eq!(sub["watch"]["usage"]["window"], window);
            assert!(
                app.subscribe(1, None, usage_options("claude", window))
                    .is_err()
            );
        }
        app.record_usage("codex", "only-current primary", 70.0, None)
            .unwrap();
        app.lock()
            .db
            .execute("DELETE FROM usage_observations", [])
            .unwrap();
        assert!(
            app.subscribe(1, None, usage_options("codex", "only-current primary"))
                .is_ok()
        );
        for window in [
            "custom_bucket primary",
            "custom-Bucket primary",
            "five-hour",
            "weekly",
            " codex primary",
            "primary",
            "limit",
        ] {
            assert!(
                app.subscribe(1, None, usage_options("codex", window))
                    .is_err(),
                "unexpected window: {window}"
            );
        }
    }

    #[test]
    fn rejected_window_choices_are_bounded_even_with_many_long_observed_ids() {
        let app = app();
        for index in 0..30 {
            let name = format!("dynamic-{index:02}-{}", "x".repeat(200));
            app.record_usage("codex", &name, 70.0, None).unwrap();
        }
        let error = app
            .subscribe(1, None, usage_options("codex", "unknown"))
            .unwrap_err();
        assert_eq!(error.0, 400);
        assert!(error.1.contains("acom limits"));
        assert!(error.1.contains('…'));
        assert!(error.1.len() < 2000);
    }

    #[test]
    fn unknown_usage_windows_reject_before_registrations_cursors_or_delivery_changes() {
        let app = app();
        app.lock().notice(1, "pending notification").unwrap();
        let batch = app.wait_for(1, 1, WaitOptions::default()).unwrap();
        let snapshot = || {
            let st = app.lock();
            (
                rows(&st.db, "SELECT * FROM subscriptions", []).unwrap(),
                rows(&st.db, "SELECT * FROM events", []).unwrap(),
                rows(&st.db, "SELECT * FROM wait_watch_cursors", []).unwrap(),
                st.pending_delivery(1).unwrap(),
            )
        };
        let before = snapshot();
        for window in ["five_horu", "", " five_hour", "FIVE_HOUR", "five-hour "] {
            for timeout in [None, Some(60)] {
                let error = app
                    .subscribe(1, timeout, usage_options("claude", window))
                    .unwrap_err();
                assert_eq!(error.0, 400);
                assert!(error.1.contains("window"));
                assert_eq!(snapshot(), before);
            }
            let error = app
                .wait_for(1, 1, usage_options("claude", window))
                .unwrap_err();
            assert_eq!(error.0, 400);
            assert_eq!(snapshot(), before);
            assert!(app.lock().waiting_updates.is_empty());
        }
        assert_eq!(app.wait_for(1, 1, WaitOptions::default()).unwrap(), batch);
    }

    #[test]
    fn limits_show_canonical_window_ids_beside_display_labels() {
        let app = app();
        let text = app.lock().limits_text(Some(1)).unwrap();
        for label in [
            "five-hour [five_hour]",
            "weekly [seven_day]",
            "weekly Fable [seven_day_fable]",
        ] {
            assert!(text.contains(label), "missing {label}");
        }
    }

    #[test]
    fn limits_discover_missing_and_observed_windows_without_mixing_providers() {
        let app = app();
        app.record_usage("codex", "custom-bucket primary", 95.0, None)
            .unwrap();
        app.lock().db.execute("DELETE FROM usage", []).unwrap();
        let limits = app.limits(Some(1)).unwrap();
        let windows = &limits["usage_windows"];
        assert!(
            windows["claude"]
                .as_array()
                .unwrap()
                .contains(&json!("five_hour"))
        );
        assert!(
            windows["claude"]
                .as_array()
                .unwrap()
                .contains(&json!("seven_day_fable"))
        );
        assert!(
            windows["codex"]
                .as_array()
                .unwrap()
                .contains(&json!("codex primary"))
        );
        assert!(
            windows["codex"]
                .as_array()
                .unwrap()
                .contains(&json!("custom-bucket primary"))
        );
        assert!(
            !windows["claude"]
                .as_array()
                .unwrap()
                .contains(&json!("custom-bucket primary"))
        );
        assert!(limits["usage"].as_array().unwrap().is_empty());
        let bounded = bounded_record(limits, None, 512, None).unwrap();
        assert!(bounded["truncated"].as_bool().unwrap_or(false));
        assert!(bounded["next_offset"].as_u64().is_some());
    }

    #[test]
    fn omitted_usage_window_does_not_rearm_a_threshold_crossing() {
        let app = app();
        let reset = Some(now() + 3600);
        app.record_usage("codex", "codex primary", 95.0, reset)
            .unwrap();
        let sub = app
            .subscribe(
                1,
                None,
                WaitOptions {
                    usage: Some(watch("above", Some(80.0))),
                    ..WaitOptions::default()
                },
            )
            .unwrap();
        assert!(
            app.hook(1)
                .unwrap()
                .contains(&format!("Subscription #{}", sub["id"]))
        );
        app.lock()
            .db
            .execute("DELETE FROM usage WHERE provider='codex'", [])
            .unwrap();
        assert!(app.hook(1).unwrap().is_empty());
        app.record_usage("codex", "codex primary", 95.0, reset)
            .unwrap();
        assert!(app.hook(1).unwrap().is_empty());
        app.record_usage("codex", "codex primary", 70.0, reset)
            .unwrap();
        assert!(app.hook(1).unwrap().is_empty());
        app.record_usage("codex", "codex primary", 90.0, reset)
            .unwrap();
        assert!(
            app.hook(1)
                .unwrap()
                .contains(&format!("Subscription #{}", sub["id"]))
        );
        assert!(app.hook(1).unwrap().is_empty());
    }

    #[test]
    fn initial_missing_window_reports_last_known_usage_not_zero_or_reset() {
        let app = app();
        app.record_usage("codex", "codex primary", 95.0, Some(now() + 3600))
            .unwrap();
        let st = app.lock();
        st.db.execute("DELETE FROM usage", []).unwrap();
        let initial = initial_usage(&st, &watch("above", Some(80.0)))
            .unwrap()
            .unwrap();
        assert_eq!(initial["used"], 95.0);
        assert_eq!(initial["stale"], true);
        assert!(
            initial["summary"]
                .as_str()
                .unwrap()
                .contains("window absent from latest status")
        );
        assert!(
            initial_usage(&st, &watch("below", Some(20.0)))
                .unwrap()
                .is_none()
        );
        assert!(initial_usage(&st, &watch("reset", None)).unwrap().is_none());
    }

    #[test]
    fn missing_window_keeps_only_an_estimated_reset_deadline() {
        let app = app();
        app.record_usage("codex", "codex primary", 95.0, Some(now() - 1))
            .unwrap();
        let st = app.lock();
        st.db.execute("DELETE FROM usage", []).unwrap();
        reset_due(&st).unwrap();
        reset_due(&st).unwrap();
        let due =
            App::event_rows(&st, "SELECT * FROM events WHERE kind='usage.reset-due'", []).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0]["details"]["confirmed"], false);
        assert_eq!(due[0]["details"]["stale"], true);
        assert!(initial_usage(&st, &watch("reset", None)).unwrap().is_none());
        assert!(
            initial_usage(&st, &watch("reset-due", None))
                .unwrap()
                .unwrap()["summary"]
                .as_str()
                .unwrap()
                .contains("recovery is not confirmed")
        );
    }

    #[test]
    fn observation_baseline_survives_restart_and_omission_is_not_confirmed_recovery() {
        let app = app();
        let home = app.home.clone();
        app.record_usage("codex", "codex primary", 100.0, None)
            .unwrap();
        app.lock().db.execute("DELETE FROM usage", []).unwrap();
        drop(app);
        let app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        let mut st = app.lock();
        st.atomic(|st| observe_usage(st, "codex", "codex primary", 100.0, None))
            .unwrap();
        let observed = App::event_rows(
            &st,
            "SELECT * FROM events WHERE kind='usage.observed' ORDER BY id",
            [],
        )
        .unwrap();
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0]["details"]["reset"], false);
        st.atomic(|st| observe_usage(st, "codex", "codex primary", 0.0, None))
            .unwrap();
        let recovered = App::event_rows(
            &st,
            "SELECT * FROM events WHERE kind='usage.observed' ORDER BY id DESC LIMIT 1",
            [],
        )
        .unwrap();
        assert_eq!(recovered[0]["details"]["before_used"], 100.0);
        assert_eq!(recovered[0]["details"]["reset"], true);
    }
}

#[cfg(test)]
mod subscription_delivery_tests {
    use super::*;

    fn app(fake_client: bool) -> Arc<App> {
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!(
            "acom-subscription-delivery-test-{}",
            crate::harness::new_uuid()
        ));
        let mut app = App::open(home, "http://127.0.0.1:0".into()).unwrap();
        let bin = app.home.join("bin");
        std::fs::create_dir(&bin).unwrap();
        if fake_client {
            let client = bin.join("codex");
            std::fs::write(&client,format!("#!/bin/sh\nIFS= read -r task || exit 0\nprintf '%s' \"$task\" > '{}/prompt-delivered'\n",app.home.display())).unwrap();
            std::fs::set_permissions(&client, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        Arc::get_mut(&mut app).unwrap().exe = bin.join("acom");
        {
            let st = app.lock();
            st.db
                .execute(
                    "INSERT INTO projects(id,path,name,created_at) VALUES(1,?1,'delivery-test',0)",
                    [app.home.to_string_lossy()],
                )
                .unwrap();
            st.db.execute_batch("INSERT INTO agents(id,project,name,task,harness,model,effort,state,launched_by,launched_at)
              VALUES(1,1,'watcher','subscription delivery fixture','codex','gpt-6-sol','medium','working',0,0),
                    (2,1,'peer','peer fixture','codex','gpt-6-sol','medium','working',0,0),
                    (3,1,'successor','successor fixture','codex','gpt-6-sol','medium','working',0,0);").unwrap();
        }
        app
    }

    fn pending_transition(app: &Arc<App>) -> i64 {
        let sub = app
            .subscribe(
                1,
                None,
                WaitOptions {
                    agents: Some(WaitAgents::Selected(vec![2])),
                    states: Some(vec!["done".into()]),
                    ..WaitOptions::default()
                },
            )
            .unwrap();
        app.lock()
            .db
            .execute("UPDATE agents SET state='done' WHERE id=2", [])
            .unwrap();
        sub["id"].as_i64().unwrap()
    }

    fn private_completion(app: &Arc<App>) -> (i64, i64, i64) {
        let (thread, _) = app
            .create_thread(
                0,
                Some(1),
                ThreadReq {
                    title: "private completion".into(),
                    members: vec!["1".into()],
                    include_user: false,
                    watch: Vec::new(),
                    private: true,
                    joinable: false,
                },
            )
            .unwrap();
        app.hook(1).unwrap();
        let sub = app.subscribe(1, Some(60), WaitOptions::default()).unwrap();
        let id = sub["id"].as_i64().unwrap();
        let message = app.post(0, thread, "private body").unwrap().0;
        assert_eq!(
            app.subscription_view(id, Some(1)).unwrap()["completion"]["message"],
            message
        );
        (id, thread, message)
    }

    #[test]
    fn subscription_wake_start_failure_preserves_update_and_does_not_spin() {
        let app = app(false);
        pending_transition(&app);
        app.lock()
            .db
            .execute("UPDATE agents SET state='idle' WHERE id=1", [])
            .unwrap();
        assert!(app.tick().unwrap_err().1.contains("can't start codex"));
        for _ in 0..3 {
            app.tick().unwrap();
        }
        let st = app.lock();
        assert_eq!(st.agent(1).unwrap().state, "crashed");
        assert!(st.procs.is_empty());
        assert!(pending(&st, 1).unwrap());
        assert_eq!(
            st.db
                .query_row(
                    "SELECT count(*) FROM subscription_updates WHERE agent=1 AND delivered=0",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            st.db
                .query_row(
                    "SELECT count(*) FROM events WHERE kind='agent.failed' AND agent=1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            st.db
                .query_row(
                    "SELECT count(*) FROM events WHERE kind='subscription.wake'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(
            st.db
                .query_row(
                    "SELECT error FROM subscription_starts WHERE agent=1",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap()
                .contains("can't start codex")
        );
    }

    #[test]
    fn post_spawn_database_failure_reaps_child_and_restores_subscription_receipt() {
        let app = app(true);
        pending_transition(&app);
        let batch = app.wait_for(1, 1, WaitOptions::default()).unwrap();
        let delivery = batch["delivery_id"].as_i64().unwrap();
        {
            let st = app.lock();
            st.db.execute_batch("UPDATE agents SET state='idle' WHERE id=1;
                CREATE TRIGGER reject_subscription_start BEFORE UPDATE OF turns ON agents WHEN NEW.id=1
                BEGIN SELECT RAISE(ABORT,'subscription post-spawn failure'); END;").unwrap();
        }
        assert!(
            app.tick()
                .unwrap_err()
                .1
                .contains("subscription post-spawn failure")
        );
        let st = app.lock();
        assert_eq!(st.agent(1).unwrap().state, "crashed");
        assert!(st.procs.is_empty());
        assert_eq!(
            st.pending_delivery(1).unwrap(),
            Some((delivery, batch["text"].as_str().unwrap().into()))
        );
        assert!(pending(&st, 1).unwrap());
        assert_eq!(
            st.db
                .query_row("SELECT turns FROM agents WHERE id=1", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            st.db
                .query_row(
                    "SELECT count(*) FROM events WHERE kind='subscription.wake'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(
            !app.home.join("prompt-delivered").exists(),
            "an uncommitted child must not receive its task"
        );
    }

    #[test]
    fn replacement_transfers_pending_subscription_receipt_and_rolls_back_consumption() {
        let app = app(false);
        let subscription = pending_transition(&app);
        let batch = app.wait_for(1, 1, WaitOptions::default()).unwrap();
        let delivery = batch["delivery_id"].as_i64().unwrap();
        {
            let mut st = app.lock();
            st.atomic(|st| {
                App::inherit_memberships(st, 1, 3)?;
                st.set_state(1, "replaced")
            })
            .unwrap();
            assert!(!pending(&st, 1).unwrap());
            assert!(pending(&st, 3).unwrap());
            assert_eq!(row(&st, subscription).unwrap()["agent"], 3);
            let failed: R<()> = st.atomic(|st| {
                let text = st.take_turn_updates(3)?;
                assert!(text.contains(&format!("Recovered delivery #{delivery}")));
                assert!(text.contains(&format!("Subscription #{subscription}")));
                Err(bad("subscription startup rollback fixture"))
            });
            assert!(failed.is_err());
            assert_eq!(
                st.pending_delivery(3).unwrap(),
                Some((delivery, batch["text"].as_str().unwrap().into()))
            );
            assert!(pending(&st, 3).unwrap());
            assert_eq!(
                st.db
                    .query_row(
                        "SELECT count(*) FROM events WHERE kind='subscription.wake'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            let text = st.atomic(|st| st.take_turn_updates(3)).unwrap();
            assert!(text.contains(&format!("Recovered delivery #{delivery}")));
            assert!(!pending(&st, 3).unwrap());
            assert_eq!(
                st.db
                    .query_row(
                        "SELECT count(*) FROM events WHERE kind='subscription.wake' AND agent=3",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
        }
        assert!(app.hook(3).unwrap().is_empty());
    }

    #[test]
    fn cancellation_does_not_reveal_an_inaccessible_private_completion() {
        let app = app(false);
        let (id, thread, message) = private_completion(&app);
        app.remove_members(thread, &["1".into()], 0).unwrap();
        let view = app.subscription_view(id, Some(1)).unwrap();
        assert!(view["completion"].get("thread").is_none());
        let canceled = app.cancel_subscription(id, 1).unwrap();
        assert!(canceled["completion"].get("thread").is_none());
        assert!(canceled["completion"].get("message").is_none());
        assert_eq!(
            app.subscription_view(id, None).unwrap()["completion"]["message"],
            message,
            "the user retains full visibility"
        );
    }

    #[test]
    fn queued_private_completion_is_redacted_if_access_changes_before_delivery() {
        let app = app(false);
        let (id, thread, message) = private_completion(&app);
        app.remove_members(thread, &["1".into()], 0).unwrap();
        let text = app.hook(1).unwrap();
        assert!(text.contains(&format!("Deferred wait #{id}")));
        assert!(text.contains("a private notification"));
        assert!(!text.contains(&format!("message #{message}")));
        assert!(!text.contains(&format!("thread #{thread}")));
        assert!(text.contains("timeout canceled"));
        assert!(app.hook(1).unwrap().is_empty());
    }

    #[test]
    fn already_issued_private_receipt_remains_immutable_after_access_changes() {
        let app = app(false);
        let (_, thread, message) = private_completion(&app);
        let batch = app.wait_for(1, 1, WaitOptions::default()).unwrap();
        assert!(
            batch["text"]
                .as_str()
                .unwrap()
                .contains(&format!("message #{message}"))
        );
        app.remove_members(thread, &["1".into()], 0).unwrap();
        assert_eq!(app.wait_for(1, 1, WaitOptions::default()).unwrap(), batch);
        app.ack_updates(1, batch["delivery_id"].as_i64().unwrap())
            .unwrap();
    }

    #[test]
    fn a_different_foreground_watch_resolves_deferred_wait_in_the_same_receipt() {
        let app = app(false);
        let sub = app
            .subscribe(
                1,
                Some(60),
                WaitOptions {
                    agents: Some(WaitAgents::Selected(vec![2])),
                    states: Some(vec!["done".into()]),
                    ..WaitOptions::default()
                },
            )
            .unwrap();
        let id = sub["id"].as_i64().unwrap();
        app.lock()
            .db
            .execute("UPDATE agents SET state='done' WHERE id=3", [])
            .unwrap();
        let batch = app
            .wait_for(
                1,
                1,
                WaitOptions {
                    agents: Some(WaitAgents::Selected(vec![3])),
                    states: Some(vec!["done".into()]),
                    after: Some(0),
                    ..WaitOptions::default()
                },
            )
            .unwrap();
        let text = batch["text"].as_str().unwrap();
        assert!(text.contains(&format!(
            "Deferred wait #{id} resolved early by updates returned by acom wait"
        )));
        assert!(text.contains("timeout canceled"));
        assert!(text.contains("agent 3 agent.state"));
        assert_eq!(
            app.subscription_view(id, Some(1)).unwrap()["state"],
            "resolved"
        );
        app.ack_updates(1, batch["delivery_id"].as_i64().unwrap())
            .unwrap();
        assert!(
            app.hook(1).unwrap().is_empty(),
            "the same completion must not require another hook or turn"
        );
    }

    #[test]
    fn foreground_completion_and_watch_cursor_roll_back_if_receipt_storage_fails() {
        let app = app(false);
        let sub = app
            .subscribe(
                1,
                Some(60),
                WaitOptions {
                    agents: Some(WaitAgents::Selected(vec![2])),
                    states: Some(vec!["done".into()]),
                    ..WaitOptions::default()
                },
            )
            .unwrap();
        let id = sub["id"].as_i64().unwrap();
        app.lock()
            .db
            .execute_batch(
                "UPDATE agents SET state='done' WHERE id=3;
            CREATE TRIGGER reject_foreground_receipt BEFORE INSERT ON update_deliveries
              BEGIN SELECT RAISE(ABORT,'foreground receipt failure'); END;",
            )
            .unwrap();
        let options = WaitOptions {
            agents: Some(WaitAgents::Selected(vec![3])),
            states: Some(vec!["done".into()]),
            after: Some(0),
            ..WaitOptions::default()
        };
        assert!(
            app.wait_for(1, 1, options.clone())
                .unwrap_err()
                .1
                .contains("foreground receipt failure")
        );
        {
            let st = app.lock();
            assert_eq!(row(&st, id).unwrap()["state"], "active");
            assert!(!pending(&st, 1).unwrap());
            assert_eq!(
                st.db
                    .query_row(
                        "SELECT count(*) FROM wait_watch_cursors WHERE agent_id=1",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert_eq!(
                st.db
                    .query_row(
                        "SELECT count(*) FROM events WHERE kind='subscription.resolved'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            st.db
                .execute_batch("DROP TRIGGER reject_foreground_receipt")
                .unwrap();
        }
        let batch = app.wait_for(1, 1, options).unwrap();
        assert!(
            batch["text"]
                .as_str()
                .unwrap()
                .contains(&format!("Deferred wait #{id}"))
        );
        app.ack_updates(1, batch["delivery_id"].as_i64().unwrap())
            .unwrap();
        assert!(app.hook(1).unwrap().is_empty());
    }

    #[test]
    fn foreground_updates_at_the_deadline_and_old_untimed_receipts_are_timeouts() {
        let app = app(false);
        let sub = app.subscribe(1, Some(60), WaitOptions::default()).unwrap();
        let id = sub["id"].as_i64().unwrap();
        {
            let mut st = app.lock();
            let deadline = now();
            st.db
                .execute(
                    "UPDATE subscriptions SET deadline=?2 WHERE id=?1",
                    params![id, deadline],
                )
                .unwrap();
            st.atomic(|st| foreground_updates(st, 1, deadline)).unwrap();
            assert_eq!(row(&st, id).unwrap()["completion"]["kind"], "timeout");
        }
        app.hook(1).unwrap();
        let sub = app.subscribe(1, Some(60), WaitOptions::default()).unwrap();
        let id = sub["id"].as_i64().unwrap();
        {
            let mut st = app.lock();
            st.db
                .execute(
                    "UPDATE subscriptions SET deadline=?2 WHERE id=?1",
                    params![id, now() - 1],
                )
                .unwrap();
            st.db.execute("INSERT INTO update_deliveries(agent_id,text) VALUES(1,'already issued receipt without timestamp')",[]).unwrap();
            st.atomic(|st| process(st)).unwrap();
            assert_eq!(row(&st, id).unwrap()["completion"]["kind"], "timeout");
            assert_eq!(
                st.pending_delivery(1).unwrap().unwrap().1,
                "already issued receipt without timestamp"
            );
        }
    }
}
