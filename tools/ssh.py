"""在测试云服务器上执行命令的小工具（服务器地址与密码都走环境变量，不落盘）。
用法:  set T_SERVER=... SSH_PASS=... && python tools/ssh.py "uname -a; free -m"
       python tools/ssh.py --put local remote
"""
import os
import sys
import paramiko

try:  # Windows 控制台默认 GBK，远端输出含中文/二进制会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = os.environ.get("T_SERVER") or ""
PORT = int(os.environ.get("T_PORT", "22"))
USER = os.environ.get("T_USER", "root")
PASSWORD = os.environ.get("SSH_PASS") or ""


def client():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=25,
              banner_timeout=40, auth_timeout=40, allow_agent=False, look_for_keys=False)
    return c


def run(c, cmd):
    _, out, err = c.exec_command(cmd, timeout=180, get_pty=False)
    o = out.read().decode("utf-8", "replace")
    e = err.read().decode("utf-8", "replace")
    rc = out.channel.recv_exit_status()
    return rc, o, e


def main():
    # 地址与密码都不入库：漏哪个都比泄一个强
    if not HOST:
        print("缺少 T_SERVER 环境变量（测试服务器地址）", file=sys.stderr)
        return 3
    if not PASSWORD:
        print("缺少 SSH_PASS 环境变量", file=sys.stderr)
        return 3
    c = client()
    if len(sys.argv) > 1 and sys.argv[1] == "--put":
        local, remote = sys.argv[2], sys.argv[3]
        sftp = c.open_sftp()
        sftp.put(local, remote)
        sftp.close()
        print(f"uploaded {local} -> {remote}")
        return 0
    cmd = sys.argv[1] if len(sys.argv) > 1 else "uname -a"
    rc, o, e = run(c, cmd)
    sys.stdout.write(o)
    if e.strip():
        sys.stdout.write("\n[stderr]\n" + e)
    print(f"\n[exit={rc}]")
    c.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
