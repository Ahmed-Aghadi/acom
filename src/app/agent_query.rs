use super::{AgentFilter, R, STATES, bad};
use rusqlite::types::Value as SqlValue;
use serde::Serialize;
use std::collections::BTreeMap;

const FIELDS: [&str; 6] = [
    "group",
    "provider",
    "model",
    "effort",
    "state",
    "pause_reason",
];
const MAX_BYTES: usize = 4096;
const MAX_CLAUSES: usize = 64;
const MAX_VALUES: usize = 128;

#[derive(Debug, Clone, Serialize)]
pub struct QueryClause {
    pub field: Option<String>,
    pub values: Vec<String>,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedAgentQuery {
    fields: BTreeMap<String, Vec<String>>,
    terms: Vec<String>,
    value_count: usize,
}

#[derive(Clone, Copy)]
enum Part {
    Char(char, bool),
    Quote,
}

fn decoded(parts: &[Part]) -> String {
    parts
        .iter()
        .filter_map(|part| match part {
            Part::Char(ch, _) => Some(*ch),
            Part::Quote => None,
        })
        .collect()
}

fn quote(value: &str) -> String {
    if !value.is_empty()
        && !value
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, ',' | ':' | '"' | '\\'))
    {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

impl ParsedAgentQuery {
    pub fn parse(search: &str) -> R<Self> {
        if search.len() > MAX_BYTES {
            return Err(bad("search must be at most 4096 bytes"));
        }
        let mut query = Self::default();
        let mut tokens = Vec::new();
        let mut token = Vec::new();
        let mut quoted = false;
        let mut chars = search.chars();
        while let Some(ch) = chars.next() {
            match ch {
                '\\' => match chars.next() {
                    Some(ch @ ('\\' | '"')) => token.push(Part::Char(ch, true)),
                    _ => return Err(bad("search escapes must be \\\\ or \\\"")),
                },
                '"' => {
                    quoted = !quoted;
                    token.push(Part::Quote);
                }
                ch if ch.is_whitespace() && !quoted => {
                    if !token.is_empty() {
                        tokens.push(std::mem::take(&mut token));
                    }
                }
                ch => token.push(Part::Char(ch, quoted)),
            }
        }
        if quoted {
            return Err(bad("search has an unclosed double quote"));
        }
        if !token.is_empty() {
            tokens.push(token);
        }
        if tokens.len() > MAX_CLAUSES {
            return Err(bad("search must have at most 64 clauses"));
        }
        for token in tokens {
            if let Some(colon) = token
                .iter()
                .position(|part| matches!(part, Part::Char(':', false)))
            {
                let field = decoded(&token[..colon]);
                if !FIELDS.contains(&field.as_str()) {
                    return Err(bad(format!(
                        "unknown search field {field:?}; use {} or quote literal text",
                        FIELDS.join(", ")
                    )));
                }
                let mut values = Vec::new();
                for parts in token[colon + 1..].split(|part| matches!(part, Part::Char(',', false)))
                {
                    if parts
                        .iter()
                        .any(|part| matches!(part, Part::Char(':', false)))
                    {
                        return Err(bad(format!("quote literal colons in {field} values")));
                    }
                    let value = decoded(parts);
                    if value.is_empty()
                        && !(field == "group"
                            && parts.iter().any(|part| matches!(part, Part::Quote)))
                    {
                        return Err(bad(format!(
                            "{field} search values must be nonempty; use group:\"\" for ungrouped agents"
                        )));
                    }
                    values.push(value);
                }
                query.add(&field, values)?;
            } else {
                let term = decoded(&token);
                if term.is_empty() {
                    return Err(bad("search terms must be nonempty"));
                }
                query.terms.push(term);
            }
        }
        query.check()?;
        Ok(query)
    }

    pub fn from_filter(filter: AgentFilter<'_>) -> R<Self> {
        if !["all", "active", "attention", "finished"].contains(&filter.category) {
            return Err(bad("category must be all, active, attention or finished"));
        }
        let mut query = Self::parse(filter.search)?;
        for (field, value) in [
            ("group", filter.group),
            ("provider", filter.provider),
            ("model", filter.model),
            ("effort", filter.effort),
            ("state", filter.state),
            ("pause_reason", filter.pause_reason),
        ] {
            if let Some(value) = value {
                query.add(field, vec![value.to_string()])?;
            }
        }
        query.check()?;
        Ok(query)
    }

    fn add(&mut self, field: &str, mut values: Vec<String>) -> R<()> {
        if self.fields.contains_key(field) {
            return Err(bad(format!(
                "{field} must not be repeated; use comma-separated alternatives in one search clause"
            )));
        }
        self.value_count += values.len();
        if self.value_count > MAX_VALUES {
            return Err(bad("search must have at most 128 field values"));
        }
        for value in &values {
            let valid = match field {
                "provider" => ["claude", "codex"].contains(&value.as_str()),
                "state" => STATES.contains(&value.as_str()),
                "pause_reason" => ["manual", "limit", "restart"].contains(&value.as_str()),
                "group" => true,
                _ => !value.is_empty(),
            };
            if !valid {
                let choices = match field {
                    "provider" => "claude or codex".to_string(),
                    "state" => STATES.join(", "),
                    "pause_reason" => "manual, limit or restart".to_string(),
                    _ => "nonempty".to_string(),
                };
                return Err(bad(format!("{field} must be {choices}")));
            }
        }
        values.sort();
        values.dedup();
        self.fields.insert(field.to_string(), values);
        Ok(())
    }

    fn check(&self) -> R<()> {
        if self.fields.len() + self.terms.len() > MAX_CLAUSES {
            return Err(bad("search must have at most 64 clauses"));
        }
        if self.fields.contains_key("pause_reason")
            && self
                .fields
                .get("state")
                .is_some_and(|states| !states.iter().any(|state| state == "paused"))
        {
            return Err(bad(
                "pause_reason requires state paused; omit state or include paused",
            ));
        }
        if self.text().len() > MAX_BYTES {
            return Err(bad("normalized search must be at most 4096 bytes"));
        }
        Ok(())
    }

    pub fn clauses(&self) -> Vec<QueryClause> {
        let mut clauses = Vec::new();
        for field in FIELDS {
            if let Some(values) = self.fields.get(field) {
                clauses.push(QueryClause {
                    field: Some(field.to_string()),
                    values: values.clone(),
                    text: format!(
                        "{field}:{}",
                        values
                            .iter()
                            .map(|value| quote(value))
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                });
            }
        }
        for term in &self.terms {
            clauses.push(QueryClause {
                field: None,
                values: vec![term.clone()],
                text: quote(term),
            });
        }
        clauses
    }

    pub fn text(&self) -> String {
        self.clauses()
            .iter()
            .map(|clause| clause.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn view(&self) -> serde_json::Value {
        serde_json::json!({"text": self.text(), "clauses": self.clauses()})
    }

    fn normalized(&self) -> (BTreeMap<String, Vec<String>>, Vec<String>) {
        let mut fields = self.fields.clone();
        if fields.contains_key("pause_reason") {
            fields.insert("state".to_string(), vec!["paused".to_string()]);
        }
        let mut terms: Vec<_> = self.terms.iter().map(|term| term.to_lowercase()).collect();
        terms.sort();
        terms.dedup();
        (fields, terms)
    }

    pub fn scope(&self) -> String {
        serde_json::to_string(&self.normalized()).unwrap()
    }

    pub fn params(&self, project: Option<i64>) -> Vec<SqlValue> {
        let (fields, terms) = self.normalized();
        let mut params = vec![project.into()];
        for field in FIELDS {
            params.push(
                serde_json::to_string(fields.get(field).unwrap_or(&Vec::new()))
                    .unwrap()
                    .into(),
            );
        }
        params.push(serde_json::to_string(&terms).unwrap().into());
        params
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_and_round_trips_exact_alternatives_and_literal_terms() {
        let input = r#"group:"Security review","a,b",名 state:paused,crashed model:"custom:id" effort:ultra reentrancy "group:x" "a\\b\"c""#;
        let query = ParsedAgentQuery::parse(input).unwrap();
        let view = query.view();
        assert_eq!(
            view["clauses"][0]["values"],
            json!(["Security review", "a,b", "名"])
        );
        assert_eq!(view["clauses"][3]["values"], json!(["crashed", "paused"]));
        assert_eq!(
            query.scope(),
            ParsedAgentQuery::parse(&query.text()).unwrap().scope()
        );
        assert_eq!(query.terms, ["reentrancy", "group:x", "a\\b\"c"]);
        assert_eq!(
            ParsedAgentQuery::parse("group:\"\"").unwrap().fields["group"],
            [""]
        );
        assert_eq!(
            ParsedAgentQuery::parse("\"state:paused\"").unwrap().terms,
            ["state:paused"]
        );
        let controls = ParsedAgentQuery::parse("group:\"A\tB\nC\" \"literal\tterm\"").unwrap();
        assert_eq!(
            controls.scope(),
            ParsedAgentQuery::parse(&controls.text()).unwrap().scope()
        );
    }

    #[test]
    fn rejects_malformed_unknown_duplicate_and_conflicting_queries() {
        for input in [
            "group:",
            "group:a,",
            "group:,a",
            "group:a,,b",
            "group:\"\",",
            "model:\"\"",
            "\"\"",
            "group:\"unclosed",
            "bad:value",
            "state:active",
            "provider:other",
            "pause_reason:user",
            "group:a group:b",
            "state:idle pause_reason:limit",
            "model:a:b",
            "a\\n",
            "group:a\\",
            ":x",
        ] {
            assert_eq!(
                ParsedAgentQuery::parse(input).unwrap_err().0,
                400,
                "{input}"
            );
        }
        let query = AgentFilter {
            group: Some("a"),
            search: "group:a",
            ..AgentFilter::default()
        };
        assert!(
            query
                .normalized()
                .unwrap_err()
                .1
                .contains("must not be repeated")
        );
        assert!(ParsedAgentQuery::parse(&"x".repeat(4097)).is_err());
        assert!(ParsedAgentQuery::parse(&vec!["x"; 65].join(" ")).is_err());
        let alternatives = (0..129)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert!(ParsedAgentQuery::parse(&format!("group:{alternatives}")).is_err());
        assert!(ParsedAgentQuery::parse(&format!("group:{}", vec!["a"; 129].join(","))).is_err());
    }

    #[test]
    fn normalized_scope_matches_equivalent_queries_without_changing_explicit_clauses() {
        let first =
            ParsedAgentQuery::parse("state:paused,crashed pause_reason:limit,manual ÄÄ NEEDLE")
                .unwrap();
        let second =
            ParsedAgentQuery::parse("pause_reason:manual,limit state:paused needle ää needle")
                .unwrap();
        assert_eq!(first.scope(), second.scope());
        let reason = ParsedAgentQuery::parse("pause_reason:limit").unwrap();
        assert_eq!(reason.clauses().len(), 1);
        assert!(!reason.text().contains("state:"));
        assert_eq!(
            reason.scope(),
            ParsedAgentQuery::parse("state:paused pause_reason:limit")
                .unwrap()
                .scope()
        );
        let direct = AgentFilter {
            group: Some("a,b"),
            effort: Some("custom effort"),
            ..AgentFilter::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(direct.fields["group"], ["a,b"]);
        assert_eq!(direct.fields["effort"], ["custom effort"]);
    }
}
