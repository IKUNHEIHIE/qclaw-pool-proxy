"""极简 WebSocket 客户端（零依赖，stdlib only），用于观察 QClaw agentwss 协议。

用法:
  python3 qws.py                 # 连接并读取服务端初始帧 8 秒
  python3 qws.py --send '{"a":1}'  # 连接后先发一帧再读
"""
import base64
import json
import os
import socket
import ssl
import struct
import sys
import time
import urllib.parse

HOST = "mmgrcalltoken.3g.qq.com"
PATH = "/agentwss"


def connect(token):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    q = urllib.parse.urlencode({"token": token})
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        "GET " + PATH + "?" + q + " HTTP/1.1\r\n"
        "Host: " + HOST + "\r\n"
        "Origin: https://qclaw.qq.com\r\n"
        "Connection: Upgrade\r\nUpgrade: websocket\r\n"
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\n"
        "\r\n"
    )
    s = ctx.wrap_socket(socket.create_connection((HOST, 443), 20), server_hostname=HOST)
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    status = head.split(b"\r\n")[0].decode("utf-8", "replace")
    return s, status, rest


def send_frame(s, payload, opcode=0x1):
    data = payload.encode("utf-8") if isinstance(payload, str) else payload
    hdr = bytes([0x80 | opcode])
    n = len(data)
    mask = os.urandom(4)
    if n < 126:
        hdr += bytes([0x80 | n])
    elif n < 65536:
        hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def read_frames(s, seconds, leftover=b""):
    frames = []
    buf = leftover
    s.settimeout(1.5)
    end = time.time() + seconds
    while time.time() < end:
        try:
            chunk = s.recv(65536)
        except socket.timeout:
            continue
        except Exception as exc:
            frames.append(("recv-error", str(exc)[:80]))
            break
        if not chunk:
            frames.append(("closed", ""))
            break
        buf += chunk
        while True:
            if len(buf) < 2:
                break
            b0, b1 = buf[0], buf[1]
            opcode = b0 & 0x0F
            ln = b1 & 0x7F
            off = 2
            masked = bool(b1 & 0x80)
            if ln == 126:
                if len(buf) < 4:
                    break
                ln = struct.unpack(">H", buf[2:4])[0]
                off = 4
            elif ln == 127:
                if len(buf) < 10:
                    break
                ln = struct.unpack(">Q", buf[2:10])[0]
                off = 10
            if masked:
                mkey = buf[off:off + 4]
                off += 4
            if len(buf) < off + ln:
                break
            payload = buf[off:off + ln]
            if masked:
                payload = bytes(x ^ mkey[i % 4] for i, x in enumerate(payload))
            buf = buf[off + ln:]
            name = {0x1: "text", 0x2: "binary", 0x8: "close", 0x9: "ping", 0xA: "pong"}.get(opcode, hex(opcode))
            if opcode in (0x1, 0x2):
                try:
                    txt = payload.decode("utf-8")
                    frames.append((name, txt[:600]))
                except Exception:
                    frames.append((name, "<bin %d bytes> %s" % (len(payload), payload[:60].hex())))
            else:
                frames.append((name, payload[:40].hex()))
    return frames, buf


def main():
    toks = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/root/.qpp-tokens.json", encoding="utf-8"))
    token = toks.get("jwt") or toks.get("sk")
    send_payload = None
    if "--send" in sys.argv:
        send_payload = sys.argv[sys.argv.index("--send") + 1]

    s, status, rest = connect(token)
    print("handshake:", status)
    if "101" not in status:
        print("body:", rest[:300])
        return
    if send_payload:
        send_frame(s, send_payload)
        print("sent:", send_payload[:120])
    frames, _ = read_frames(s, 10, rest)
    print("收到帧数:", len(frames))
    for kind, data in frames[:12]:
        print("  [%s] %s" % (kind, data))
    s.close()


if __name__ == "__main__":
    main()
