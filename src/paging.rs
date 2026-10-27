// Shared response budgets and exclusive, stable-ID cursors.
use crate::app::{R, bad, conflict};
use serde_json::{Value, json};
use std::hash::{Hash, Hasher};

#[derive(Clone, Debug)]
pub struct PageQuery {
    pub before: Option<i64>,
    pub after: Option<i64>,
    pub through: Option<i64>,
    pub revision: Option<String>,
    pub since: Option<String>,
    pub limit: i64,
    pub max_bytes: i64,
}

impl Default for PageQuery {
    fn default() -> Self {
        Self {
            before: None,
            after: None,
            through: None,
            revision: None,
            since: None,
            limit: 50,
            max_bytes: 16000,
        }
    }
}

impl PageQuery {
    pub fn validate(&self) -> R<()> {
        validate_budget(self.max_bytes)?;
        if !(1..=200).contains(&self.limit) {
            return Err(bad("limit must be 1–200"));
        }
        if self.before.is_some() && self.after.is_some()
            || self.before.is_some_and(|v| v <= 0)
            || self.after.is_some_and(|v| v < 0)
            || self.through.is_some_and(|v| v < 0)
        {
            return Err(bad(
                "before must be positive; after and through must be nonnegative; use only one direction",
            ));
        }
        if self.since.is_some()
            && (self.before.is_some() || self.after.is_some() || self.revision.is_some())
        {
            return Err(bad(
                "since is only for a fresh page, without a revision cursor",
            ));
        }
        Ok(())
    }

    pub fn snapshot(&self, revision: &str) -> R<Option<Value>> {
        self.validate()?;
        if self.revision.as_deref().is_some_and(|v| v != revision) {
            return Err(conflict(
                "collection changed; restart paging without a cursor",
            ));
        }
        Ok(self
            .since
            .as_deref()
            .filter(|v| *v == revision)
            .map(|_| json!({"unchanged":true,"revision":revision})))
    }

    pub fn ascending(&self) -> bool {
        self.after.is_some()
    }

    /// Candidates include one extra row. Even an oversized first item advances
    /// the cursor via an explicit ID stub, never by silently dropping a row.
    pub fn finish(
        &self,
        candidates: Vec<Value>,
        total: i64,
        through: i64,
        revision: &str,
    ) -> R<Value> {
        self.finish_with(candidates, total, through, revision, &json!({}))
    }

    pub fn finish_with(
        &self,
        candidates: Vec<Value>,
        total: i64,
        through: i64,
        revision: &str,
        extra: &Value,
    ) -> R<Value> {
        let count = candidates.len();
        let envelope = |items: &[Value], more: bool| {
            let last = items.last().and_then(|v| v["id"].as_i64());
            let mut value = json!({"items":items,"has_more":more,"next_before":if self.ascending(){None}else{last},"next_after":if self.ascending(){last}else{None},"through":through,"revision":revision,"total":total});
            if let Some(fields) = extra.as_object() {
                value.as_object_mut().unwrap().extend(fields.clone());
            }
            value
        };
        let mut items = Vec::new();
        for mut item in candidates.into_iter().take(self.limit as usize) {
            if item["truncated"] == true {
                item = stub(&item);
            }
            items.push(item.clone());
            if envelope(&items, true).to_string().len() > self.max_bytes as usize {
                items.pop();
                if !items.is_empty() {
                    break;
                }
                items.push(stub(&item));
                break;
            }
        }
        let result = envelope(&items, items.len() < count);
        if result.to_string().len() > self.max_bytes as usize {
            return Err(bad("max_bytes too small for page metadata"));
        }
        Ok(result)
    }
}

fn stub(item: &Value) -> Value {
    let mut result = json!({"id":item["id"],"truncated":true});
    for key in [
        "project",
        "thread",
        "sender",
        "at",
        "state",
        "user_member",
        "unread",
        "messages",
        "replacement",
        "replacement_pending",
        "stopping",
        "holder_stopping",
        "replacement_start_pending",
        "wake_queued_at",
        "is_waiting",
        "has_diagnostics",
        "agent",
        "mode",
        "deadline",
        "private",
        "joinable",
        "owner",
        "created_by",
        "total_tokens",
        "token_usage_state",
    ] {
        if let Some(value) = item.get(key).filter(|v| !v.is_null()) {
            result[key] = value.clone();
        }
    }
    result
}

