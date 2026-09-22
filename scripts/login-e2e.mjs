// 离线端到端验证扫码登录链路：用一个桩登录页 + 桩总线，把
// "无头浏览器出码 → 捕获 code → 兑换 JWT → 取 sk- → 取模型 → 生成号池账号" 整条跑通。
// 真实世界唯一没被这段测试覆盖的，是腾讯那个兑换接口的 apiId 与参数（4026 已下线）。
//   node scripts/login-e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { LoginManager } from '../src/login.mjs';

const PAGE_DELAY_MS = 2500;   // 留足时间让引擎挂上请求监听
// 网页通道签名密钥（与 src/qclaw-api.mjs 同一个）；桩里独立重算一遍，用来证明头真的带上了且算得对
const SIGN_SECRET = '2fc7c82b2cdc2a6083239d343843adf314b571dd0ee036163b61fb209be47492';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.' +
  Buffer.from(JSON.stringify({ iss: 'openclaw', exp: 9999999999, user_id: 999001, auth_type: 'wechat' })).toString('base64url') +
  '.c3lnLXN0dWItd2l0aC1hLXJlYWxpc3RpYy00M2NoYXItc2ln';

const calls = [];
let lubanBody = null;
let lubanFlaky = 0;
// 场景 G：4050 前几次掐断连接，验引擎会退避重试而不是降级成自造 state
let stateFlaky = 0;
// 场景 F 的桩侧状态：服务端签发/校验的 state，以及兑换请求带没带对签名
let issuedState = null;
let webExBody = null;
let webSigOk = false;
let webTriedMobile = false;
function verifySign(body, headers) {
  const ts = headers['x-sign-timestamp'];
  const got = headers['x-sign-signature'];
  if (!ts || !got || !headers['x-openclaw-clientversion']) return false;
  // 独立重算一遍：排序键 + timestamp，HMAC-SHA256 hex（不复用被测代码，否则这个断言就是自证）
  const str = [...Object.keys(body), 'timestamp'].sort().map(k =>
    k === 'timestamp' ? `timestamp=${ts}` : `${k}=${body[k] == null ? '' : String(body[k])}`).join('&');
  return crypto.createHmac('sha256', SIGN_SECRET).update(str, 'utf8').digest('hex') === got;
}
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const send = (obj, type = 'application/json') => {
      res.writeHead(200, { 'content-type': type });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    const ok = data => send({ ret: 0, data: { resp: { common: { code: 0, message: 'Success' }, data } } });
    if (req.url.startsWith('/loginpage2')) {   // 必须先于 /loginpage 判断（前缀会互相吃掉）
      return send(`<!doctype html><meta charset=utf-8><title>stub login 2</title>模拟"页面自己兑换"
        <script>setTimeout(()=>{fetch('/api/account/userauth/check?code=TESTCODE2').then(r=>r.json());}, 1500);</script>`,
        'text/html; charset=utf-8');
    }
    if (req.url.startsWith('/loginpage3')) {
      return send(`<!doctype html><meta charset=utf-8><title>stub login 3</title>token 只写进 localStorage
        <script>setTimeout(()=>{localStorage.setItem('qclaw_token','${FAKE_JWT}');}, 1200);</script>`,
        'text/html; charset=utf-8');
    }
    if (req.url.startsWith('/loginpage4')) {
      return send(`<!doctype html><meta charset=utf-8><title>stub login 4</title>模拟管家 /wxLogin 页面自己换出 loginkey
        <script>setTimeout(()=>{fetch('/sendLoginCode',{method:'POST',headers:{'content-type':'application/json'},
          body:'{"code":"PAGECODE","guid":"page-guid","loginAccType":32}'}).then(r=>r.json());}, 1500);</script>`,
        'text/html; charset=utf-8');
    }
    // 场景 F：官网网页通道 —— state 由服务端 4050 签发，兑换时必须原样带回且带 HMAC 签名
    if (req.url.startsWith('/loginpage5')) {      const st = new URL(req.url, 'http://x').searchParams.get('state') || '';
      // 顺手把腾讯出码页自己的"探测本机 PC 微信"噪声模拟进来：
      // 这些 console.log 里带"失败"二字，早先会被原样透到用户日志里，看着像出 bug 了。
      // 真页面就是连着一串端口逐个探测的（13013…14015），所以这里也分几次发 ——
      // 只发一次的话，会不会被接到取决于 CDP 挂上没有，那条"只说一次"的断言就变成计时的抛硬币。
      return send(`<!doctype html><meta charset=utf-8><title>stub login 5</title>模拟网页版扫码回调
        <script>
          let n = 0;
          const t = setInterval(()=>{
            console.log('端口' + (14014 - n) + '连接失败，尝试下一个端口');
            if (++n === 5) { clearInterval(t); console.warn('SEER LOG: seer lib version: 1.0.0'); }
          }, 300);
          setTimeout(()=>{clearInterval(t);location.href='/proxy/login5?code=F5CODE&state=${encodeURIComponent(st)}';}, ${PAGE_DELAY_MS});
        </script>`,
        'text/html; charset=utf-8');
    }
    // 场景 G 的页面：出码但不跳转 —— 这一场只验 4050 的重试，别让后面的兑换动作搅进来
    if (req.url.startsWith('/loginpage-g')) {
      return send('<!doctype html><meta charset=utf-8><title>stub login G</title>静态桩页'
        + '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">',
        'text/html; charset=utf-8');
    }
    if (req.url.startsWith('/loginpage?')) {
      return send(`<!doctype html><meta charset=utf-8><title>stub login</title>
        <body style="font:14px sans-serif">模拟微信登录页
        <script>setTimeout(()=>{location.href='/proxy/login?code=TESTCODE123&state=${encodeURIComponent(new URL(req.url,'http://x').searchParams.get('state')||'')}';}, ${PAGE_DELAY_MS});</script>`
        , 'text/html; charset=utf-8');
    }
    if (req.url.startsWith('/proxy/login')) { calls.push('callback'); return send('ok', 'text/plain'); }
    // luban：中继页对 code 做的那一步。返回管家会话（loginkey/accountId），
    // 4099 只有在这个 loginkey 被当成 x-token 带上来时才发登录态 —— 用来证明两级串联。
    if (req.url.startsWith('/sendLoginCode')) {
      calls.push('sendLoginCode');
      // 场景 E：前 N 次直接掐断连接（云服务器到 luban 实测 4 次里有 3 次连不上），
      // 微信 code 是一次性的，只靠外层换 loginAccType 会把整次扫码废掉。
      // 必须连 socket 一起断掉：只 req.destroy() 会让 keep-alive 的 socket 挂着，
      // 客户端要等 15s AbortSignal 超时才报错，测不出"快速失败重试"。
      if (lubanFlaky > 0) { lubanFlaky--; req.socket.destroy(); return; }
      lubanBody = JSON.parse(body || '{}');
      return send({ success: true, traceid: 'stub-trace', result: { resp: {
        retCode: 0, loginkey: 'LK-STUB-abcdef0123456789', accountId: 999001, renewalTime: 0,
        thirdPartyAccInfo: { accType: 2, nickName: '桩用户', unionId: 'u-stub' } } } });
    }
    // 场景 B：登录页自己在浏览器里把 code 换掉，token 直接躺在响应体里
    if (req.url.startsWith('/api/account/userauth/check')) {
      calls.push('pageexchange');
      return ok({ access_token: FAKE_JWT, user_info: { user_id: 999002, guid: 'stub-guid-bbb' } });
    }
    const m = /^\/data\/(\d+)\/forward$/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end('no route'); }
    calls.push('bus:' + m[1]);
    // 场景 F 的服务端：4050 签发 state（记住自己签了什么），4026 只在
    // ①state 是自己签的 ②网页通道 HMAC 签名独立重算能对得上 时才发 JWT。
    // 少带/算错任一头，这里就会退回到 code=4/-1，测试立刻看得见。
    if (m[1] === '4050') {
      // 场景 G：这台服务器对 jprx 的出口实测会抖（同一分钟内可见 4320/4050 各自 fetch failed）。
      // 前 stateFlaky 次直接掐线 —— 模拟"根本没连通"，引擎必须退避重试而不是降级成自造 state。
      if (stateFlaky > 0) { stateFlaky--; req.socket.destroy(); return; }
      issuedState = 'srv-' + crypto.randomBytes(8).toString('hex');
      return ok({ state: issuedState });
    }
    if (m[1] === '4026') {
      const b = JSON.parse(body || '{}');
      webExBody = b;
      webSigOk = verifySign(b, req.headers);
      if (!webSigOk) return send({ ret: 0, data: { resp: { common: { code: 21004, message: '鉴权不通过，请升级最新版本' }, data: null } } });
      if (b.state !== issuedState) return send({ ret: 0, data: { resp: { common: { code: 4, message: 'state 无效或已过期，请重新获取' }, data: null } } });
      if (b.code !== 'F5CODE') return send({ ret: 0, data: { resp: { common: { code: -1, message: '微信授权失败' }, data: null } } });
      return ok({ token: FAKE_JWT, user_info: { user_id: 999005, nickname: '网页通道用户', avatar_url: 'https://stub/avatar.png' } });
    }
    if (m[1] === '4630') { webTriedMobile = true; return send({ ret: 0, data: { resp: { common: { code: -1, message: '微信授权失败' }, data: null } } }); }
    if (m[1] === '4099') {
      // 只认带 loginkey 的那一次：证明 luban → 总线 的凭据链没断
      if (req.headers['x-token'] !== 'LK-STUB-abcdef0123456789') return send({ ret: 0, data: { resp: { common: { code: 21004, message: '鉴权不通过，请升级最新版本' } } } });
      return ok({ token: FAKE_JWT, openclaw_channel_token: 'ch-stub', loginKey: 'lk-stub', user_info: { user_id: 999001, guid: 'stub-guid-00000000000000000000000000000000000000000000000000000000000000aa' } });
    }
    if (m[1] === '4055') return ok({ key: 'sk-stub00000000000000000000000000000000000000000000000000aa', masked_key: 'sk-stub…00aa' });
    if (m[1] === '4320') return ok({ model_status_list: [{ id: 'pool-glm-5.2', display_id: 'pool-glm-5.2', name: 'GLM-5.2' }, { id: 'default', display_id: 'default', name: 'Auto' }] });
    return ok({});
  });
});

