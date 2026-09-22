// 在运行 QClaw 的 Windows 机器上执行，导出一个号池账号记录。
//   node src/bootstrap.mjs [--host 192.168.1.20] [--port 33187] [--id 账号名] [--out config.json]
// --host/--port 决定号池服务器回访本机的地址（默认 127.0.0.1，仅供本机试用）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { AIZONE_BASE, busCreateApiKey, busModelList } from './qclaw-api.mjs';

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function masterKey() {
  const ls = readJson(path.join(APPDATA, 'QClaw', 'Local State'));
  if (!ls.os_crypt?.encrypted_key) throw new Error('Local State 里没有 os_crypt.encrypted_key');
  const raw = Buffer.from(ls.os_crypt.encrypted_key, 'base64');
  if (raw.slice(0, 5).toString() !== 'DPAPI') throw new Error('encrypted_key 缺少 DPAPI 前缀');
  const b64 = raw.slice(5).toString('base64');
  const ps = [
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${b64}')`,
    '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  const key = Buffer.from(out.replace(/\s+/g, ''), 'base64');
  if (key.length !== 32) throw new Error('DPAPI 主密钥长度异常: ' + key.length);
  return key;
}

function dec(key, cipherB64) {
  const buf = Buffer.from(cipherB64, 'base64');
  if (buf.slice(0, 3).toString('latin1') !== 'v10') throw new Error('密文不是 v10 格式');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.slice(3, 15));
  d.setAuthTag(buf.slice(-16));
  return Buffer.concat([d.update(buf.slice(15, -16)), d.final()]).toString('utf8');
}

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const gwPath = path.join(HOME, '.qclaw', 'openclaw.json');
if (!fs.existsSync(gwPath)) throw new Error(`找不到 ${gwPath}；本机是否运行过 QClaw？`);
const gw = readJson(gwPath);
if (gw.gateway?.auth?.mode !== 'token') console.error('提示: gateway.auth.mode 不是 token，记录可能不完整');

const port = Number(arg('port', gw.gateway?.port ?? 33187));
const host = arg('host', '127.0.0.1');
const id = arg('id', 'qclaw-' + os.hostname());

let jwtClaims = null;

const base = `http://${host}:${port}/`;

