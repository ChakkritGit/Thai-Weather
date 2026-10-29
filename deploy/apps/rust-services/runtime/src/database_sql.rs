//! A deliberately small SQL-shaped language translated into the existing structured API.
//! Input is never sent to PostgreSQL. Unsupported syntax fails closed.
use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum SqlOperation {
    Select {
        schema: String,
        table: String,
        sort: Option<String>,
        descending: bool,
        limit: i64,
    },
    Insert {
        schema: String,
        table: String,
        values: HashMap<String, Option<String>>,
    },
    Update {
        schema: String,
        table: String,
        key: HashMap<String, String>,
        values: HashMap<String, Option<String>>,
    },
    Delete {
        schema: String,
        table: String,
        key: HashMap<String, String>,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum Token {
    Word(String),
    Ident(String),
    Text(String),
    Number(String),
    Symbol(char),
}

type Result<T> = std::result::Result<T, &'static str>;
const INVALID: &str = "unsupported SQL syntax";

fn tokenize(input: &str) -> Result<Vec<Token>> {
    if input.len() > 16_384 || input.contains('\0') {
        return Err(INVALID);
    }
    let chars: Vec<_> = input.chars().collect();
    let mut i = 0;
    let mut tokens = Vec::new();
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '\'' || c == '"' {
            let quote = c;
            i += 1;
            let mut result = String::new();
            let mut closed = false;
            while i < chars.len() {
                if chars[i] == quote {
                    i += 1;
                    if chars.get(i) == Some(&quote) {
                        result.push(quote);
                        i += 1;
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    result.push(chars[i]);
                    i += 1;
                }
            }
            if !closed {
                return Err(INVALID);
            }
            tokens.push(if quote == '\'' {
                Token::Text(result)
            } else {
                Token::Ident(result)
            });
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_alphanumeric() || matches!(chars[i], '_' | '$')) {
                i += 1;
            }
            tokens.push(Token::Word(chars[start..i].iter().collect()));
        } else if c.is_ascii_digit()
            || (c == '-' && chars.get(i + 1).is_some_and(char::is_ascii_digit))
        {
            let start = i;
            if c == '-' {
                i += 1;
            }
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if chars.get(i) == Some(&'.') && chars.get(i + 1).is_some_and(char::is_ascii_digit) {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if matches!(chars.get(i), Some('e' | 'E')) {
                i += 1;
                if matches!(chars.get(i), Some('+' | '-')) {
                    i += 1;
                }
                let digits = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if digits == i {
                    return Err(INVALID);
                }
            }
            tokens.push(Token::Number(chars[start..i].iter().collect()));
        } else if matches!(c, '(' | ')' | ',' | '.' | '=' | '*' | ';') {
            tokens.push(Token::Symbol(c));
            i += 1;
        } else {
            // In particular, comments, operators and escape syntax are not accepted.
            return Err(INVALID);
        }
        if tokens.len() > 1024 {
            return Err(INVALID);
        }
    }
    Ok(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}
impl Parser {
    fn keyword(&mut self, expected: &str) -> bool {
        if matches!(self.tokens.get(self.pos), Some(Token::Word(s)) if s.eq_ignore_ascii_case(expected))
        {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn require_keyword(&mut self, expected: &str) -> Result<()> {
        self.keyword(expected).then_some(()).ok_or(INVALID)
    }
    fn symbol(&mut self, expected: char) -> bool {
        if self.tokens.get(self.pos) == Some(&Token::Symbol(expected)) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn require_symbol(&mut self, expected: char) -> Result<()> {
        self.symbol(expected).then_some(()).ok_or(INVALID)
    }
    fn ident(&mut self) -> Result<String> {
        let name = match self.tokens.get(self.pos) {
            Some(Token::Word(s)) => s.to_ascii_lowercase(),
            Some(Token::Ident(s)) => s.clone(),
            _ => return Err(INVALID),
        };
        if name.is_empty() || name.len() > 128 {
            return Err(INVALID);
        }
        self.pos += 1;
        Ok(name)
    }
    fn table(&mut self) -> Result<(String, String)> {
        let first = self.ident()?;
        if self.symbol('.') {
            Ok((first, self.ident()?))
        } else {
            Ok(("public".into(), first))
        }
    }
    fn value(&mut self) -> Result<Option<String>> {
        let value = match self.tokens.get(self.pos) {
            Some(Token::Text(s) | Token::Number(s)) => Some(s.clone()),
            Some(Token::Word(s)) if s.eq_ignore_ascii_case("null") => None,
            Some(Token::Word(s)) if s.eq_ignore_ascii_case("true") => Some("true".into()),
            Some(Token::Word(s)) if s.eq_ignore_ascii_case("false") => Some("false".into()),
            _ => return Err(INVALID),
        };
        self.pos += 1;
        Ok(value)
    }
    fn fields(&mut self) -> Result<HashMap<String, Option<String>>> {
        let mut values = HashMap::new();
        loop {
            let name = self.ident()?;
            self.require_symbol('=')?;
            if values.insert(name, self.value()?).is_some() || values.len() > 100 {
                return Err(INVALID);
            }
            if !self.symbol(',') {
                break;
            }
        }
        Ok(values)
    }
    fn where_key(&mut self) -> Result<HashMap<String, String>> {
        self.require_keyword("where")?;
        let mut key = HashMap::new();
        loop {
            let name = self.ident()?;
            self.require_symbol('=')?;
            let value = self.value()?.ok_or(INVALID)?;
            if key.insert(name, value).is_some() || key.len() > 32 {
                return Err(INVALID);
            }
            if !self.keyword("and") {
                break;
            }
        }
        Ok(key)
    }
    fn select(&mut self) -> Result<SqlOperation> {
        self.require_symbol('*')?;
        self.require_keyword("from")?;
        let (schema, table) = self.table()?;
        let mut sort = None;
        let mut descending = false;
        if self.keyword("order") {
            self.require_keyword("by")?;
            sort = Some(self.ident()?);
            if self.keyword("desc") {
                descending = true;
            } else {
                self.keyword("asc");
            }
        }
        let mut limit = 50;
        if self.keyword("limit") {
            let Some(Token::Number(s)) = self.tokens.get(self.pos) else {
                return Err(INVALID);
            };
            limit = s.parse().map_err(|_| INVALID)?;
            if !(1..=100).contains(&limit) {
                return Err(INVALID);
            }
            self.pos += 1;
        }
        Ok(SqlOperation::Select {
            schema,
            table,
            sort,
            descending,
            limit,
        })
    }
    fn insert(&mut self) -> Result<SqlOperation> {
        self.require_keyword("into")?;
        let (schema, table) = self.table()?;
        self.require_symbol('(')?;
        let mut names = Vec::new();
        loop {
            names.push(self.ident()?);
            if names.len() > 100 {
                return Err(INVALID);
            }
            if !self.symbol(',') {
                break;
            }
        }
        self.require_symbol(')')?;
        self.require_keyword("values")?;
        self.require_symbol('(')?;
        let mut values = HashMap::new();
        for (i, name) in names.into_iter().enumerate() {
            if i > 0 {
                self.require_symbol(',')?;
            }
            if values.insert(name, self.value()?).is_some() {
                return Err(INVALID);
            }
        }
        self.require_symbol(')')?;
        Ok(SqlOperation::Insert {
            schema,
            table,
            values,
        })
    }
    fn update(&mut self) -> Result<SqlOperation> {
        let (schema, table) = self.table()?;
        self.require_keyword("set")?;
        let values = self.fields()?;
        let key = self.where_key()?;
        Ok(SqlOperation::Update {
            schema,
            table,
            key,
            values,
        })
    }
    fn delete(&mut self) -> Result<SqlOperation> {
        self.require_keyword("from")?;
        let (schema, table) = self.table()?;
        let key = self.where_key()?;
        Ok(SqlOperation::Delete { schema, table, key })
    }
}

pub(super) fn parse(input: &str) -> Result<SqlOperation> {
    let mut parser = Parser {
        tokens: tokenize(input)?,
        pos: 0,
    };
    let operation = if parser.keyword("select") {
        parser.select()?
    } else if parser.keyword("insert") {
        parser.insert()?
    } else if parser.keyword("update") {
        parser.update()?
    } else if parser.keyword("delete") {
        parser.delete()?
    } else {
        return Err(INVALID);
    };
    parser.symbol(';');
    if parser.pos != parser.tokens.len() {
        return Err(INVALID);
    }
    Ok(operation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_safe_single_table_commands() {
        assert_eq!(
            parse("select * from public.items order by amount DESC limit 10;"),
            Ok(SqlOperation::Select {
                schema: "public".into(),
                table: "items".into(),
                sort: Some("amount".into()),
                descending: true,
                limit: 10
            })
        );
        assert_eq!(
            parse("SELECT * FROM \"Post\""),
            Ok(SqlOperation::Select {
                schema: "public".into(),
                table: "Post".into(),
                sort: None,
                descending: false,
                limit: 50
            })
        );
        assert_eq!(
            parse("insert into items (name, amount, nullable) values ('O''Brien', -1.5, NULL)"),
            Ok(SqlOperation::Insert {
                schema: "public".into(),
                table: "items".into(),
                values: HashMap::from([
                    ("name".into(), Some("O'Brien".into())),
                    ("amount".into(), Some("-1.5".into())),
                    ("nullable".into(), None)
                ])
            })
        );
        assert_eq!(
            parse(
                "UPDATE public.pair SET value='changed' WHERE first_key='one' AND second_key='two'"
            ),
            Ok(SqlOperation::Update {
                schema: "public".into(),
                table: "pair".into(),
                key: HashMap::from([
                    ("first_key".into(), "one".into()),
                    ("second_key".into(), "two".into())
                ]),
                values: HashMap::from([("value".into(), Some("changed".into()))])
            })
        );
        assert_eq!(
            parse("DELETE FROM items WHERE id=7"),
            Ok(SqlOperation::Delete {
                schema: "public".into(),
                table: "items".into(),
                key: HashMap::from([("id".into(), "7".into())])
            })
        );
    }

    #[test]
    fn rejects_bypasses_and_unimplemented_sql() {
        for sql in [
            "SELECT * FROM items; DROP TABLE items",
            "SELECT * FROM items;;",
            "SELECT * FROM items -- comment",
            "SELECT * FROM items /* comment */",
            "SELECT token FROM items",
            "SELECT * FROM items WHERE id=1",
            "SELECT * FROM items ORDER BY token; SELECT * FROM sessions",
            "SELECT * FROM items LIMIT 0",
            "SELECT * FROM items LIMIT 101",
            "SELECT * FROM items LIMIT 1.5",
            "SELECT * FROM items LIMIT -1",
            "SELECT * FROM items JOIN secrets ON true",
            "SELECT * FROM items ORDER BY (SELECT token)",
            "INSERT INTO items (name) VALUES (pg_read_file('/etc/passwd'))",
            "INSERT INTO items (name) VALUES ('x'),('y')",
            "UPDATE items SET name='x'",
            "UPDATE items SET name='x' WHERE id=1 OR true",
            "UPDATE items SET name='x' WHERE id=NULL",
            "UPDATE items SET name='x', name='y' WHERE id=1",
            "UPDATE items SET name='x' WHERE id=1 AND id=2",
            "DELETE FROM items",
            "DELETE FROM items WHERE id=1 RETURNING *",
            "DELETE FROM items WHERE id=1; COMMIT",
            "WITH x AS (DELETE FROM items) SELECT * FROM x",
            "UPDATE items SET name=E'x' WHERE id=1",
            "UPDATE items SET name='unterminated WHERE id=1",
        ] {
            assert!(parse(sql).is_err(), "accepted {sql}");
        }
    }

    #[test]
    fn literals_are_data_not_sql_and_identifiers_are_folded_or_quoted() {
        let result =
            parse("UPDATE \"Odd.Schema\".\"x\"\"y\" SET VALUE='a; DROP -- ''quoted''' WHERE ID=1")
                .unwrap();
        assert_eq!(
            result,
            SqlOperation::Update {
                schema: "Odd.Schema".into(),
                table: "x\"y".into(),
                key: HashMap::from([("id".into(), "1".into())]),
                values: HashMap::from([("value".into(), Some("a; DROP -- 'quoted'".into()))])
            }
        );
    }
}
