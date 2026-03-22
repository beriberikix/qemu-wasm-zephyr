#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
#
# Minimal development server that adds the Cross-Origin-Isolation headers
# required for SharedArrayBuffer (needed by Emscripten pthread support).

import http.server
import sys
import argparse


class COIRequestHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler that injects COOP/COEP headers on every response."""

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def guess_type(self, path):
        if path.endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("port", nargs="?", type=int, default=None)
    parser.add_argument("--port", dest="port_flag", type=int, default=None)
    args = parser.parse_args()

    port = args.port_flag if args.port_flag is not None else (args.port if args.port is not None else 8080)
    server = http.server.HTTPServer(("", port), COIRequestHandler)
    print(f"Serving on http://localhost:{port}")
    print("Cross-Origin-Isolation enabled (COOP + COEP)")
    print("Press Ctrl+C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