await new Promise(r => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;
process.env.QPP_JPRX_BASE = base + '/';
process.env.QPP_LOGIN_URL = base + '/loginpage?state={state}';
process.env.QPP_LOGIN_API_IDS = '4099';
process.env.QPP_LUBAN_BASE = base + '/';

let inserted = null;
const mgr = new LoginManager({ log: () => {}, onDone: a => { inserted = a; } });
const sess = await mgr.start();
console.log('start ->', sess.status, sess.error || '');
if (sess.status === 'failed') { console.error('FAIL 引擎启动失败（是否没装 chromium/edge？）'); process.exit(1); }

let out = sess;
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500));
  out = mgr.get(sess.loginId);
  if (out.status === 'done' || out.status === 'failed') break;
}

const checks = [
  ['登录页被浏览器捕获到回调 code', calls.includes('callback')],
  ['兑换接口被调用（QPP_LOGIN_API_IDS 生效）', calls.includes('bus:4099')],
  ['中继页那一步 sendLoginCode 被调用且带上 code/guid', calls.includes('sendLoginCode')
    && lubanBody?.code === 'TESTCODE123' && !!lubanBody?.guid && lubanBody?.loginAccType === 2],
  ['随后取 sk- 与模型清单', calls.includes('bus:4055') && calls.includes('bus:4320')],
  ['会话状态到达 done', out.status === 'done'],
  ['生成了 qclaw-aizone 账号记录', !!out.accountRecord && out.accountRecord.type === 'qclaw-aizone'],
  ['账号记录字段齐全（apiKey/jwt/guid/account/models）',
    !!out.accountRecord && /^sk-/.test(out.accountRecord.apiKey || '') && out.accountRecord.jwt === FAKE_JWT
    && !!out.accountRecord.guid && out.accountRecord.account === 999001 && out.accountRecord.models.length === 2],
  ['onDone 回调把账号交给了号池', !!inserted && inserted.id === out.accountRecord?.id],
  ['二维码图片已产出', typeof out.qrImage === 'string' && out.qrImage.startsWith('data:image/png;base64,') && out.qrImage.length > 3000]
];

