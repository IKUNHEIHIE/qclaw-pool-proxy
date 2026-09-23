import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, configPathFromArgv, saveConfig, validate } from './config.mjs';
import { Pool } from './pool.mjs';
import { UpstreamError } from './upstream.mjs';
import { LoginManager, sweepStaleProfiles } from './login.mjs';
import { KeyStore, maskKey, ESTIMATE_CAP, estimateTokens } from './keys.mjs';
import { busIdentity } from './qclaw-api.mjs';
import { anthropicToOpenAI } from './translate.mjs';
import { respond } from './respond.mjs';
import { responsesToChat, newResponseId } from './responses.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web');
const MAX_BODY = 32 * 1024 * 1024;
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
})();

const cfgFile = configPathFromArgv(process.argv);
const cfg = loadConfig(cfgFile);
const pool = new Pool(cfg, { persist: () => { saveConfig(cfg); } });
const startedAt = Date.now();

const log = (...a) => console.log(new Date().toISOString(), ...a);

const keys = new KeyStore(cfg);
let saveTimer = null;
function scheduleSave() {
  keys.snapshotForSave();
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { saveConfig(cfg); } catch (e) { log('写配置失败:', e.message); } }, 5000).unref?.();
}

/**
 * 同一微信号重复上号的识别。
 * 编号空间是混乱的：QClaw 的 user_id、管家的 accountId、按 appid 变的 openid 都可能不同，
 * 只有 unionid 在开放平台维度稳定 —— 所以拿它当主键，认出"还是那个号"后就地更新凭据，
 * 而不是在池子里堆出多条指向同一个人的记录（那会让轮询虚增、额度被自己抢自己的）。
 */
async function resolveIdentity(a) {
  if (a.type !== 'qclaw-aizone' || !a.jwt) return a.identity || null;
  if (a.identity?.unionid) return a.identity;
  try { return await busIdentity({ guid: a.guid, account: a.account, jwt: a.jwt }, { timeoutMs: 8000 }); }
  catch { return a.identity || null; }
}

async function upsertAccount(body) {
  if (!body?.id) throw Object.assign(new Error('账号缺少 id'), { statusCode: 400 });
  const rec = { ...body };
  rec.identity = await resolveIdentity(rec);
  const unionid = rec.identity?.unionid || '';
  let i = cfg.accounts.findIndex(a => a.id === rec.id);
  if (i < 0 && unionid) {
    const dup = cfg.accounts.findIndex(a => a?.identity?.unionid && a.identity.unionid === unionid);
    if (dup >= 0) {
      // 认出是同一个号：沿用池里已有的 id，新凭据覆盖上去，并告诉调用方发生了什么
      rec.reusedId = cfg.accounts[dup].id;
      rec.id = cfg.accounts[dup].id;
      i = dup;
    }
  }
  // 新号默认排到队尾：优先级是"序号越小越优先"，留空的话它在按序号重排前排不出位置。
  if (i < 0 && rec.priority === undefined) rec.priority = cfg.accounts.length;
  const merged = i < 0 ? rec : { ...cfg.accounts[i], ...rec };
  const next = { ...cfg, accounts: i < 0 ? [...cfg.accounts, rec] : cfg.accounts.map((a, n) => (n === i ? merged : a)) };
  // 必须在写盘前校验：这份配置是启动时 loadConfig→validate 的输入，
  // 写进一个非法账号会让带 Restart=always 的服务在下次启动时崩溃循环，只能手工修文件。
  try { validate(next); } catch (e) {
    throw Object.assign(new Error(e.message.replace(/^配置无效:\s*/, '账号无效: ').replace(/\n\s*- /g, '；')), { statusCode: 400 });
  }
  if (i < 0) cfg.accounts.push(rec); else cfg.accounts[i] = merged;
  saveConfig(cfg);
  pool.state.delete(rec.id);
  // 手工加、且不带 models 的账号靠目录才知道能服务什么；不刷就成了"什么都不是"，
  // 而且 serves() 现在对空目录一律不接，不刷这个号就永远接不到请求。
  await pool.refreshCatalog(rec.id).catch(() => {});
  return { id: rec.id, reused: rec.reusedId || null, unionid: rec.identity?.unionid || '' };
}

