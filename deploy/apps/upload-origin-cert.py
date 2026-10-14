"""Upload the Cloudflare Origin CA certificate to Nginx Proxy Manager as a custom certificate (run on the VPS).

    python3 upload-origin-cert.py < creds     # creds: NPM email, then password, on stdin

Expects /root/origin-ca/origin.key (made on the VPS, never leaves it) and /root/origin-ca/origin.pem
(signed by Cloudflare for chakkritton.com + *.chakkritton.com, 15 years; valid only behind the orange
cloud, which the origin lock enforces anyway). Skips the upload when a cert with that name exists.
"""
import json
import sys
import urllib.request
import uuid

NAME = "Cloudflare Origin CA *.chakkritton.com"
user = sys.stdin.readline().strip()
secret = sys.stdin.readline().strip()


def call(path, body=None, token=None, method=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request("http://127.0.0.1:81/api" + path, data=data, method=method or ("POST" if data else "GET"))
    r.add_header("Content-Type", ctype)
    if token:
        r.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read() or b"null")


tok = call("/tokens", {"identity": user, "secret": secret})["token"]
if any(c.get("nice_name") == NAME for c in call("/nginx/certificates", token=tok)):
    sys.exit(print("already uploaded:", NAME))
cert = call("/nginx/certificates", {"provider": "other", "nice_name": NAME}, tok)
boundary = uuid.uuid4().hex
parts = []
for field, path in (("certificate", "/root/origin-ca/origin.pem"), ("certificate_key", "/root/origin-ca/origin.key")):
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{field}.pem"\r\n'
                 f"Content-Type: application/x-pem-file\r\n\r\n".encode() + open(path, "rb").read() + b"\r\n")
body = b"".join(parts) + f"--{boundary}--\r\n".encode()
call(f"/nginx/certificates/{cert['id']}/upload", token=tok, raw=body, ctype=f"multipart/form-data; boundary={boundary}")
print("uploaded", NAME, "id", cert["id"])
