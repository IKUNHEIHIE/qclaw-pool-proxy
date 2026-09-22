// 服务端自助登录：无头浏览器接管 QClaw 的微信登录页，捕获回调里的授权产物，换成号池账号。
//
// 已确证的事实（抓包 + 明文 bundle + 官网 bundle，2026-09-22 复核）：
//   登录入口 = https://open.weixin.qq.com/connect/qrconnect
//     appid=wx9d11056dd75b7240  scope=snsapi_login
//     redirect_uri=https://security.guanjia.qq.com/login   state=**服务端 4050 签发给本设备 guid 的那串**
//   兑换 = 总线 4026 {guid, code, state} → {token(JWT), user_info:{user_id, nickname, avatar_url}}
//     —— 但必须带网页版 HMAC 签名三头（见 qclaw-api.mjs 的 webSignHeaders）。
//     不带签名时它回 21004「鉴权不通过，请升级最新版本」，很容易被误读成"接口已下线"，
//     我们因此绕了一大圈（09-22 曾据此判定自助扫码不可行，结论是错的）。
//   微信 code 是一次性的：谁先拿它去兑换谁就消耗掉，所以签名通道必须排在 luban 之前。
//   兜底通道 = 中继页 security.guanjia.qq.com/login 把 code postMessage 给父页 /wxLogin，
//   父页 POST https://luban.m.qq.com/api/public/pcmgr/sendLoginCode {code,guid,loginAccType} → 管家会话（loginkey，无 JWT）。

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { attach } from './cdp.mjs';
import {
  AIZONE_BASE, BUS, busCallRaw, busCreateApiKey, busExchange, busModelList,
  sendLoginCode, webCall, webGuid, webLoginState
} from './qclaw-api.mjs';

export const WX_APPID = 'wx9d11056dd75b7240';
export const WX_REDIRECT = 'https://security.guanjia.qq.com/login';
const SESSION_TTL_MS = 5 * 60 * 1000;
// 登录页自己的噪声：微信出码页会逐个端口探测本机 PC 微信（13013~14015）想要"一键确认"，
// 服务器上没有 PC 微信，这六条必然"连接失败"，与扫码成败无关；SEER 是腾讯埋点的自我播报。
// 不滤掉的话，用户看到六行"失败"会以为坏了 —— 但它们确实只配当 debug 脚注。
const BENIGN_CONSOLE = /端口\s*\d{4,5}\s*连接失败|check-?login|connect_qrconnect_checkLogin|SEER LOG/i;
// 扫码是一次性事件：把浏览器经过的每个登录/回调地址落盘，事后可以从文件里还原真实契约
const TRAIL = process.env.QPP_LOGIN_TRAIL || 'login-trail.log';
// 签名兑换的 apiId 列表：4026 是官网桌面端用的，4630 是同一套参数在移动端的编号（实测都会验 state）
const webExchangeIds = () => (process.env.QPP_WEB_LOGIN_API_IDS || `${BUS.wxLogin},${BUS.wxLoginMobile}`)
  .split(',').map(x => x.trim()).filter(Boolean);
// 兜底通道：扫码后若发现新接口，用逗号分隔的 apiId 列表覆盖即可，不必改代码
const exchangeIds = () => (process.env.QPP_LOGIN_API_IDS || '4026').split(',').map(x => x.trim()).filter(Boolean);
// luban sendLoginCode 的账号类型：中继页给 QClaw 传 2，管家自己的网页硬编码 32
const accTypes = () => (process.env.QPP_LOGIN_ACC_TYPES || '2,32').split(',').map(x => Number(x.trim())).filter(Number.isFinite);
// 这台服务器到 luban 的出口实测会随机连不上，而微信 code 是一次性的 —— 只给连接层失败留重试
const LUBAN_TRIES = Math.max(1, Number(process.env.QPP_LUBAN_TRIES) || 3);

function trail(line) {
  try { fs.appendFileSync(TRAIL, new Date().toISOString() + ' ' + line + '\n'); } catch { /* 只读文件系统 */ }
}

function findBrowser() {
  const env = process.env.QPP_BROWSER;
  if (env && fs.existsSync(env)) return env;
  const cands = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ];
  return cands.find(p => fs.existsSync(p)) || null;
}

/**
 * 精确杀掉属于某个临时 profile 的浏览器进程。
 *
 * 为什么不能只 kill 我们 spawn 出来的那个子进程：Debian/Ubuntu 的 /usr/lib/chromium/chromium
 * 是个包装脚本，它会用 systemd-run 把**真正的浏览器**拉进自己的 transient scope
 * （云服务器实测：主浏览器进程 ppid=1、sid=自身 pid、cgroup=app-org.chromium.Chromium-<pid>.scope）。
 * 于是 node 的进程组、cgroup 都管不到它 —— 发版 kill 掉服务后它就长期赖在 1c1g 上
 * （实测漏过 21 个进程、主进程 RSS 215MB），而且它持着的 tmpfs profile 目录此后谁都删不掉。
 * 唯一稳定的身份是命令行里的 `--user-data-dir=<我们建的那个目录>`。
 */
function killProfileBrowser(dir) {
  if (!dir || process.platform === 'win32') return;   // Windows 上浏览器是真子进程，proc.kill 就够
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)).map(Number); } catch { return; }
  const needle = `user-data-dir=${dir}`;
  for (const pid of pids) {
    if (pid === process.pid) continue;
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8'); } catch { continue; }  // 已退或没权限
    if (!cmd.includes(needle)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ }
  }
}