// 模型目录不在网关端口上，而在 QClaw 自有代理端口（默认 19000）。逐个探测，取第一个
// 真能返回 JSON 目录的作为 catalogBase。
async function probeCatalog(token) {
  const candBases = [`http://127.0.0.1:19000/`, `http://${host}:19000/`, base];
  for (const cb of [...new Set(candBases)]) {
    try {
      const r = await fetch(new URL('proxy/llm/models', cb), {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { continue; }
      if (Array.isArray(j?.data) && j.data.length) return { catalogBase: cb, models: j.data };
    } catch { /* 端口未开，换下一个 */ }
  }
  return null;
}

const probe = await probeCatalog(gw.gateway?.auth?.token);
const account = {
  id,
  type: 'openclaw-gateway',
  base,
  catalogBase: probe?.catalogBase ?? base,
  token: gw.gateway?.auth?.token,
  defaultAgent: 'main',
  modelAgents: {},
  weight: 100
};

if (probe) {
  console.error(`模型目录确认 OK: ${probe.models.length} 个 @ ${probe.catalogBase} -> ${probe.models.map(m => 'qclaw/' + m.id).join(', ')}`);
} else {
  console.error(`\n未能从本机的 19000 / ${port} 拉到模型目录。`);
  console.error('请确认 QClaw 正在运行；号池服务器若需回访本机，请用 --host 指定可达地址。');
}

let busAuth = null;
try {
  const store = readJson(path.join(APPDATA, 'QClaw', 'app-store.json'));
  const k = masterKey();
  account.llmApiKey = dec(k, store['authGateway.providers.qclaw.apiKey'].cipherText);
  const jwt = dec(k, store['secure.jwtToken'].cipherText);
  jwtClaims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
  account.note = `user_id=${jwtClaims.user_id} auth_type=${jwtClaims.auth_type} exp=${new Date(jwtClaims.exp * 1000).toISOString()}`;
  busAuth = { guid: jwtClaims.guid, account: jwtClaims.user_id, jwt };
} catch (e) {
  console.error('凭据解密失败（不影响 gateway 模式）:', e.message);
}

for (const m of probe?.models ?? []) {
  if (m.id !== 'modelroute') account.modelAgents['qclaw/' + m.id] = account.defaultAgent;
}

const accounts = [account];

// 免签直连形态：只需要登录 JWT + 该账号的 sk-，服务器侧完全不需要 QClaw。
// sk- 由总线 4055 按账号签发（幂等，同一账号每次返回同一把）。
if (busAuth) {
  try {
    const [{ key }, models] = await Promise.all([busCreateApiKey(busAuth), busModelList(busAuth)]);
    accounts.push({
      id: `${id}-cloud`,
      type: 'qclaw-aizone',
      base: AIZONE_BASE,
      apiKey: key,
      jwt: busAuth.jwt,
      guid: busAuth.guid,
      account: busAuth.account,
      models: models.map(m => m.id),
      weight: 100,
      note: account.note
    });
    console.error(`\n免签直连账号 ${id}-cloud 就绪：sk-…${key.slice(-6)}，${models.length} 个模型`);
  } catch (e) {
    console.error('\n未能建立免签直连账号（总线不可达？）:', e.message);
  }
}

const outFile = arg('out', null);
const pushTo = arg('push', null);
const pushToken = arg('admin-token', null) || process.env.PROXY_ADMIN_TOKEN || '';

// 把账号直接推进远端号池：多机加号不必再手改 config.json
if (pushTo) {
  if (!pushToken) console.error('⚠ 未提供 --admin-token / PROXY_ADMIN_TOKEN，推送会被拒绝（401）');
  const base = pushTo.endsWith('/') ? pushTo : pushTo + '/';
  for (const acc of accounts) {
    // 指向 127.0.0.1 的 gateway 账号推给远端服务器没有意义（那是本机的端口），
    // 推过去只会在对端反复连失败、白白进冷却。注意要带端口匹配。
    if (acc.type === 'openclaw-gateway' && /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?\//.test(acc.base || '')) {
      console.error(`跳过 ${acc.id}：openclaw-gateway 指向本机回环地址，远端用不上（直连账号会照常推送）`);
      continue;
    }
    try {
      const r = await fetch(new URL('admin/accounts/upsert', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${pushToken}` },
        body: JSON.stringify(acc),
        signal: AbortSignal.timeout(30000)
      });
      const t = await r.text();
      if (r.ok) console.error(`已推送到 ${base} → ${acc.id} (${acc.type})`);
      else { console.error(`推送失败 ${acc.id}: HTTP ${r.status} ${t.slice(0, 160)}`); process.exitCode = 1; }
    } catch (e) { console.error(`推送异常 ${acc.id}: ${e.message}`); process.exitCode = 1; }
  }
}

if (outFile) {
  const p = path.resolve(outFile);
  const isNew = !fs.existsSync(p);
  const cfg = isNew ? { listen: { host: '0.0.0.0', port: 8787 }, accounts: [] } : readJson(p);
  cfg.accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  for (const acc of accounts) {
    const i = cfg.accounts.findIndex(a => a.id === acc.id);
    if (i >= 0) cfg.accounts[i] = acc; else cfg.accounts.push(acc);
  }
  const generated = {};
  if (isNew) {
    generated.PROXY_ADMIN_TOKEN = 'admin-' + crypto.randomBytes(16).toString('hex');
    const clientKey = 'vk-' + crypto.randomBytes(16).toString('hex');
    cfg.adminToken = '${env:PROXY_ADMIN_TOKEN}';
    cfg.clientKeys = [{ key: clientKey, name: id }];
    generated['客户端密钥'] = clientKey;
  }
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* Windows 上无意义 */ }
  console.error(`\n已写入 ${p}（账号数 ${cfg.accounts.length}）`);
  for (const [k, v] of Object.entries(generated)) console.error(`  ${k} = ${v}   ← 只打印这一次，请保存`);
} else if (!pushTo) {
  console.log('\n把下面这段贴进 config.json 的 accounts[] 里：\n');
  console.log(JSON.stringify(accounts, null, 2));
}
if (jwtClaims?.exp) {
  const days = (jwtClaims.exp * 1000 - Date.now()) / 86400000;
  console.error(`\nJWT 剩余有效期: ${days.toFixed(1)} 天`);
  if (days < 7) console.error('⚠ 临期，注意重新登录续期');
}
