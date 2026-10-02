"""Serve the built website locally: python scripts/serve_site.py [--port 8770].

The site uses ES modules, which browsers refuse to load from file://, so it must be served.
"""
import argparse
import functools
import http.server
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1] / "docs"

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    args = ap.parse_args()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DOCS))
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as srv:
        print(f"Serving {DOCS} at http://127.0.0.1:{args.port}/")
        srv.serve_forever()