// ---- 场景 B：token 直接躺在登录页的响应体里，完全不需要知道兑换 apiId ----
calls.length = 0; inserted = null;
process.env.QPP_LOGIN_URL = base + '/loginpage2?state={state}';
const mgrB = new LoginManager({ log: () => {}, onDone: a => { inserted = a; } });
const sB = await mgrB.start();
let outB = sB;
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500));
  outB = mgrB.get(sB.loginId);
  if (outB.status === 'done' || outB.status === 'failed') break;
}
checks.push(
  ['[B] 页面自身的兑换请求被观察到', calls.includes('pageexchange')],
  ['[B] 未调用任何 apiId 就拿到 token（不依赖兑换接口）', !calls.some(c => c.startsWith('bus:4099'))],
  ['[B] 仍完成 sk-/模型/入池', outB.status === 'done' && !!inserted && inserted.account === 999002],
  ['[B] 日志记录了 token 来自响应体', (outB.log || []).some(l => /从响应体.*拿到 token/.test(l))]
);
mgrB.cancel(sB.loginId);

// ---- 场景 C：token 只出现在页面 localStorage，靠周期探测兜住 ----
calls.length = 0; inserted = null;
process.env.QPP_LOGIN_URL = base + '/loginpage3?state={state}';
const mgrC = new LoginManager({ log: () => {}, onDone: a => { inserted = a; } });
const sC = await mgrC.start();
let outC = sC;
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500));
  outC = mgrC.get(sC.loginId);
  if (outC.status === 'done' || outC.status === 'failed') break;
}
checks.push(
  ['[C] 无跳转/无响应可挖时仍能拿到 token', outC.status === 'done'],
  ['[C] 日志记录了来源是页面 cookie/storage', (outC.log || []).some(l => /cookie\/storage/.test(l))],
  ['[C] 账号入池', !!inserted && inserted.account === 999001]
);
mgrC.cancel(sC.loginId);

