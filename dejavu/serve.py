"""Static dev server that disables caching so edited ES modules always reload.

Usage: python3 serve.py [port]   (default 3003, bound to 127.0.0.1)
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3003
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
