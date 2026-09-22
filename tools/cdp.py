"""极简 Chrome DevTools Protocol 客户端（stdlib only，明文 ws）。

用法:
  python tools/cdp.py list
  python tools/cdp.py eval --match "QClaw" --expr "1+1"
  python tools/cdp.py eval --idx 0 --expr "await (async()=>{...})()"
"""
import base64
import json
import os
import socket
import struct
import sys
import urllib.request
import urllib.parse

CDP_HOST = "127.0.0.1"
CDP_PORT = 9222


def http_json(path):
    with urllib.request.urlopen(f"http://{CDP_HOST}:{CDP_PORT}{path}", timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def ws_connect(ws_url):
    u = urllib.parse.urlsplit(ws_url)
    host = u.hostname
    port = u.port or 80
    path = u.path + ("?" + u.query if u.query else "")
    key = base64.b64encode(os.urandom(16)).decode()
    s = socket.create_connection((host, port), 20)
    s.sendall((
        f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
        "Connection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
    ).encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = s.recv(4096)
        if not c:
            raise RuntimeError("handshake failed")
        buf += c
    head, rest = buf.split(b"\r\n\r\n", 1)
    if b"101" not in head.split(b"\r\n")[0]:
        raise RuntimeError("bad handshake: " + head.decode("utf-8", "replace")[:200])
    return s, rest


class WS:
    def __init__(self, ws_url):
        self.s, self.buf = ws_connect(ws_url)
        self.s.settimeout(60)
        self.id = 0

    def send(self, text):
        data = text.encode("utf-8")
        hdr = bytes([0x81])
        n = len(data)
        mask = os.urandom(4)
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n):
        while len(self.buf) < n:
            c = self.s.recv(65536)
            if not c:
                raise RuntimeError("closed")
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        while True:
            b0, b1 = self._read(2)
            op = b0 & 0x0F
            ln = b1 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(ln)
            if op == 0x8:
                raise RuntimeError("server closed")
            if op in (0x9, 0xA):
                continue
            obj = json.loads(payload.decode("utf-8", "replace"))
            if "id" in obj:
                return obj

    def call(self, method, params=None):
        self.id += 1
        mid = self.id
        self.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            obj = self.recv()
            if obj.get("id") == mid:
                if "error" in obj:
                    raise RuntimeError(json.dumps(obj["error"])[:400])
                return obj.get("result", {})


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    targets = [t for t in http_json("/json") if t.get("type") == "page"]
    if cmd == "list":
        for i, t in enumerate(targets):
            print(f"{i}: {t.get('title','')[:60]!r} url={t.get('url','')[:80]}")
        return

    idx = 0
    if "--idx" in sys.argv:
        idx = int(sys.argv[sys.argv.index("--idx") + 1])
    if "--match" in sys.argv:
        m = sys.argv[sys.argv.index("--match") + 1].lower()
        for i, t in enumerate(targets):
            if m in (t.get("title", "") + t.get("url", "")).lower():
                idx = i
                break
    expr = sys.argv[sys.argv.index("--expr") + 1]
    t = targets[idx]
    ws = WS(t["webSocketDebuggerUrl"])
    res = ws.call("Runtime.evaluate", {
        "expression": expr, "awaitPromise": True, "returnByValue": True, "timeout": 60000
    })
    out = res.get("result", {})
    blob = json.dumps(out.get("value", out), ensure_ascii=False)
    if "--out" in sys.argv:
        path = sys.argv[sys.argv.index("--out") + 1]
        with open(path, "w", encoding="utf-8") as fh:
            if res.get("exceptionDetails"):
                fh.write("EXC " + json.dumps(res["exceptionDetails"], ensure_ascii=False) + "\n")
            fh.write(blob)
        print(f"written {len(blob)} bytes -> {path}")
        return
    print(f"target[{idx}] = {t.get('title','')[:50]!r}")
    if res.get("exceptionDetails"):
        print("JS 异常:", json.dumps(res["exceptionDetails"], ensure_ascii=False)[:600])
    print("结果:", blob[:2000])


if __name__ == "__main__":
    main()
