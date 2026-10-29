//! Dock database manager: catalog-backed identifiers, an explicit disclosure policy and audited writes.
use crate::util;
use axum::{
    Json, Router,
    extract::{Query, State},
    response::Response,
    routing::get,
};
use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use tokio_postgres::{Client, GenericClient, NoTls, Transaction};

type Error = Box<dyn std::error::Error + Send + Sync>;
type Policy = HashMap<String, HashMap<String, HashMap<String, Vec<String>>>>;

struct App {
    host: String,
    user: String,
    password: String,
    policy: Policy,
    audit: PathBuf,
    permits: Semaphore,
}

#[derive(Clone)]
struct Column {
    name: String,
    kind: String,
    nullable: bool,
    has_default: bool,
    generated: bool,
    primary: bool,
    secret: bool,
}

fn sensitive(name: &str) -> bool {
    let name = name.to_ascii_lowercase().replace(['_', '-'], "");
    [
        "password",
        "passwd",
        "secret",
        "token",
        "credential",
        "session",
        "passkey",
        "privatekey",
        "apikey",
        "oauth",
        "auth",
        "hash",
        "salt",
        "otp",
        "recovery",
    ]
    .iter()
    .any(|word| name.contains(word))
}

fn identifier(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
fn database_allowed(s: &str) -> bool {
    ["postgres", "expenses", "portfolio", "calorieflow"].contains(&s)
}
fn schema_allowed(s: &str) -> bool {
    !s.is_empty() && s != "information_schema" && !s.starts_with("pg_")
}
fn disclosure_type_allowed(name: &str, is_enum: bool, is_builtin: bool) -> bool {
    is_enum
        || (is_builtin
            && matches!(
                name,
                "uuid"
                    | "text"
                    | "varchar"
                    | "bpchar"
                    | "numeric"
                    | "int2"
                    | "int4"
                    | "int8"
                    | "float4"
                    | "float8"
                    | "bool"
                    | "date"
                    | "timestamp"
                    | "timestamptz"
                    | "_text"
                    | "_varchar"
            ))
}

impl App {
    async fn connect(&self, database: &str) -> Result<Client, Error> {
        if !database_allowed(database) || self.user.is_empty() || self.password.is_empty() {
            return Err("database unavailable".into());
        }
        let mut c = tokio_postgres::Config::new();
        c.host(&self.host).user(&self.user).password(&self.password).dbname(database)
            .application_name("dock-database")
            .connect_timeout(Duration::from_secs(5))
            .options("-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000 -c search_path=pg_catalog -c standard_conforming_strings=on");
        let (client, connection) =
            tokio::time::timeout(Duration::from_secs(6), c.connect(NoTls)).await??;
        tokio::spawn(async move {
            if connection.await.is_err() {
                eprintln!("database manager connection closed");
            }
        });
        Ok(client)
    }
    async fn columns<C: GenericClient + Sync>(
        &self,
        client: &C,
        db: &str,
        schema: &str,
        table: &str,
    ) -> Result<Vec<Column>, Error> {
        if !schema_allowed(schema) || table.is_empty() {
            return Err("invalid table".into());
        }
        let allowed = self
            .policy
            .get(db)
            .and_then(|v| v.get(schema))
            .and_then(|v| v.get(table));
        let rows = client.query("SELECT a.attname, pg_catalog.format_type(a.atttypid,a.atttypmod), NOT a.attnotnull, (d.adbin IS NOT NULL), (a.attgenerated <> '' OR a.attidentity <> ''), EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)), t.typname, t.typtype='e', (t.typnamespace='pg_catalog'::pg_catalog.regnamespace AND t.typtype='b') FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid JOIN pg_catalog.pg_type t ON t.oid=a.atttypid LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", &[&schema,&table]).await?;
        let mut columns = Vec::new();
        for r in rows {
            let name: String = r.get(0);
            let type_name: String = r.get(6);
            let secret = sensitive(schema)
                || sensitive(table)
                || sensitive(&name)
                || !disclosure_type_allowed(&type_name, r.get(7), r.get(8))
                || !allowed.is_some_and(|v| v.contains(&name));
            columns.push(Column {
                name,
                kind: r.get(1),
                nullable: r.get(2),
                has_default: r.get(3),
                generated: r.get(4),
                primary: r.get(5),
                secret,
            });
        }
        if columns.is_empty() {
            return Err("table unavailable".into());
        }
        Ok(columns)
    }
    fn audit_open(&self) -> Result<Connection, Error> {
        let c = Connection::open(&self.audit)?;
        c.busy_timeout(Duration::from_secs(2))?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, database_name TEXT NOT NULL, schema_name TEXT NOT NULL, table_name TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, columns_changed TEXT NOT NULL)")?;
        Ok(c)
    }
}

