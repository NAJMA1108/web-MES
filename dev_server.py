"""Server lokal: menyajikan website + meneruskan /api/* ke API asli (menghindari CORS).
Jalankan:  python dev_server.py   lalu buka http://localhost:5500
"""
import http.server
import os
import urllib.error
import urllib.request

API = os.environ.get("API", "https://filling-machine-api.zamazzam.me")
PORT = int(os.environ.get("PORT", "5500"))
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/") or self.path.startswith("/health"):
            return self.proxy()
        return super().do_GET()

    def proxy(self):
        headers = {"User-Agent": "Mozilla/5.0"}
        if self.headers.get("X-Api-Key"):
            headers["X-Api-Key"] = self.headers["X-Api-Key"]
        try:
            res = urllib.request.urlopen(urllib.request.Request(API + self.path, headers=headers), timeout=15)
        except urllib.error.HTTPError as err:
            res = err
        except Exception as err:
            self.send_error(502, "API tidak terjangkau: %s" % err)
            return
        body = res.read()
        self.send_response(getattr(res, "status", None) or res.code)
        self.send_header("Content-Type", res.headers.get("Content-Type", "application/json"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


print("Website: http://localhost:%d  ->  API: %s" % (PORT, API))
http.server.ThreadingHTTPServer(("", PORT), Handler).serve_forever()