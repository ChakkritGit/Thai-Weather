//! A small MCP client for Dock's chat model (streamable HTTP, JSON-RPC 2.0). MCP_SERVERS in chat.env names the
//! servers as `name=https://…` pairs, comma separated; MCP_<NAME>_TOKEN, when set, goes with each request as a bearer
//! token. Their tools are listed once per ten minutes (a server that fails is asked again after a minute) and offered
//! to the model as `mcp_<name>_<tool>`; what they return is untrusted text.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const PROTOCOL: &str = "2025-06-18";
/// over all servers: each tool's description and schema go to the model with every question
const MAX_TOOLS: usize = 24;
const MAX_BODY: usize = 2_000_000;

#[derive(Clone, Debug)]
pub struct Tool {
    pub server: String,
    pub name: String,
    pub exposed: String,
    pub spec: Value,
}
#[derive(Debug)]
struct Server {
    name: String,
    url: String,
    token: Option<String>,
}
#[derive(Default)]
struct State {
    listed: Option<(Instant, Duration)>,
    tools: Vec<Tool>,
    /// per server: its session id (when it gave one) and the protocol version it chose
    sessions: HashMap<String, (Option<String>, String)>,
}
pub struct Mcp {
    servers: Vec<Server>,
    client: reqwest::Client,
    state: Mutex<State>,
}

