// 管理面来源闸的回归测试。
//
// 这里要防的 specifically 是：X-Forwarded-For 由调用方控制，若拿它当"本机"依据，
// 一个 `-H 'X-Forwarded-For: 127.0.0.1'` 就能从公网绕过 adminAllowFrom ——
// 而闸后面站着的是整个号池的 sk- 与登录 JWT。
//
//   node scripts/admin-guard-test.mjs
//
// 需要本机有一个非回环 IP（有线/无线网卡任一），用它模拟"外部来源"。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ADMIN = 'guard-test-token';

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

const LAN = lanAddress();
if (!LAN) {
  console.log('SKIP  找不到非回环 IPv4，无法模拟外部来源（需要任一联网网卡）');
  process.exit(0);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '0.0.0.0', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** 起一个指定 adminAllowFrom / trustProxy 的实例，跑完就杀 */
async function withServer(listenExtra, fn) {
  const port = await freePort();
  const file = path.join(os.tmpdir(), `qpp-guard-${port}.json`);
  fs.writeFileSync(file, JSON.stringify({
    listen: { host: '0.0.0.0', port, ...listenExtra },
    adminToken: ADMIN, clientKeys: [], accounts: []
  }, null, 2));
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--config', file],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PROXY_ADMIN_TOKEN: ADMIN } });
  let stderr = '';
  p.stderr.on('data', d => { stderr += d; });
  const base = `http://${LAN}:${port}`;
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + '/healthz'); if (r.ok) break; } catch { /* 还没起来 */ }
      await new Promise(r => setTimeout(r, 250));
    }
    await fn(base);
  } finally {
    p.kill('SIGKILL');
    try { fs.unlinkSync(file); } catch { /* 已删 */ }
    if (stderr.trim()) console.log('  (子进程 stderr) ' + stderr.trim().split('\n').slice(-1)[0]);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const state = (base, headers = {}) =>
  fetch(base + '/admin/state', { headers: { authorization: 'Bearer ' + ADMIN, ...headers } });

await withServer({ adminAllowFrom: ['127.0.0.1'] }, async base => {
  const direct = await state(base);
  ok('白名单只给回环时，从外部来源访问管理面被拒', direct.status === 403, 'HTTP ' + direct.status);

  const spoofed = await state(base, { 'x-forwarded-for': '127.0.0.1' });
  ok('伪造 X-Forwarded-For: 127.0.0.1 绕不过去（C1 回归）', spoofed.status === 403, 'HTTP ' + spoofed.status);

  const spoofedChain = await state(base, { 'x-forwarded-for': '8.8.8.8, 127.0.0.1' });
  ok('XFF 链条里塞回环也绕不过去', spoofedChain.status === 403, 'HTTP ' + spoofedChain.status);

  const loop = await fetch(`http://127.0.0.1:${new URL(base).port}/admin/state`,
    { headers: { authorization: 'Bearer ' + ADMIN } });
  ok('本机 socket 仍放行（否则自己也管不了）', loop.status === 200, 'HTTP ' + loop.status);

  const badTok = await fetch(`http://127.0.0.1:${new URL(base).port}/admin/state`,
    { headers: { authorization: 'Bearer wrong' } });
  ok('来源放行不等于令牌放行（错令牌仍 401）', badTok.status === 401, 'HTTP ' + badTok.status);
});

await withServer({ adminAllowFrom: [LAN] }, async base => {
  const allowed = await state(base);
  ok('把外部来源写进白名单后确实可访问', allowed.status === 200, 'HTTP ' + allowed.status);
});

await withServer({ adminAllowFrom: ['127.0.0.1'], trustProxy: true }, async base => {
  // 明确信任反代时，取 XFF 的最后一跳：203.0.113.9 在链尾 → 仍不在白名单 → 拒
  const tail = await state(base, { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' });
  ok('trustProxy 时取链尾而非链首（首跳仍是客户端自填）', tail.status === 403, 'HTTP ' + tail.status);
});

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