/**
 * 开机把自己上次留下的残骸扫掉。
 * 为什么要：服务被 SIGKILL/OOM/断电带走时，退出钩子根本没机会跑，浏览器与它的 tmpfs profile
 * 就一直躺在机器上（云服务器实测漏过 21 个进程、25 个目录，1c1g 上 tmpfs 上限才 987M）。
 * 判据用目录的 mtime：还在跑的浏览器会持续写 profile，mtime 必然新；超过会话 TTL 的一定是残骸。
 * 只按 qpp-login- 前缀动手，绝不碰别人的目录；也不靠"存在即僵尸"下结论 —— 本机可能同时跑两个实例。
 */
export function sweepStaleProfiles(log = () => {}) {
  const root = os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return 0; }
  const cutoff = Date.now() - SESSION_TTL_MS;
  let cleaned = 0;
  for (const n of names) {
    if (!n.startsWith('qpp-login-')) continue;
    const dir = path.join(root, n);
    try {
      if (fs.statSync(dir).mtimeMs > cutoff) continue;      // 还在跑的会话，别碰
      killProfileBrowser(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      cleaned++;
    } catch (e) { log(`清理残留浏览器目录失败 ${dir}: ${e.code || e.message}`); }
  }
  if (cleaned) log(`已清理上次遗留的无头浏览器残骸：${cleaned} 个临时 profile`);
  return cleaned;
}

function launchBrowser(exe, port, userDataDir, onErr) {
  const args = [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=430,640'
  ];
  // 容器/root 下 chromium 的 setuid 沙箱起不来；非 root 时保留沙箱。
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  args.push('about:blank');
  // POSIX 下让浏览器自成进程组：kill 主进程只会让它 fork 出来的 zygote/gpu/renderer
  // 被 init 收养继续跑（云服务器上实测这样漏了 21 个 chromium 进程、主进程 RSS 215MB，
  // 而且是 tmpfs 里的 profile 删不掉的直接原因）。detached + 负 PID 才能整组带走。
  const detached = process.platform !== 'win32';
  const p = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], detached });
  p.groupKilled = false;
  /** 整组回收：先负 PID 打给进程组，Windows 上没有组概念就直接打给进程 */
  p.killGroup = () => {
    try { if (detached) { process.kill(-p.pid, 'SIGKILL'); p.groupKilled = true; return; } } catch { /* 组已没了 */ }
    try { p.kill('SIGKILL'); } catch { /* 已退 */ }
  };
  let tail = '';
  p.stderr.on('data', d => { tail = (tail + d.toString()).slice(-1200); });
  p.on('exit', code => onErr?.(`浏览器退出 code=${code}\n${tail}`));
  p.on('error', e => onErr?.('浏览器启动失败: ' + e.message));
  p.unref();
  return p;
}

/** 从任意回调 URL 里捞出授权产物 */
function extractParams(url) {
  const out = {};
  try {
    const u = new URL(url);
    for (const k of ['code', 'state', 'token', 'access_token', 'jwt', 'loginKey', 'guid']) {
      const v = u.searchParams.get(k);
      if (v) out[k] = v;
    }
  } catch { /* 非 URL，忽略 */ }
  return out;
}

/** 找一个空闲端口：并发/残留会话不会互相抢死同一个调试端口 */
function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      const srv = net.createServer();
      srv.once('error', () => {
        srv.close();
        if (left <= 0) return reject(new Error(`找不到空闲调试端口（从 ${start} 起）`));
        tryPort(p + 1, left - 1);
      });
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(p)));
    };
    tryPort(start, 40);
  });
}

/** 在任意 JSON 里找 JWT 形状的 token；登录页常常自己在浏览器里完成兑换 */
function pickToken(text) {
  if (!text || text.length > 300000) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  const out = {};
  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && v.startsWith('eyJ') && v.length > 40 && /token|jwt|key/i.test(k)) out[k.toLowerCase()] = v;
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  })(obj, 0);
  const token = out.token || out.access_token || out.jwt || out.accesstoken || Object.values(out)[0];
  if (!token) return null;
  const userInfo = (function findUser(n, d) {
    if (!n || typeof n !== 'object' || d > 5) return null;
    for (const [k, v] of Object.entries(n)) {
      if (/user_?info/i.test(k) && v && typeof v === 'object') return v;
      const r = findUser(v, d + 1); if (r) return r;
    }
    return null;
  })(obj, 0);
  return { token, user_info: userInfo || {}, raw: true };
}

/** 值得翻响应体的 URL：登录/鉴权/绑定相关，跳过静态资源与埋点 */
const EXCHANGE_URL_RE = /login|oauth|userauth|account|\/auth|token|bind|qrconnect/i;
const SKIP_URL_RE = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|map)(\?|$)|beacon|galileo|report|collect|datareport|stat\b/i;