const SECRET_FIELD = /^(token|apiKey|jwt|clientSecret|password|loginKey|loginkey|guid)$/i;
/**
 * 管理端读配置只为看结构，不能把号池凭据顺带发出去：
 * jwt 就是 30 天的 X-OpenClaw-Token（比 sk- 更值钱），guid 是设备身份，
 * adminToken 回显给已经持有它的人没有意义，只会多一处泄露点（日志/截图/代理）。
 */
function redactAccount(a) {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) {
    if (SECRET_FIELD.test(k)) out[k] = v ? '•已隐藏•' : undefined;
    else if (k === 'headers' && v && typeof v === 'object') out.headers = Object.fromEntries(Object.keys(v).map(h => [h, '•已隐藏•']));
    else out[k] = v;
  }
  return out;
}

const logins = new LoginManager({
  log,
  // 把 upsert 的结果回传给扫码引擎：它要靠 reused 区分「新增了一个号」与
  // 「这个微信号本来就在池里，只是换了凭据」——两种情况号池数量不一样，提示也不能一样。
  onDone: async account => {
    const r = await upsertAccount(account);
    return { ...r, poolSize: cfg.accounts.length };
  }
});

/**
 * CORS 允许来源。配成数组时按请求 Origin 精确回显 —— 回显具体来源就必须带 Vary: Origin，
 * 否则共享缓存会把 A 站的响应喂给 B 站。
 */
function corsOrigin(req) {
  const raw = cfg.cors?.origin;
  if (raw === undefined || raw === null || raw === '*') return '*';
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map(x => String(x).trim()).filter(Boolean);
  if (!list.length || list.includes('*')) return '*';
  const origin = req?.headers?.origin;
  return origin && list.includes(origin) ? origin : list[0];
}

function corsHeaders(req) {
  const o = corsOrigin(req);
  return o === '*' ? { 'access-control-allow-origin': '*' }
    : { 'access-control-allow-origin': o, vary: 'Origin' };
}

function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...(res._cors || { 'access-control-allow-origin': '*' }),
    ...headers
  });
  res.end(body);
}

const errBody = (e, external = false) => {
  const status = e instanceof UpstreamError ? (e.status || 502) : e?.statusCode || 400;
  const type = e.errType || (status === 401 || status === 403 ? 'authentication_error'
    : status === 429 ? 'rate_limit_exceeded'
    : status >= 500 ? 'upstream_error' : 'invalid_request_error');
  // 对外只说"发生了什么"，号池内部（账号 id、上游原文）留在日志与 /admin/state 里
  const message = (external && e.safe) ? e.safe : (e.message || String(e));
  return { status, payload: { error: { message, type, code: e.errCode || e.kind || null } } };
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const buf = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { statusCode: 413 })); req.destroy(); return; }
      buf.push(c);
    });
    req.on('end', () => {
      if (!buf.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(buf).toString('utf8'))); }
      catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : (req.headers['x-api-key'] || '').trim();
}

/**
 * 客户端 IP。X-Forwarded-For 完全由调用方控制，未经明确信任代理前一律不采信；
 * 即使信任代理，也要取链条的**最后**一跳 —— 第一个值仍是客户端自己塞的。
 */
function ipOf(req) {
  const sock = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!cfg.listen?.trustProxy) return sock;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return (chain.length ? chain[chain.length - 1] : sock).replace(/^::ffff:/, '');
}

function inCidr(ip, cidr) {
  const [base, bits] = String(cidr).split('/');
  if (!bits) return ip === base || (cidr.endsWith('*') && ip.startsWith(cidr.slice(0, -1)));
  const n = Number(bits);
  if (ip.includes(':') || base.includes(':')) return ip === base;   // v6 只做精确匹配，够用
  const a = ip.split('.').map(Number), b = base.split('.').map(Number);
  if (a.length !== 4 || b.length !== 4 || a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  const ia = (a[0] << 24 | a[1] << 16 | a[2] << 8 | a[3]) >>> 0;
  const ib = (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (ia & mask) === (ib & mask);
}

/**
 * 管理面来源限制：默认不限制（保持现有部署可用），配了 adminAllowFrom 就强制。
 * "本机"只认 socket 地址 —— 否则一个 `X-Forwarded-For: 127.0.0.1` 就能从公网绕过整道闸，
 * 而闸后面站着的是整个号池的凭据。
 */
function adminAllowed(req) {
  const allow = cfg.listen?.adminAllowFrom;
  if (!Array.isArray(allow) || !allow.length) return true;
  const sock = String(req.socket?.remoteAddress || '');
  if (sock === '127.0.0.1' || sock === '::1' || sock.startsWith('::ffff:127.')) return true;
  const ip = ipOf(req);
  return allow.some(c => inCidr(ip, c));
}

function checkAdmin(req) {
  return cfg.adminToken && bearer(req) === cfg.adminToken;
}

/** 请求正文拼起来，用于上游不给 usage 时粗估 token（截断：只为算量级，不是账单） */
function promptTextOf(payload) {
  const text = (payload.messages || []).map(m => String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content) || '')).join('')
    + String(payload.system || '');
  return text.length > ESTIMATE_CAP ? text.slice(0, ESTIMATE_CAP) : text;
}

