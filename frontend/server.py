"""Dev server for the gTTS web demo.

Serves the static frontend and proxies /api/* to the FastAPI backend so the
browser stays on a single origin (the backend has no CORS middleware).

    python frontend/server.py            # http://localhost:3000
    python frontend/server.py --port 5173 --backend http://localhost:8000
"""

import argparse
import json
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC_DIR = Path(__file__).parent
BACKEND = "http://localhost:8000"


class DemoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, backend: str = BACKEND, **kwargs):
        self.backend = backend.rstrip("/")
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_POST(self):
        if self.path.startswith("/api/"):
            self.proxy("POST")
        else:
            self.send_error(404, "Not Found")

    def do_GET(self):
        if self.path == "/api/health":
            self.health()
        elif self.path.startswith("/api/"):
            self.proxy("GET")
        else:
            super().do_GET()

    def health(self):
        """Report whether the backend is reachable, for the status pill."""
        try:
            with urllib.request.urlopen(f"{self.backend}/openapi.json", timeout=3) as res:
                ok = res.status == 200
        except Exception:
            ok = False
        self.send_json(200, {"ok": ok, "backend": self.backend})

    def proxy(self, method: str):
        target = f"{self.backend}{self.path[len('/api'):]}"
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        request = urllib.request.Request(target, data=body, method=method)
        if content_type := self.headers.get("Content-Type"):
            request.add_header("Content-Type", content_type)

        try:
            with urllib.request.urlopen(request, timeout=60) as res:
                self.relay(res.status, res.headers.get("Content-Type"), res.read())
        except urllib.error.HTTPError as err:
            # Pass the backend's own error (e.g. 400 "input length") to the client.
            self.relay(err.code, err.headers.get("Content-Type"), err.read())
        except urllib.error.URLError as err:
            self.send_json(502, {"detail": f"Không gọi được backend {self.backend}: {err.reason}"})

    def relay(self, status: int, content_type: str | None, payload: bytes):
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, status: int, payload: dict):
        self.relay(status, "application/json", json.dumps(payload).encode())

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"[frontend] {fmt % args}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--backend", default=BACKEND, help="FastAPI base URL")
    args = parser.parse_args()

    handler = partial(DemoHandler, backend=args.backend)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"gTTS web demo  →  http://localhost:{args.port}")
    print(f"proxying /api/* →  {args.backend}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
        server.server_close()


if __name__ == "__main__":
    main()