/** 解 JWT payload；挖到裸 JWT 时靠它拿 user_id / guid */
function jwtClaims(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

/** 任意文本里捞 JWT 形状的串（cookie / storage / 响应头都可能带） */
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/;
function grabJwt(text) {
  if (!text) return null;
  const m = JWT_RE.exec(String(text));
  return m ? m[0] : null;
}

/**
 * 从响应体里认 luban sendLoginCode 的管家会话。loginkey 不是 JWT 形状，
 * 所以 grabJwt/pickToken 那条路看不见它 —— 页面自己去兑换时（正确 appid）要靠这里接住。
 * retCode 非 0 时 loginkey 是空串，正则自然不匹配，等于返回 null。
 */
const LOGINKEY_RE = /"loginkey"\s*:\s*"([^"]{8,})"/;
const LOGINKEY_RE_TEST = /"loginkey"\s*:\s*"[^"]{8,}"/;
function pickLoginKey(text) {
  const t = String(text || '');
  const lk = LOGINKEY_RE.exec(t);
  if (!lk) return null;
  const acc = /"accountId"\s*:\s*"?(\d{4,})"?/.exec(t);
  const rt = /"retCode"\s*:\s*(\d+)/.exec(t);
  const nick = /"nickName"\s*:\s*"([^"]{1,40})"/.exec(t);
  return {
    loginkey: lk[1],
    accountId: acc ? Number(acc[1]) : 0,
    retCode: rt ? Number(rt[1]) : 0,
    thirdPartyAccInfo: { nickName: nick ? nick[1] : '' }
  };
}

/** 读页面里的 cookie 与 storage —— 登录态有时只落在这里 */
const PAGE_PROBE = `(() => { try {
  const pick = o => { const r = {}; for (let i = 0; i < o.length; i++) { const k = o.key(i); r[k] = o.getItem(k); } return r; };
  return JSON.stringify({ cookie: document.cookie || '', ls: pick(localStorage), ss: pick(sessionStorage) });
} catch (e) { return '{}'; } })()`;

