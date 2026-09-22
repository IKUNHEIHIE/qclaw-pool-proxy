"""把号池代理部署到测试云服务器：打包 src/web/package.json -> 上传 -> 解包 -> 启动 -> 自检。

密码只从环境变量 SSH_PASS 读取，不落盘。
"""
import io
import os
import sys
import shlex
import tarfile
import json
import secrets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ssh  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_DIR = "/opt/qclaw-pool-proxy"
ADMIN_TOKEN = os.environ.get("DEPLOY_ADMIN_TOKEN") or "admin-" + secrets.token_hex(16)
CLIENT_KEY = os.environ.get("DEPLOY_CLIENT_KEY") or "vk-" + secrets.token_hex(16)
# 读远端 config.json 里现用的管理令牌与第一个客户端密钥（DEPLOY_KEEP_CONFIG 模式下要用）
CFG_READ = ("import json;c=json.load(open('config.json'));"
            "print(c.get('adminToken',''));print((c.get('clientKeys') or [{}])[0].get('key',''))")


def make_tar():
    buf = io.BytesIO()
    # ui/ 是前端源码、web/ 是它的构建产物。两者都发：运行时只需要 web/，
    # 但少了 ui/ 与那三个配置文件，云端就成了一份"改不动也复现不了"的前端。
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for base in ("src", "web", "scripts", "ui"):
            d = os.path.join(ROOT, base)
            if os.path.isdir(d):
                tf.add(d, arcname=base)
        for extra in ("package.json", "vite.config.ts", "tsconfig.json", "components.json"):
            p = os.path.join(ROOT, extra)
            if os.path.isfile(p):
                tf.add(p, arcname=extra)
    buf.seek(0)
    return buf


def main():
    if not ssh.PASSWORD:
        print("需要 SSH_PASS 环境变量", file=sys.stderr)
        return 3

    acct_file = os.environ.get("DEPLOY_ACCOUNTS_FILE")
    accounts = json.load(open(acct_file, encoding="utf-8"))["accounts"] if acct_file else []
    cfg = {
        "listen": {"host": "0.0.0.0", "port": 8787},
        "adminToken": ADMIN_TOKEN,
        "clientKeys": [{"key": CLIENT_KEY, "name": "deployed"}],
        "accounts": accounts,
        "scheduler": {"cooldownAuthFailSeconds": 90, "cooldownRateLimitSeconds": 120,
                      "cooldownServerErrorSeconds": 30, "stickyRouting": True},
        "upstream": {"timeoutMs": 120000, "modelPrefix": "qclaw/"},
    }

    t = make_tar()
    c = ssh.client()
    print("== 上传代码包 ==")
    sftp = c.open_sftp()
    sftp.putfo(t, "/tmp/qpp.tar.gz")
    sftp.close()
    print("== 解包 ==")
    rc, out, err = ssh.run(c, f"mkdir -p {REMOTE_DIR} && tar xzf /tmp/qpp.tar.gz -C {REMOTE_DIR} && ls {REMOTE_DIR} && node -v")
    print(out or err, f"[exit={rc}]")

    admin, ckey, src = ADMIN_TOKEN, CLIENT_KEY, "（本次新生成）"
    if os.environ.get("DEPLOY_KEEP_CONFIG"):
        print("== 跳过 config.json（DEPLOY_KEEP_CONFIG：沿用远端已有账号与密钥） ==")
        # 先读回远端现值：一是自检要用对的密钥（拿新生成的假值去 curl 只会回「API 密钥无效」，
        # 看着像发版失败），二是万一远端 adminToken 写的是 ${env:PROXY_ADMIN_TOKEN} 占位符，
        # 这里传随机值就等于静默换令牌 —— 后台立刻谁都进不去。
        rc, out, err = ssh.run(c, f"cd {REMOTE_DIR} && python3 -c \"{CFG_READ}\"")
        got = out.split()
        if len(got) >= 2:
            admin, ckey, src = got[0], got[1], "（远端 config.json 现值，本次未改）"
        else:
            print(f"⚠ 读远端密钥失败，自检按新生成的值走（预期 401）: {err or out} [exit={rc}]")
    else:
        print(f"== 写入远端 config.json（账号数 {len(accounts)}） ==")
        sftp = c.open_sftp()
        with sftp.open(f"{REMOTE_DIR}/config.json", "w") as f:
            f.write(json.dumps(cfg, indent=2, ensure_ascii=False))
        sftp.close()
        ssh.run(c, f"chmod 600 {REMOTE_DIR}/config.json")

    print("== 重启服务 ==")
    # 登录页地址一类的运行期参数用 QPP_* 透传，避免为改一个 URL 就重新发版
    qpp_env = " ".join(f"{k}={shlex.quote(v)}" for k, v in sorted(os.environ.items()) if k.startswith("QPP_"))
    # 按监听端口取 PID，避免 pkill -f 匹配到自己的命令行；pidfile 只可能过期。
    kill_by_port = ("for p in $(ss -ltnpH 'sport = :8787' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); "
                    "do kill $p; done")
    # 日志必须 append：之前用 > 每次发版都把旧现场清掉，账号消失过一次却无从查证。
    # config.json 也先留一份带时间戳的备份（只留最近 5 份），号池的 sk-/JWT 丢了只能重新登录补号。
    rc, out, err = ssh.run(
        c,
        f"cd {REMOTE_DIR}; "
        f"cp -a config.json config.pre-deploy-$(date +%Y%m%d-%H%M%S).json 2>/dev/null; "
        f"ls -1t config.pre-deploy-*.json 2>/dev/null | tail -n +6 | xargs -r rm -f; "
        f"{kill_by_port} 2>/dev/null; "
        # 服务退出前会先回收进行中的扫码会话（最多 3 秒），固定 sleep 1 会让新进程撞上
        # EADDRINUSE 起不来 —— 必须等端口真的空出来。
        f"for i in $(seq 1 24); do ss -ltnH 'sport = :8787' | grep -q . || break; sleep 0.5; done; "
        f"PROXY_ADMIN_TOKEN={shlex.quote(admin)} {qpp_env} setsid nohup node src/server.mjs --config config.json "
        f"</dev/null >> /var/log/qpp.log 2>&1 & sleep 4; "
        # 别把 $! 当 node 的 PID：setsid 会再 fork 一次，$! 停在那个包装进程上，
        # 它一退出 pidfile 就成了假账（实测 qpp.sh stop 因此杀不到服务，攒下一堆孤儿浏览器）。
        # 直接问内核谁在听 8787，拿到的才是真的。
        f"ss -ltnpH 'sport = :8787' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u | head -1 > qpp.pid; "
        f"echo pidfile=$(cat qpp.pid); tail -8 /var/log/qpp.log",
    )
    print(out or err, f"[exit={rc}]")

    print("== 自检 ==")
    rc, out, err = ssh.run(
        c,
        "curl -s -m 8 http://127.0.0.1:8787/healthz; echo; "
        "curl -s -o /dev/null -w 'webui HTTP %{http_code} size=%{size_download}\\n' http://127.0.0.1:8787/; "
        "curl -s -m 8 -H 'Authorization: Bearer " + ckey + "' http://127.0.0.1:8787/v1/models | head -c 200; echo; "
        "free -m | head -2; pgrep -af 'src/server.mjs' | head -2",
    )
    print(out or err, f"[exit={rc}]")
    print("\nADMIN_TOKEN=" + admin + " " + src)
    print("CLIENT_KEY=" + ckey + " " + src)
    c.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