pub fn validate_budget(max_bytes: i64) -> R<()> {
    if !(512..=65536).contains(&max_bytes) {
        return Err(bad("max_bytes must be 512–65536"));
    }
    Ok(())
}

pub fn fingerprint(value: impl Hash) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

/// Large records are explicit stubs or version-pinned UTF-8 JSON chunks. A
/// changed mutable record cannot be stitched into an older version's chunks.
pub fn bounded_record(
    value: Value,
    offset: Option<i64>,
    max_bytes: i64,
    expected: Option<&str>,
) -> R<Value> {
    validate_budget(max_bytes)?;
    if expected.is_some() && offset.is_none() {
        return Err(bad("version requires an explicit record offset"));
    }
    let text = value.to_string();
    if offset.is_none() && text.len() <= max_bytes as usize {
        return Ok(value);
    }
    let version = fingerprint(&text);
    if offset.is_none() {
        let mut result = json!({"truncated":true,"total_bytes":text.len(),"next_offset":0,"version":version,"format":"json"});
        if let Some(id) = value.get("id") {
            result["id"] = id.clone();
        }
        return Ok(result);
    }
    let start = offset.unwrap();
    if start < 0 || start as usize > text.len() || !text.is_char_boundary(start as usize) {
        return Err(bad(
            "offset must be a UTF-8 byte boundary within this record",
        ));
    }
    if start > 0 && expected.is_none() {
        return Err(bad("version is required after the first chunk"));
    }
    if expected.is_some_and(|v| v != version) {
        return Err(conflict("record changed; restart reading at offset 0"));
    }
    let start = start as usize;
    let envelope = |end: usize| json!({"chunk":&text[start..end],"offset":start,"next_offset":end,"total_bytes":text.len(),"has_more":end<text.len(),"version":version,"format":"json"});
    // Binary search UTF-8 boundaries. Budgeting must include JSON escaping, but
    // serializing every growing character prefix would be quadratic.
    let ends: Vec<usize> = std::iter::once(start)
        .chain(
            text[start..]
                .char_indices()
                .map(|(n, ch)| start + n + ch.len_utf8())
                .take_while(|end| end - start <= max_bytes as usize),
        )
        .collect();
    let (mut low, mut high) = (0, ends.len());
    while low + 1 < high {
        let mid = (low + high) / 2;
        if envelope(ends[mid]).to_string().len() <= max_bytes as usize {
            low = mid;
        } else {
            high = mid;
        }
    }
    let end = ends[low];
    if end == start && start < text.len() {
        return Err(bad("max_bytes too small for chunk metadata"));
    }
    Ok(envelope(end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_advance_past_oversize_items_without_skipping_the_next() {
        let q = PageQuery {
            max_bytes: 512,
            ..Default::default()
        };
        let page = q
            .finish(
                vec![json!({"id":3,"text":"☃".repeat(2000)}), json!({"id":2})],
                2,
                3,
                "r",
            )
            .unwrap();
        assert!(page.to_string().len() <= 512);
        assert_eq!(page["items"][0]["id"], 3);
        assert_eq!(page["items"][0]["truncated"], true);
        assert_eq!(page["next_before"], 3);
        assert_eq!(page["has_more"], true);
    }

    #[test]
    fn record_chunks_are_lossless_budgeted_and_version_pinned() {
        let value = json!({"id":1,"text":"☃\\\"\n😀".repeat(1000)});
        for record in [json!({"id":1}), value.clone()] {
            assert!(bounded_record(record, None, 512, Some("ignored-before")).is_err());
        }
        let mut offset = 0;
        let mut version = None;
        let mut result = String::new();
        loop {
            let chunk =
                bounded_record(value.clone(), Some(offset), 512, version.as_deref()).unwrap();
            assert!(chunk.to_string().len() <= 512);
            result.push_str(chunk["chunk"].as_str().unwrap());
            offset = chunk["next_offset"].as_i64().unwrap();
            version = Some(chunk["version"].as_str().unwrap().to_string());
            if chunk["has_more"] == false {
                break;
            }
        }
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap(), value);
        assert_eq!(
            bounded_record(
                json!({"id":1,"text":"changed"}),
                Some(1),
                512,
                version.as_deref()
            )
            .unwrap_err()
            .0,
            409
        );
        assert!(bounded_record(value.clone(), Some(1), 512, None).is_err());
        let raw = value.to_string();
        let snow = raw.find('☃').unwrap();
        assert!(bounded_record(value, Some((snow + 1) as i64), 512, None).is_err());
    }
}
