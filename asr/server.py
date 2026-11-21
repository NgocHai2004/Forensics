"""ASR service: POST /transcribe {"path", "language"?} -> segments; GET /health. Contract: docs/CONTRACT-multimodal.md §1."""
import json, os, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import av, ctranslate2
from faster_whisper import WhisperModel

if ctranslate2.get_cuda_device_count() < 1:
    raise SystemExit("no CUDA device visible - refusing to run ASR on CPU")
# model cached in /data/models/whisper (HF_HOME) -> downloaded once, survives rebuilds
MODEL = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3"), device="cuda", compute_type="float16",
                     download_root="/data/models/whisper")
LOCK = threading.Lock()  # ponytail: global lock, one file at a time (one model, contract says sequential)
ROOTS = (Path("/evidence"), Path("/data"))
MAX_HOURS = float(os.environ.get("ASR_MAX_HOURS", "6"))


def transcribe(body):
    p = Path(str(body.get("path", ""))).resolve()  # resolve symlinks/.. before the root check
    if not any(p.is_relative_to(r) for r in ROOTS):
        return 400, {"detail": "path must be under /evidence or /data"}
    if not p.is_file():
        return 400, {"detail": f"file not found: {p}"}
    try:
        with av.open(str(p)) as c:
            if not c.streams.audio:
                return 200, {"language": None, "duration": float(c.duration or 0) / 1e6, "segments": []}
            if (c.duration or 0) / 1e6 > MAX_HOURS * 3600:  # decode_audio buffers all PCM in RAM; mem_limit is the real guard
                return 422, {"detail": f"audio longer than {MAX_HOURS} h"}
        with LOCK:
            segs, info = MODEL.transcribe(str(p), language=body.get("language"), vad_filter=True, beam_size=5)
            segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs]
    except (av.FFmpegError, IndexError, ValueError) as e:
        return 422, {"detail": f"cannot decode: {e}"}
    # ponytail: "prefer vi when unsure" = trust detection only above 0.5, else vi
    lang = info.language if info.language_probability >= 0.5 or body.get("language") else "vi"
    if lang != info.language:  # low-confidence non-vi detection -> redo in vi
        with LOCK:
            segs, _ = MODEL.transcribe(str(p), language="vi", vad_filter=True, beam_size=5)
            segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs]
    return 200, {"language": lang, "duration": round(info.duration, 2), "segments": segs}


class H(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "device": "cuda"})  # startup exits if no CUDA device
        self.reply(404, {"detail": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self.reply(404, {"detail": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            assert isinstance(body, dict)
        except (ValueError, AssertionError):
            return self.reply(400, {"detail": "body must be a JSON object"})
        try:
            self.reply(*transcribe(body))
        except Exception as e:  # CUDA OOM etc.: answer 500 instead of dropping the connection
            self.reply(500, {"detail": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 9001), H).serve_forever()