// 响应四象限（OpenAI/Anthropic × JSON/SSE）连同背压、断开处理都在 respond.mjs，那边有离线测试。

async function handleChatCompletion(req, res, openaiBody, model, style, auth, respMeta) {
  const payload = { ...openaiBody, model };
  const cap = auth.record.maxTokens;
  if (cap && (!payload.max_tokens || payload.max_tokens > cap)) payload.max_tokens = cap;
  const stream = !!payload.stream;
  if (cap) res.setHeader('x-qclaw-max-tokens', String(payload.max_tokens));  // 让客户端与验收脚本看得见被下调后的预算
  const pText = promptTextOf(payload);
  // aizone 从不返回 usage，所以这里先按字符数估一份；流式结束后若上游确实没给，就用它记账
  const promptTokens = estimateTokens(pText);
  const wantUsage = !!payload.stream_options?.include_usage;
  const t0 = Date.now();
  // 粘的是"同一个会话"，不是"同一个密钥"：若按 clientKey 固定，一个密钥永远只吃一个号，
  // 号池对单个用户就形同虚设。没有会话标识时退回加权轮询。
  const sticky = payload.user || payload.metadata?.user_id || req.headers['x-qclaw-session'] || '';
  const { res: up, account } = await pool.run(model, payload, {
    stickyKey: sticky || undefined,
    only: req.headers['x-qclaw-account'] || undefined
  });
  const ms = Date.now() - t0;
  log(`chat key=${auth.record.name} model=${model} acct=${account.id} stream=${stream} ${ms}ms`);
  res.setHeader('x-qclaw-account', account.id);
  res.setHeader('x-qclaw-request-ms', String(ms));
  if (auth.record.rpm) res.setHeader('x-ratelimit-limit', String(auth.record.rpm));

  // 客户端提前断开时用来停止拉上游；res 上的 error 必须有监听者，否则会抛成未处理事件
  const guard = { gone: false };
  res.on('close', () => { if (!res.writableEnded) guard.gone = true; });
  res.on('error', () => { guard.gone = true; });

  const failed = (status, error) => {
    auth.accounted = true;        // 别让外层 catch 对同一次请求重复记账
    keys.record(auth.record, { ok: false, model, account: account.id, ms, status, stream, error, promptText: pText });
    scheduleSave();
  };

  try {
    const out = await respond({
      res, up, style,
      stream, model, guard, cors: corsOrigin(req), promptTokens, wantUsage
    });
    auth.accounted = true;
    // 上游没给 usage 时按字符数粗估（推理内容也计费，所以连同 reasoning 一起算），UI 标"估"
    keys.record(auth.record, {
      ok: true, model, account: account.id, ms, status: 200, stream,
      promptTokens: out.usage?.prompt_tokens ?? promptTokens,
      completionTokens: out.usage?.completion_tokens ?? estimateTokens(out.text + out.reasoning),
      promptText: pText
    });
    if (out.aborted) log(`客户端提前断开 key=${auth.record.name} acct=${account.id}（已停止拉上游）`);
    scheduleSave();
  } catch (e) {
    failed(errBody(e).status, e.message);
    throw e;
  }
}