// Acquire a relation lock before looking at its type or column metadata. It is
// held until the transaction ends, so concurrent DDL cannot replace the relation
// or alter its fields between the disclosure check and the actual operation.
async fn lock_table(
    tx: &Transaction<'_>,
    schema: &str,
    table: &str,
    write: bool,
) -> Result<(), Error> {
    if !schema_allowed(schema) || table.is_empty() || schema.len() > 256 || table.len() > 256 {
        return Err("invalid table".into());
    }
    let mode = if write {
        "ROW EXCLUSIVE"
    } else {
        "ACCESS SHARE"
    };
    tx.batch_execute(&format!(
        "LOCK TABLE {}.{} IN {mode} MODE",
        identifier(schema),
        identifier(table)
    ))
    .await?;
    Ok(())
}

async fn relation_oid(tx: &Transaction<'_>, schema: &str, table: &str) -> Result<u32, Error> {
    let row = tx.query_one("SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p')", &[&schema,&table]).await?;
    Ok(row.get(0))
}

#[derive(Deserialize)]
struct TableQuery {
    database: String,
}
#[derive(Deserialize)]
struct RowQuery {
    database: String,
    schema: String,
    table: String,
    #[serde(default)]
    search: String,
    #[serde(default)]
    sort: String,
    #[serde(default)]
    direction: String,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}
#[derive(Deserialize)]
struct Mutation {
    database: String,
    schema: String,
    table: String,
    action: String,
    #[serde(default)]
    key: HashMap<String, String>,
    #[serde(default)]
    values: serde_json::Map<String, Value>,
    #[serde(default)]
    version: String,
    #[serde(default)]
    confirm: bool,
}
#[derive(Deserialize)]
struct SqlRequest {
    database: String,
    sql: String,
    #[serde(default)]
    write: bool,
    #[serde(default)]
    confirm: bool,
}
fn error(status: u16, msg: &str) -> Response {
    util::json(status, json!({"error":msg,"message":msg}))
}
fn busy() -> Response {
    error(503, "database manager busy")
}

