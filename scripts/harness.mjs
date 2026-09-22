// 一次性自桩实例：假总线 + 假推理上游 + 假登录页 + 用临时配置起的代理。
//
// 它存在的理由有两个：
//   1) 跑回归不该需要真凭据。以前为了在非 8787 端口跑 verify，我拿真 JWT 手搓过一份临时
//      config 落在仓库里 —— 自桩模式下 config 里全是本机生成的假值，泄了也不是事故，
//      而且文件一律落 os.tmpdir()，不进工作区。
//   2) 真上游有 1~2% 瞬时失败、模型有时不调工具，那类断言天生是抖的；契约层（报文归一、
//      总线字段解析、错误分类、调度冷却、限额鉴权）应该有一次确定性的、离线可跑的钉。
//
// 边界要说清楚：桩按 src/qclaw-api.mjs 解析器所依赖的字段形状回答，所以它证明的是
// "我们自己的解析与归一自洽"，**不证明腾讯今天还按这个形状回答**。后者只有
// `npm run verify:live` 打真号池才能给 —— 别把这里的绿灯读成"链路活着"。
//
// 上游行为照着实测契约写（src/reasoning.mjs、src/upstream.mjs 的注释里那批测量）：
//   - aizone 从不返回 usage（连 stream_options.include_usage 也不给）
//   - 思考只有开关有效：reasoning_effort:'none' / thinking:{type:'disabled'} 才关掉
//   - 参数写错回 HTTP 200 + {"common":{"code":21004}}（登录态）或 400 + error.type=proxy_param_error
//   - 4050/4026 认 HMAC 签名，缺签名回 21004（我们据此误判过整族下线）
// 桩对 4050/4026 独立重算一遍签名，所以谁改坏 webSignHeaders，这里立刻红。

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const hex = n => crypto.randomBytes(n).toString('hex');

// 逐条照抄 2026-09-22 从云端真号池 /v1/models 拉到的真实目录（4320 能力 + 4327 倍率 + 上下文窗口）。
// 不放宽：桩一旦"比真的更能思考"，离线绿灯就成了假绿灯 —— 能力表必须与真上游一致，
// 真实与桩的差异只允许出现在"这一次上游有没有真的思考"这种随机性上。
const CATALOG = [
  ['default', 'Auto', ['图片输入'], 250000, 'standard', 0.02, 0.02, 'x1.0'],
  ['pool-hy3-preview', 'Hy3', ['深度思考'], 262144, 'economy', 0.01, 0.01, 'x0.5'],
  ['pool-deepseek-v4-pro', 'DeepSeek-V4-Pro', ['深度思考'], 1048576, 'advanced', 0.024, 0.024, 'x1.2'],
  ['pool-deepseek-v4-flash', 'DeepSeek-V4-Flash', [], 1048576, 'economy', 0.01, 0.01, 'x0.5'],
  ['pool-glm-5.2', 'GLM-5.2', [], 1048576, 'standard', 0.05, 0.05, 'x2.5'],
  ['pool-glm-5.2-night', 'GLM-5.2 · 夜间专属', [], 1048576, 'standard', 0.03, 0.03, 'x1.5'],
  ['pool-glm-5.1', 'GLM-5.1', [], 204800, 'advanced', 0.05, 0.05, 'x2.5'],
  ['pool-kimi-k2.7-code-highspeed', 'Kimi-K2.7-Code-HighSpeed', ['图片输入'], 262144, 'advanced', 0.064, 0.064, 'x3.2'],
  ['pool-kimi-k2.6', 'Kimi-K2.6', ['图片输入'], 262144, 'standard', 0.032, 0.032, 'x1.6'],
  ['pool-minimax-m3', 'MiniMax-M3', ['图片输入'], 204800, 'advanced', 0.016, 0.016, 'x0.8'],
  ['pool-minimax-m2.7', 'MiniMax-M2.7', [], 204800, 'economy', 0.014, 0.014, 'x0.7']
].map(([id, name, capabilities, context_window, tier, input_rate, output_rate, multiplier]) =>
  ({ id, name, capabilities, context_window, tier, input_rate, output_rate, multiplier }));

const MODELS_BY_ID = Object.fromEntries(CATALOG.map(m => [m.id, m]));
const canThink = id => (MODELS_BY_ID[id]?.capabilities || []).some(c => c.includes('深度思考'));

const ACCOUNTS = [
  { id: 'selfstub-a', user: 1900000001, unionid: 'ovR1VuSELFSTUBAAAA0000000000001', nick: '自桩甲' },
  { id: 'selfstub-b', user: 1900000002, unionid: 'ovR1VuSELFSTUBBBBB0000000000002', nick: '自桩乙' }
];