async function handleAdmin(req, res, url) {
  if (!adminAllowed(req)) {
    return send(res, 403, { error: { message: '管理端点仅限受信来源访问（listen.adminAllowFrom）', type: 'permission_denied' } });
  }
  if (!checkAdmin(req)) return send(res, 401, { error: { message: 'admin token 无效', type: 'authentication_error' } });
  // pathname 是百分号编码的，必须解码后再和配置里的 id 比 ——
  // 否则任何非 ASCII 账号 id（WebUI 的手动添加允许中文）都会让删除/刷新/启停统统 404。
  const seg = url.pathname.split('/').filter(Boolean)
    .map(s => { try { return decodeURIComponent(s); } catch { return s; } });

  if (req.method === 'GET' && seg[1] === 'state') {
    return send(res, 200, {
      version: VERSION, startedAt, uptimeMs: Date.now() - startedAt, stats: pool.stats,
      scheduler: cfg.scheduler, accounts: pool.snapshot(), models: pool.modelIndex(),
      rates: pool.rates,
      keys: keys.summary(), noKeysConfigured: !(cfg.clientKeys || []).length,
      configPath: cfgFile
    });
  }
  if (req.method === 'GET' && seg[1] === 'config') {
    const { _file, ...safe } = cfg;
    return send(res, 200, {
      ...safe,
      adminToken: safe.adminToken ? '•已隐藏•' : undefined,
      accounts: cfg.accounts.map(redactAccount),
      clientKeys: (cfg.clientKeys || []).map(k => ({ ...k, key: maskKey(k.key) }))
    });
  }
  if (req.method === 'POST' && seg[1] === 'catalog' && seg[2] === 'refresh') {
    return send(res, 200, await pool.refreshAll());
  }
  if (req.method === 'POST' && seg[1] === 'test') {
    // WebUI 用 /admin/test + body.accountId；accountId 省略时由号池自行选号
    const { model, prompt, accountId } = await readJson(req);
    const out = await pool.run(model || 'qclaw/modelroute', {
      messages: [{ role: 'user', content: prompt || '只回复两个字：收到' }], max_tokens: 64, stream: false
    }, { maxAttempts: accountId ? 1 : 3, only: accountId || undefined, allowUnavailable: true });
    const json = await out.res.json();
    return send(res, 200, { account: out.account.id, reply: json.choices?.[0]?.message?.content ?? null, raw: json });
  }
  if (req.method === 'POST' && seg[1] === 'login' && seg[2] === 'start') {
    return send(res, 200, await logins.start());
  }
  if (seg[1] === 'login' && seg[2]) {
    const s = logins.get(seg[2]);
    if (!s) return send(res, 404, { error: { message: '登录会话不存在或已回收' } });
    if (req.method === 'POST' && seg[3] === 'cancel') { logins.cancel(seg[2]); return send(res, 200, { ok: true }); }
    return send(res, 200, s);
  }

  // ---- 对外密钥 ----
  if (seg[1] === 'keys') {
    if (req.method === 'GET' && !seg[2]) return send(res, 200, { keys: keys.list() });
    if (req.method === 'POST' && !seg[2]) {
      const body = await readJson(req);
      const rec = keys.create(body);
      saveConfig(cfg);
      return send(res, 201, { ...rec, warning: '这是唯一一次完整展示该密钥，请立刻保存' });
    }
    const key = seg[2];
    if (req.method === 'POST' && seg[3] === 'rotate') {
      const rec = keys.rotate(key);
      if (!rec) return send(res, 404, { error: { message: '密钥不存在' } });
      saveConfig(cfg);
      return send(res, 200, { ...rec, warning: '新密钥，旧的那把已立即失效' });
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const rec = keys.update(key, await readJson(req));
      if (!rec) return send(res, 404, { error: { message: '密钥不存在' } });
      saveConfig(cfg);
      return send(res, 200, { ok: true, key: rec });
    }
    if (req.method === 'DELETE') {
      if (!keys.remove(key)) return send(res, 404, { error: { message: '密钥不存在' } });
      saveConfig(cfg);
      return send(res, 200, { ok: true });
    }
  }
  if (req.method === 'GET' && seg[1] === 'log') {
    return send(res, 200, { log: keys.recent(Number(url.searchParams.get('limit')) || 80), totals: keys.summary() });
  }

  if (req.method === 'POST' && seg[1] === 'accounts') {
    if (seg[2] === 'upsert') {
      const body = await readJson(req);
      return send(res, 200, { ok: true, ...(await upsertAccount(body)) });
    }
    const id = seg[2];
    if (seg[3] === 'refresh') return send(res, 200, { models: await pool.refreshCatalog(id) });
    // 体检即查积分（见 Pool.probe）：一次轻量总线查询，不烧推理额度
    if (seg[3] === 'probe') return send(res, 200, await pool.probe(id));
    if (seg[3] === 'test') {
      const { model, prompt, accountId } = await readJson(req);
      const out = await pool.run(model || 'qclaw/modelroute', {
        messages: [{ role: 'user', content: prompt || '只回复两个字：收到' }], max_tokens: 64, stream: false
      }, { maxAttempts: 1, only: accountId || id, allowUnavailable: true });
      const json = await out.res.json();
      return send(res, 200, { account: out.account.id, reply: json.choices?.[0]?.message?.content ?? null, raw: json });
    }
    if (req.method === 'POST' && (seg[3] === 'disable' || seg[3] === 'enable')) {
      const a = pool.account(id);
      // 未知 id 以前是 TypeError → 500；这是管理端点，给 404 才看得懂
      if (!a) return send(res, 404, { error: { message: `账号不存在 ${id}`, type: 'invalid_request_error' } });
      a.enabled = seg[3] === 'enable';
      if (a.enabled) { pool.state.delete(id); await pool.refreshCatalog(id).catch(() => {}); }
      saveConfig(cfg);
      return send(res, 200, { ok: true, enabled: a.enabled });
    }
  }
  // 只改调用优先级序号，不碰凭据：号池里 0600 的那份记录不该为了排个序被前端整条回读再写回
  if (req.method === 'PATCH' && seg[1] === 'accounts' && seg[2] && !seg[3]) {
    const a = cfg.accounts.find(x => x.id === seg[2]);
    if (!a) return send(res, 404, { error: { message: `账号不存在 ${seg[2]}`, type: 'invalid_request_error' } });
    const body = await readJson(req);
    const p = Number(body.priority);
    if (!Number.isInteger(p) || p < 0) {
      return send(res, 400, { error: { message: 'priority 必须是 ≥0 的整数序号', type: 'invalid_request_error' } });
    }
    a.priority = p;
    saveConfig(cfg);
    return send(res, 200, { ok: true, id: a.id, priority: a.priority });
  }
  if (req.method === 'DELETE' && seg[1] === 'accounts' && seg[2]) {
    const i = cfg.accounts.findIndex(a => a.id === seg[2]);
    if (i < 0) return send(res, 404, { error: { message: '账号不存在' } });
    cfg.accounts.splice(i, 1); pool.state.delete(seg[2]); saveConfig(cfg);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: { message: '未知管理端点' } });
}

