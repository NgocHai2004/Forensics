"""LibreOffice headless convert service: doc/xls/ppt/rtf/odt/ods/odp -> docx/xlsx/pptx."""
import hashlib, json, os, shutil, signal, subprocess, tempfile, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FMT = {"doc": "docx", "rtf": "docx", "odt": "docx", "xls": "xlsx", "ods": "xlsx", "ppt": "pptx", "odp": "pptx"}
ROOTS = ("/evidence", "/data")
OUT = "/data/converted"
LOCK = threading.Lock()  # ponytail: 1 convert at a time; use a soffice pool if throughput matters


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def convert(src):
    """Return (status, body). Never writes next to src."""
    real = os.path.realpath(src)  # resolves symlinks pointing outside the roots
    if not any(real.startswith(r + "/") for r in ROOTS) or not os.path.isfile(real):
        return 400, {"error": "path not allowed or not a file"}
    fmt = FMT.get(os.path.splitext(real)[1].lower().lstrip("."))
    if not fmt:
        return 400, {"error": "unsupported extension"}
    dst = f"{OUT}/{sha256(real)}.{fmt}"
    if os.path.exists(dst):
        return 200, {"path": dst}
    os.makedirs(OUT, exist_ok=True)
    with LOCK:
        if os.path.exists(dst):
            return 200, {"path": dst}
        tmp = tempfile.mkdtemp(dir=OUT, prefix=".tmp-")  # same fs as dst -> atomic rename
        profile = f"/tmp/lo-{uuid.uuid4()}"
        try:
            p = subprocess.Popen(["soffice", "--headless", "--norestore", f"-env:UserInstallation=file://{profile}",
                                  "--convert-to", fmt, "--outdir", tmp, real],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                log = p.communicate(timeout=120)[0].decode(errors="replace")
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
                return 422, {"error": "libreoffice timeout"}
            outs = [f for f in os.listdir(tmp) if f.endswith("." + fmt)]
            if p.returncode or not outs:
                return 422, {"error": "libreoffice failed", "log": log[-500:]}
            os.replace(f"{tmp}/{outs[0]}", dst)
            return 200, {"path": dst}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            shutil.rmtree(profile, ignore_errors=True)


class H(BaseHTTPRequestHandler):
    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send(*((200, {"ok": True}) if self.path == "/health" else (404, {"error": "not found"})))

    def do_POST(self):
        if self.path != "/convert":
            return self.send(404, {"error": "not found"})
        try:
            path = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))["path"]
            assert isinstance(path, str)
        except Exception:
            return self.send(400, {"error": "body must be {\"path\": str}"})
        self.send(*convert(path))


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 9002), H).serve_forever()