/// `name=url` pairs; a name is 1-16 lowercase letters or digits, a URL http(s). Others are skipped.
fn servers(spec: &str, token: impl Fn(&str) -> Option<String>) -> Vec<Server> {
    let mut list: Vec<Server> = Vec::new();
    for part in spec
        .split([',', '\n', ' '])
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        let Some((name, url)) = part.split_once('=') else {
            continue;
        };
        let name = name.trim().to_lowercase();
        let url = url.trim();
        let named = !name.is_empty()
            && name.len() <= 16
            && name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        if !named
            || !(url.starts_with("https://") || url.starts_with("http://"))
            || list.iter().any(|s| s.name == name)
        {
            continue;
        }
        let token = token(&name).filter(|t| !t.is_empty());
        list.push(Server {
            name,
            url: url.into(),
            token,
        });
    }
    list
}
/// `mcp_<server>_<tool>`, in the characters a tool name may have, at most 64 of them.
fn exposed(server: &str, tool: &str) -> String {
    format!("mcp_{server}_{tool}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect()
}
/// A tools/call result as text: its text parts, a mark for anything else, and whether the tool said it failed.
fn result_text(res: &Value) -> String {
    let parts = res["content"]
        .as_array()
        .map(|c| {
            c.iter()
                .map(|p| match p["type"].as_str() {
                    Some("text") => p["text"].as_str().unwrap_or("").to_string(),
                    Some("resource") => p["resource"]["text"].as_str().map_or_else(
                        || format!("[ไฟล์ {}]", p["resource"]["uri"].as_str().unwrap_or("")),
                        str::to_string,
                    ),
                    Some("resource_link") => format!("[ลิงก์ {}]", p["uri"].as_str().unwrap_or("")),
                    Some("image") => "[รูปภาพ]".into(),
                    Some("audio") => "[เสียง]".into(),
                    _ => String::new(),
                })
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let text = if parts.is_empty() && !res["structuredContent"].is_null() {
        res["structuredContent"].to_string()
    } else {
        parts
    };
    if res["isError"] == json!(true) {
        format!("เครื่องมือแจ้งว่าผิดพลาด: {text}")
    } else if text.is_empty() {
        "(เครื่องมือไม่ได้ส่งข้อความกลับมา)".into()
    } else {
        text
    }
}
/// One server-sent event's data (its `data:` lines joined), parsed as JSON.
fn event(raw: &str) -> Option<Value> {
    let data = raw
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(|l| l.strip_prefix(' ').unwrap_or(l))
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::from_str(&data).ok()
}

impl Mcp {
    /// MCP_SERVERS, each server with its MCP_<NAME>_TOKEN.
    pub fn from_env() -> Mcp {
        Mcp::from_spec(&std::env::var("MCP_SERVERS").unwrap_or_default(), |name| {
            std::env::var(format!("MCP_{}_TOKEN", name.to_uppercase())).ok()
        })
    }
    /// The servers of `spec` (MCP_SERVERS' form), each with the token `token(name)` gives.
    pub fn from_spec(spec: &str, token: impl Fn(&str) -> Option<String>) -> Mcp {
        Mcp {
            servers: servers(spec, token),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
            state: Mutex::new(State::default()),
        }
    }
    /// One JSON-RPC message to a server: a request (`id`) answered as JSON or as an event stream, or a notification.
    /// Also the session id the server gave.
    async fn rpc(
        &self,
        s: &Server,
        session: Option<&str>,
        version: &str,
        id: Option<u64>,
        method: &str,
        params: Value,
    ) -> Result<(Value, Option<String>), String> {
        let mut body = json!({"jsonrpc":"2.0","method":method,"params":params});
        if let Some(id) = id {
            body["id"] = json!(id);
        }
        let mut req = self
            .client
            .post(&s.url)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", version)
            .timeout(Duration::from_secs(20))
            .json(&body);
        if let Some(t) = &s.token {
            req = req.bearer_auth(t);
        }
        if let Some(x) = session {
            req = req.header("mcp-session-id", x);
        }
        let mut res = req.send().await.map_err(|e| {
            if e.is_timeout() {
                "เซิร์ฟเวอร์ MCP ตอบช้าเกินไป".to_string()
            } else {
                "ติดต่อเซิร์ฟเวอร์ MCP ไม่ได้".to_string()
            }
        })?;
        let sid = res
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .or_else(|| session.map(str::to_string));
        let Some(id) = id else {
            return Ok((Value::Null, sid));
        };
        if !res.status().is_success() {
            return Err(format!("เซิร์ฟเวอร์ MCP ตอบ HTTP {}", res.status().as_u16()));
        }
        let stream = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.starts_with("text/event-stream"));
        let msg = if stream {
            // read only until our answer: a server may keep the stream open after it
            let mut buf: Vec<u8> = Vec::new();
            let mut found = None;
            'read: while let Some(chunk) = res
                .chunk()
                .await
                .map_err(|_| "อ่านคำตอบ MCP ไม่จบ".to_string())?
            {
                buf.extend(chunk.iter().filter(|b| **b != b'\r'));
                if buf.len() > MAX_BODY {
                    return Err("คำตอบ MCP ใหญ่เกินไป".into());
                }
                while let Some(end) = buf.windows(2).position(|w| w == b"\n\n") {
                    let raw = String::from_utf8_lossy(&buf[..end]).into_owned();
                    buf.drain(..end + 2);
                    if let Some(v) = event(&raw).filter(|v| v["id"] == json!(id)) {
                        found = Some(v);
                        break 'read;
                    }
                }
            }
            found
                .or_else(|| event(&String::from_utf8_lossy(&buf)).filter(|v| v["id"] == json!(id)))
                .ok_or("เซิร์ฟเวอร์ MCP ไม่ได้ตอบ")?
        } else {
            let bytes = res
                .bytes()
                .await
                .map_err(|_| "อ่านคำตอบ MCP ไม่จบ".to_string())?;
            if bytes.len() > MAX_BODY {
                return Err("คำตอบ MCP ใหญ่เกินไป".into());
            }
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|_| "คำตอบ MCP ไม่ใช่ JSON".to_string())?
        };
        if let Some(e) = msg.get("error").filter(|e| !e.is_null()) {
            let text = e["message"].as_str().unwrap_or("ผิดพลาด");
            return Err(format!(
                "MCP: {}",
                text.chars().take(200).collect::<String>()
            ));
        }
        Ok((msg["result"].clone(), sid))
    }
    /// The server's session, opened (initialize, then notifications/initialized) when there is none yet.
    async fn session(
        &self,
        s: &Server,
        st: &mut State,
    ) -> Result<(Option<String>, String), String> {
        if let Some(x) = st.sessions.get(&s.name) {
            return Ok(x.clone());
        }
        let (res, sid) = self
            .rpc(
                s,
                None,
                PROTOCOL,
                Some(1),
                "initialize",
                json!({"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"dock-chat","version":"1.0.0"}}),
            )
            .await?;
        let version = res["protocolVersion"]
            .as_str()
            .unwrap_or(PROTOCOL)
            .to_string();
        self.rpc(
            s,
            sid.as_deref(),
            &version,
            None,
            "notifications/initialized",
            json!({}),
        )
        .await?;
        st.sessions
            .insert(s.name.clone(), (sid.clone(), version.clone()));
        Ok((sid, version))
    }
    /// A request in the server's session; once more in a new session when it fails (sessions expire).
    async fn ask(
        &self,
        s: &Server,
        st: &mut State,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let mut last = String::new();
        for _ in 0..2 {
            let attempt = match self.session(s, st).await {
                Ok((sid, version)) => {
                    self.rpc(
                        s,
                        sid.as_deref(),
                        &version,
                        Some(id),
                        method,
                        params.clone(),
                    )
                    .await
                }
                Err(e) => Err(e),
            };
            match attempt {
                Ok((res, _)) => return Ok(res),
                Err(e) => {
                    st.sessions.remove(&s.name);
                    last = e;
                }
            }
        }
        Err(last)
    }
    /// Every server's tools, in the OpenAI shape the model is given.
    pub async fn tools(&self) -> Vec<Tool> {
        if self.servers.is_empty() {
            return Vec::new();
        }
        let mut st = self.state.lock().await;
        if let Some((at, ttl)) = st.listed
            && at.elapsed() < ttl
        {
            return st.tools.clone();
        }
        let mut all: Vec<Tool> = Vec::new();
        let mut failed = false;
        for s in &self.servers {
            let mut cursor: Option<String> = None;
            for page in 0..3 {
                let params = cursor
                    .as_ref()
                    .map_or_else(|| json!({}), |c| json!({"cursor": c}));
                let res = match self.ask(s, &mut st, 2 + page, "tools/list", params).await {
                    Ok(res) => res,
                    Err(e) => {
                        eprintln!("chat mcp {}: tools/list failed: {e}", s.name);
                        failed = true;
                        break;
                    }
                };
                for t in res["tools"].as_array().into_iter().flatten() {
                    let Some(name) = t["name"].as_str() else {
                        continue;
                    };
                    let exposed = exposed(&s.name, name);
                    if all.iter().any(|x| x.exposed == exposed) {
                        continue;
                    }
                    let mut schema = t["inputSchema"].clone();
                    if !schema.is_object() {
                        schema = json!({"type":"object","properties":{}});
                    }
                    if let Some(o) = schema.as_object_mut() {
                        o.remove("$schema");
                    }
                    let description = format!(
                        "[MCP {}] {}",
                        s.name,
                        t["description"]
                            .as_str()
                            .unwrap_or(name)
                            .chars()
                            .take(600)
                            .collect::<String>()
                    );
                    all.push(Tool {
                        server: s.name.clone(),
                        name: name.into(),
                        spec: json!({"type":"function","function":{"name":exposed,"description":description,"parameters":schema}}),
                        exposed,
                    });
                }
                cursor = res["nextCursor"].as_str().map(str::to_string);
                if cursor.is_none() {
                    break;
                }
            }
        }
        all.truncate(MAX_TOOLS);
        st.tools = all.clone();
        st.listed = Some((
            Instant::now(),
            Duration::from_secs(if failed { 60 } else { 600 }),
        ));
        all
    }
    /// The tool's answer as text, or None when `exposed` is not one of the MCP tools.
    pub async fn call(&self, exposed: &str, args: &Value) -> Option<String> {
        let mut st = self.state.lock().await;
        let tool = st.tools.iter().find(|t| t.exposed == exposed).cloned()?;
        let s = self.servers.iter().find(|s| s.name == tool.server)?;
        Some(
            match self
                .ask(
                    s,
                    &mut st,
                    9,
                    "tools/call",
                    json!({"name":tool.name,"arguments":args}),
                )
                .await
            {
                Ok(res) => result_text(&res),
                Err(e) => format!("เรียก {} ของ {} ไม่สำเร็จ: {e}", tool.name, tool.server),
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn servers_and_names() {
        let list = servers(
            "docs=https://docs.example/mcp, bad_name=https://x.example, ftp=ftp://x, docs=https://dup.example,two=http://127.0.0.1:1/mcp",
            |n| (n == "docs").then(|| "fixture-token".to_string()),
        );
        assert_eq!(
            list.iter()
                .map(|s| (s.name.as_str(), s.url.as_str(), s.token.is_some()))
                .collect::<Vec<_>>(),
            [
                ("docs", "https://docs.example/mcp", true),
                ("two", "http://127.0.0.1:1/mcp", false)
            ]
        );
        assert_eq!(exposed("docs", "search.v2 docs"), "mcp_docs_search_v2_docs");
        assert_eq!(exposed("a", &"x".repeat(80)).len(), 64);
        assert_eq!(
            result_text(
                &json!({"content":[{"type":"text","text":"one"},{"type":"image","data":"x"},{"type":"text","text":"two"}]})
            ),
            "one\n[รูปภาพ]\ntwo"
        );
        assert_eq!(
            result_text(&json!({"content":[{"type":"text","text":"nope"}],"isError":true})),
            "เครื่องมือแจ้งว่าผิดพลาด: nope"
        );
        assert_eq!(
            result_text(&json!({"content":[],"structuredContent":{"a":1}})),
            "{\"a\":1}"
        );
    }

    /// A fake MCP server: a session id on initialize, tools/list as JSON, tools/call as an event stream that stays
    /// open after the answer (as some servers do), and one expired session (404) to be opened again.
    #[tokio::test]
    async fn lists_and_calls_tools_over_json_and_event_streams() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            let mut sessions = 0;
            let mut expired_once = false;
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 65536];
                let mut len = 0;
                // headers, then as many bytes as content-length says
                let (head, body) = loop {
                    len += s.read(&mut buf[len..]).await.unwrap();
                    let text = String::from_utf8_lossy(&buf[..len]).to_string();
                    if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                        let want = head
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if rest.len() >= want {
                            break (head.to_lowercase(), rest.to_string());
                        }
                    }
                };
                let msg: Value = serde_json::from_str(&body).unwrap();
                let method = msg["method"].as_str().unwrap().to_string();
                let session = head.lines().find_map(|l| {
                    l.strip_prefix("mcp-session-id:")
                        .map(|v| v.trim().to_string())
                });
                log.lock()
                    .unwrap()
                    .push(format!("{method} {}", session.clone().unwrap_or_default()));
                let reply = |status: &str, ctype: &str, extra: &str, body: &str| {
                    format!(
                        "HTTP/1.1 {status}\r\ncontent-type: {ctype}\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                let out = match method.as_str() {
                    "initialize" => {
                        sessions += 1;
                        let body = json!({"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":PROTOCOL,"capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}}).to_string();
                        reply(
                            "200 OK",
                            "application/json",
                            &format!("mcp-session-id: s{sessions}\r\n"),
                            &body,
                        )
                    }
                    "notifications/initialized" => {
                        reply("202 Accepted", "application/json", "", "")
                    }
                    "tools/list" => {
                        let body = json!({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"lookup","description":"Look a word up","inputSchema":{"$schema":"x","type":"object","properties":{"q":{"type":"string"}}}}]}}).to_string();
                        reply("200 OK", "application/json", "", &body)
                    }
                    "tools/call" if !expired_once => {
                        expired_once = true;
                        reply("404 Not Found", "text/plain", "", "no session")
                    }
                    "tools/call" => {
                        let answer = json!({"jsonrpc":"2.0","id":msg["id"],"result":{"content":[{"type":"text","text":format!("found {}", msg["params"]["arguments"]["q"].as_str().unwrap())}]}});
                        // a notification first, then the answer; the stream is not closed after it
                        let events = format!(
                            "event: message\r\ndata: {}\r\n\r\nevent: message\r\ndata: {}\r\n\r\n",
                            json!({"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"x"}}),
                            answer
                        );
                        let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\n\r\n";
                        s.write_all(head.as_bytes()).await.unwrap();
                        s.write_all(events.as_bytes()).await.unwrap();
                        // hold the stream open a while: the client must not wait for its end
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                            drop(s);
                        });
                        continue;
                    }
                    _ => reply("400 Bad Request", "text/plain", "", ""),
                };
                s.write_all(out.as_bytes()).await.unwrap();
            }
        });
        let mcp = Mcp::from_spec(&format!("fixture={url}"), |_| None);
        let tools = mcp.tools().await;
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].exposed, "mcp_fixture_lookup");
        assert_eq!(
            tools[0].spec["function"]["description"],
            "[MCP fixture] Look a word up"
        );
        assert!(
            tools[0].spec["function"]["parameters"]
                .get("$schema")
                .is_none()
        );
        let started = Instant::now();
        let answer = mcp
            .call("mcp_fixture_lookup", &json!({"q": "krathong"}))
            .await;
        assert_eq!(answer.as_deref(), Some("found krathong"));
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "waited for the stream to end"
        );
        assert_eq!(mcp.call("server_status", &json!({})).await, None);
        // cached: no second tools/list
        assert_eq!(mcp.tools().await.len(), 1);
        assert_eq!(
            *seen.lock().unwrap(),
            [
                "initialize ",
                "notifications/initialized s1",
                "tools/list s1",
                "tools/call s1",
                "initialize ",
                "notifications/initialized s2",
                "tools/call s2"
            ]
        );
    }
}
