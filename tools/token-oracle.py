"""通过 CDP 调用 QClaw 的 authMod token oracle：取 JWT、解出加密的 user token、查登录态。

输出只打印长度与前缀，明文写入 re/token-oracle.json（600 权限）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENVF = os.path.join(HERE, "re", "gateway-env.txt")
OUT = os.path.join(HERE, "re", "token-oracle.json")

enc = ""
for line in open(ENVF, encoding="utf-8", errors="replace"):
    if line.startswith("QCLAW_USER_TOKEN_ENCRYPTED="):
        enc = line.split("=", 1)[1].strip()
        break
print("密文长度:", len(enc))

EXPR = """(async () => {
  const t = window.electronAPI.authMod.token;
  const out = { avail: await t.isAvailable() };
  try { out.jwt = await t.getJwt(); } catch (e) { out.jwtErr = String(e); }
  try { out.userInfo = await t.getUserInfo(); } catch (e) { out.userInfoErr = String(e); }
  try { out.decrypted = await t.decrypt(%r); } catch (e) { out.decryptErr = String(e); }
  try { out.wxLoginState = await window.electronAPI.authMod.wx.getLoginState(); } catch (e) { out.wxStateErr = String(e); }
  try { out.tsStatus = await window.electronAPI.turingShield.getStatus(); } catch (e) { out.tsStatusErr = String(e); }
  try { out.integrationWeixinStatus = await window.electronAPI.integration.getWeixinStatus(); } catch (e) { out.iwErr = String(e); }
  return JSON.stringify(out);
})()""" % enc

targets = [x for x in cdp.http_json("/json") if x.get("type") == "page"]
ws = cdp.WS(targets[0]["webSocketDebuggerUrl"])
res = ws.call("Runtime.evaluate", {"expression": EXPR, "awaitPromise": True, "returnByValue": True, "timeout": 60000})
if res.get("exceptionDetails"):
    print("JS 异常:", json.dumps(res["exceptionDetails"], ensure_ascii=False)[:500])
val = res.get("result", {}).get("value")
if not val:
    print("无结果:", json.dumps(res)[:400])
    sys.exit(1)

data = json.loads(val)
fd = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=1)
print("明文已写入", OUT, "(600)\n")


def brief(v):
    if isinstance(v, str):
        return f"len={len(v)} head={v[:14]!r}" if len(v) > 24 else repr(v)
    if isinstance(v, dict):
        return {k: brief(x) for k, x in list(v.items())[:8]}
    return v


for k, v in data.items():
    print(f"  {k}: {json.dumps(brief(v), ensure_ascii=False)}")

dec = data.get("decrypted")
if isinstance(dec, str) and dec.count(".") == 2:
    try:
        import base64
        pl = dec.split(".")[1]
        pl += "=" * (-len(pl) % 4)
        print("\n  >>> decrypted 是 JWT，claims:", json.dumps(json.loads(base64.urlsafe_b64decode(pl)), ensure_ascii=False)[:400])
    except Exception as e:
        print("\n  >>> decrypted 解析 JWT 失败:", e)
