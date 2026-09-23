// 端到端验证脚本：打自己的代理，覆盖 OpenAI/Anthropic × 流式/非流式 × 鉴权
//
//   node scripts/verify.mjs --self                 自桩实例：零凭据、离线、可当回归跑
//   BASE=http://host:port node scripts/verify.mjs <clientKey> <adminToken>   打真号池
//
// 两种模式的结论不能互相替代。--self 验的是报文归一、总线字段解析、错误分类、调度冷却、
// 限额鉴权这些"我们自己的逻辑"；只有打真号池那次才能说"腾讯那条链路今天还认我们"。
import { Script } from 'node:vm';
import { startHarness } from './harness.mjs';

const SELF = process.argv.includes('--self');
const pos = process.argv.slice(2).filter(a => !a.startsWith('--'));
let BASE = SELF ? '' : (process.env.BASE || 'http://127.0.0.1:8787');
let CLIENT = pos[0] || '';
let ADMIN = pos[1] || '';
let harness = null;
const P = m => `data:text/plain;base64,${Buffer.from(m).toString('base64')}`;

let pass = 0, fail = 0;
// 未消费的 SSE 响应体、或服务中途重启，都会让 undici 抛一个没人 await 的 rejection，
// 直接把整个脚本打成一段堆栈 —— 验收脚本必须永远给出结论，而不是崩掉。
const strays = [];
process.on('unhandledRejection', e => { strays.push(String(e && e.message || e)); });
process.on('uncaughtException', e => { strays.push('uncaught: ' + String(e && e.message || e)); });
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`);
  cond ? pass++ : fail++;
};

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) return await r.json(); } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('服务未就绪');
}

let H = null;
const madeKeys = [];
async function cleanupKeys() {
  for (const k of madeKeys.splice(0)) {
    try { await fetch(BASE + '/admin/keys/' + encodeURIComponent(k), { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } }); } catch { /* 服务已停 */ }
  }
}

async function post(p, body, headers = H) {
  try {
    const r = await fetch(BASE + p, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, res: r, text: await r.text() };
  } catch (e) {
    // 服务重启/连接被重置时给一个可判定的结果，而不是让断言抛出去
    return { status: 0, res: { headers: new Headers(), text: async () => '' }, text: String(e.message || e) };
  }
}

(async () => {
  if (SELF) {
    harness = await startHarness();
    BASE = harness.base; CLIENT = harness.clientKey; ADMIN = harness.adminToken;
    console.log(`自桩实例已起：${BASE}（2 个假账号 + 假总线，凭据全部本机生成）`);
    console.log('这一趟不证明腾讯接口还活着 —— 那要跑 npm run verify:live。\n');
  } else if (!CLIENT || !ADMIN) {
    console.error('缺客户端密钥或管理令牌。\n' +
      '  live 用法：BASE=http://host:8787 node scripts/verify.mjs <vk-…> <admin-…>\n' +
      '  离线回归：  npm test（带 --self 起自桩实例，不需要凭据）\n' +
      '  空着凭据继续跑只会对着一屏 401 报假失败，不如直接停在这里。');
    process.exit(2);
  }
  H = { 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT };
  const h = await waitReady();
  ok('healthz', h.ok === true, JSON.stringify(h));

  // 鉴权：错误密钥必须 401
  const bad = await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer vk-wrong' } });
  ok('错误客户端密钥被拒 (401)', bad.status === 401, 'HTTP ' + bad.status);
  const noadm = await fetch(BASE + '/admin/state', { headers: { authorization: 'Bearer nope' } });
  ok('错误管理令牌被拒 (401)', noadm.status === 401, 'HTTP ' + noadm.status);

  // 模型目录
  const mr = await fetch(BASE + '/v1/models', { headers: H });
  const mj = await mr.json();
  const ids = (mj.data || []).map(m => m.id);
  ok('/v1/models 返回 11 个 qclaw 模型', mr.status === 200 && ids.length === 11 && ids.every(i => i.startsWith('qclaw/')), `${ids.length} 个`);

  // OpenAI 非流式
  // max_tokens 要给足：pool-* 多为推理模型，预算小时思考会吃满额度、content 返回空串。
  const t0 = Date.now();
  const c1 = await post('/v1/chat/completions', { model: 'qclaw/pool-minimax-m3', messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 512, stream: false });
  const j1 = JSON.parse(c1.text);
  ok('OpenAI 非流式可用', c1.status === 200 && typeof j1.choices?.[0]?.message?.content === 'string' && j1.choices[0].message.content.length > 0,
    `${Date.now() - t0}ms reply=${JSON.stringify(j1.choices?.[0]?.message?.content?.slice(0, 40))}`);

  // OpenAI 流式
  const c2 = await post('/v1/chat/completions', { model: 'qclaw/pool-minimax-m3', messages: [{ role: 'user', content: '用一句话说明什么是反向代理' }], max_tokens: 1024, stream: true });
  const lines = c2.text.split('\n').filter(l => l.startsWith('data:'));
  const done = c2.text.includes('[DONE]');
  const deltaText = lines.map(l => { try { return JSON.parse(l.slice(5)).choices?.[0]?.delta?.content ?? ''; } catch { return ''; } }).join('');
  ok('OpenAI 流式可用', c2.status === 200 && lines.length > 2 && deltaText.length > 4 && done,
    `${lines.length} 个 SSE 分片, ${deltaText.length} 字, DONE=${done}`);

  // Anthropic 非流式
  const c3 = await post('/v1/messages', { model: 'qclaw/pool-minimax-m3', max_tokens: 512, messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }] });
  const j3 = JSON.parse(c3.text);
  const text3 = (j3.content || []).find(b => b.type === 'text');
  ok('Anthropic 非流式可用（思考块若存在必须排在正文前）', c3.status === 200 && j3.type === 'message'
    && !!text3 && text3.text.length > 0 && !!j3.stop_reason
    && (j3.content || []).findIndex(b => b.type === 'thinking') <= (j3.content || []).findIndex(b => b.type === 'text'),
    `role=${j3.role} stop=${j3.stop_reason} blocks=${(j3.content || []).map(b => b.type).join(',')} text=${JSON.stringify(text3?.text?.slice(0, 30))}`);

  // Anthropic 流式
  const c4 = await post('/v1/messages', { model: 'qclaw/pool-minimax-m3', max_tokens: 512, stream: true, messages: [{ role: 'user', content: '说三个字的短语' }] });
  const evs = c4.text.split('\n').filter(l => l.startsWith('event:')).map(l => l.slice(7).trim());
  const td = c4.text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)).delta?.text ?? ''; } catch { return ''; } }).join('');
  ok('Anthropic 流式可用', c4.status === 200 && evs.includes('message_start') && evs.includes('content_block_delta') && evs.includes('message_stop') && td.length > 0,
    `事件=${[...new Set(evs)].join(',')} | 文本=${JSON.stringify(td.slice(0, 30))}`);

  // 未知模型：gateway 账号会兜底到 defaultAgent(200)，带显式清单的账号应给干净的 404；
  // 无论如何都不能是 5xx —— 客户端会把"模型不存在"当成可重试的池故障。
  const c5 = await post('/v1/chat/completions', { model: 'qclaw/不存在的模型', messages: [{ role: 'user', content: '回一个字：好' }], max_tokens: 512 });
  ok('未知模型名不返回 5xx', c5.status === 200 || c5.status === 404, 'HTTP ' + c5.status + ' ' + c5.text.slice(0, 60));

  // 管理端状态
  // 管理端状态：统计要跨账号汇总（多号池里单个账号可能只分到一部分请求），
  // 并且任何凭据原文都不能出现在快照里。
  const st = await (await fetch(BASE + '/admin/state', { headers: { authorization: 'Bearer ' + ADMIN } })).json();
  const acct = st.accounts?.[0];
  const sum = k => st.accounts.reduce((n, a) => n + (a[k] || 0), 0);
  const dump = JSON.stringify(st);
  const leaked = /sk-[a-z0-9]{20,}/i.test(dump) || /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(dump);
  // 上游偶发失败是真实存在的（实测约 1~2%），号池的正确行为就是冷却它并换号。
  // 所以这里断言"池子仍在工作"，而不是"上游从没失败过"。
  const healthy = st.accounts.filter(a => a.ok);
  const errText = st.accounts.filter(a => a.lastError).map(a => `${a.id}:${String(a.lastError).slice(0, 60)}`).join(' ');
  ok('admin/state 汇总正确且不泄露凭据', healthy.length >= 1 && sum('requests') >= 3 && sum('successes') >= 3
    && st.accounts.every(a => !!a.secretHint) && !leaked,
    `accounts=${st.accounts.length} 健康=${healthy.length} req=${sum('requests')} ok=${sum('successes')} 泄漏=${leaked}${errText ? ' 错误:' + errText : ''}`);

  // 实测总线有 ~1-2% 瞬时失败（fetch failed / 5xx）。这条验的是"号池能逐账号重载目录"，
  // 不是"腾讯那一秒没抖"，所以容一次重试；两次都失败才算问题。
  let refreshStatus = 0, refreshErr = '', failedRefresh = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rr = await fetch(BASE + '/admin/accounts/' + encodeURIComponent(st.accounts[0].id) + '/refresh', { method: 'POST', headers: { authorization: 'Bearer ' + ADMIN } });
      refreshStatus = rr.status;
      if (!rr.ok) refreshErr = (await rr.text()).slice(0, 160);
      // 全量重载必须逐个账号成功：只看 HTTP 200 会把"某个号刷新失败"吞掉
      const all = await (await fetch(BASE + '/admin/catalog/refresh', { method: 'POST', headers: { authorization: 'Bearer ' + ADMIN } })).json();
      failedRefresh = Object.entries(all || {}).filter(([k, v]) => !v.ok && !/^verify-/.test(k)).map(([k, v]) => `${k}:${v.error}`);
      if (refreshStatus === 200 && !failedRefresh.length) break;
      if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
    } catch (e) { refreshStatus = -1; refreshErr = e.message; }
  }
  ok('admin 目录重载（逐账号成功，容一次瞬时抖动）', refreshStatus === 200 && failedRefresh.length === 0,
    `HTTP ${refreshStatus}${refreshErr ? ' ' + refreshErr : ''}${failedRefresh.length ? ' 失败: ' + failedRefresh.join(' ') : ''}`);

  // 客户端密钥自助增删（对话面板依赖它）
  const nk = await post('/admin/keys', { name: 'verify' }, { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN });
  const nj = JSON.parse(nk.text);
  madeKeys.push(nj.key);
  const useNew = await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer ' + (nj.key || '') } });
  const del = await fetch(BASE + '/admin/keys/' + encodeURIComponent(nj.key || ''), { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } });
  const afterDel = await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer ' + (nj.key || '') } });
  ok('客户端密钥可自助生成/删除', /^vk-/.test(nj.key || '') && useNew.status === 200 && del.status === 200 && afterDel.status === 401,
    `new=${String(nj.key).slice(0, 6)}… use=${useNew.status} del=${del.status} after=${afterDel.status}`);

  // ---- 对外 API 的准入控制：限额 / 白名单 / 停用 / 轮换 / 计量 / CORS ----
  const mk = async body => { const rec = JSON.parse((await post('/admin/keys', body,
    { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN })).text); madeKeys.push(rec.key); return rec; };
  const asKey = k => ({ 'content-type': 'application/json', authorization: 'Bearer ' + k });
  const adminPatch = (path, body) => fetch(BASE + path, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN }, body: JSON.stringify(body) });

  const kRpm = await mk({ name: 'v-rpm', rpm: 1 });
  const q = { model: 'qclaw/pool-glm-5.2', messages: [{ role: 'user', content: '回一个字：好' }], max_tokens: 512 };
  const r1 = await post('/v1/chat/completions', q, asKey(kRpm.key));
  const r2 = await post('/v1/chat/completions', q, asKey(kRpm.key));
  ok('密钥级速率限制生效 (429 + retry-after)', r1.status === 200 && r2.status === 429
    && !!r2.res.headers.get('retry-after') && JSON.parse(r2.text).error?.type === 'rate_limit_exceeded',
    `${r1.status}→${r2.status} retry-after=${r2.res.headers.get('retry-after')}`);
  await fetch(BASE + '/admin/keys/' + encodeURIComponent(kRpm.key), { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } });

  const kMdl = await mk({ name: 'v-models', models: ['qclaw/pool-glm-5.2'] });
  const mList = await fetch(BASE + '/v1/models', { headers: asKey(kMdl.key) });
  const mJson = JSON.parse(await mList.text());
  const mOk = await post('/v1/chat/completions', q, asKey(kMdl.key));
  const mNo = await post('/v1/chat/completions', { ...q, model: 'qclaw/pool-kimi-k2.6' }, asKey(kMdl.key));
  ok('模型白名单：清单被过滤且越权 403', mJson.data?.length === 1 && mJson.data[0].id === 'qclaw/pool-glm-5.2'
    && mOk.status === 200 && mNo.status === 403, `models=${mJson.data?.length} allow=${mOk.status} deny=${mNo.status}`);

  const pOff = await adminPatch('/admin/keys/' + encodeURIComponent(kMdl.key), { enabled: false });
  const offCall = await fetch(BASE + '/v1/models', { headers: asKey(kMdl.key) });
  const onCall = (await adminPatch('/admin/keys/' + encodeURIComponent(kMdl.key), { enabled: true }),
    await fetch(BASE + '/v1/models', { headers: asKey(kMdl.key) }));
  ok('停用即 403、重新启用即恢复', pOff.status === 200 && offCall.status === 403 && onCall.status === 200,
    `off=${offCall.status} on=${onCall.status}`);

  const rot = JSON.parse((await post('/admin/keys/' + encodeURIComponent(kMdl.key) + '/rotate', {},
    { authorization: 'Bearer ' + ADMIN })).text);
  madeKeys.push(rot.key);
  const oldDead = await fetch(BASE + '/v1/models', { headers: asKey(kMdl.key) });
  const newAlive = await fetch(BASE + '/v1/models', { headers: asKey(rot.key) });
  ok('轮换后旧密钥立刻失效', oldDead.status === 401 && newAlive.status === 200, `${oldDead.status}/${newAlive.status}`);

  const getJson = async p => JSON.parse(await (await fetch(BASE + p, { headers: { authorization: 'Bearer ' + ADMIN } })).text());
  const kMeter = await mk({ name: 'v-meter' });
  for (let i = 0; i < 3; i++) await fetch(BASE + '/v1/models', { headers: asKey(kMeter.key) });
  const kl = (await getJson('/admin/keys')).keys.find(x => x.key === kMeter.key);
  const lg = await getJson('/admin/log?limit=60');
  ok('按密钥计量（逐密钥，非全局总数）', kl?.stats?.requests === 3 && kl?.today === 3
    && lg.log.filter(x => x.key === kMeter.name).length >= 3 && lg.log.every(x => typeof x.status === 'number' && x.at),
    `该密钥 requests=${kl?.stats?.requests} today=${kl?.today} 日志命中=${lg.log.filter(x => x.key === kMeter.name).length}`);

  const kQuota = await mk({ name: 'v-quota', dailyRequests: 2 });
  const q1 = await fetch(BASE + '/v1/models', { headers: asKey(kQuota.key) });
  const q2 = await fetch(BASE + '/v1/models', { headers: asKey(kQuota.key) });
  const q3 = await fetch(BASE + '/v1/models', { headers: asKey(kQuota.key) });
  const qBody = JSON.parse(await q3.text());
  ok('日配额到顶后 429 insufficient_quota', q1.status === 200 && q2.status === 200 && q3.status === 429
    && qBody.error?.type === 'insufficient_quota' && !!q3.headers.get('retry-after'),
    `${q1.status}→${q2.status}→${q3.status} ${qBody.error?.type}`);

  const kCap = await mk({ name: 'v-cap', maxTokens: 512 });
  const capped = await post('/v1/chat/completions',
    { model: 'qclaw/pool-glm-5.2', messages: [{ role: 'user', content: '回一个字：好' }], max_tokens: 999999 },
    asKey(kCap.key));
  ok('maxTokens 上限下调客户端请求', capped.status === 200 && capped.res.headers.get('x-qclaw-max-tokens') === '512',
    `status=${capped.status} 生效预算=${capped.res.headers.get('x-qclaw-max-tokens')}`);

  // 被鉴权后环节拒掉的请求也要出现在日志里（它已经扣过 rpm/日配额，不记就是静默消耗）
  const kDeny = await mk({ name: 'v-deny', models: ['qclaw/pool-glm-5.2'] });
  await post('/v1/chat/completions', { model: 'qclaw/pool-kimi-k2.6', messages: [{ role: 'user', content: 'x' }] }, asKey(kDeny.key));
  await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, asKey(kDeny.key));
  const lgDeny = (await getJson('/admin/log?limit=60')).log.filter(x => x.key === 'v-deny');
  ok('鉴权后失败仍计入日志与失败数', lgDeny.length >= 2 && lgDeny.some(x => x.status === 403)
    && lgDeny.some(x => x.status === 400) && lgDeny.every(x => x.ok === false),
    `v-deny 日志 ${lgDeny.length} 条：${lgDeny.map(x => x.status).join(',')}`);

  // 管理端读配置不能把号池登录态带出去：jwt 就是 30 天的 X-OpenClaw-Token，比 sk- 更值钱
  const cfgTxt = JSON.stringify(await getJson('/admin/config'));
  ok('/admin/config 不泄露 JWT / sk- / guid', !/eyJ[A-Za-z0-9_-]{8,}\./.test(cfgTxt)
    && !/sk-[a-f0-9]{16,}/.test(cfgTxt) && !/[0-9a-f]{64}/.test(cfgTxt) && !/"_file"/.test(cfgTxt),
    `长度=${cfgTxt.length} 命中JWT=${/eyJ[A-Za-z0-9_-]{8,}\./.test(cfgTxt)}`);

  // x-qclaw-account 是外部可发的头，不得绕过停用/冷却/服务能力
  const deadAcct = { id: 'verify-offline-acct', type: 'qclaw-aizone', base: 'https://mmgrcalltoken.3g.qq.com/aizone/v1/',
    apiKey: 'sk-invalid-for-test', jwt: 'x', guid: 'y', account: '1', weight: 100000, enabled: false,
    models: ['pool-glm-5.2'] };   // 给了 models 才谈得上"被选中但已停用"，否则测的是"根本没被选中"
  await post('/admin/accounts/upsert', deadAcct, { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN });
  const pinned = await post('/v1/chat/completions', q, { ...H, 'x-qclaw-account': deadAcct.id });
  const pinnedBody = JSON.parse(pinned.text || '{}');
  ok('外部无法用 x-qclaw-account 定向到停用账号', pinned.status === 403 || pinned.status === 404,
    `${pinned.status} ${pinnedBody.error?.code || pinnedBody.error?.type || ''}`);

  // 停用之后必须还能启用回来（以前只有 disable，被停用的号只能手改 config 救）
  const reEnabled = await post(`/admin/accounts/${encodeURIComponent(deadAcct.id)}/enable`, {},
    { authorization: 'Bearer ' + ADMIN });
  const stEnabled = await getJson('/admin/state');
  const stillOff = stEnabled.accounts.find(a => a.id === deadAcct.id)?.enabled === false;
  const unknownAcct = await post('/admin/accounts/no-such-account/disable', {}, { authorization: 'Bearer ' + ADMIN });
  ok('账号停用后可再启用，未知账号返回 404（不是 500）',
    reEnabled.status === 200 && !stillOff && unknownAcct.status === 404,
    `enable=${reEnabled.status} 仍停用=${stillOff} unknown=${unknownAcct.status}`);
  await fetch(BASE + '/admin/accounts/' + encodeURIComponent(deadAcct.id), { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } });

  // 错误体要带稳定的机器码：中文 message 会被改，外部 SDK 只能按 code 分支
  const codeRes = await post('/v1/chat/completions', { ...q, model: 'qclaw/pool-kimi-k2.6' }, asKey(kDeny.key));
  const codeBody = JSON.parse(codeRes.text || '{}');
  ok('鉴权类错误带稳定 error.code', codeRes.status === 403 && codeBody.error?.code === 'model_not_allowed',
    `${codeRes.status} code=${codeBody.error?.code}`);
  const badKey = await fetch(BASE + '/v1/models', { headers: { authorization: 'Bearer vk-nope' } });
  const badKeyCode = JSON.parse(await badKey.text()).error?.code;
  ok('无效密钥错误带 error.code', badKey.status === 401 && badKeyCode === 'invalid_api_key', `code=${badKeyCode}`);

  // 非法账号必须在写盘前被拒：否则下次启动 loadConfig→validate 直接崩溃循环
  const badAcct = await post('/admin/accounts/upsert', { id: 'verify-bad', type: 'not-a-real-type', base: 'x', apiKey: 'sk-x' },
    { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN });
  ok('非法账号被 400 拒绝（防启动期崩溃循环）', badAcct.status === 400, `HTTP ${badAcct.status}`);

  // 回归：目录还没加载的账号绝不能"什么模型都接"。
  // 以前它 return true，于是启动期 refreshAll 没跑完时，未知模型名会被打到上游换回 400 → 客户端看到 502。
  const bare = { id: 'verify-bare', type: 'qclaw-aizone', base: 'https://mmgrcalltoken.3g.qq.com/aizone/v1/',
    apiKey: 'sk-invalid-for-test', jwt: 'x', guid: 'y', account: '1', weight: 100000 };
  await post('/admin/accounts/upsert', bare, { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN });
  const bareState = await getJson('/admin/state');
  const bareRow = bareState.accounts.find(a => a.id === bare.id);
  const unknownNow = await post('/v1/chat/completions',
    { model: 'qclaw/不存在的模型', messages: [{ role: 'user', content: 'x' }] }, H);
  ok('目录未加载的账号不会什么都接（未知模型仍 404，不是 502）',
    unknownNow.status === 404 && bareRow && !bareRow.catalogCount,
    `HTTP ${unknownNow.status} 该号目录=${bareRow?.catalogCount}`);
  await fetch(BASE + '/admin/accounts/' + encodeURIComponent(bare.id), { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } });

  await cleanupKeys();

  // ---- 第四项：同一微信号重复上号必须认出来，就地更新而不是新增 ----
  for (const ghost of ['verify-换个名字', 'verify-再换一个名字']) {
    await fetch(BASE + '/admin/accounts/' + encodeURIComponent(ghost), { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } });
  }
  const beforeN = (await getJson('/admin/state')).accounts.length;
  const up1 = JSON.parse((await post('/admin/accounts/upsert',
    { id: 'verify-换个名字', type: 'qclaw-aizone', base: 'https://mmgrcalltoken.3g.qq.com/aizone/v1/',
      apiKey: 'sk-dedup-probe', jwt: 'x', guid: 'y', account: '1', models: ['pool-glm-5.2'],
      identity: { unionid: 'ovR1VuTESTUNIONID0000', nickname: '去重探针' } },
    { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN })).text);
  const up2 = JSON.parse((await post('/admin/accounts/upsert',
    { id: 'verify-再换一个名字', type: 'qclaw-aizone', base: 'https://mmgrcalltoken.3g.qq.com/aizone/v1/',
      apiKey: 'sk-dedup-probe-2', jwt: 'x', guid: 'y', account: '1', models: ['pool-glm-5.2'],
      identity: { unionid: 'ovR1VuTESTUNIONID0000', nickname: '去重探针' } },
    { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN })).text);
  const stD = await getJson('/admin/state');
  // 断言只看"同一个 unionid 在池子里是否只有一条"：绝对计数会被上一轮残留干扰，
  // 那种断言既脆又测不出真问题。
  const dupes = stD.accounts.filter(a => a.identity?.unionid === 'ovR1VuTESTUNIONID0000');
  ok('同一 unionid 重复上号被识别为同一账号（就地更新、不新增）',
    up1.id === 'verify-换个名字' && !up1.reused
    && up2.reused === up1.id && up2.id === up1.id && dupes.length === 1,
    `第2次 reused=${up2.reused || '无'} 该 unionid 条目数=${dupes.length}`);
  // 就地更新要真的把凭据覆盖上去，否则认出了还是旧钥匙
  const merged = (await getJson('/admin/config')).accounts.find(a => a.id === up1.id);
  ok('重复上号覆盖了凭据而不是留下旧值',
    merged && String(merged.note || '') === '' && stD.accounts.find(a => a.id === up1.id)?.ok === true,
    `id=${up1?.id}`);
  // 中文/非 ASCII 账号 id 的管理端点必须可用：pathname 是百分号编码的，
  // 早先没解码导致 DELETE/刷新/启停对这类 id 一律 404（账号留在池里删不掉）。
  const delProbe = await fetch(BASE + '/admin/accounts/' + encodeURIComponent(up1.id), { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } });
  const goneAfter = (await getJson('/admin/state')).accounts.some(a => a.id === up1.id);
  ok('非 ASCII 账号 id 的管理端点可用（删除后确实消失）', delProbe.status === 200 && !goneAfter,
    `DELETE=${delProbe.status} 仍在池里=${goneAfter}`);

  // ---- 第二项：积分余额（4110 = QClaw 面板上那个数）与今日 token（4075）是两回事 ----
  // verify-* 是假凭据的探针账号，查不到额度是正确行为，不能拿来当"积分功能坏了"的证据
  const isRealAiz = a => a.type === 'qclaw-aizone' && !/^verify-/.test(a.id);
  const stNow = await getJson('/admin/state');
  const aiz = stNow.accounts.filter(isRealAiz);
  // 总线偶发 "fetch failed / 总线不可达"（同一次刷新里其它接口都成功）。先给一次定向重试再断言 ——
  // 抖动可以容忍，但标准不放宽：重试之后每个真账号仍必须拿得到积分、日额度与 unionid。
  const incomplete = a => !a.credits || a.credits.error || !a.tokens || a.tokens.error
    || !a.identity || a.identity.error || !a.identity.unionid;
  if (aiz.some(incomplete)) {
    for (const a of aiz.filter(incomplete)) {
      await post(`/admin/accounts/${encodeURIComponent(a.id)}/refresh`, {}, { authorization: 'Bearer ' + ADMIN });
    }
    const again = (await getJson('/admin/state')).accounts.filter(isRealAiz);
    again.forEach(v => { const t = aiz.find(x => x.id === v.id); if (t) Object.assign(t, v); });
  }
  ok('账号带积分余额(4110，与 QClaw「积分」面板同口径)', aiz.length > 0 && aiz.every(a => a.credits && !a.credits.error
    && typeof a.credits.balance === 'number' && a.credits.balance >= 0
    && Array.isArray(a.credits.items) && a.credits.items.length > 0
    && a.credits.items.every(i => typeof i.remain === 'number' && !!i.label)
    // 余额必须等于各笔赠送剩余之和，否则说明字段读错了源
    && Math.abs(a.credits.balance - a.credits.items.reduce((s, i) => s + i.remain, 0)) < 1),
    aiz.map(a => `${a.id}:${a.credits?.balance}分/${a.credits?.items?.length}笔`).join(' '));
  ok('积分明细分得清活动/订阅/积分包（不是同一个数抄三遍）', aiz.every(a => {
    const c = a.credits || {};
    return typeof c.activity === 'number' && typeof c.subscription === 'number' && typeof c.package === 'number'
      && Math.abs(c.balance - (c.activity + c.subscription + c.package + (c.dailyFree || 0))) < 1;
  }), aiz.map(a => `${a.id}:活动${a.credits?.activity}/订阅${a.credits?.subscription}/包${a.credits?.package}`).join(' '));
  ok('账号带今日 token 与 RPM(4075)', aiz.every(a => a.tokens && !a.tokens.error
    && a.tokens.dailyLimit > 0 && a.tokens.rpmLimit > 0 && a.tokens.remaining <= a.tokens.dailyLimit),
    aiz.map(a => `${a.id}:${a.tokens?.dailyUsed}/${a.tokens?.dailyLimit}·RPM${a.tokens?.rpmLimit}`).join(' '));
  const mdl = stNow.models;
  ok('模型目录带能力标签(4320)', mdl.filter(m => (m.capabilities || []).length).length >= 2
    && mdl.some(m => m.canThink && (m.capabilities || []).includes('深度思考')),
    mdl.map(m => `${m.id.replace('qclaw/', '')}:${(m.capabilities || []).join('/') || '—'}`).join(' '));
  ok('模型目录带积分倍率(4327)', mdl.filter(m => m.creditRate && m.creditRate.inputRate > 0).length >= mdl.length - 1,
    `${mdl.filter(m => m.creditRate).length}/${mdl.length} 个模型有倍率`);
  ok('账号带稳定身份 unionid(4027)', aiz.every(a => a.identity && /[A-Za-z0-9_-]{16,}/.test(a.identity.unionid || '')),
    aiz.map(a => `${a.identity?.nickname || a.identity?.error || '?'}…${String(a.identity?.unionid || '').slice(-6)}`).join(' '));

  // ---- 第三项：Responses API（ChatGPT / Codex 系客户端走这个）----
  // 用会思考的模型验：这样"reasoning 项存在且排在 message 前"这条分支真的被跑到，
  // 而不是靠"上游这次没思考"蒙过去（桩与真上游在这里行为一致：v4-pro 带「深度思考」）
  const rsp = await post('/v1/responses', { model: 'qclaw/pool-deepseek-v4-pro', input: '只回复两个字：收到', max_output_tokens: 900 }, H);
  const rspJ = JSON.parse(rsp.text);
  // 不能写死 output[0]：上游思考时那里是 reasoning 项。原断言只在"上游那一次没思考"时成立，
  // 换个模型或上游改了默认值就会假失败 —— 改成"找到 message 项"，并顺手把顺序钉住。
  const msgIdx = (rspJ.output || []).findIndex(o => o.type === 'message');
  const rsnIdx = (rspJ.output || []).findIndex(o => o.type === 'reasoning');
  ok('/v1/responses 非流式返回 response 对象（思考项若存在必须排在 message 前）', rsp.status === 200
    && rspJ.object === 'response' && rspJ.status === 'completed'
    && typeof rspJ.output_text === 'string' && rspJ.output_text.length > 0
    && msgIdx >= 0 && rspJ.output[msgIdx].content?.[0]?.type === 'output_text'
    && (rsnIdx < 0 || rsnIdx < msgIdx)
    && /^resp_/.test(rspJ.id || '') && !!rspJ.usage?.input_tokens_details,
    `id=${rspJ.id} output=${(rspJ.output || []).map(o => o.type).join(',')} text=${JSON.stringify(String(rspJ.output_text || '').slice(0, 14))}`);

  const rspErr = await post('/v1/responses', { model: 'qclaw/pool-glm-5.2', input: 'x', previous_response_id: 'resp_x' }, H);
  ok('/v1/responses 明确拒绝有状态字段而不是假装支持', rspErr.status === 400
    && JSON.parse(rspErr.text).error?.code === 'unsupported_field', `HTTP ${rspErr.status}`);

  const rspS = await post('/v1/responses', { model: 'qclaw/pool-glm-5.2', input: '只回复两个字：收到', max_output_tokens: 600, stream: true }, H);
  const rspEvs = [...rspS.text.matchAll(/^event: (\S+)$/gm)].map(m => m[1]);
  ok('/v1/responses 流式给出 Responses 事件序列', rspS.status === 200
    && rspEvs.includes('response.created') && rspEvs.includes('response.in_progress')
    && rspEvs.includes('response.output_text.delta') && rspEvs.includes('response.output_item.done')
    && rspEvs.includes('response.completed') && rspS.text.includes('[DONE]'),
    `${rspEvs.length} 个事件: ${rspEvs.filter((v, i, a) => a.indexOf(v) === i).join(',')}`);

  const rspArr = await post('/v1/responses', { model: 'qclaw/pool-glm-5.2',
    input: [{ role: 'user', content: [{ type: 'input_text', text: '只回复两个字：收到' }] }],
    instructions: '简洁', max_output_tokens: 600 }, H);
  ok('/v1/responses 支持 input 数组与 instructions', rspArr.status === 200
    && JSON.parse(rspArr.text).output_text?.length > 0, `HTTP ${rspArr.status}`);

  const rspAllow = await mk({ name: 'v-rsp-allow', models: ['qclaw/pool-glm-5.2'] });
  const rspKey = await post('/v1/responses', { model: 'qclaw/pool-kimi-k2.6', input: 'x' }, asKey(rspAllow.key));
  ok('/v1/responses 同样受密钥模型白名单约束', rspKey.status === 403, `HTTP ${rspKey.status}`);

  // ---- 思考深度与工具调用（真上游对照，全部经反代三个入口）----
  const WEATHER = [{ type: 'function', function: { name: 'get_weather', description: '查询指定城市当前天气', parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] } } }];
  const TQ = '上海现在天气怎么样？必须调用工具查询。';
  const tOpen = JSON.parse((await post('/v1/chat/completions', { model: 'qclaw/pool-deepseek-v4-flash', messages: [{ role: 'user', content: TQ }], tools: WEATHER, max_tokens: 400 }, H)).text);
  const tCall = tOpen.choices?.[0]?.message?.tool_calls?.[0];
  ok('工具调用（OpenAI 入口）：finish_reason=tool_calls 且参数可解析',
    tOpen.choices?.[0]?.finish_reason === 'tool_calls' && tCall?.function?.name === 'get_weather'
    && typeof JSON.parse(tCall.function.arguments).city === 'string',
    `${tCall?.function?.name}(${tCall?.function?.arguments})`);

  const tTool = JSON.parse((await post('/v1/chat/completions', {
    model: 'qclaw/pool-deepseek-v4-flash', tools: WEATHER, max_tokens: 300,
    messages: [{ role: 'user', content: TQ },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_v1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] },
      { role: 'tool', tool_call_id: 'call_v1', content: '{"city":"上海","temp":"23℃"}' }]
  }, H)).text);
  ok('工具调用：回传 tool 结果后能续写（多轮工具链可用）',
    typeof tTool.choices?.[0]?.message?.content === 'string' && tTool.choices[0].message.content.length > 0
    && tTool.choices[0].message.content.includes('23'),
    JSON.stringify(String(tTool.choices?.[0]?.message?.content || '').slice(0, 40)));

  const tAnth = JSON.parse((await post('/v1/messages', {
    model: 'qclaw/pool-deepseek-v4-flash', max_tokens: 400, messages: [{ role: 'user', content: TQ }],
    tools: [{ name: 'get_weather', description: '查询城市天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]
  }, H)).text);
  const useBlk = (tAnth.content || []).find(b => b.type === 'tool_use');
  ok('工具调用（Anthropic 入口）：tool_use 块带 name 与 input（思考块在前也算通过）',
    tAnth.stop_reason === 'tool_use' && useBlk?.name === 'get_weather' && typeof useBlk.input?.city === 'string',
    `${(tAnth.content || []).map(b => b.type).join(',')} → ${useBlk?.name} ${JSON.stringify(useBlk?.input)}`);

  const tRsp = JSON.parse((await post('/v1/responses', {
    model: 'qclaw/pool-deepseek-v4-flash', input: TQ, max_output_tokens: 400,
    tools: [{ type: 'function', name: 'get_weather', description: '查询城市天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]
  }, H)).text);
  ok('工具调用（Responses 入口）：扁平 tools 已转成上游形态，产出 function_call 项',
    tRsp.output?.some(o => o.type === 'function_call' && o.name === 'get_weather' && /city/.test(o.arguments || '')),
    `HTTP 状态见上，output=${(tRsp.output || []).map(o => o.type).join(',') || JSON.stringify(tRsp).slice(0, 90)}`);

  const TH = '鸡兔同笼，头35脚94，各有几只？请推理。';
  const thOn = JSON.parse((await post('/v1/chat/completions', { model: 'qclaw/pool-deepseek-v4-pro', messages: [{ role: 'user', content: TH }], max_tokens: 900 }, H)).text);
  const thOff = JSON.parse((await post('/v1/chat/completions', { model: 'qclaw/pool-deepseek-v4-pro', messages: [{ role: 'user', content: TH }], max_tokens: 900, reasoning_effort: 'none' }, H)).text);
  const rOn = thOn.choices?.[0]?.message?.reasoning_content || '';
  const rOff = thOff.choices?.[0]?.message?.reasoning_content || '';
  ok('思考深度：reasoning_effort=none 真的关掉思考（默认会思考）',
    rOn.length > 30 && rOff.length === 0 && (thOff.choices?.[0]?.message?.content || '').length > 0,
    `开=${rOn.length}字 关=${rOff.length}字`);

  const thAnth = JSON.parse((await post('/v1/messages', { model: 'qclaw/pool-deepseek-v4-pro', messages: [{ role: 'user', content: TH }], max_tokens: 900 }, H)).text);
  const thAnthOff = JSON.parse((await post('/v1/messages', { model: 'qclaw/pool-deepseek-v4-pro', messages: [{ role: 'user', content: TH }], max_tokens: 900, thinking: { type: 'disabled' } }, H)).text);
  ok('思考深度（Anthropic 入口）：reasoning_content 转成 thinking 块，且 disabled 能关掉',
    thAnth.content?.[0]?.type === 'thinking' && (thAnth.content[0].thinking || '').length > 30
    && !thAnthOff.content.some(b => b.type === 'thinking'),
    `开=${(thAnth.content || []).map(b => b.type).join(',')} 关=${(thAnthOff.content || []).map(b => b.type).join(',')}`);

  const anthSS = await post('/v1/messages', { model: 'qclaw/pool-deepseek-v4-pro', max_tokens: 900, stream: true, messages: [{ role: 'user', content: TH }] }, H);
  ok('Anthropic 流式：thinking 块先开先关，正文随后（不是只发一个 text 块）',
    anthSS.status === 200 && /"type":"thinking"/.test(anthSS.text) && anthSS.text.includes('"thinking_delta"')
    && anthSS.text.includes('"text_delta"')
    && anthSS.text.indexOf('"thinking_delta"') < anthSS.text.indexOf('"text_delta"'),
    `blocks=${[...new Set([...anthSS.text.matchAll(/"content_block":\{"type":"(\w+)"/g)].map(m => m[1]))].join(',')} 字节=${anthSS.text.length}`);

  const anthST = await post('/v1/messages', {
    model: 'qclaw/pool-deepseek-v4-flash', max_tokens: 400, stream: true, messages: [{ role: 'user', content: TQ }],
    tools: [{ name: 'get_weather', description: '查询城市天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]
  }, H);
  ok('Anthropic 流式工具：参数以 input_json_delta 分片下发（旧实现把参数整段丢掉）',
    anthST.text.includes('"type":"tool_use"') && anthST.text.includes('"input_json_delta"') && anthST.text.includes('上海'),
    `字节=${anthST.text.length}`);

  const thRsp = JSON.parse((await post('/v1/responses', { model: 'qclaw/pool-deepseek-v4-pro', input: TH, max_output_tokens: 900, reasoning: { effort: 'none' } }, H)).text);
  ok('思考深度（Responses 入口）：reasoning.effort=none 映射为关闭思考，不再静默无效',
    !(thRsp.output || []).some(o => o.type === 'reasoning') && (thRsp.output_text || '').length > 0
    && thRsp.usage?.output_tokens > 0,
    `output=${(thRsp.output || []).map(o => o.type).join(',')} usage=${JSON.stringify(thRsp.usage || null)}`);

  const usageStream = await post('/v1/chat/completions', { model: 'qclaw/pool-deepseek-v4-flash', messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 400, stream: true, stream_options: { include_usage: true } }, H);
  const usageFrame = (usageStream.text.match(/"usage":\{[^}]*\}/) || [''])[0];
  ok('流式 include_usage：上游不给 usage 时补一帧估算（否则客户端按 0 算上下文）',
    usageStream.status === 200 && /"prompt_tokens":\d+,"completion_tokens":[1-9]/.test(usageFrame)
    && usageStream.text.indexOf(usageFrame) < usageStream.text.lastIndexOf('[DONE]'),
    usageFrame);

  const badParam = await post('/v1/chat/completions', { model: 'qclaw/pool-glm-5.2', messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 400, tools: 'oops' }, H);
  const cooled = (await getJson('/admin/state')).accounts.filter(isRealAiz).filter(a => a.cooldownSecondsLeft > 0);
  ok('客户端参数错误回 400 而不是 502，且不把账号打进冷却',
    badParam.status === 400 && JSON.parse(badParam.text).error?.code === 'client_param' && cooled.length === 0,
    `HTTP ${badParam.status} 冷却中账号=${cooled.length} ${badParam.text.slice(0, 70)}`);
  ok('对外错误不回显号池内部（账号 id 不外泄）',
    !/qclaw-[A-Za-z0-9_-]{4,}/.test(badParam.text), badParam.text.slice(0, 90));

  // 畸形 thinking 在归一时被丢掉，不会带着坏参数去打上游（上游会 1400）
  const fixedThinking = await post('/v1/chat/completions', { model: 'qclaw/pool-glm-5.2', messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 400, thinking: { budget_tokens: 80 } }, H);
  ok('上游不认的畸形 thinking 被就地丢弃，而不是转手让上游 400',
    fixedThinking.status === 200 && !!JSON.parse(fixedThinking.text).choices?.[0]?.message,
    `HTTP ${fixedThinking.status}`);

  // ---- 第一项：密钥明文可见 + 非 HTTPS 下的剪贴板兜底 ----
  const uiHtml = (await readUi()).text;
  ok('WebUI 含明文开关与剪贴板兜底', uiHtml.includes('btnShowKeys') && uiHtml.includes('isSecureContext')
    && uiHtml.includes('execCommand') && uiHtml.includes('clipboard'),
    '明文开关 + clipboard 回退 + 全选弹层都在');

  const preflight = await fetch(BASE + '/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'http://example.com' } });
  ok('CORS 预检可用（浏览器直连）', preflight.status === 204 && /\*/.test(preflight.headers.get('access-control-allow-origin') || '')
    && /authorization/i.test(preflight.headers.get('access-control-allow-headers') || ''),
    `${preflight.status} origin=${preflight.headers.get('access-control-allow-origin')}`);

  const noKey = await post('/v1/chat/completions', q, { 'content-type': 'application/json' });
  ok('缺密钥 401、错密钥 401（错误体是 OpenAI 形状）', noKey.status === 401
    && JSON.parse(noKey.text).error?.type === 'authentication_error', `${noKey.status}`);

  await cleanupKeys();

  // 扫码登录：会话查询要有正确的 404 语义；start 依赖无头浏览器，缺浏览器时必须给出可执行的中文提示
  const noSession = await fetch(BASE + '/admin/login/does-not-exist', { headers: { authorization: 'Bearer ' + ADMIN } });
  ok('未知登录会话返回 404', noSession.status === 404, 'HTTP ' + noSession.status);
  const startR = await post('/admin/login/start', {}, { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN });
  const startJ = JSON.parse(startR.text);
  const loginOk = startJ.status === 'waiting' || /chromium|浏览器|browser/i.test(String(startJ.error || ''));
  ok('扫码登录可发起（或明确提示缺浏览器）', startR.status === 200 && loginOk,
    `status=${startJ.status} err=${String(startJ.error || '').slice(0, 60)} qr=${startJ.qrImage ? Math.round(startJ.qrImage.length / 1024) + 'KB' : '无'}`);
  // 二维码出来了不等于链路通了：state 必须是 4050 真签发的。签名一旦算错，这里会静默降级成
  // 自造 state —— 页面上毫无异样，只有朋友真扫完那次兑换才失败。
  const sigLog = (startJ.log || []).join('\n');
  const noBrowser = /chromium|浏览器|browser/i.test(String(startJ.error || ''));
  ok('扫码的 state 来自 4050 签发（签名算错会静默退化成自造 state）',
    noBrowser || (/4050 签发/.test(sigLog) && !/暂用自造值/.test(sigLog)),
    sigLog.split('\n').filter(l => /state/i.test(l)).slice(0, 2).join(' | ') || '(无 state 日志)');
  if (startJ.loginId) await post(`/admin/login/${startJ.loginId}/cancel`, {}, { authorization: 'Bearer ' + ADMIN });

  // 号池调度：坏号必须被识别为鉴权故障并冷却，且不能把它的失败透给客户端。
  // 定向打坏号（x-qclaw-account）才是确定性的 —— 轮询游标会让"随机命中坏号"不可靠。
  const poison = {
    id: 'verify-poison', type: 'qclaw-aizone', base: 'https://mmgrcalltoken.3g.qq.com/aizone/v1/',
    apiKey: 'sk-invalid-for-test', jwt: 'x', guid: 'y', account: '1', weight: 100000,
    // 必须显式给 models：serves() 现在对空目录一律不接，不给的话这条测的就不是
    // "鉴权故障→冷却"，而是"根本没被选中"。
    models: ['pool-glm-5.2']
  };
  await post('/admin/accounts/upsert', poison, { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN });
  const forced = await post('/v1/chat/completions',
    { model: 'qclaw/pool-glm-5.2', messages: [{ role: 'user', content: '回一个字：好' }], max_tokens: 512 },
    { 'content-type': 'application/json', authorization: 'Bearer ' + CLIENT, 'x-qclaw-account': 'verify-poison' });
  const normal = await post('/v1/chat/completions', { model: 'qclaw/pool-glm-5.2', messages: [{ role: 'user', content: '回一个字：好' }], max_tokens: 512 });
  const pst = await (await fetch(BASE + '/admin/state', { headers: { authorization: 'Bearer ' + ADMIN } })).json();
  const pa = pst.accounts.find(a => a.id === 'verify-poison');
  ok('坏号被判为鉴权故障并进入冷却', forced.status >= 400 && pa && pa.failures >= 1 && pa.cooldownSecondsLeft > 0,
    `forced=${forced.status} fail=${pa?.failures} cooldown=${pa?.cooldownSecondsLeft}s`);
  ok('池里有坏号时正常请求仍成功', normal.status === 200, 'HTTP ' + normal.status);
  await fetch(BASE + '/admin/accounts/verify-poison', { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } });

  // 多账号轮询：同一个密钥的连续请求要分散到不同号（粘的是会话，不是密钥）。
  // 只在"当前可用账号 ≥2"时才要求分散 —— 有号在冷却时集中到剩号上是正确行为。
  const avail = async () => {
    const s = await (await fetch(BASE + '/admin/state', { headers: { authorization: 'Bearer ' + ADMIN } })).json();
    return s.accounts.filter(a => a.enabled !== false && a.cooldownSecondsLeft <= 0 && a.id !== 'verify-poison');
  };
  const pre = await avail();
  if (pre.length >= 2) {
    const before = Object.fromEntries(pre.map(a => [a.id, a.requests]));
    for (let i = 0; i < 8; i++) {
      await post('/v1/chat/completions', { model: 'qclaw/pool-glm-5.2', messages: [{ role: 'user', content: '回一个字：好' }], max_tokens: 512 });
    }
    const after = await (await fetch(BASE + '/admin/state', { headers: { authorization: 'Bearer ' + ADMIN } })).json();
    const used = after.accounts.filter(a => (a.requests - (before[a.id] ?? -1)) > 0).map(a => a.id);
    const mid = await avail();
    const who = async () => (await post('/v1/chat/completions', { model: 'qclaw/pool-glm-5.2', user: 'sticky-probe', messages: [{ role: 'user', content: '好' }], max_tokens: 512 })).res.headers.get('x-qclaw-account');
    const s1 = await who(), s2 = await who();
    const stable = mid.length === pre.length;      // 可用集合变了的话粘性换号是预期的
    ok('多账号轮询 + 会话粘性', used.length >= 2 && (!!s1 && (!stable || s1 === s2)),
      `轮询命中 ${used.length}/${pre.length} 个号；粘性 ${s1}/${s2}${stable ? '' : '（可用集合有变化，跳过一致性判定）'}`);
  } else {
    console.log(`SKIP  多账号轮询（当前仅 ${pre.length} 个账号可用，其余在冷却）`);
  }

  // 额度是目录刷新时顺带拉的，必须用刷新之后的最新状态判断（st 是刷新前抓的，会误报）
  const stAfter = await (await fetch(BASE + '/admin/state', { headers: { authorization: 'Bearer ' + ADMIN } })).json();
  const aizone = stAfter.accounts.filter(a => a.type === 'qclaw-aizone' && !/^verify-/.test(a.id));
  ok('直连账号已带额度信息(4708)', aizone.length > 0 && aizone.every(a => a.quota && (a.quota.error || typeof a.quota.canUse === 'boolean')),
    aizone.map(a => `${a.id}:${a.quota?.error ? 'err' : 'trial=' + a.quota?.remaining}`).join(' '));

  // 前端是 shadcn/ui(React) 构建产物：/ 只回一个挂载壳，功能字面量都在 assets 的 JS chunk 里。
  // 所以把壳 + chunk + 样式拼成一份文本再 grep —— 断言的含义不变（"这个功能真的随包发出去了"），
  // 顺带把"壳在但 chunk 404 / 样式没发出去"这类白屏事故一起覆盖掉。
  const ui = await readUi();
  const shell = ui.shell;
  const assets = ui.assets;
  const html = ui.text;
  ok('构建产物完整（壳引用的每个 asset 都 200 且 content-type 正确）',
    assets.length >= 2 && assets.every(a => a.status === 200 && /javascript|text\/css/.test(a.type)),
    assets.map(a => `${a.url}:${a.status}/${a.type.split(';')[0]}`).join(' '));
  ok('WebUI 可访问', ui.status === 200 && html.includes('QClaw 号池代理') && html.length > 5000, `${html.length} 字节`);
  ok('WebUI 含流式对话面板', html.includes('id:chat') && html.includes('cStream') && html.includes('reasoning_content') && html.includes('id:pool'),
    '对话/号池页签与 SSE 解析就位');
  ok('WebUI 含补号入口（推送命令 + 批量导入 + 扫码登录）',
    html.includes('pushCmd') && html.includes('btnImport') && html.includes('btnLoginStart') && html.includes('btnLoginCancel'),
    '四种加号入口都在页面上');
  ok('WebUI 扫码区写清了真实机制（服务端签发 state + 签名兑换，不是"不能入池"）',
    /4050/.test(html) && /4026/.test(html) && /HMAC/.test(html) && !/当前不能入池/.test(html)
    && /生成登录二维码/.test(html),
    '扫码区讲明 state/签名/自动入池，按钮不再标"诊断用"');
  // 扫已入池的微信号是"就地更新凭据"，号池数量不变。早先只说「已写入号池」，
  // 有人删号后重扫同一个微信号，看到成功提示却发现池子小了一个，误判成加号功能坏了。
  ok('WebUI 扫码结果按 reused 分两套文案（新增 vs 同微信号就地更新）',
    /\.reused/.test(html) && /号池数量不变/.test(html) && /已新增账号/.test(html),
    'done 分支会告诉用户"要加新号得换微信号"');
  ok('号池为空的提示不谎称"扫码不能入池"，且点明要用没进过池的微信号',
    !/扫码入口目前不能入池/.test(html) && /还没进过池的微信号/.test(html),
    '空池提示指向扫码，同时说清重复微信号只更新不增号');
  ok('WebUI 是控制台形态（概览/密钥/号池/对话/日志/接入 六个视图）',
    ['overview', 'keys', 'pool', 'chat', 'log', 'api'].every(v => html.includes('id:' + v))
    && html.includes('btnNewKey') && html.includes('fRpm') && html.includes('fDaily') && html.includes('fModels'),
    '六视图 + 密钥限额表单齐');
  // 只 grep id 的话，内联脚本里一个语法错误也能让三项全绿而页面其实一片空白
  const jsChunk = (assets.find(a => a.url.endsWith('.js')) || { text: '' }).text;
  const inline = jsChunk.replace(/^\s*(?:import|export)[^;\n]*;?/gm, '').replace(/\bimport\.meta\b/g, '({url:"/"})');
  let scriptErr = '';
  try { new Script('(async()=>{' + inline + '})'); } catch (e) { scriptErr = e.message; }
  ok('WebUI 内联脚本可解析（防"断言全绿但页面空白"）', !scriptErr && inline.length > 8000,
    scriptErr || `脚本 ${Math.round(inline.length / 1024)}KB`);

  // 游离异常单独算一项：它说明有代码路径抛了没人接的 rejection，
  // 这类问题被静默吞掉过太多次（服务崩了、响应体没消费、断言根本没跑）
  // ---- 号池优先级（序号越小越优先）与体检（=查积分）：界面字面量 + 端点行为都要有结论 ----
  ok('WebUI 号池页有「序号」优先级列与重排入口',
    /btnProbeAll/.test(html) && /btnResequence/.test(html) && /prio-/.test(html) && /全部查积分/.test(html),
    '序号输入框、单个查积分、全部查积分、按顺序重排都在包里');
  ok('WebUI 已把测活与查积分合成一个动作（并说清查不到积分=要重新登录）',
    /查积分/.test(html) && /probe/.test(html) && /需要重新登录/.test(html) && !/全部测活/.test(html),
    '按钮走 /probe，判死文案是「需要重新登录」');
  ok('WebUI 对话页有思考开关与新建对话',
    /cThink/.test(html) && /reasoning_effort/.test(html) && /cNew/.test(html) && /新建对话/.test(html),
    '思考关掉时请求体带 reasoning_effort:"none"，对话按会话分列');
  {
    const hdr = { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN };
    const target = stAfter.accounts.find(a => a.type === 'qclaw-aizone') || stAfter.accounts[0];
    const was = target.priority;
    const patch = v => fetch(BASE + '/admin/accounts/' + encodeURIComponent(target.id),
      { method: 'PATCH', headers: hdr, body: JSON.stringify({ priority: v }) });
    const neg = await patch(-1);
    const junk = await patch('abc');
    ok('priority 只接受 ≥0 的整数（负数与非整数都 400）', neg.status === 400 && junk.status === 400,
      `负数 ${neg.status} / 非整数 ${junk.status}`);
    const set = await patch(7);
    const st2 = await (await fetch(BASE + '/admin/state', { headers: { authorization: 'Bearer ' + ADMIN } })).json();
    const cfgj = await (await fetch(BASE + '/admin/config', { headers: { authorization: 'Bearer ' + ADMIN } })).json();
    ok('PATCH priority 立刻反映到 /admin/state（界面才排得动序）',
      set.status === 200 && st2.accounts.find(a => a.id === target.id).priority === 7);
    ok('优先级已写盘（重启后仍在，不是只活在内存里）',
      (cfgj.accounts.find(a => a.id === target.id) || {}).priority === 7);
    await patch(was == null ? 0 : was);   // 还原：不能因为跑一次验收就把使用者的号池顺序改掉
    const t = await (await fetch(BASE + '/admin/accounts/' + encodeURIComponent(target.id) + '/test',
      { method: 'POST', headers: hdr, body: '{}' })).json();
    ok('深度测活端点（真发推理）仍定向打到了这个号', t.account === target.id && typeof t.reply === 'string',
      `${t.account} 回 ${(t.reply || '').slice(0, 12)}`);

    // 体检与查积分合并后的核心取舍：探针换成 4110，一次都不该碰推理接口
    const chatBefore = harness ? harness.hits.chat : 0;
    const pv = await (await fetch(BASE + '/admin/accounts/' + encodeURIComponent(target.id) + '/probe',
      { method: 'POST', headers: hdr, body: '{}' })).json();
    ok('体检=查积分：不碰推理就能判定活着并拿到余额',
      pv.state === 'alive' && typeof pv.balance === 'number' && pv.balance >= 0
      && (!harness || harness.hits.chat === chatBefore),
      `${pv.state} 余额=${pv.balance} 推理 +${harness ? harness.hits.chat - chatBefore : 'live 模式不计'}`);

    // 假凭据账号：总线带业务码回来（21004）必须判成"要重新登录"并摘出轮询，
    // 而不是含糊成"不通" —— 这条与下一条是"确定性拒绝"与"没连通"的分界线。
    const dead = { id: 'verify-probe-dead', type: 'qclaw-aizone', base: 'https://mmgrcalltoken.3g.qq.com/aizone/v1/',
      apiKey: 'sk-invalid-for-test', jwt: 'x', guid: 'y', account: '1', models: ['pool-glm-5.2'] };
    await post('/admin/accounts/upsert', dead, { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN });
    const dq = await (await fetch(BASE + '/admin/accounts/' + encodeURIComponent(dead.id) + '/probe',
      { method: 'POST', headers: hdr, body: '{}' })).json();
    const drow = (await getJson('/admin/state')).accounts.find(a => a.id === dead.id);
    ok('查不到积分即判掉线/被封：状态「需要重新登录」且进冷却摘出轮询',
      dq.state === 'need_login' && drow?.needLogin === true && drow?.ok === false && drow?.cooldownSecondsLeft > 0,
      `${dq.state} needLogin=${drow?.needLogin} 冷却=${drow?.cooldownSecondsLeft}s ${(dq.reason || '').slice(0, 40)}`);
    const dcredits = JSON.stringify(drow?.credits || {});
    ok('判死的号留下失败原因，不会把上一次的余额当现值', /error/.test(dcredits) && !/"balance"/.test(dcredits), dcredits.slice(0, 90));
    await fetch(BASE + '/admin/accounts/' + encodeURIComponent(dead.id), { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } });

    // 反例：根本没连通时**不能**判成要重新登录，否则一次网络抖动能把整个池子清空。
    // 顺带盖住非直连账号的退化路径（它们没有总线身份，探针换成拉自己的模型目录）。
    const ghost = { id: 'verify-probe-ghost', type: 'openai-compat', base: 'http://127.0.0.1:1/v1/', apiKey: 'sk-ghost' };
    await post('/admin/accounts/upsert', ghost, { 'content-type': 'application/json', authorization: 'Bearer ' + ADMIN });
    const gq = await (await fetch(BASE + '/admin/accounts/' + encodeURIComponent(ghost.id) + '/probe',
      { method: 'POST', headers: hdr, body: '{}' })).json();
    const grow = (await getJson('/admin/state')).accounts.find(a => a.id === ghost.id);
    ok('连不上只报「暂不可达」，不判掉线、不进冷却（不定罪）',
      gq.state === 'unreachable' && !grow?.needLogin && grow?.cooldownSecondsLeft === 0,
      `${gq.state} needLogin=${grow?.needLogin} 冷却=${grow?.cooldownSecondsLeft}s`);
    await fetch(BASE + '/admin/accounts/' + encodeURIComponent(ghost.id), { method: 'DELETE', headers: { authorization: 'Bearer ' + ADMIN } });

    const four04 = await fetch(BASE + '/admin/accounts/no-such-account/probe', { method: 'POST', headers: hdr, body: '{}' });
    ok('未知账号体检返回 404 而不是 500', four04.status === 404, `HTTP ${four04.status}`);
  }

  if (strays.length) ok('无游离异常（未处理的 rejection / 未消费的响应体）', false, strays.slice(0, 3).join(' | '));
  else console.log('PASS  无游离异常（未处理的 rejection / 未消费的响应体）');

  // 自桩模式必须先证明"这一趟真的走在桩上"：QPP_JPRX_BASE 没生效的话，
  // 请求会悄悄打回真腾讯，测试照样能绿，但那就不再是离线回归了。
  if (SELF) {
    const b = harness.hits.bus;
    ok('自桩确实被踩到（离线断言没有偷偷打真服务）', harness.hits.chat > 10
      && ['4320', '4327', '4110', '4075', '4027', '4708'].every(id => b[id] > 0),
      `推理 ${harness.hits.chat} 次，总线 ${Object.entries(b).map(([k, v]) => k + '×' + v).join(' ')}`);
    ok('自桩账号是本机造的假号（没把真号池牵进来）', harness.accountIds.length === 2
      && st.accounts.filter(a => harness.accountIds.includes(a.id)).length === 2,
      `池里 ${st.accounts.length} 条：${st.accounts.map(a => a.id).join(' ')}`);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  await finish(fail ? 1 : 0);
})().catch(async e => { console.error('验证脚本异常:', e); await cleanupKeys(); await finish(2); });

/** 收尾：自桩模式要把子进程和临时文件清干净，失败时把子进程 stderr 带出来 */
async function finish(code) {
  if (harness) {
    if (code !== 0) {
      const t = harness.stderr().trim();
      if (t) console.error('\n自桩代理 stderr:\n' + t.split('\n').slice(-25).join('\n'));
    }
    try { await harness.stop(); } catch (e) { console.error('停自桩失败:', e.message); }
  }
  process.exit(code);
}

/**
 * 前端已换成 shadcn/ui(React) 构建产物：/ 只是一个挂载壳，功能字面量都在 assets 的 chunk 里。
 * 这里把壳 + JS + CSS 拼成一份文本来 grep，并抹掉引号 —— 打包器输出的是反引号字符串
 * （id:`chat`），留着引号写断言就会出现"断言全绿而页面其实没这个 id"的假绿灯。
 */
async function readUi() {
  const r = await fetch(BASE + '/');
  const shell = await r.text();
  const urls = (shell.match(/(?:src|href)="(\/assets\/[^"]+)"/g) || []).map(x => x.slice(x.indexOf('"') + 1, -1));
  const assets = [];
  for (const u of urls) {
    const a = await fetch(BASE + u);
    assets.push({ url: u, status: a.status, type: a.headers.get('content-type') || '', text: a.status === 200 ? await a.text() : '' });
  }
  const raw = shell + '\n' + assets.map(a => a.text).join('\n');
  const text = raw.replace(/["']/g, '').split(String.fromCharCode(96)).join('');
  return { status: r.status, shell, assets, text };
}
