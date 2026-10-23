use super::{AgentFilter, R, STATES, bad};
use rusqlite::types::Value as SqlValue;
use serde::Serialize;
use std::collections::BTreeSet;

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
const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct QueryClause {
    pub field: Option<String>,
    pub values: Vec<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Expression {
    Clause { clause: QueryClause },
    And { children: Vec<Expression> },
    Or { children: Vec<Expression> },
    Not { child: Box<Expression> },
}

#[derive(Debug, Clone, Default)]
pub struct ParsedAgentQuery {
    expression: Option<Expression>,
    clause_count: usize,
    value_count: usize,
}

#[derive(Debug, Clone, Copy)]
enum Part {
    Char(char, bool),
    Quote,
}

#[derive(Debug)]
enum Token {
    Clause(Vec<Part>),
    And,
    Or,
    Not,
    Open,
    Close,
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
        && !["AND", "OR", "NOT"].contains(&value)
        && !value
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, ',' | ':' | '"' | '\\' | '(' | ')'))
    {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

impl QueryClause {
    fn new(field: Option<String>, values: Vec<String>) -> Self {
        let text = values
            .iter()
            .map(|value| quote(value))
            .collect::<Vec<_>>()
            .join(",");
        let text = field
            .as_ref()
            .map_or_else(|| text.clone(), |field| format!("{field}:{text}"));
        Self {
            field,
            values,
            text,
        }
    }
}

impl Expression {
    fn join(and: bool, mut children: Vec<Self>) -> Self {
        if children.len() == 1 {
            return children.pop().unwrap();
        }
        if and {
            Self::And { children }
        } else {
            Self::Or { children }
        }
    }

    fn contains_field(&self, field: &str) -> bool {
        match self {
            Self::Clause { clause } => clause.field.as_deref() == Some(field),
            Self::And { children } | Self::Or { children } => {
                children.iter().any(|child| child.contains_field(field))
            }
            Self::Not { child } => child.contains_field(field),
        }
    }

    fn normalized(&self) -> Self {
        match self {
            Self::Clause { clause } => Self::Clause {
                clause: if clause.field.is_none() {
                    QueryClause::new(None, vec![clause.values[0].to_lowercase()])
                } else {
                    clause.clone()
                },
            },
            Self::Not { child } => Self::Not {
                child: Box::new(child.normalized()),
            },
            Self::And { children } | Self::Or { children } => {
                let and = matches!(self, Self::And { .. });
                let mut flat = Vec::new();
                for child in children {
                    match child.normalized() {
                        Self::And { children } if and => flat.extend(children),
                        Self::Or { children } if !and => flat.extend(children),
                        child => flat.push(child),
                    }
                }
                // A positive pause-reason clause already requires paused, so a
                // compatible state clause adds no restriction to this AND.
                if and && flat.iter().any(|child| matches!(child, Self::Clause { clause } if clause.field.as_deref() == Some("pause_reason"))) {
                    flat.retain(|child| !matches!(child, Self::Clause { clause } if clause.field.as_deref() == Some("state") && clause.values.iter().any(|value| value == "paused")));
                }
                flat.sort();
                flat.dedup();
                Self::join(and, flat)
            }
        }
    }

    fn text(&self, parent: u8) -> String {
        let (precedence, text) = match self {
            Self::Clause { clause } => (4, clause.text.clone()),
            Self::And { children } => (
                2,
                children
                    .iter()
                    .map(|child| child.text(2))
                    .collect::<Vec<_>>()
                    .join(" AND "),
            ),
            Self::Or { children } => (
                1,
                children
                    .iter()
                    .map(|child| child.text(1))
                    .collect::<Vec<_>>()
                    .join(" OR "),
            ),
            Self::Not { child } => (3, format!("NOT {}", child.text(3))),
        };
        if precedence < parent {
            format!("({text})")
        } else {
            text
        }
    }

    fn sql(&self, params: &mut Vec<SqlValue>) -> String {
        match self {
            Self::Clause { clause } => {
                let field = clause.field.as_deref();
                params.push(if field.is_some() {
                    serde_json::to_string(&clause.values).unwrap().into()
                } else {
                    clause.values[0].clone().into()
                });
                let bind = params.len();
                if field.is_none() {
                    return format!(
                        "EXISTS (SELECT 1 FROM json_each(json_array(a.name,CAST(a.id AS TEXT),a.harness,a.model,a.grp,a.status_text,a.task)) field WHERE instr(acom_lower(coalesce(field.value,'')),?{bind})>0)"
                    );
                }
                let column = match field.unwrap() {
                    "group" => "coalesce(a.grp,'')",
                    "provider" => "a.harness",
                    "model" => "a.model",
                    "effort" => "a.effort",
                    "state" => "a.state",
                    "pause_reason" => {
                        "CASE WHEN a.pause_reason IN ('user','all') THEN 'manual' ELSE a.pause_reason END"
                    }
                    _ => unreachable!(),
                };
                let predicate =
                    format!("coalesce(({column}) IN (SELECT value FROM json_each(?{bind})),0)");
                if field == Some("pause_reason") {
                    format!("(coalesce(a.state='paused',0) AND {predicate})")
                } else {
                    predicate
                }
            }
            Self::And { children } | Self::Or { children } => {
                let join = if matches!(self, Self::And { .. }) {
                    " AND "
                } else {
                    " OR "
                };
                format!(
                    "({})",
                    children
                        .iter()
                        .map(|child| child.sql(params))
                        .collect::<Vec<_>>()
                        .join(join)
                )
            }
            Self::Not { child } => format!("(NOT ({}))", child.sql(params)),
        }
    }
}

struct Parser {
    tokens: std::iter::Peekable<std::vec::IntoIter<Token>>,
    query: ParsedAgentQuery,
}

impl Parser {
    fn lex(search: &str) -> R<Vec<Token>> {
        let mut tokens = Vec::new();
        let mut token = Vec::new();
        fn flush(tokens: &mut Vec<Token>, token: &mut Vec<Part>) {
            if token.is_empty() {
                return;
            }
            let operator = token
                .iter()
                .all(|part| matches!(part, Part::Char(_, false)));
            tokens.push(match (operator, decoded(token).as_str()) {
                (true, "AND") => Token::And,
                (true, "OR") => Token::Or,
                (true, "NOT") => Token::Not,
                _ => Token::Clause(std::mem::take(token)),
            });
            token.clear();
        }
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
                    flush(&mut tokens, &mut token);
                }
                '(' | ')' if !quoted => {
                    flush(&mut tokens, &mut token);
                    tokens.push(if ch == '(' { Token::Open } else { Token::Close });
                }
                ch => token.push(Part::Char(ch, quoted)),
            }
        }
        if quoted {
            return Err(bad("search has an unclosed double quote"));
        }
        flush(&mut tokens, &mut token);
        Ok(tokens)
    }

    fn or(&mut self, depth: usize) -> R<Expression> {
        let mut children = vec![self.and(depth)?];
        while matches!(self.tokens.peek(), Some(Token::Or)) {
            self.tokens.next();
            children.push(self.and(depth)?);
        }
        Ok(Expression::join(false, children))
    }

    fn and(&mut self, depth: usize) -> R<Expression> {
        let mut children = vec![self.unary(depth)?];
        loop {
            match self.tokens.peek() {
                Some(Token::And) => {
                    self.tokens.next();
                }
                Some(Token::Clause(_) | Token::Open | Token::Not) => {}
                _ => break,
            }
            children.push(self.unary(depth)?);
        }
        Ok(Expression::join(true, children))
    }

    fn unary(&mut self, depth: usize) -> R<Expression> {
        match self.tokens.next() {
            Some(Token::Not) | Some(Token::Open) if depth >= MAX_DEPTH => {
                Err(bad("search nesting and NOT depth must be at most 32"))
            }
            Some(Token::Not) => Ok(Expression::Not {
                child: Box::new(self.unary(depth + 1)?),
            }),
            Some(Token::Open) => {
                let expression = self.or(depth + 1)?;
                if !matches!(self.tokens.next(), Some(Token::Close)) {
                    return Err(bad("search has an unclosed parenthesis"));
                }
                Ok(expression)
            }
            Some(Token::Clause(token)) => self.clause(token),
            _ => Err(bad(
                "search requires a clause, NOT clause, or parenthesized expression",
            )),
        }
    }

    fn clause(&mut self, token: Vec<Part>) -> R<Expression> {
        let clause = if let Some(colon) = token
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
            for parts in token[colon + 1..].split(|part| matches!(part, Part::Char(',', false))) {
                if parts
                    .iter()
                    .any(|part| matches!(part, Part::Char(':', false)))
                {
                    return Err(bad(format!("quote literal colons in {field} values")));
                }
                let value = decoded(parts);
                if value.is_empty()
                    && !(field == "group" && parts.iter().any(|part| matches!(part, Part::Quote)))
                {
                    return Err(bad(format!(
                        "{field} search values must be nonempty; use group:\"\" for ungrouped agents"
                    )));
                }
                values.push(value);
            }
            self.query.add_clause(Some(field), values)?
        } else {
            let term = decoded(&token);
            if term.is_empty() {
                return Err(bad("search terms must be nonempty"));
            }
            self.query.add_clause(None, vec![term])?
        };
        Ok(Expression::Clause { clause })
    }
}

