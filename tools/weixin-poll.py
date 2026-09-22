"""轮询 QClaw 的微信绑定状态，直到 connected / 超时，并把结果写盘。"""
import json
import sys
import time

sys.path.insert(0, __import__("os").path.dirname(__file__))
import cdp  # noqa: E402

SESSION = sys.argv[1] if len(sys.argv) > 1 else "cc13b700-baf3-4ac5-81f2-73da99bc1a94"
OUT = "re/weixin-poll.log"
DEADLINE = time.time() + 300

expr = "(async()=>{const r=await window.electronAPI.integration.weixinLoginPoll(%r);return JSON.stringify(r)})()" % SESSION

targets = [t for t in cdp.http_json("/json") if t.get("type") == "page"]
ws = cdp.WS(targets[0]["webSocketDebuggerUrl"])

seen = set()
with open(OUT, "w", encoding="utf-8") as f:
    while time.time() < DEADLINE:
        try:
            res = ws.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
            val = res.get("result", {}).get("value")
        except Exception as exc:
            f.write("poll error: %r\n" % (exc,))
            f.flush()
            time.sleep(3)
            continue
        line = time.strftime("%H:%M:%S") + " " + str(val)
        f.write(line + "\n")
        f.flush()
        try:
            st = json.loads(val).get("status")
        except Exception:
            st = None
        if st and st not in seen:
            seen.add(st)
            print(line, flush=True)
        if st == "connected":
            print("=== CONNECTED ===", flush=True)
            break
        if st == "expired":
            print("=== EXPIRED，需要重新生成二维码 ===", flush=True)
            break
        time.sleep(2)
print("状态集合:", seen)