function serveStatic(res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[\\/])/, ''));
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'not found');
  }
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const isApi = url.pathname.startsWith('/v1/');
  let auth = null;
  res._cors = corsHeaders(req);          // 解析一次，send() 与各流式分支共用
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...res._cors,
        'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,x-api-key,x-qclaw-session,x-qclaw-account,anthropic-version',
        'access-control-max-age': '600'
      });
      return res.end();
    }
    if (url.pathname === '/healthz') {
      return send(res, 200, { ok: true, version: VERSION, accounts: cfg.accounts.length, keys: keys.all().length, uptimeMs: Date.now() - startedAt });
    }

    if (url.pathname.startsWith('/admin/')) return await handleAdmin(req, res, url);

    if (!isApi) return serveStatic(res, url);

    auth = keys.authorize(bearer(req));

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      // accounts 是号池拓扑（哪些号服务这个模型），只给管理端看；带上它等于把定向打某个号的入口地址发给调用方
      const data = pool.modelIndex().filter(m => keys.allowsModel(auth.record, m.id))
        .map(m => { const { accounts, ...rest } = m; return rest; });
      keys.record(auth.record, { ok: true, model: 'models', account: '-', status: 200, ms: 0 });
      scheduleSave();
      return send(res, 200, { object: 'list', data });
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/completions')) {
      const body = await readJson(req);
      if (!body.model) throw Object.assign(new Error('缺少 model'), { statusCode: 400 });
      keys.requireModel(auth.record, body.model);
      const openaiBody = url.pathname.endsWith('/completions') && !body.messages
        ? { ...body, messages: [{ role: 'user', content: String(body.prompt ?? '') }] } : body;
      return await handleChatCompletion(req, res, openaiBody, body.model, 'openai', auth);
    }
    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      const body = await readJson(req);
      if (!body.model) throw Object.assign(new Error('缺少 model'), { statusCode: 400 });
      keys.requireModel(auth.record, body.model);
      const openaiBody = responsesToChat(body);
      const meta = { id: newResponseId(), created_at: Math.floor(Date.now() / 1000) };
      return await handleChatCompletion(req, res, openaiBody, body.model, 'responses', auth, meta);
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const body = await readJson(req);
      keys.requireModel(auth.record, body.model);
      const openaiBody = anthropicToOpenAI(body);
      return await handleChatCompletion(req, res, openaiBody, body.model, 'anthropic', auth);
    }
    throw Object.assign(new Error(`未知端点 ${req.method} ${url.pathname}`), { statusCode: 404 });
  } catch (e) {
    const { status, payload } = errBody(e, isApi);
    if (!auth) keys.denied(e);
    else if (!auth.accounted) keys.recordDenied(auth.record, e);
    if (status >= 500) log('ERROR', e.message);
    if (!res.headersSent) send(res, status, payload, e.headers || {}); else res.end();
  }
});