// ---- 场景 D：页面自己调 sendLoginCode 换出 loginkey（管家 appid 的真实路径）。
// loginkey 不是 JWT 形状，grabJwt 看不见它 —— 必须被单独认出来并当 x-token 交给总线。
calls.length = 0; inserted = null;
process.env.QPP_LOGIN_URL = base + '/loginpage4?state={state}';
const mgrD = new LoginManager({ log: () => {}, onDone: a => { inserted = a; } });
const sD = await mgrD.start();
let outD = sD;
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500));
  outD = mgrD.get(sD.loginId);
  if (outD.status === 'done' || outD.status === 'failed') break;
}
checks.push(
  ['[D] 页面自换的 sendLoginCode 被接住', calls.includes('sendLoginCode')],
  ['[D] 不重复兑换（只此一次）', calls.filter(c => c === 'sendLoginCode').length === 1],
  ['[D] loginkey 被认出并记进日志', (outD.log || []).some(l => /sendLoginCode 返回管家会话/.test(l))],
  ['[D] loginkey 当 x-token 换到 JWT 并入池', outD.status === 'done' && !!inserted && inserted.account === 999001]
);
mgrD.cancel(sD.loginId);

// ---- 场景 E：luban 前两次掐断连接，第三次才通 —— 真实云服务器就是这样抖的。
// 修之前：一次抖动 = 一个朋友的扫码作废；修之后：连接层失败重试，retCode 非 0 不重试。
calls.length = 0; inserted = null; lubanFlaky = 2;
process.env.QPP_LOGIN_URL = base + '/loginpage?state={state}';
const mgrE = new LoginManager({ log: () => {}, onDone: a => { inserted = a; } });
const sE = await mgrE.start();
let outE = sE;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 500));
  outE = mgrE.get(sE.loginId);
  if (outE.status === 'done' || outE.status === 'failed') break;
}
checks.push(
  ['[E] 连接层失败被重试（同一 loginAccType 打了 3 次）', calls.filter(c => c === 'sendLoginCode').length === 3],
  ['[E] 重试过程写进了会话日志', (outE.log || []).some(l => /没连通 luban/.test(l))],
  ['[E] 抖动之后仍然换到会话并入池', outE.status === 'done' && !!inserted && inserted.account === 999001]
);
mgrE.cancel(sE.loginId);
lubanFlaky = 0;