async fn databases(State(a): State<Arc<App>>) -> Response {
    let Ok(_permit) = a.permits.try_acquire() else {
        return busy();
    };
    let Ok(c) = a.connect("postgres").await else {
        return error(503, "database unavailable");
    };
    match c.query("SELECT datname FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname", &[]).await {
        Ok(rows) => util::json(200, json!({"databases":rows.iter().filter_map(|r| { let name: String = r.get(0); database_allowed(&name).then_some(json!({"name":name})) }).collect::<Vec<_>>() })),
        Err(_) => error(503, "database unavailable"),
    }
}
async fn tables(State(a): State<Arc<App>>, Query(q): Query<TableQuery>) -> Response {
    let Ok(_permit) = a.permits.try_acquire() else {
        return busy();
    };
    let Ok(c) = a.connect(&q.database).await else {
        return error(503, "database unavailable");
    };
    let sql = "SELECT n.nspname,c.relname,GREATEST(c.reltuples,0)::bigint,pg_catalog.pg_total_relation_size(c.oid) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname <> 'information_schema' AND left(n.nspname,3) <> 'pg_' ORDER BY n.nspname,c.relname";
    match c.query(sql, &[]).await {
        Ok(rows) => util::json(
            200,
            json!({"tables":rows.iter().map(|r| json!({"schema":r.get::<_,String>(0),"name":r.get::<_,String>(1),"rows":r.get::<_,i64>(2),"size":r.get::<_,i64>(3)})).collect::<Vec<_>>() }),
        ),
        Err(_) => error(503, "tables unavailable"),
    }
}
fn editable(schema: &str, columns: &[Column]) -> bool {
    schema == "public"
        && columns.iter().any(|c| c.primary)
        && !columns.iter().any(|c| c.primary && c.secret)
}
fn columns_json(columns: &[Column]) -> Vec<Value> {
    columns.iter().map(|c| json!({"name":c.name,"type":c.kind,"nullable":c.nullable,"has_default":c.has_default,"generated":c.generated,"primary":c.primary,"secret":c.secret})).collect()
}
async fn rows(State(a): State<Arc<App>>, Query(q): Query<RowQuery>) -> Response {
    let Ok(_permit) = a.permits.try_acquire() else {
        return busy();
    };
    if q.search.len() > 256
        || q.sort.len() > 256
        || q.offset.unwrap_or(0) < 0
        || q.offset.unwrap_or(0) > 1_000_000
    {
        return error(400, "invalid query");
    }
    let Ok(mut c) = a.connect(&q.database).await else {
        return error(503, "database unavailable");
    };
    let Ok(tx) = c.build_transaction().read_only(true).start().await else {
        return error(503, "database unavailable");
    };
    if lock_table(&tx, &q.schema, &q.table, false).await.is_err() {
        return error(404, "table unavailable");
    }
    let Ok(oid) = relation_oid(&tx, &q.schema, &q.table).await else {
        return error(404, "table unavailable");
    };
    let Ok(cols) = a.columns(&tx, &q.database, &q.schema, &q.table).await else {
        return error(404, "table unavailable");
    };
    let safe: Vec<_> = cols.iter().filter(|x| !x.secret).collect();
    let can_edit = editable(&q.schema, &cols);
    if safe.is_empty() {
        return util::json(
            200,
            json!({"columns":columns_json(&cols),"rows":[],"total":0,"editable":false}),
        );
    }
    let selected = if q.sort.is_empty() {
        None
    } else {
        safe.iter().find(|x| x.name == q.sort).copied()
    };
    if !q.sort.is_empty() && selected.is_none() {
        return error(400, "invalid sort");
    }
    if !q.direction.is_empty() && !["asc", "desc"].contains(&q.direction.as_str()) {
        return error(400, "invalid sort direction");
    }
    let table = format!("{}.{}", identifier(&q.schema), identifier(&q.table));
    let values = safe.iter().map(|x| { let col=identifier(&x.name); format!("{},CASE WHEN t.{col} IS NULL THEN NULL WHEN octet_length(t.{col}::text)>16384 THEN to_jsonb('[value too large]'::text) ELSE to_jsonb(t.{col}) END",literal(&x.name)) }).collect::<Vec<_>>().join(",");
    let keys = if can_edit {
        cols.iter()
            .filter(|x| x.primary)
            .map(|x| format!("{},t.{}::text", literal(&x.name), identifier(&x.name)))
            .collect::<Vec<_>>()
            .join(",")
    } else {
        String::new()
    };
    let searches = safe
        .iter()
        .map(|x| {
            format!(
                "position(lower($1) in lower(coalesce(t.{}::text,'')))>0",
                identifier(&x.name)
            )
        })
        .collect::<Vec<_>>()
        .join(" OR ");
    let filter = format!("($1='' OR ({searches}))");
    let order = selected
        .map(|x| {
            format!(
                "ORDER BY t.{} {} NULLS LAST",
                identifier(&x.name),
                if q.direction == "desc" { "DESC" } else { "ASC" }
            )
        })
        .unwrap_or_default();
    let count_sql = format!("SELECT count(*) FROM {table} t WHERE {filter}");
    let data_sql = format!(
        "SELECT json_build_object('values',json_build_object({values}),'key',json_build_object({keys}),'version','{oid}:' || t.tableoid::text || ':' || t.xmin::text)::text FROM {table} t WHERE {filter} {order} LIMIT $2 OFFSET $3"
    );
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let offset = q.offset.unwrap_or(0);
    let result = async {
        let total: i64 = tx.query_one(&count_sql, &[&q.search]).await?.get(0);
        let data = tx.query(&data_sql, &[&q.search, &limit, &offset]).await?;
        let mut values = Vec::new();
        for r in data {
            let s: String = r.get(0);
            values.push(serde_json::from_str::<Value>(&s)?);
        }
        Ok::<_, Error>((total, values))
    }
    .await;
    match result {
        Ok((total, values)) => {
            if tx.commit().await.is_err() {
                return error(503, "rows unavailable");
            }
            util::json(
                200,
                json!({"columns":columns_json(&cols),"rows":values,"total":total,"editable":can_edit}),
            )
        }
        Err(_) => error(503, "rows unavailable"),
    }
}

