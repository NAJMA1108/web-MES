"""Server lokal: menyajikan website + meneruskan /api/* ke API asli (menghindari CORS).
Jalankan:  python dev_server.py
Buka:      http://localhost:3000  atau  http://localhost:5500
"""
import http.server
import os
import urllib.error
import urllib.request

API = os.environ.get("API", "https://filling-machine-api.zamazzam.me").rstrip("/")
DEFAULT_PORTS = [3000, 5500, 5000, 8080]
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/") or self.path.startswith("/health"):
            return self.proxy("GET")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self.proxy("POST")
        self.send_error(405, "Method Not Allowed")

    def proxy(self, method="GET"):
        headers = {"User-Agent": "Mozilla/5.0"}
        if self.headers.get("X-Api-Key"):
            headers["X-Api-Key"] = self.headers["X-Api-Key"]
        content_type = self.headers.get("Content-Type")
        if content_type:
            headers["Content-Type"] = content_type

        data = None
        if method == "POST":
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                data = self.rfile.read(content_length)

        target_url = API + self.path
        req = urllib.request.Request(target_url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                body = res.read()
                self.send_response(res.status)
                self.send_header("Content-Type", res.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as err:
            body = err.read()
            self.send_response(err.code)
            self.send_header("Content-Type", err.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as err:
            msg = ('{"status":"error","detail":"%s"}' % str(err)).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)


def run():
    env_port = os.environ.get("PORT")
    ports_to_try = [int(env_port)] if env_port else DEFAULT_PORTS

    server = None
    active_port = None
    for port in ports_to_try:
        try:
            server = http.server.ThreadingHTTPServer(("", port), Handler)
            active_port = port
            break
        except OSError:
            continue

    if not server:
        raise RuntimeError("Tidak ada port yang tersedia dari daftar: %s" % ports_to_try)

    print("=" * 60)
    print(" MES DEV SERVER BERHASIL DIJALANKAN")
    print(" Website: http://localhost:%d" % active_port)
    print(" Meneruskan /api/* ke: %s" % API)
    print("=" * 60)
    server.serve_forever()


if __name__ == "__main__":
    run()