// ---- 场景 F：官网网页通道（qclaw.qq.com 自己用的那条）。
// 与前面几条的根本差别：state 由服务端 4050 签发给本设备 guid，兑换必须带 HMAC 签名三头。
// 桩里独立重算签名、并且只认自己签出去的 state —— 少带或算错都会退回 21004/code=4，测试立刻可见。
calls.length = 0; inserted = null; issuedState = null; webExBody = null; webSigOk = false; webTriedMobile = false;
process.env.QPP_LOGIN_URL = base + '/loginpage5?state=%STATE%';
const mgrF = new LoginManager({ log: () => {}, onDone: a => { inserted = a; return { id: a.id, reused: null, poolSize: 4 }; } });
const sF = await mgrF.start();
let outF = sF;
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500));
  outF = mgrF.get(sF.loginId);
  if (outF.status === 'done' || outF.status === 'failed') break;
}
checks.push(
  ['[F] 引擎先向 4050 要服务端签发的 state（不再自造）', calls.includes('bus:4050') && !!issuedState],
  ['[F] 兑换请求带对了网页 HMAC 签名（桩独立重算）', webSigOk === true],
  ['[F] 兑换用的 state 就是 4050 签发的那个', webExBody?.state === issuedState],
  ['[F] guid 用网页通道的 qclawmp_ 形态', /^qclawmp_/.test(String(webExBody?.guid))],
  ['[F] 签名通道一步拿到 JWT，不必再走 luban', outF.status === 'done' && !calls.includes('sendLoginCode')],
  ['[F] 账号入池（user_id=999005，昵称来自网页通道）',
    !!inserted && inserted.account === 999005 && inserted.identity?.nickname === '网页通道用户'],
  ['[F] 桌面编号 4026 成功时不再试移动端 4630', webTriedMobile === false],
  ['[F] 登录页的 PC 微信探测噪声没进用户日志',
    !(outF.log || []).some(l => /端口\d+连接失败|SEER LOG/.test(l))],
  ['[F] 那类噪声压成一句人话且只说一次',
    (outF.log || []).filter(l => /探测本机 PC 微信/.test(l)).length === 1],
  ['[F] 新增分支把"池里共几个号"说出口（含糊的「已写入号池」会让人以为多了一个号）',
    (outF.log || []).some(l => /已新增账号 .*号池共 4 个号/.test(l))],
  ['[F] reused 为空时向管理端透出 poolSize', outF.reused === null && outF.poolSize === 4]
);
mgrF.cancel(sF.loginId);

// ---- 场景 I：同一个微信号第二次扫码（unionid 命中，号池里那条被就地更新）。
// 真实用户故事：删掉一个号后又扫了同一个微信号，看到「已写入号池」却发现池子小了一个，
// 于是判定"加号功能坏了"。这一场把 新增/就地更新 两套文案的分叉钉住。
calls.length = 0; inserted = null; issuedState = null;
process.env.QPP_LOGIN_URL = base + '/loginpage5?state=%STATE%';
const mgrI = new LoginManager({
  log: () => {},
  onDone: a => { inserted = a; return { id: 'qclaw-1911858646', reused: 'qclaw-1911858646', poolSize: 2 }; }
});
const sI = await mgrI.start();
let outI = sI;
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500));
  outI = mgrI.get(sI.loginId);
  if (outI.status === 'done' || outI.status === 'failed') break;
}
checks.push(
  ['[I] 重复微信号仍走完兑换并入池', outI.status === 'done' && !!inserted && inserted.account === 999005],
  ['[I] 日志说「已就地更新」而不是"新增了号"',
    (outI.log || []).some(l => /已就地更新 qclaw-1911858646 的凭据/.test(l))],
  ['[I] 并给出下一步：要加新号得换微信号',
    (outI.log || []).some(l => /号池数量不变/.test(l) && /另一个微信号/.test(l))],
  ['[I] reused/poolSize 透出给管理端（界面靠它选文案）',
    outI.reused === 'qclaw-1911858646' && outI.poolSize === 2],
  ['[I] 含糊的「已写入号池」在两个分支里都不出现',
    ![...(outI.log || []), ...(outF.log || [])].some(l => /已写入号池/.test(l))]
);
mgrI.cancel(sI.loginId);

// ---- 场景 J：入池那一步本身失败（写盘被拒、账号没过校验）。
// done 一到界面就停止轮询，所以 done 必须在入池返回之后才许报 —— 先报后输的话，
// 那次失败用户永远看不到，只会以为"提示成功了但号池没动"。
calls.length = 0; issuedState = null;
process.env.QPP_LOGIN_URL = base + '/loginpage5?state=%STATE%';
const mgrJ = new LoginManager({
  log: () => {},
  onDone: async () => { await new Promise(r => setTimeout(r, 1200)); throw new Error('账号无效（桩）'); }
});
const sJ = await mgrJ.start();
const seenJ = [];
let outJ = sJ;
for (let i = 0; i < 240; i++) {
  await new Promise(r => setTimeout(r, 50));
  outJ = mgrJ.get(sJ.loginId);
  if (outJ && !seenJ.includes(outJ.status)) seenJ.push(outJ.status);
  if (outJ?.status === 'done' || outJ?.status === 'failed') break;
}
checks.push(
  ['[J] 入池失败落在 failed 并带上原因', outJ.status === 'failed' && /入池失败: 账号无效/.test(outJ.error || '')],
  ['[J] 报出 failed 之前从未报过 done', !seenJ.includes('done')],
  ['[J] 空档期状态是 saving（界面不会停在"请在手机上确认"）', seenJ.includes('saving')],
  ['[J] 失败过程写进了会话日志', (outJ.log || []).some(l => /入池失败/.test(l))]
);
mgrJ.cancel(sJ.loginId);