impl ParsedAgentQuery {
    pub fn parse(search: &str) -> R<Self> {
        if search.len() > MAX_BYTES {
            return Err(bad("search must be at most 4096 bytes"));
        }
        let mut parser = Parser {
            tokens: Parser::lex(search)?.into_iter().peekable(),
            query: Self::default(),
        };
        if parser.tokens.peek().is_some() {
            parser.query.expression = Some(parser.or(0)?);
            if parser.tokens.peek().is_some() {
                return Err(bad(
                    "search has an unexpected closing parenthesis or operator",
                ));
            }
        }
        parser.query.check()?;
        Ok(parser.query)
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
                if query
                    .expression
                    .as_ref()
                    .is_some_and(|expression| expression.contains_field(field))
                {
                    return Err(bad(format!(
                        "{field} must not be repeated between a scalar filter and search; put the full condition in search"
                    )));
                }
                let clause = query.add_clause(Some(field.to_string()), vec![value.to_string()])?;
                let leaf = Expression::Clause { clause };
                query.expression = Some(match query.expression.take() {
                    Some(expression) => Expression::join(true, vec![expression, leaf]),
                    None => leaf,
                });
            }
        }
        query.check()?;
        Ok(query)
    }

    fn add_clause(&mut self, field: Option<String>, mut values: Vec<String>) -> R<QueryClause> {
        self.clause_count += 1;
        if self.clause_count > MAX_CLAUSES {
            return Err(bad("search must have at most 64 clauses"));
        }
        self.value_count += if field.is_some() { values.len() } else { 0 };
        if self.value_count > MAX_VALUES {
            return Err(bad("search must have at most 128 field values"));
        }
        for value in &values {
            let valid = match field.as_deref() {
                Some("provider") => ["claude", "codex"].contains(&value.as_str()),
                Some("state") => STATES.contains(&value.as_str()),
                Some("pause_reason") => ["manual", "limit", "restart"].contains(&value.as_str()),
                Some("group") => true,
                _ => !value.is_empty(),
            };
            if !valid {
                let choices = match field.as_deref() {
                    Some("provider") => "claude or codex".to_string(),
                    Some("state") => STATES.join(", "),
                    Some("pause_reason") => "manual, limit or restart".to_string(),
                    _ => "nonempty".to_string(),
                };
                return Err(bad(format!(
                    "{} must be {choices}",
                    field.as_deref().unwrap_or("term")
                )));
            }
        }
        values.sort();
        values.dedup();
        Ok(QueryClause::new(field, values))
    }

    fn check(&self) -> R<()> {
        if self.text().len() > MAX_BYTES {
            return Err(bad("normalized search must be at most 4096 bytes"));
        }
        Ok(())
    }

    pub fn clauses(&self) -> Option<Vec<QueryClause>> {
        let mut clauses = Vec::new();
        fn collect(expression: &Expression, clauses: &mut Vec<QueryClause>) -> bool {
            match expression {
                Expression::Clause { clause } => {
                    clauses.push(clause.clone());
                    true
                }
                Expression::And { children } => {
                    children.iter().all(|child| collect(child, clauses))
                }
                _ => false,
            }
        }
        if self
            .expression
            .as_ref()
            .is_some_and(|expression| !collect(expression, &mut clauses))
        {
            return None;
        }
        let mut seen = BTreeSet::new();
        if clauses
            .iter()
            .filter_map(|clause| clause.field.as_deref())
            .any(|field| !seen.insert(field))
        {
            return None;
        }
        let mut sorted = Vec::new();
        for field in FIELDS {
            if let Some(clause) = clauses
                .iter()
                .find(|clause| clause.field.as_deref() == Some(field))
            {
                sorted.push(clause.clone());
            }
        }
        sorted.extend(clauses.into_iter().filter(|clause| clause.field.is_none()));
        Some(sorted)
    }

    pub fn text(&self) -> String {
        match self.clauses() {
            Some(clauses) => clauses
                .iter()
                .map(|clause| clause.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            None => self.expression.as_ref().unwrap().text(0),
        }
    }

    pub fn view(&self) -> serde_json::Value {
        serde_json::json!({"text": self.text(), "clauses": self.clauses(), "expression": self.expression})
    }

    pub fn scope(&self) -> String {
        serde_json::to_string(&self.expression.as_ref().map(Expression::normalized)).unwrap()
    }

    pub fn compile(&self, project: Option<i64>) -> (String, Vec<SqlValue>) {
        let mut params = vec![project.into()];
        let sql = self
            .expression
            .as_ref()
            .map(|expression| expression.normalized().sql(&mut params))
            .unwrap_or_else(|| "1".to_string());
        (sql, params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn boolean_precedence_and_advanced_view() {
        let view = ParsedAgentQuery::parse("state:idle OR pause_reason:limit")
            .unwrap()
            .view();
        assert_eq!(view["expression"]["op"], "or");
        assert_eq!(view["clauses"], serde_json::Value::Null);
        let view = ParsedAgentQuery::parse("a OR b AND NOT (c OR d)")
            .unwrap()
            .view();
        assert_eq!(view["expression"]["op"], "or");
        assert_eq!(view["expression"]["children"][1]["op"], "and");
        assert_eq!(
            view["expression"]["children"][1]["children"][1]["op"],
            "not"
        );
        assert_eq!(
            ParsedAgentQuery::parse("").unwrap().view()["expression"],
            serde_json::Value::Null
        );
        for input in [
            "state:idle state:paused",
            "group:a OR group:b",
            "NOT NOT state:paused",
            "a(b OR c)",
            "NOT(a OR b)",
            r#""AND" "OR" "NOT" "(literal)" group:"x(y)""#,
            "group:OR",
        ] {
            let query = ParsedAgentQuery::parse(input).unwrap();
            assert_eq!(
                query.scope(),
                ParsedAgentQuery::parse(&query.text()).unwrap().scope(),
                "{input}"
            );
        }
        assert!(
            ParsedAgentQuery::parse("state:idle state:paused")
                .unwrap()
                .clauses()
                .is_none()
        );
        assert!(
            ParsedAgentQuery::parse("group:a (provider:codex AND x)")
                .unwrap()
                .clauses()
                .is_some()
        );
        assert!(
            ParsedAgentQuery::parse("or and not")
                .unwrap()
                .clauses()
                .is_some()
        );
    }

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
        let terms: Vec<_> = query
            .clauses()
            .unwrap()
            .into_iter()
            .filter(|clause| clause.field.is_none())
            .map(|clause| clause.values[0].clone())
            .collect();
        assert_eq!(terms, ["reentrancy", "group:x", "a\\b\"c"]);
        assert_eq!(
            ParsedAgentQuery::parse("group:\"\"").unwrap().view()["clauses"][0]["values"],
            json!([""])
        );
        assert_eq!(
            ParsedAgentQuery::parse("\"state:paused\"").unwrap().view()["clauses"][0]["values"],
            json!(["state:paused"])
        );
        let controls = ParsedAgentQuery::parse("group:\"A\tB\nC\" \"literal\tterm\"").unwrap();
        assert_eq!(
            controls.scope(),
            ParsedAgentQuery::parse(&controls.text()).unwrap().scope()
        );
    }

    #[test]
    fn rejects_malformed_unknown_and_ambiguous_queries() {
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
            "a AND",
            "OR a",
            "a OR",
            "a AND OR b",
            "NOT",
            "()",
            "(a",
            "a)",
            "(a OR)",
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
        for depth in [32, 33] {
            for input in [
                format!("{}x{}", "(".repeat(depth), ")".repeat(depth)),
                format!("{}x", "NOT ".repeat(depth)),
            ] {
                assert_eq!(
                    ParsedAgentQuery::parse(&input).is_ok(),
                    depth == 32,
                    "{input}"
                );
            }
        }
        for input in [
            "NOT group:a",
            "group:b OR state:idle",
            "state:idle OR (NOT group:a)",
        ] {
            assert!(
                AgentFilter {
                    group: Some("a"),
                    search: input,
                    ..AgentFilter::default()
                }
                .normalized()
                .is_err()
            );
        }
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
        assert_eq!(reason.clauses().unwrap().len(), 1);
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
        assert_eq!(direct.view()["clauses"][0]["values"], json!(["a,b"]));
        assert_eq!(
            direct.view()["clauses"][1]["values"],
            json!(["custom effort"])
        );
        for (left, right) in [
            (
                "group:a AND (state:idle OR state:paused)",
                "(state:paused OR state:idle OR state:idle) group:a",
            ),
            ("NOT (A OR b)", "NOT (b OR a)"),
            ("a b c", "c AND (A AND b)"),
        ] {
            assert_eq!(
                ParsedAgentQuery::parse(left).unwrap().scope(),
                ParsedAgentQuery::parse(right).unwrap().scope()
            );
        }
        assert_ne!(
            ParsedAgentQuery::parse("a OR b c").unwrap().scope(),
            ParsedAgentQuery::parse("(a OR b) c").unwrap().scope()
        );
    }
}