// An audit attempt is written before PostgreSQL is changed. If the manager is killed
// before recording the outcome, the durable 'pending' entry remains visible.
fn start_audit(a: &App, m: &Mutation) -> Result<i64, Error> {
    let db = a.audit_open()?;
    let mut names: Vec<&str> = m.values.keys().map(String::as_str).collect();
    names.sort_unstable();
    let names = serde_json::to_string(&names)?;
    db.execute(
        "INSERT INTO audit (time,database_name,schema_name,table_name,action,status,columns_changed) VALUES (CAST(strftime('%s','now') AS INTEGER)*1000,?1,?2,?3,?4,'pending',?5)",
        params![m.database,m.schema,m.table,m.action,names],
    )?;
    Ok(db.last_insert_rowid())
}

fn finish_audit(a: &App, id: i64, status: &str) -> Result<(), Error> {
    a.audit_open()?.execute(
        "UPDATE audit SET status=?1 WHERE id=?2",
        params![status, id],
    )?;
    Ok(())
}

async fn audit(State(a): State<Arc<App>>) -> Response {
    let Ok(_permit) = a.permits.try_acquire() else {
        return busy();
    };
    let result = || -> Result<Vec<Value>, Error> {
        let db = a.audit_open()?;
        let mut stmt = db.prepare("SELECT time,database_name,schema_name,table_name,action,status,columns_changed FROM audit ORDER BY id DESC LIMIT 100")?;
        let rows = stmt.query_map([], |r| {
            Ok(json!({
                "time":r.get::<_,i64>(0)?, "database":r.get::<_,String>(1)?,
                "schema":r.get::<_,String>(2)?, "table":r.get::<_,String>(3)?,
                "action":r.get::<_,String>(4)?, "status":r.get::<_,String>(5)?,
                "columns":serde_json::from_str::<Value>(&r.get::<_,String>(6)?).unwrap_or(json!([]))
            }))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    };
    match result() {
        Ok(entries) => util::json(200, json!({"entries":entries})),
        Err(_) => error(503, "audit unavailable"),
    }
}

fn parse_version(s: &str) -> Option<(u32, &str, &str)> {
    let (oid, rest) = s.split_once(':')?;
    let (row_oid, xmin) = rest.split_once(':')?;
    if oid.is_empty()
        || oid.len() > 10
        || !oid.bytes().all(|b| b.is_ascii_digit())
        || row_oid.is_empty()
        || row_oid.len() > 10
        || !row_oid.bytes().all(|b| b.is_ascii_digit())
        || row_oid.parse::<u32>().is_err()
        || xmin.is_empty()
        || xmin.len() > 10
        || !xmin.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((oid.parse().ok()?, row_oid, xmin))
}

async fn mutate(State(a): State<Arc<App>>, Json(m): Json<Mutation>) -> Response {
    let Ok(_permit) = a.permits.try_acquire() else {
        return busy();
    };
    if !m.confirm
        || !["insert", "update", "delete"].contains(&m.action.as_str())
        || m.values.len() > 100
        || m.key.len() > 32
    {
        return error(400, "confirmation or action invalid");
    }
    let Ok(mut c) = a.connect(&m.database).await else {
        return error(503, "database unavailable");
    };
    let Ok(tx) = c.transaction().await else {
        return error(503, "database unavailable");
    };
    if lock_table(&tx, &m.schema, &m.table, true).await.is_err() {
        return error(404, "table unavailable");
    }
    let Ok(oid) = relation_oid(&tx, &m.schema, &m.table).await else {
        return error(404, "table unavailable");
    };
    let Ok(cols) = a.columns(&tx, &m.database, &m.schema, &m.table).await else {
        return error(404, "table unavailable");
    };
    if !editable(&m.schema, &cols) {
        return error(403, "table is read-only");
    }
    let pk: Vec<_> = cols.iter().filter(|c| c.primary).collect();
    let version = parse_version(&m.version);
    if m.action != "insert"
        && (version.is_none()
            || m.key.len() != pk.len()
            || pk.iter().any(|c| !m.key.contains_key(&c.name)))
    {
        return error(400, "row key or version invalid");
    }
    if m.action != "insert" && version.is_some_and(|(version_oid, _, _)| version_oid != oid) {
        return error(409, "table changed; reload the row");
    }
    if m.action == "insert" && (!m.key.is_empty() || !m.version.is_empty()) {
        return error(400, "insert key invalid");
    }
    if m.action == "delete" && !m.values.is_empty() {
        return error(400, "delete values invalid");
    }
    if m.action == "update" && m.values.is_empty() {
        return error(400, "no fields selected");
    }
    let mut params: Vec<Option<String>> = Vec::new();
    let mut assignments = Vec::new();
    let mut field_names = Vec::new();
    let mut fields: Vec<_> = m.values.iter().collect();
    fields.sort_unstable_by(|a, b| a.0.cmp(b.0));
    for (name, value) in fields {
        let Some(col) = cols.iter().find(|c| {
            !(c.name != *name || c.secret || c.generated || m.action == "update" && c.primary)
        }) else {
            return error(400, "field unavailable");
        };
        let value = match value {
            Value::Null if col.nullable => None,
            Value::String(s) if s.len() <= 16384 => Some(s.clone()),
            _ => return error(400, "field value invalid"),
        };
        params.push(value);
        let cast = format!("${}::text::{}", params.len(), col.kind);
        assignments.push(format!("{}={cast}", identifier(name)));
        field_names.push((identifier(name), cast));
    }
    let table = format!("{}.{}", identifier(&m.schema), identifier(&m.table));
    let sql = if m.action == "insert" {
        if field_names.is_empty() {
            format!("INSERT INTO {table} DEFAULT VALUES")
        } else {
            format!(
                "INSERT INTO {table} ({}) VALUES ({})",
                field_names
                    .iter()
                    .map(|x| x.0.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
                field_names
                    .iter()
                    .map(|x| x.1.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    } else {
        let mut filters = Vec::new();
        for col in pk {
            let value = &m.key[&col.name];
            if value.len() > 4096 {
                return error(400, "row key invalid");
            }
            params.push(Some(value.clone()));
            filters.push(format!(
                "{}=${}::text::{}",
                identifier(&col.name),
                params.len(),
                col.kind
            ));
        }
        params.push(Some(version.unwrap().1.to_string()));
        filters.push(format!("tableoid::text=${}::text", params.len()));
        params.push(Some(version.unwrap().2.to_string()));
        filters.push(format!("xmin::text=${}::text", params.len()));
        if m.action == "update" {
            format!(
                "UPDATE {table} SET {} WHERE {}",
                assignments.join(","),
                filters.join(" AND ")
            )
        } else {
            format!("DELETE FROM {table} WHERE {}", filters.join(" AND "))
        }
    };
    let Ok(audit_id) = start_audit(&a, &m) else {
        return error(503, "audit unavailable");
    };
    let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
        .iter()
        .map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    let result = tx.execute(&sql, &refs).await;
    let (status, code, message) = match result {
        Ok(1) => match tx.commit().await {
            Ok(()) => ("success", 200, "ok"),
            Err(_) => ("unknown", 503, "write outcome requires audit review"),
        },
        Ok(0) => {
            let _ = tx.rollback().await;
            ("conflict", 409, "row changed or no longer exists")
        }
        Ok(_) => {
            let _ = tx.rollback().await;
            ("failed", 500, "unexpected row count")
        }
        Err(_) => {
            let _ = tx.rollback().await;
            (
                "failed",
                400,
                "could not change row; check the values and constraints",
            )
        }
    };
    if finish_audit(&a, audit_id, status).is_err() {
        eprintln!("database manager: could not record write outcome");
        return error(503, "write outcome requires audit review");
    }
    if code == 200 {
        util::json(code, json!({"ok":true}))
    } else {
        error(code, message)
    }
}

// Fetch a version only for an exact, policy-approved primary key. mutate() then
// compares the relation, physical table and xmin; a concurrent change becomes 409.
async fn row_version(
    a: &App,
    db: &str,
    schema: &str,
    table: &str,
    key: &HashMap<String, String>,
) -> Result<String, Response> {
    let _permit = a.permits.try_acquire().map_err(|_| busy())?;
    let mut c = a
        .connect(db)
        .await
        .map_err(|_| error(503, "database unavailable"))?;
    let tx = c
        .build_transaction()
        .read_only(true)
        .start()
        .await
        .map_err(|_| error(503, "database unavailable"))?;
    lock_table(&tx, schema, table, false)
        .await
        .map_err(|_| error(404, "table unavailable"))?;
    let oid = relation_oid(&tx, schema, table)
        .await
        .map_err(|_| error(404, "table unavailable"))?;
    let cols = a
        .columns(&tx, db, schema, table)
        .await
        .map_err(|_| error(404, "table unavailable"))?;
    if !editable(schema, &cols) {
        return Err(error(403, "table is read-only"));
    }
    let pk: Vec<_> = cols.iter().filter(|c| c.primary).collect();
    if key.len() != pk.len() || pk.iter().any(|c| !key.contains_key(&c.name)) {
        return Err(error(400, "complete primary key required"));
    }
    let mut values = Vec::new();
    let mut predicates = Vec::new();
    for col in pk {
        let value = &key[&col.name];
        if value.len() > 4096 {
            return Err(error(400, "row key invalid"));
        }
        values.push(value.clone());
        predicates.push(format!(
            "{}=${}::text::{}",
            identifier(&col.name),
            values.len(),
            col.kind
        ));
    }
    let sql = format!(
        "SELECT tableoid::text,xmin::text FROM {}.{} WHERE {}",
        identifier(schema),
        identifier(table),
        predicates.join(" AND ")
    );
    let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = values
        .iter()
        .map(|v| v as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    match tx.query_opt(&sql, &refs).await {
        Ok(Some(row)) => {
            let row_oid: String = row.get(0);
            let xmin: String = row.get(1);
            tx.commit()
                .await
                .map_err(|_| error(503, "database unavailable"))?;
            Ok(format!("{oid}:{row_oid}:{xmin}"))
        }
        Ok(None) => Err(error(404, "row not found")),
        Err(_) => Err(error(400, "row key invalid")),
    }
}

async fn sql_query(State(a): State<Arc<App>>, Json(q): Json<SqlRequest>) -> Response {
    use crate::database_sql::SqlOperation;
    let Ok(op) = crate::database_sql::parse(&q.sql) else {
        return error(400, "unsupported SQL syntax");
    };
    if let SqlOperation::Select {
        schema,
        table,
        sort,
        descending,
        limit,
    } = op
    {
        return rows(
            State(a),
            Query(RowQuery {
                database: q.database,
                schema,
                table,
                search: String::new(),
                sort: sort.unwrap_or_default(),
                direction: if descending {
                    "desc".into()
                } else {
                    "asc".into()
                },
                limit: Some(limit),
                offset: Some(0),
            }),
        )
        .await;
    }
    if !q.write || !q.confirm {
        return error(403, "enable and confirm this write");
    }
    let (schema, table, action, key, values) = match op {
        SqlOperation::Insert {
            schema,
            table,
            values,
        } => (schema, table, "insert", HashMap::new(), values),
        SqlOperation::Update {
            schema,
            table,
            key,
            values,
        } => (schema, table, "update", key, values),
        SqlOperation::Delete { schema, table, key } => {
            (schema, table, "delete", key, HashMap::new())
        }
        SqlOperation::Select { .. } => unreachable!(),
    };
    let version = if action == "insert" {
        String::new()
    } else {
        match row_version(&a, &q.database, &schema, &table, &key).await {
            Ok(version) => version,
            Err(response) => return response,
        }
    };
    let values = values
        .into_iter()
        .map(|(name, value)| (name, value.map(Value::String).unwrap_or(Value::Null)))
        .collect();
    mutate(
        State(a),
        Json(Mutation {
            database: q.database,
            schema,
            table,
            action: action.into(),
            key,
            values,
            version,
            confirm: true,
        }),
    )
    .await
}

pub fn router() -> Result<Router, Box<dyn std::error::Error>> {
    let policy_path = util::env("DATABASE_POLICY_PATH", "/config/policy.json");
    let policy: Policy = serde_json::from_slice(&std::fs::read(policy_path)?)?;
    let app = Arc::new(App {
        host: util::env("POSTGRES_HOST", "apps-db"),
        user: util::env("POSTGRES_USER", "postgres"),
        password: util::env("POSTGRES_PASSWORD", ""),
        policy,
        audit: PathBuf::from(util::env("DATABASE_AUDIT_PATH", "/data/audit.sqlite")),
        permits: Semaphore::new(4),
    });
    app.audit_open().map_err(|_| "database audit unavailable")?;
    Ok(Router::new()
        .route(
            "/health",
            get(|| async { util::json(200, json!({"ok":true})) }),
        )
        .route("/database/databases", get(databases))
        .route("/database/tables", get(tables))
        .route("/database/rows", get(rows).post(mutate))
        .route("/database/sql", axum::routing::post(sql_query))
        .route("/database/audit", get(audit))
        .with_state(app))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_sensitive_names_and_quotes_identifiers() {
        for name in ["pin_hash", "apiKey", "private_key", "oauth", "user_session"] {
            assert!(sensitive(name), "{name}");
        }
        assert!(!sensitive("created_at"));
        assert_eq!(identifier("a\"b"), "\"a\"\"b\"");
        assert_eq!(literal("a'b"), "'a''b'");
    }
    #[test]
    fn validates_row_version_and_internal_schemas() {
        assert_eq!(
            parse_version("123:456:4294967295"),
            Some((123, "456", "4294967295"))
        );
        assert_eq!(parse_version("123:456:-1"), None);
        assert_eq!(parse_version("123:456:1 OR 1=1"), None);
        assert_eq!(parse_version("4294967296:456:1"), None);
        assert_eq!(parse_version("123:4294967296:1"), None);
        assert_eq!(parse_version("4294967295"), None);
        assert!(!schema_allowed("pg_catalog"));
        assert!(!schema_allowed("information_schema"));
        assert!(schema_allowed("public"));
        assert!(!disclosure_type_allowed("jsonb", false, true));
        assert!(!disclosure_type_allowed("bytea", false, true));
        assert!(!disclosure_type_allowed("_jsonb", false, true));
        assert!(!disclosure_type_allowed("custom_domain", false, false));
        assert!(!disclosure_type_allowed("text", false, false));
        assert!(disclosure_type_allowed("int4", false, true));
    }
}