// ---- 场景 G：4050 前两次掐断连接，第三次才通 —— 云服务器到 jprx 的出口实测就是这样抖的。
// 修之前：一次连不上就降级用自造 state，页面照常出码，朋友扫完才在兑换那步被 code=4 挡回来；
// 修之后：连接层失败退避重试（业务码 21004 之类不重试，那是签名错了，重试无意义）。
calls.length = 0; inserted = null; issuedState = null; stateFlaky = 2;
process.env.QPP_LOGIN_URL = base + '/loginpage-g?state=%STATE%';
const mgrG = new LoginManager({ log: () => {}, onDone: a => { inserted = a; } });
const sG = await mgrG.start();     // state 这一步在 start() 里同步做完，返回时重试已经跑过
checks.push(
  ['[G] 4050 连接层失败被退避重试（一共打了 3 次）', calls.filter(c => c === 'bus:4050').length === 3],
  ['[G] 最终用的仍是服务端签发的 state（没退化成自造值）',
    !!issuedState && (sG.log || []).some(l => /4050 签发/.test(l)) && !(sG.log || []).some(l => /暂用自造值/.test(l))],
  ['[G] "第几次才通"写进了日志', (sG.log || []).some(l => /第 3 次才通/.test(l))],
  ['[G] 抖动没影响出码', sG.status === 'waiting' && !!sG.qrImage]
);
stateFlaky = 0;
mgrG.cancel(sG.loginId);

// ---- 场景 H：服务退出时必须把进行中的会话连同无头浏览器一起带走。
// 发版 kill 掉服务时若还有会话在跑，chromium 会被 init 收养：云服务器实测因此漏过
// 21 个进程（主进程 RSS 215MB），而它持着的 tmpfs profile 目录此后谁都删不掉。
// 平时那套删除重试的 timer 全是 unref 的，进程一 exit 就没了 —— 所以 shutdown 必须自己等到位。
calls.length = 0;
process.env.QPP_LOGIN_URL = base + '/loginpage-g?state=%STATE%';
const mgrH = new LoginManager({ log: () => {}, onDone: () => {} });
const sH = await mgrH.start();
const sessH = mgrH.sessions.get(sH.loginId);
const uddH = sessH?.udd;
await mgrH.shutdown();
checks.push(
  ['[H] shutdown 把进行中的会话标成 expired', mgrH.get(sH.loginId).status === 'expired'],
  ['[H] shutdown 真的删掉了临时 profile 目录（不是等 unref 的定时器）',
    !!uddH && !fs.existsSync(uddH), uddH || '没建出目录'],
  ['[H] 会话记录里的 udd 已置空（不会被二次删）', sessH?.udd === null],
  ['[H] 空转的 shutdown 不炸（没有会话时可直接调用）', (await mgrH.shutdown()) === undefined]
);

let bad = 0;
for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) bad++; }
console.log('\n场景 B 日志:\n' + outB.log.map(l => '  ' + l).join('\n'));
stub.close();
mgr.cancel(sess.loginId);
console.log(bad ? `\n${bad} 项失败` : '\n登录链路全部通过');
console.log(`合计 ${checks.length - bad} 通过 / ${bad} 失败`);
// 等桩把在途连接收尾再退出，但别无限等：undici 的 keep-alive 能让 close 永不回调
await Promise.race([new Promise(r => stub.close(r)), new Promise(r => setTimeout(r, 1500))]);
// 临时 profile 是退避重试删的（那些 timer 都 unref 过，不留住事件循环），而这里马上 process.exit ——
// 不等一下就是"跑一次测试漏一串目录"。生产进程长驻，没这个问题。
await new Promise(r => setTimeout(r, 1400));
process.exit(bad ? 1 : 0);
