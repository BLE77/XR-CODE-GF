#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse
import json
import mimetypes
import os

mimetypes.add_type("model/vnd.usdz+zip", ".usdz")
mimetypes.add_type("model/gltf-binary", ".glb")

class MobileYukiHandler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path.split("?", 1)[0] != "/diagnostics":
            self.send_error(404)
            return
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            payload = json.loads(self.rfile.read(length) or b"{}")
            safe = {
                "immersiveAr": bool(payload.get("immersiveAr")),
                "detail": str(payload.get("detail", ""))[:200],
                "userAgent": str(payload.get("userAgent", ""))[:500],
            }
            print("MOBILE_YUKI_XR_DIAGNOSTIC=" + json.dumps(safe, sort_keys=True), flush=True)
            self.send_response(204)
            self.end_headers()
        except Exception:
            self.send_error(400)

    def send_head(self):
        response = super().send_head()
        return response

    def end_headers(self):
        if self.path.split("?", 1)[0].split("#", 1)[0].lower().endswith(".usdz"):
            self.send_header("Content-Disposition", 'inline; filename="Yuki.usdz"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5184)
    args = parser.parse_args()
    os.chdir(Path(__file__).resolve().parent)
    print(f"MOBILE_YUKI_WEB_READY=http://{args.host}:{args.port}", flush=True)
    ThreadingHTTPServer((args.host, args.port), MobileYukiHandler).serve_forever()