/** 找页面上真正渲染出来的二维码图片（要等 naturalWidth，早截会得到一张空白） */
const QR_PROBE = `(() => {
  const imgs = [...document.querySelectorAll('img')];
  const hit = imgs.find(i => {
    const src = i.currentSrc || i.src || '';
    const r = i.getBoundingClientRect();
    return /qrcode|qrconnect|connect\\/q|\\/q\\?/i.test(src) && (i.naturalWidth || 0) > 40 && r.width > 20 && r.height > 20;
  });
  if (hit) { const r = hit.getBoundingClientRect(); return JSON.stringify({ ok: true, x: r.x, y: r.y, w: r.width, h: r.height }); }
  const any = imgs.find(i => (i.naturalWidth || 0) > 60);
  if (any) { const r = any.getBoundingClientRect(); if (r.width > 60 && r.height > 60) return JSON.stringify({ ok: true, x: r.x, y: r.y, w: r.width, h: r.height }); }
  // 管家登录页把二维码放在 wxLogin.js 的跨域 iframe 里，顶层文档看不见那张 img —— 按 iframe 裁剪
  const fr = [...document.querySelectorAll('iframe')].map(f => f.getBoundingClientRect())
    .filter(r => r.width > 100 && r.height > 100)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (fr) return JSON.stringify({ ok: true, frame: true, x: fr.x, y: fr.y, w: fr.width, h: fr.height });
  return JSON.stringify({ ok: false, imgs: imgs.length, text: ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 220) });
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class LoginManager {
  constructor({ log = () => {}, onDone = null } = {}) {
    this.sessions = new Map();
    this.log = log;
    this.onDone = onDone;   // 登录成功后把账号写进号池的回调
    this.basePort = Number(process.env.QPP_DEBUG_PORT || 9333);
  }

  newGuid() { return crypto.randomBytes(32).toString('hex'); }

  async start() {
    const exe = findBrowser();
    if (!exe) {
      throw new Error('服务器上没有无头浏览器：装一个 chromium（apt install chromium）或设 QPP_BROWSER 指向 chrome/edge');
    }
    const id = crypto.randomBytes(8).toString('hex');
    const guid = this.newGuid();
    // 网页通道的 guid（官网用 qclawmp_<uuid>），state 就是绑在它上面的，兑换时必须用同一个。
    const wguid = webGuid();
    // state 必须由服务端签发：自造的 64hex 会在兑换时被 `code=4 state 无效或已过期` 挡回来。
    // 这台服务器对 jprx 的出口实测会抖（同一分钟内可见 4320/4050 各自 fetch failed），
    // 一次抖动就降级成自造 state = 朋友那次扫码白扫，所以连接层失败要重试；
    // 业务码（21004 之类）不重试 —— 那是签名/参数错了，打多少次都一样。
    // 仍保留降级到自造值的出口，好让离线桩与登录页本身继续可测（日志会说清是哪一种）。
    let state, stateHow;
    const stateTries = Math.max(1, Number(process.env.QPP_STATE_TRIES) || 3);
    for (let i = 1; ; i++) {
      try {
        state = await webLoginState(wguid);
        stateHow = `state 由 ${BUS.wxLoginState} 签发（网页通道${i > 1 ? `，第 ${i} 次才通` : ''}，guid=${wguid.slice(0, 20)}…）`;
        break;
      } catch (e) {
        if (e.transport && i < stateTries) {
          trail(`[${id}] STATE ${e.message} → 退避后第 ${i + 1} 次`);
          await new Promise(r => setTimeout(r, 400 * i));
          continue;
        }
        state = crypto.randomBytes(32).toString('hex');
        stateHow = `${BUS.wxLoginState} 没拿到 state（${e.message}${e.transport ? `，已试过 ${i} 次` : ''}），暂用自造值 —— 兑换会被服务端拒`;
        break;
      }
    }
    // 默认打微信登录页；QPP_LOGIN_URL 可覆盖（{state} 占位），便于离线端到端验证与将来换入口
    // 占位符用 %STATE%/%GUID%：之前写成模板字面量里的 {{state}}，
    // 结果发出去的 state 真带了一对花括号并被微信原样回传，白排一次队。
    const DEFAULT_LOGIN_URL = 'https://open.weixin.qq.com/connect/qrconnect'
      + `?appid=${WX_APPID}&scope=snsapi_login&redirect_uri=${encodeURIComponent(WX_REDIRECT)}`
      + '&state=%STATE%&login_type=jssdk&self_redirect=true';
    const tpl = process.env.QPP_LOGIN_URL || DEFAULT_LOGIN_URL;
    const url = tpl.replace(/%STATE%|\{state\}/g, state).replace(/%GUID%|\{guid\}/g, guid);

    const sess = {
      id, guid, webGuid: wguid, state, status: 'starting', qrImage: null, log: [], seen: [],
      createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS,
      error: null, settled: false, qrCropped: false, capturing: false,
      proc: null, cdp: null, udd: null
    };
    this.sessions.set(id, sess);
    this._push(sess, `浏览器: ${exe}`);
    this._push(sess, stateHow);
    this._push(sess, `guid=${guid.slice(0, 12)}… state=${state.slice(0, 12)}…`);

    // 每个会话独立 profile + 独立调试端口，允许并行扫码
    sess.udd = fs.mkdtempSync(path.join(os.tmpdir(), 'qpp-login-'));
    try {
      sess.port = await freePort(this.basePort);
      sess.proc = launchBrowser(exe, sess.port, sess.udd, m => { sess.browserErr = m; this._push(sess, m); });
      sess.cdp = await attach(url, { port: sess.port, waitMs: 15000 });
      await sess.cdp.onAnyRequest(u => this._onUrl(sess, u));
      sess.cdp.onNavigation(u => this._onUrl(sess, u));
      sess.cdp.onResponse(r => this._onResponse(sess, r));
      await sess.cdp.onConsole(m => {
        if (BENIGN_CONSOLE.test(m)) {
          // 探测 PC 微信失败是预期行为，但也不能完全不出声：压成一句人话，只说一次
          if (!sess.notedBenign) {
            sess.notedBenign = true;
            this._push(sess, '（登录页在探测本机 PC 微信以支持"免扫码一键确认"，服务器上没有，必然连不上 —— 不影响扫码）');
          }
          return;
        }
        if (/exception|error|warning|拒绝|失败|无效|过期/.test(m)) this._push(sess, m);
      });
      sess.status = 'waiting';
      this._push(sess, '已打开登录页，等二维码渲染后截图');
      await this._captureQr(sess);
      sess.probeTimer = setInterval(() => this._probePage(sess), 2000);
    } catch (e) {
      sess.status = 'failed';
      sess.error = String(e.message || e) + (sess.browserErr ? '；' + sess.browserErr : '');
      this._push(sess, '启动失败: ' + sess.error);
      this._teardown(sess);
    }
    this._reapLater(sess);
    return this.public(sess);
  }

  get(id) {
    const s = this.sessions.get(id);
    return s ? this.public(s) : null;
  }

  cancel(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.status = 'expired'; this._push(s, '已取消'); this._teardown(s);
    return true;
  }

  _push(sess, line) {
    sess.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (sess.log.length > 60) sess.log.shift();
    this.log(`[login ${sess.id.slice(0, 6)}] ${line}`);
  }

  _onUrl(sess, url) {
    if (!url || url === 'about:blank' || sess.seen.length > 400) return;
    const p = extractParams(url);
    if (!p.code && !p.token && !p.access_token && !p.jwt) {
      // 拿到 code 之后页面才会去做真正的兑换，这段窗口里的每个请求都可能是答案，全记下来
      const interesting = sess.code || /login|oauth|callback|qrcode|qrconnect|token|auth/i.test(url);
      if (interesting && !sess.seen.includes(url)) {
        sess.seen.push(url.slice(0, 240));
        trail(`[${sess.id}] hop ${url.slice(0, 500)}`);
      }
      return;
    }
    if (!sess.seen.includes(url)) {
      sess.seen.push(url.slice(0, 240));
      this._push(sess, `回调 URL: ${url.slice(0, 160)}`);
      trail(`[${sess.id}] CALLBACK ${url}`);
    }
    if (sess.status === 'waiting') sess.status = 'scanned';
    Object.assign(sess, { code: p.code || sess.code, token: p.token || p.access_token || p.jwt || sess.token });
    if (sess.settled) return;
    if (sess.token) { sess.settled = true; this._finish(sess, { token: sess.token }); return; }
    // 拿到 code 后先等一小会儿：登录页往往已经自己在浏览器里换好了 token（响应体里就有），
    // 那条路不需要知道兑换 apiId。等不到再回退到按 apiId 主动兑换。
    if (sess.code && !sess.codeTimer) {
      sess.codeTimer = setTimeout(() => {
        sess.codeTimer = null;
        if (sess.settled) return;
        sess.settled = true;
        this._exchange(sess);
      }, 2500);
    }
  }

  /**
   * 登录页可能自己在浏览器里就把 code 换成了 token（桌面端就是这么拿到 JWT 的）。
   * 直接读响应体就不需要知道兑换接口的 apiId —— 这正是 4026 下线后剩下的活路。
   */
  _onResponse(sess, { url, requestId, mimeType, headers }) {
    if (sess.settled || !url || SKIP_URL_RE.test(url)) return;
    // code 到手后的窗口内放宽到所有非静态请求 —— 兑换接口叫什么名字我们还不知道
    const wide = !!sess.code && !/\.(js|css|png|jpe?g|gif|svg|ico|woff2?)(\?|$)/i.test(url);
    if (!wide && !EXCHANGE_URL_RE.test(url)) return;
    // 登录态也可能只在响应头/Set-Cookie 里，且未必是 json
    const hdrToken = Object.entries(headers || {}).find(([k]) => /token|jwt|authorization/i.test(k));
    if (hdrToken) {
      const t = grabJwt(hdrToken[1]);
      if (t) { this._takeToken(sess, t, `响应头 ${hdrToken[0]}`); return; }
    }
    if (mimeType && !/json|text|javascript/i.test(mimeType)) return;
    sess.cdp?.responseBody(requestId).then(body => {
      if (sess.settled || !body) return;
      if (wide && body && body.length > 2) trail(`[${sess.id}] RESP ${url.slice(0, 200)} :: ${body.slice(0, 300).replace(/\s+/g, ' ')}`);
      // 页面自己把 code 换成了管家会话（appid 对得上时只有它会成功）—— 直接接手，别再重复兑换
      if (/sendLoginCode/i.test(url) || LOGINKEY_RE_TEST.test(body)) {
        const lk = pickLoginKey(body);
        if (lk) {
          if (sess.codeTimer) { clearTimeout(sess.codeTimer); sess.codeTimer = null; }
          this._push(sess, `页面自换的 sendLoginCode 返回管家会话（accountId=${lk.accountId} `
            + `昵称=${lk.thirdPartyAccInfo.nickName || '?'}）`);
          trail(`[${sess.id}] PAGE-SENDLOGINCODE ${url.slice(0, 120)} :: ${body.slice(0, 600)}`);
          sess.settled = true;
          this._exchange(sess, lk);
          return;
        }
      }
      const found = pickToken(body) || (grabJwt(body) ? { token: grabJwt(body) } : null);
      if (!found?.token) return;
      this._takeToken(sess, found.token, `响应体 ${url.slice(0, 140)}`, found.user_info);
    }).catch(() => { /* 响应体已被释放，忽略 */ });
  }

  /**
   * 等二维码真的画出来再截。服务器带宽/渲染慢时早截会得到一张纯白 —— 就是这个 bug。
   * 定位到图片就按元素裁剪（比整页截图清楚得多），最多等 15s 再退回整页。
   */
  async _captureQr(sess) {
    if (sess.capturing || !sess.cdp) return;
    sess.capturing = true;
    try {
      // 先给一张整页图，二维码框至少不会空着；等图片元素真的渲染出来再换成按元素裁剪的清晰版
      if (!sess.qrImage) sess.qrImage = await sess.cdp.screenshot();
      const deadline = Date.now() + Number(process.env.QPP_QR_WAIT_MS || 20000);
      for (;;) {
        if (!sess.cdp || sess.settled) return;      // 会话已回收/已完成，别再截了
        let info = {};
        try { info = JSON.parse(await sess.cdp.evalJson(QR_PROBE) || '{}'); } catch { info = {}; }
        if (!sess.cdp) return;
        // 页面完全空白时不能提前收工：那是 SPA 还没启动完，不是"没出码"。
        // 只有页面确实渲染了内容却没有任何图片，才判定为没出码。
        const booted = (info.text || '').length > 0 || (info.imgs || 0) > 0;
        if (info.ok === false && booted && (info.imgs || 0) === 0 && Date.now() > deadline - 13000) {
          sess.qrImage = await sess.cdp.screenshot();
          this._push(sess, '登录页没有任何图片，退回整页截图。页面文字：' + String(info.text || '(空)').slice(0, 160));
          return;
        }
        if (info.ok) {
          // 跨域 iframe 里的二维码没法查状态，多等一会儿再截，避免裁到还没画出来的白框
          if (info.frame) { await sleep(1800); this._push(sess, '按内嵌二维码框架裁剪'); }
          sess.qrImage = await sess.cdp.screenshot({
            x: Math.max(0, Math.floor(info.x)), y: Math.max(0, Math.floor(info.y)),
            width: Math.ceil(info.w), height: Math.ceil(info.h)
          });
          if (!sess.qrCropped) this._push(sess, '二维码已渲染，截图按元素裁剪');
          sess.qrCropped = true;
          return;
        }
        if (Date.now() > deadline) {
          if (!sess.cdp) return;
          sess.qrImage = await sess.cdp.screenshot();
          this._push(sess, `15s 内没等到二维码图片（页面 img 数=${info.imgs ?? '?'}），退回整页截图。`
            + `页面文字：${(info.text || '(空)').slice(0, 160)}`);
          return;
        }
        await sleep(600);
      }
    } finally { sess.capturing = false; }
  }

  /** 周期读页面 cookie/storage，兜住"既不跳转也不在响应里"的情况 */
  async _probePage(sess) {
    if (sess.settled || !sess.cdp) return;
    // 二维码是慢加载的话，靠这里补一张；前端每次轮询都会拿到新的 qrImage
    if (!sess.qrCropped && sess.status === 'waiting') this._captureQr(sess);
    const raw = await sess.cdp.evalJson(PAGE_PROBE);
    if (typeof raw !== 'string' || sess.settled) return;
    const t = grabJwt(raw);
    if (t && t !== sess.jwt) this._takeToken(sess, t, '页面 cookie/storage');
  }

  _takeToken(sess, token, where, userInfo) {
    if (sess.settled) return;
    sess.settled = true;
    this._push(sess, `从${where}拿到 token`);
    trail(`[${sess.id}] TOKEN ${where}`);
    this._finish(sess, { token, user_info: userInfo || {} });
  }

  /**
   * 拿 code 换登录态，两级：
   *   1) _webExchange —— 官网那条网页通道：签名 + 服务端签发的 state，直接吐 openclaw JWT。
   *      必须排在最前：微信 code 是一次性的，luban 先跑就把 code 烧掉了。
   *   2) luban sendLoginCode —— 管家中继页真正调的兑换接口，走 luban 网关而不是 jprx，
   *      只换出管家会话（loginkey），没有 JWT；留着是为了诊断与将来可能的绑定通路。
   *   3) 兜底：拿 loginkey 当 x-token 再打一遍总线，探它现在认不认这种凭据。
   */
  async _exchange(sess, pre = null) {
    const errs = [];
    if (await this._webExchange(sess, errs)) return;
    const wx = pre || await this._luban(sess, errs);
    if (wx) {
      sess.loginKey = wx.loginkey; sess.accountId = wx.accountId;
      // loginkey 本身就是 JWT 的话（服务端换了口径），直接就是登录态
      if (wx.loginkey && JWT_RE.test(wx.loginkey)) {
        await this._finish(sess, { token: grabJwt(wx.loginkey) });
        return;
      }
    }
    // 总线兑换：拿到管家会话就先带 x-token=loginkey 试，再退回裸试（4026 未下线的版本靠这条）
    const creds = wx ? [{ loginKey: wx.loginkey, account: wx.accountId }, {}] : [{}];
    for (const cred of creds) {
      for (const apiId of exchangeIds()) {
        const tag = cred.loginKey ? 'x-token=loginkey' : '匿名';
        try {
          const data = await busExchange(apiId, { guid: sess.guid, code: sess.code, state: sess.state, ...cred });
          trail(`[${sess.id}] EXCHANGE ${apiId} OK (${tag})`);
          await this._finish(sess, data);
          return;
        } catch (e) {
          errs.push(`${apiId}(${tag}): ${e.message}`);
          trail(`[${sess.id}] EXCHANGE ${apiId} FAIL ${e.message}`);
          this._push(sess, `${apiId}(${tag}) 换取失败: ${e.message}`);
        }
      }
    }
    sess.settled = false;   // 允许后续回调（比如页面又发了一个新接口）再试
    if (wx && await this._probeBus(sess, wx, errs)) return;
    sess.status = 'failed';
    sess.error = `授权码已拿到（${String(sess.code).slice(0, 8)}…），但兑换未产出登录态：${errs.join(' ; ') || '无结果'}。`
      + (wx ? '签名通道与 luban 都只给到管家会话，没有 openclaw JWT —— 该号的兑换契约与已验证版本不同。'
            : '回调轨迹已写入 ' + TRAIL + '，据此可定位当前使用的兑换接口。');
    this._push(sess, sess.error);
    this._teardown(sess);
  }

  /**
   * 网页通道兑换：签名三头 + 服务端签发的 state，一步拿到 openclaw JWT。
   * 返回 true 表示已经交给 _finish（无论入池成败），false 才继续走 luban 兜底。
   */
  async _webExchange(sess, errs) {
    for (const apiId of webExchangeIds()) {
      let r = null;
      try {
        r = await webCall(apiId, { guid: sess.webGuid, code: sess.code, state: sess.state });
      } catch (e) {
        errs.push(`${apiId}(签名): ${e.message}`);
        this._push(sess, `${apiId} 签名兑换没打到服务端: ${e.message}`);
        continue;
      }
      trail(`[${sess.id}] WEBEX ${apiId} code=${r.code} msg=${r.message} data=${JSON.stringify(r.data || {}).slice(0, 400)}`);
      if (r.data?.token) {
        this._push(sess, `${apiId} 签名兑换成功，拿到登录 token`);
        await this._finish(sess, r.data);
        return true;
      }
      // state 被拒 = 我们这边的问题，重试另一个 apiId 也一样；微信侧拒绝则两种编号都会这么说
      errs.push(`${apiId}(签名): ${r.code} ${r.message}`);
      this._push(sess, `${apiId} 签名兑换未返回 token: code=${r.code} ${r.message}`);
    }
    return false;
  }

  /** 中继页 /wxLogin 父页对 code 做的那一步。返回 null 表示没换到管家会话。 */
  async _luban(sess, errs) {
    for (const t of accTypes()) {
      let r = null;
      // 实测这台服务器出口到 luban.m.qq.com 极不稳（连打 4 次只有 1 次通），而微信 code 是一次性的：
      // 一次连接抖动就把整次扫码废掉，用户只能再麻烦一个人扫一次。所以只对"根本没打到服务端"的
      // 失败重试；retCode 非 0 是服务端明确答复（code 已用过/不对这个 appid），重试没有意义。
      for (let i = 0; i < LUBAN_TRIES && !r; i++) {
        try {
          r = await sendLoginCode({ code: sess.code, guid: sess.guid, loginAccType: t });
        } catch (e) {
          trail(`[${sess.id}] SENDLOGINCODE type=${t} FAIL#${i + 1} ${e.message}`);
          const blip = /不可达|fetch failed|TimeoutError|AbortError|socket/i.test(e.message || '');
          if (blip && i + 1 < LUBAN_TRIES) {
            this._push(sess, `sendLoginCode(type=${t}) 第 ${i + 1} 次没连通 luban（${e.message}），重试`);
            await sleep(600 * (i + 1));
            continue;
          }
          errs.push(`sendLoginCode(${t}): ${e.message}`);
          this._push(sess, `sendLoginCode(type=${t}) 失败: ${e.message}`);
          break;
        }
      }
      if (!r) continue;
      trail(`[${sess.id}] SENDLOGINCODE type=${t} :: ${JSON.stringify(r).slice(0, 900)}`);
      this._push(sess, `sendLoginCode(type=${t}) retCode=${r.retCode} traceid=${r.traceid || '-'}`);
      if (Number(r.retCode) === 0) {
        this._push(sess, `管家会话到手：accountId=${r.accountId} loginkey=${String(r.loginkey).slice(0, 12)}…`
          + ` 昵称=${r.thirdPartyAccInfo?.nickName || '?'}`);
        return r;
      }
      errs.push(`sendLoginCode(${t}) retCode=${r.retCode}`);
    }
    return null;
  }

  /**
   * 只拿到管家会话时，把"loginkey 当 x-token 能不能直接开号"探出来。
   * 一次扫码就要把所有结论带回去，不该让用户扫第二次；其中任何一步返回 JWT 就直接入池。
   */
  async _probeBus(sess, wx, errs) {
    const auth = { guid: sess.guid, account: wx.accountId, jwt: '', token: wx.loginkey };
    const shots = [
      [`4055 createApiKey`, BUS.createApiKey, {}],
      [`4058 channelToken`, BUS.refreshChannelToken, {}],
      [`4027 用户信息`, BUS.userInfo, {}],
      [`4320 模型目录`, BUS.modelStatus, {}]
    ];
    for (const [name, apiId, body] of shots) {
      try {
        const d = await busCallRaw(apiId, body, auth);
        const s = JSON.stringify(d).slice(0, 200);
        trail(`[${sess.id}] PROBE ${apiId} OK :: ${s}`);
        this._push(sess, `${name} 带 loginkey 通了 → ${s}`);
        const cand = d?.token || d?.openclaw_channel_token || d?.jwt || d?.access_token;
        if (cand && JWT_RE.test(String(cand))) {
          await this._finish(sess, { token: grabJwt(String(cand)), user_info: d.user_info || { user_id: wx.accountId, guid: sess.guid } });
          return true;
        }
      } catch (e) {
        trail(`[${sess.id}] PROBE ${apiId} FAIL ${e.message}`);
        errs.push(`${name}(loginkey): ${e.message}`);
      }
    }
    return false;
  }

  /** 有了 JWT：立刻取 sk- + 模型清单，拼成号池账号 */
  async _finish(sess, data) {
    const jwt = data.token || data.jwt;
    if (!jwt) { this._push(sess, '回调里没有 token'); return; }
    // 只有 JWT、没有 user_info 时（从 cookie/响应头挖到的），账号信息就在 JWT 里
    const claims = jwtClaims(jwt);
    const info = data.user_info || {};
    const userId = info.user_id || data.user_id || claims.user_id;
    sess.jwt = jwt;
    this._push(sess, `拿到 JWT（user_id=${userId ?? '?'}）`);
    try {
      let auth = { guid: info.guid || claims.guid || sess.guid, account: userId, jwt };
      let key, models;
      try {
        [key, models] = await Promise.all([busCreateApiKey(auth), busModelList(auth)]);
      } catch (e) {
        // 网页通道的 token 是按 qclawmp_<uuid> 签发的，而号池里的老账号带的是桌面端 64hex 设备 guid。
        // 两种 guid 各试一次再判失败 —— 否则同一个号会因为 guid 形态不同而上不了池。
        const alt = auth.guid === sess.webGuid ? sess.guid : sess.webGuid;
        this._push(sess, `sk- 获取失败（${e.message}），改用 guid=${String(alt).slice(0, 14)}… 重试`);
        auth = { ...auth, guid: alt };
        [key, models] = await Promise.all([busCreateApiKey(auth), busModelList(auth)]);
      }
      sess.account = {
        id: `qclaw-${userId || sess.id.slice(0, 8)}`,
        type: 'qclaw-aizone',
        base: AIZONE_BASE,
        apiKey: key.key, jwt, guid: auth.guid, account: userId,
        // unionid 是"同一个微信号"的稳定身份，入池时靠它认出重复上号并就地更新
        identity: {
          userId: userId ?? null, openid: info.openid || '', unionid: info.unionid || '',
          nickname: info.nickname || '', avatar: info.head_img_url || info.avatar_url || ''
        },
        models: models.map(m => m.id), weight: 100,
        note: `扫码登录于 ${new Date().toISOString()}`
      };
      this._push(sess, `已取 sk-（…${key.key.slice(-6)}）+ ${models.length} 个模型，正在入池`);
      const who = `user_id=${userId ?? '?'}${info.nickname ? ` 昵称「${info.nickname}」` : ''}`;
      // 这里必须分清"新增"与"就地更新"：unionid 命中时号池数量不变，而一句「已写入号池」
      // 会被读成"多了一个号"。实测有人删了号再扫一次，看到成功提示却发现号池反而少一个，
      // 以为加号功能坏了 —— 其实扫出来的本来就是池里已有的那个微信号。
      // done 也要留到入池返回之后：入池那一步会写盘 + 刷目录，先报 done 的话
      // UI 已经停止轮询，万一这里失败（配置校验不过）就永远看不到「入池失败」。
      // saving 是这段空档的状态，免得界面还停在"请在手机上确认"。
      sess.status = 'saving';
      try {
        const r = await this.onDone?.(sess.account);
        sess.upsert = r;
        sess.status = 'done';
        this._push(sess, r?.reused
          ? `这个微信号已在号池里，已就地更新 ${r.reused} 的凭据（${who}）；号池数量不变 —— 要加新号得用另一个微信号扫码`
          : `已新增账号 ${sess.account.id}（${who}）${r?.poolSize ? `，号池共 ${r.poolSize} 个号` : ''}`);
      } catch (e) { sess.status = 'failed'; sess.error = '入池失败: ' + e.message; this._push(sess, sess.error); }
    } catch (e) {
      sess.status = 'failed';
      sess.error = 'JWT 已拿到但 sk- 获取失败: ' + e.message;
      this._push(sess, sess.error);
    }
    this._teardown(sess);
  }

  /**
   * 服务退出前把进行中的会话一起带走。
   * 不做这件事的代价是实测出来的：发版 kill 掉服务时若有会话在跑，chromium 会被 init 收养，
   * 在 1c1g 上白占 200MB+，而且它持着的 tmpfs profile 目录此后谁都删不掉（云服务器漏过 21 个进程）。
   * 平时那套删除重试的 timer 全是 unref 的，进程一 exit 就消失，所以这里必须自己等到位。
   */
  async shutdown() {
    const live = [...this.sessions.values()].filter(s => s.proc || s.udd);
    for (const s of live) {
      if (s.status !== 'done' && s.status !== 'failed') { s.status = 'expired'; this._push(s, '服务退出，会话已终止'); }
      try { s.cdp?.close(); } catch { /* 已关 */ }
      s.codeTimer && clearTimeout(s.codeTimer);
      s.probeTimer && clearInterval(s.probeTimer);
      try { s.proc?.killGroup ? s.proc.killGroup() : s.proc?.kill('SIGKILL'); } catch { /* 已退 */ }
      killProfileBrowser(s.udd);   // 组杀不到它（见 killProfileBrowser 的注释），按 profile 补刀
    }
    const until = Date.now() + 2000;
    for (const s of live) {
      while (s.udd) {
        try { fs.rmSync(s.udd, { recursive: true, force: true }); s.udd = null; break; }
        catch (e) {
          if (Date.now() >= until) { trail(`[${s.id}] 退出时临时浏览器目录没删掉：${s.udd} (${e.code || e.message})`); break; }
          await new Promise(r => setTimeout(r, 150));
        }
      }
    }
  }

  _teardown(sess) {
    if (sess.codeTimer) { clearTimeout(sess.codeTimer); sess.codeTimer = null; }
    if (sess.probeTimer) { clearInterval(sess.probeTimer); sess.probeTimer = null; }
    try { sess.cdp?.close(); } catch { /* 已关 */ }
    // 走 killGroup：直接 proc.kill() 只杀主进程，POSIX 下会留下一串被 init 收养的 chromium 子进程
    try { sess.proc?.killGroup?.() ?? sess.proc?.kill('SIGKILL'); } catch { /* 已退 */ }
    // 进程组也管不到它（见 killProfileBrowser），所以再按 profile 目录精确补刀
    killProfileBrowser(sess.udd);
    this._dropProfile(sess.udd, sess.id);
    sess.udd = null;
    sess.cdp = null; sess.proc = null;
  }

  /**
   * 删掉无头浏览器的临时 profile。kill 是异步的，浏览器真正释放目录还在几十毫秒之后，
   * 所以「rm 一次、失败就静默跳过」在 Windows 上基本等于没删 —— 本机 tmpdir 一次会话
   * 就攒下 43 个 qpp-login-* （每个几百个文件）。等一等、退避重试几次，最后一次都不成才记一行。
   */
  _dropProfile(dir, id = '', attempt = 0) {
    if (!dir) return;
    // 第一次也要等：kill 之后浏览器释放目录本来就要几十毫秒，抢在前面必 EBUSY。
    // Windows 上 Edge  whole 进程树退干净实测能到 2 秒以上，所以前期密一点、次数多一点。
    if (attempt === 0) { setTimeout(() => this._dropProfile(dir, id, 1), 150).unref?.(); return; }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (attempt < 12) setTimeout(() => this._dropProfile(dir, id, attempt + 1), 150 * attempt).unref?.();
      else trail(`[${id}] 临时浏览器目录没删掉：${dir} (${e.code || e.message})`);
    }
  }

  _reapLater(sess) {
    setTimeout(() => {
      if (sess.status !== 'done' && sess.status !== 'failed') {
        sess.status = 'expired'; this._push(sess, '二维码超时'); this._teardown(sess);
      }
      setTimeout(() => this.sessions.delete(sess.id), 10 * 60 * 1000);
    }, SESSION_TTL_MS).unref();
  }

  public(s) {
    return {
      loginId: s.id, status: s.status, qrImage: s.qrImage, expiresAt: s.expiresAt,
      error: s.error, log: s.log.slice(-24), seen: s.seen.slice(-24),
      account: s.account ? { id: s.account.id, models: s.account.models?.length } : null,
      reused: s.upsert?.reused || null, poolSize: s.upsert?.poolSize ?? null,
      accountRecord: s.account || null
    };
  }
}