// 之前两个都设成 0，等于在公网口上关掉了 slowloris 防护。requestTimeout 只约束
// "收完请求头/体"，不限制响应时长，所以取 upstream.timeoutMs + 10s：不误伤长回复，又留住护栏。
// 退出前把内存里的用量落盘：否则每次部署/重启都会丢掉最近一个合并周期内的计量与日配额。
// 还要把进行中的扫码会话带走：发版 kill 服务时若留着会话，无头 chromium 会被 init 收养，
// 在 1c1g 上白占 200MB+，且它持着的 tmpfs profile 目录此后删不掉（云服务器实测漏过 21 个进程）。
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { keys.snapshotForSave(); saveConfig(cfg); } catch (e) { log('退出前写配置失败:', e.message); }
    // 只给 3 秒：收尾很重要，但把服务卡死在退出路上更糟（systemd 会 SIGKILL）
    await Promise.race([logins.shutdown().catch(e => log('退出前回收扫码会话失败:', e.message)),
      new Promise(r => setTimeout(r, 3000))]);
    process.exit(0);
  });
}

server.headersTimeout = 60000;
server.requestTimeout = Number(cfg.upstream.timeoutMs || 120000) + 10000;
server.keepAliveTimeout = 30000;
server.listen(cfg.listen.port, cfg.listen.host, async () => {
  sweepStaleProfiles(log);     // 上次被 SIGKILL/OOM 带走时留下的无头浏览器残骸
  log(`qclaw-pool-proxy ${VERSION} 监听 http://${cfg.listen.host}:${cfg.listen.port}  配置: ${cfgFile}`);
  if (!(cfg.clientKeys || []).length) log('警告: 尚未签发任何客户端密钥，/v1/* 会一律返回 503（在 WebUI「密钥」页创建）');
  if (!(cfg.listen?.adminAllowFrom || []).length) log('提示: 管理端 /admin/* 未限制来源，公网部署建议配 listen.adminAllowFrom');
  const r = await pool.refreshAll();
  for (const [id, v] of Object.entries(r)) log(`  账号 ${id}: ${v.ok ? `目录 ${v.models.length} 个模型` : '目录拉取失败 -> ' + v.error}`);
  // 上次若是被 SIGKILL/OOM 带走的，退出钩子没机会跑，无头浏览器与 tmpfs profile 会一直赖着
  sweepStaleProfiles(log);
  for (const a of cfg.accounts) {
    if (a.type !== 'openclaw-gateway') continue;
    const agents = new Set(Object.values(a.modelAgents || {}).map(v => v || 'main'));
    const declared = pool.runtime(a.id).catalog.length;
    if (declared > 1 && agents.size < 2) {
      log(`  ⚠ 账号 ${a.id}: 声明了 ${declared} 个模型，但 modelAgents 全部指向同一 agent (${[...agents][0] || a.defaultAgent || 'main'})。`);
      log(`     gateway 模式按 agent 路由，未经绑定的模型会落到同一个底层模型上。要让模型可区分，需在`);
      log(`     ~/.qclaw/openclaw.json 的 agents.list 里为每个 agent 显式设置 model.primary，再回填 modelAgents。`);
    }
  }
});
