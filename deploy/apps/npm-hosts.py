"""Create / update the Nginx Proxy Manager hosts for the self-hosted apps (run on the VPS).

    python3 npm-hosts.py <certificate-name> < creds      # creds: NPM email, then password, on stdin

Every host gets the Cloudflare real-IP line, the /_a analytics beacon, and its own extra locations.
Upstreams are resolved per request (variables + Docker's resolver), so NPM still starts while an app
container is down. The certificate is looked up by its NPM "nice name" (the Cloudflare Origin CA cert,
uploaded once by upload-origin-cert.py). Existing hosts are updated in place, never duplicated.
"""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

CERT_NAME = sys.argv[1] if len(sys.argv) > 1 else "Cloudflare Origin CA *.chakkritton.com"
user = sys.stdin.readline().strip()
secret = sys.stdin.readline().strip()

REAL_IP = "# behind Cloudflare: the visitor's IP (CF ranges are trusted in NPM's ip_ranges.conf)\nreal_ip_header CF-Connecting-IP;\n"

BEACON = """# page views / Web Vitals → apps-analytics (Dock "สถิติเว็บ"); small bodies, rate-limited per visitor
location = /_a {
  limit_req zone=beacon burst=20 nodelay;
  client_max_body_size 4k;
  set $analytics apps-analytics:8790;
  proxy_pass http://$analytics;
  proxy_set_header Host $host;
  proxy_set_header CF-Connecting-IP $remote_addr;
}
"""


def ws(path: str, upstream: str, note: str) -> str:
    """A WebSocket location; the original (un-decoded) URI is passed through untouched."""
    return f"""# {note}
location ^~ {path} {{
  set $ws_upstream {upstream};
  proxy_pass http://$ws_upstream;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $http_connection;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_read_timeout 1h;
  proxy_send_timeout 1h;
}}
"""


def proxied(path: str, upstream: str, note: str) -> str:
    """A plain HTTP location; the original URI is passed through untouched."""
    return f"""# {note}
location ^~ {path} {{
  set $upstream_{path.strip('/')} {upstream};
  proxy_pass http://$upstream_{path.strip('/')};
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  client_max_body_size 1m;
}}
"""


# CalorieFlow's API owns all of /api/ (web and native app): uploads up to the web's limit, the chat's live stream
# (server-sent events: unbuffered, held open), and the client's address set here, as the API trusts X-Real-IP
CALORIEFLOW_API = """# CalorieFlow API (Rust, repo CalorieFlowWeb api/)
location ^~ /api/ {
  set $calorieflow_api apps-calorieflow-api:8080;
  proxy_pass http://$calorieflow_api;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_buffering off;
  proxy_read_timeout 1h;
  client_max_body_size 70m;
}
"""


PORTFOLIO_PROBES = (Path(__file__).resolve().parents[1] / "hardening" / "npm-portfolio-probes.conf").read_text()

HOSTS = [
    (["chakkritton.com", "www.chakkritton.com"], "apps-portfolio", 3000, proxied("/media/", "apps-media:8793", "studio uploads (media service)") + PORTFOLIO_PROBES),
    (["expenses.chakkritton.com"], "apps-expenses", 3000, proxied("/data/", "apps-dbgw:8791", "the app's data API (database gateway → PostgREST / reminders)")),
    (["whiteboard.chakkritton.com"], "apps-whiteboard", 3000, ws("/rooms/", "apps-rooms:8787", "Yjs rooms (was the whiteboard-rooms Worker)")),
    (["drive-music.chakkritton.com"], "apps-drive-music", 3000, ws("/parties/", "apps-sync:8788", "Party Play sync (was the drive-music-sync Worker)")),
    # chat videos are up to 60 MB (the app checks; Cloudflare allows 100 MB); /ai/* never gets here (a Worker route)
    (["calorieflow.chakkritton.com"], "apps-calorieflow", 3000, "client_max_body_size 70m;\n" + CALORIEFLOW_API),
    (["health.chakkritton.com"], "apps-health", 8789, ""),  # the status Worker's view inside the VPS
]

HTTP_TOP_EXTRA = "limit_req_zone $binary_remote_addr zone=beacon:10m rate=60r/m;\n"


def req(url, body=None, token=None, method=None):
    r = urllib.request.Request("http://127.0.0.1:81/api" + url, data=json.dumps(body).encode() if body is not None else None,
                               method=method or ("POST" if body is not None else "GET"))
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read() or b"null")


# the beacon's rate-limit zone lives at http level, next to the login zone
top = subprocess.run(["docker", "exec", "nginx-proxy-manager", "cat", "/data/nginx/custom/http_top.conf"], capture_output=True, text=True).stdout
if "zone=beacon" not in top:
    subprocess.run(["docker", "exec", "-i", "nginx-proxy-manager", "sh", "-c", "cat >> /data/nginx/custom/http_top.conf"],
                   input=("\n# analytics beacon (/_a): per visitor\n" + HTTP_TOP_EXTRA).encode(), check=True)
    print("http_top: beacon zone added")

tok = req("/tokens", {"identity": user, "secret": secret})["token"]
certs = [c for c in req("/nginx/certificates", token=tok) if c.get("nice_name") == CERT_NAME]
if not certs:
    sys.exit(f"certificate {CERT_NAME!r} is not in NPM yet (run upload-origin-cert.py first)")
cert_id = certs[0]["id"]
existing = {d: h for h in req("/nginx/proxy-hosts", token=tok) for d in h["domain_names"]}

for domains, host, port, extra in HOSTS:
    body = {
        "domain_names": domains, "forward_scheme": "http", "forward_host": host, "forward_port": port,
        "access_list_id": 0, "certificate_id": cert_id, "ssl_forced": True, "caching_enabled": False,
        "block_exploits": True, "allow_websocket_upgrade": True, "http2_support": True,
        "hsts_enabled": True, "hsts_subdomains": False, "locations": [],
        "advanced_config": REAL_IP + BEACON + extra, "meta": {"letsencrypt_agree": False, "dns_challenge": False},
    }
    old = next((existing[d] for d in domains if d in existing), None)
    if old:
        req(f"/nginx/proxy-hosts/{old['id']}", body, tok, "PUT")
        print("updated", domains[0])
    else:
        req("/nginx/proxy-hosts", body, tok)
        print("created", domains[0])

# the weather site keeps its config and gains the beacon
tw = existing.get("thai-weather.chakkritton.com")
if tw and "location = /_a" not in (tw.get("advanced_config") or ""):
    req(f"/nginx/proxy-hosts/{tw['id']}", {"advanced_config": (tw.get("advanced_config") or REAL_IP) + BEACON}, tok, "PUT")
    print("thai-weather: beacon added")

t = subprocess.run(["docker", "exec", "nginx-proxy-manager", "nginx", "-t"], capture_output=True, text=True)
print(t.stderr.strip().splitlines()[-1])