/** 假登录 JWT：形状必须真（两处断言专门检查管理端快照不外泄 eyJ/sk-，得有的可查才行） */
function fakeJwt(user, guid) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = { iss: 'openclaw', exp: Math.floor(Date.now() / 1000) + 30 * 86400, iat: Math.floor(Date.now() / 1000), user_id: user, guid, auth_type: 'wechat' };
  return `${head}.${b64u(body)}.${crypto.randomBytes(32).toString('base64url')}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const envelope = data => ({ ret: 0, data: { resp: { common: { code: 0, message: 'Success' }, data } } });
const busFail = (code, message) => ({ ret: 0, data: { resp: { common: { code, message }, data: null } } });

/** 独立重算网页通道签名（不复用被测的 webSignHeaders，否则这条断言是自证） */
function signOk(body, headers, secret) {
  const ts = headers['x-sign-timestamp'];
  const got = headers['x-sign-signature'];
  if (!ts || !got || !headers['x-openclaw-clientversion']) return false;
  const str = [...Object.keys(body), 'timestamp'].sort().map(k =>
    k === 'timestamp' ? `timestamp=${ts}` : `${k}=${body[k] == null ? '' : String(body[k])}`).join('&');
  return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex') === got;
}

const REASON = '先理清条件：头 35、脚 94。假设全是鸡则 70 脚，多出 24 只脚来自兔子，'
  + '故兔 12 只、鸡 23 只。代回验算：35 个头、94 只脚，成立。';

/** 照着实测契约生成一次补全的正文（非流式与流式共用同一份语义判断） */
function completion(reqBody) {
  const msgs = Array.isArray(reqBody.messages) ? reqBody.messages : [];
  const lastTool = [...msgs].reverse().find(m => m.role === 'tool');
  const history = msgs.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join(' ');
  const tools = Array.isArray(reqBody.tools) ? reqBody.tools : null;
  const weather = tools?.find(t => /get_weather/.test(t?.function?.name || t?.name || ''));
  // 有工具且还没回传结果才发起调用；回了结果就该出正文（真模型也是这个次序）
  const callTool = !!weather && !lastTool;
  const city = (history.match(/上海|北京|深圳|广州|杭州/) || ['上海'])[0];
  const off = reqBody.reasoning_effort === 'none' || reqBody.thinking?.type === 'disabled';
  const reasoning = !off && canThink(reqBody.model || '') ? REASON : '';
  const args = JSON.stringify({ city });
  const temp = String(lastTool?.content || '').match(/"temp"\s*:\s*"([^"]+)"/)?.[1] || '23℃';
  const content = callTool ? ''
    : lastTool ? `${city}现在${temp}，多云，出门不用带伞。`
      : `收到。这是一条来自自桩上游的回答，模型 ${reqBody.model || '?'}，用于校验报文转换与调度链路。`;
  return { reasoning, content, args, callTool, finish: callTool ? 'tool_calls' : 'stop' };
}

function chunk(model, delta, finish = null) {
  return { id: 'chatcmpl-selfstub', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] };
}

/** 流式分片序列：思考在前、正文在中、工具参数分两段下发（Anthropic 侧要看到 input_json_delta） */
function streamFrames(model, c) {
  const f = [chunk(model, { role: 'assistant' })];
  for (let i = 0; i < c.reasoning.length; i += 18) f.push(chunk(model, { reasoning_content: c.reasoning.slice(i, i + 18) }));
  if (c.callTool) {
    f.push(chunk(model, { tool_calls: [{ index: 0, id: 'call_selfstub', type: 'function', function: { name: 'get_weather', arguments: '' } }] }));
    f.push(chunk(model, { tool_calls: [{ index: 0, function: { arguments: c.args.slice(0, 9) } }] }));
    f.push(chunk(model, { tool_calls: [{ index: 0, function: { arguments: c.args.slice(9) } }] }));
  } else {
    for (let i = 0; i < c.content.length; i += 8) f.push(chunk(model, { content: c.content.slice(i, i + 8) }));
  }
  f.push(chunk(model, {}, c.finish));
  return f;
}

function chatJson(model, c) {
  const msg = { role: 'assistant', content: c.content };
  if (c.reasoning) msg.reasoning_content = c.reasoning;
  if (c.callTool) msg.tool_calls = [{ id: 'call_selfstub', type: 'function', function: { name: 'get_weather', arguments: c.args } }];
  // 刻意不带 usage：aizone 实测从不返回，补 usage 帧是我们自己的责任，得留着被检验
  return { id: 'chatcmpl-selfstub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: msg, finish_reason: c.finish }] };
}

/**
 * 起桩 + 代理。返回 {base, clientKey, adminToken, stubBase, log, stop}。
 * stop() 一定杀掉子进程并删掉临时配置与临时 trail 日志。
 */
export async function startHarness({ log = () => {} } = {}) {
  const stubPort = await freePort();
  const proxyPort = await freePort();
  const stubBase = `http://127.0.0.1:${stubPort}/`;
  const secret = hex(32);          // 假密钥：桩与被测进程各持一份，走环境变量注入
  const adminToken = 'selfstub-admin-' + hex(12);
  const clientKey = 'vk-' + hex(24);
  const guids = { 'selfstub-a': 'selfstub-guid-a', 'selfstub-b': 'selfstub-guid-b' };
  const issuedStates = new Set();
  const hits = { bus: {}, chat: 0 };

  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => raw += d);
    req.on('end', () => {
      const send = (obj, type = 'application/json', status = 200) => {
        res.writeHead(status, { 'content-type': type });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };
      const body = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();

      if (req.url === '/loginpage') {
        // 只出码不跳转：自桩模式下不打算真兑换，别把号池账号数在断言中途改掉
        return send('<!doctype html><meta charset=utf-8><title>selfstub login</title><div id=qr></div>');
      }

      const bus = req.url.match(/^\/data\/(\d+)\/forward$/);
      if (bus) {
        const apiId = bus[1];
        hits.bus[apiId] = (hits.bus[apiId] || 0) + 1;
        if (apiId === '4050' || apiId === '4026' || apiId === '4630') {
          if (!signOk(body, req.headers, secret)) return send(busFail(21004, '鉴权不通过，请升级最新版本'));
          if (apiId === '4050') {
            const state = 'selfstub-state-' + hex(8);
            issuedStates.add(state);
            return send(envelope({ state }));
          }
          if (!issuedStates.has(body.state)) return send(busFail(4, 'state 无效或已过期'));
          return send(envelope({ token: fakeJwt(1900000003, body.guid || ''), user_info: { user_id: 1900000003, nickname: '自桩扫码', unionid: 'ovR1VuSELFSTUBSCAN0000000000003' } }));
        }
        // 其余接口看登录态：verify-* 探针账号的 jwt 是 'x'，必须像真总线一样拒，
        // 否则"目录未加载的账号不会什么都接"那条断言就失去意义了
        const jwt = String(req.headers['x-openclaw-token'] || '');
        if ((jwt.match(/\./g) || []).length !== 2) return send(busFail(21004, '鉴权不通过，请升级最新版本'));
        const acct = ACCOUNTS.find(a => String(req.headers['x-account']) === String(a.user)) || ACCOUNTS[0];
        switch (apiId) {
          case '4320':
            return send(envelope({ model_status_list: CATALOG.map(m => ({
              display_id: m.id, id: m.id, name: m.name, capabilities: m.capabilities, context_window: m.context_window })) }));
          case '4327': {
            const ids = Array.isArray(body.model_ids) && body.model_ids.length ? body.model_ids : CATALOG.map(m => m.id);
            return send(envelope({ rates: ids.filter(id => MODELS_BY_ID[id]).map(m => ({
              model_id: m, model_tier: MODELS_BY_ID[m].tier, input_rate: MODELS_BY_ID[m].input_rate,
              output_rate: MODELS_BY_ID[m].output_rate, rate_multiplier: MODELS_BY_ID[m].multiplier,
              note: `输入每1000 Token消耗 ${MODELS_BY_ID[m].input_rate} Q点，输出每1000 Token消耗 ${MODELS_BY_ID[m].output_rate} Q点` })) }));
          }
          case '4055':
            return send(envelope({ key: 'sk-' + crypto.createHash('sha256').update(String(acct.user)).digest('hex').slice(0, 48) }));
          case '4708':
            return send(envelope({ can_use: true, source: 'trial', reason: '', trial_type: 1, trial_remaining: 6, trial_used: 24, trial_expires_at: new Date(Date.now() + 6 * 864e5).toISOString(), purchase_expires_at: '' }));
          case '4110': {
            // 三处一致性断言在盯着：balance == Σitems.remain == 活动+订阅+包+每日赠送
            const items = [
              { label: '新用户活动', total_amount: 1000, remain_amount: 900, expire_time: '2026-12-31T00:00:00Z', product_type: 1 },
              { label: '月度订阅', total_amount: 2000, remain_amount: 2000, expire_time: '2026-10-31T00:00:00Z', product_type: 2 },
              { label: '积分包', total_amount: 1500, remain_amount: 1200, expire_time: '2026-11-15T00:00:00Z', product_type: 3 }
            ];
            return send(envelope({ balance: 4100, total_daily_free_granted: 0, balance_detail: { activity_q: 900, subscription_q: 2000, package_q: 1200, daily_free: 0, items } }));
          }
          case '4075':
            return send(envelope({ daily_token_limit: 1000000, daily_token_used: 12345, rpm_limit: 60 }));
          case '4027':
            return send(envelope({ user_id: acct.user, openid: 'oTpFx' + acct.unionid.slice(-10), unionid: acct.unionid, nickname: acct.nick, head_img_url: 'https://example.invalid/a.png' }));
          default:
            return send(busFail(100002, '未知 apiId ' + apiId));
        }
      }

      if (req.url.startsWith('/aizone/v1/chat/completions')) {
        hits.chat++;
        // 推理接口认 sk- + X-OpenClaw-Token：探针账号带的是 jwt='x'，按实测回 200+21004
        const jwt = String(req.headers['x-openclaw-token'] || '');
        if ((jwt.match(/\./g) || []).length !== 2 || !/^Bearer sk-/.test(String(req.headers.authorization || ''))) {
          return send({ common: { code: 21004, message: '鉴权不通过' } });
        }
        if ('tools' in body && body.tools != null && !Array.isArray(body.tools)) {
          return send({ error: { type: 'proxy_param_error', message: 'tools 必须是数组' } }, 'application/json', 400);
        }
        if (typeof body.model !== 'string' || !body.model) {
          return send({ error: { type: 'invalid_request', message: 'model 必填' } }, 'application/json', 400);
        }
        const c = completion(body);
        if (!body.stream) return send(chatJson(body.model, c));
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const f of streamFrames(body.model, c)) res.write(`data: ${JSON.stringify(f)}\n\n`);
        return res.end('data: [DONE]\n\n');
      }

      return send({ common: { code: 100002, message: '自桩没有这个路由: ' + req.url } }, 'application/json', 404);
    });
  });
  await new Promise(r => stub.listen(stubPort, '127.0.0.1', r));

  const cfgFile = path.join(os.tmpdir(), `qpp-selfstub-${proxyPort}.json`);
  const trail = path.join(os.tmpdir(), `qpp-selfstub-${proxyPort}-trail.log`);
  const cfg = {
    listen: { host: '127.0.0.1', port: proxyPort },
    adminToken,
    clientKeys: [{ key: clientKey, name: 'selfstub', createdAt: new Date().toISOString(), usage: { day: '1970-01-01', requests: 0 }, stats: {} }],
    cors: { origin: '*' },
    accounts: ACCOUNTS.map(a => ({
      id: a.id, type: 'qclaw-aizone', base: stubBase + 'aizone/v1/',
      apiKey: 'sk-' + crypto.createHash('sha256').update(a.id).digest('hex').slice(0, 48),
      jwt: fakeJwt(a.user, guids[a.id]), guid: guids[a.id], account: a.user,
      identity: { userId: a.user, unionid: a.unionid, nickname: a.nick }, weight: 100,
      note: '自桩账号'
    })),
    upstream: { timeoutMs: 20000 }
  };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--config', cfgFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      QPP_JPRX_BASE: stubBase,
      QPP_LUBAN_BASE: stubBase + 'luban/',
      QPP_LOGIN_URL: stubBase + 'loginpage?state={state}',
      QPP_WEB_SIGN_SECRET: secret,
      QPP_LOGIN_TRAIL: trail
    }
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; log('[自桩代理] ' + String(d).trim()); });
  child.stdout.on('data', d => log('[代理] ' + String(d).trim()));

  const base = `http://127.0.0.1:${proxyPort}`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) break; } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
    if (i === 79) throw new Error('自桩代理没起来:\n' + stderr.slice(-2000));
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const gone = new Promise(r => child.once('exit', r));
    child.kill('SIGKILL');
    await gone;
    // 先等子进程退出再删：它在 SIGTERM 路径上会回写配置，反过来删会留下孤儿文件
    for (const f of [cfgFile, cfgFile + '.bak', cfgFile + '.tmp', trail]) {
      try { fs.unlinkSync(f); } catch { /* 没生成过 */ }
    }
    await Promise.race([new Promise(r => stub.close(r)), new Promise(r => setTimeout(r, 1500))]);
  };
  process.once('exit', () => {
    try { child.kill('SIGKILL'); } catch { /* 已退 */ }
    for (const f of [cfgFile, trail]) { try { fs.unlinkSync(f); } catch { /* 已删 */ } }
  });

  return { base, clientKey, adminToken, stubBase, hits, secret, cfgFile, stop,
    stderr: () => stderr,
    issuedStates, accountIds: ACCOUNTS.map(a => a.id) };
}
