// QClaw 业务总线（jprx）客户端：只依赖 fetch + node:crypto，可在无 QClaw 的服务器上运行。
//
// 总线是统一转发形式：POST https://jprx.m.qq.com/data/<apiId>/forward
// 鉴权只需 X-OpenClaw-Token（登录态 JWT）+ X-Guid + X-Account；
// 实测设备令牌 X-Qclaw-DeviceToken 与 JPrx-Ctx 签名对这里用到的 apiId 都不是必需的。
// 响应统一是 {ret, data:{resp:{common:{code,message}, data}}}，code===0 为成功，
// 21004 表示登录态失效。
// 例外是扫码登录那两条（4050/4026）：它们不看登录态，看下面 webSignHeaders() 的 HMAC 签名。

import crypto from 'node:crypto';


// 可覆盖是为了能做端到端离线验证（scripts/login-e2e.mjs 用桩总线跑通整条登录链）。
// 必须在使用时读环境变量：模块加载期取值会让调用方设置 env 完全失效。
export const JPRX_DEFAULT = 'https://jprx.m.qq.com/';
export const jprxBase = () => process.env.QPP_JPRX_BASE || JPRX_DEFAULT;
export const AIZONE_BASE = 'https://mmgrcalltoken.3g.qq.com/aizone/v1/';

export const BUS = {
  modelStatus: '4320',
  modelRates: '4327',
  createApiKey: '4055',
  quota: '4708',
  todayTokens: '4075',
  qpoint: '4110',
  refreshChannelToken: '4058',
  userInfo: '4027',
  wxLogin: '4026',
  wxLoginMobile: '4630',
  wxLoginState: '4050',
  createIOAState: '4072',
  checkIOAState: '4073'
};

const WEB = { web_version: '1.4.0', web_env: 'release' };

export class BusError extends Error {
  constructor(message, { code, http, apiId, transport = false } = {}) {
    super(message);
    this.name = 'BusError';
    this.code = code;
    this.http = http;
    this.apiId = apiId;
    // transport=true 表示"根本没连通"（连接/超时/非 JSON），这类重试有可能救回来；
    // 业务码（21004、4 …）是确定性拒绝，重试只是浪费时间。调用方按这个字段分流。
    this.transport = transport;
  }
}

function busHeaders({ guid, account, jwt, token }) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-version': '1',
    'x-token': token || '',
    'x-session': '',
    'x-guid': guid || '1',
    'x-account': String(account || '1'),
    'x-openclaw-token': jwt || ''
  };
}

/** 剥掉外壳拿业务 data；兼容 resp 直接挂字段与 resp.data 两层嵌套。 */
function unwrap(json) {
  const resp = json?.data?.resp ?? json?.resp ?? json?.data ?? json;
  const common = resp?.common ?? (resp?.code !== undefined ? { code: resp.code, message: resp.msg } : null);
  if (common && Number(common.code) !== 0) {
    throw new BusError(`总线 ${common.code}: ${common.message || ''}`, { code: common.code });
  }
  return resp?.data ?? resp;
}

/**
 * ── 网页版通道（qclaw.qq.com 官网自己的扫码登录用的就是这一套）───────────────
 * 与桌面端的 JPrx-Ctx 是两套签名。缺这三个头时 4026/4050 回
 * `21004 鉴权不通过，请升级最新版本` —— 那是签名校验失败，不是接口下线（我们曾据此误判过一次）。
 * 算法（从官网 bundle 还原）：把 body 的键连同 `timestamp` 一起排序，拼成 `k=v&k=v&timestamp=ms`，
 * HMAC-SHA256 取 hex；密钥是那串 64 位十六进制**字符串本身的 UTF-8 字节**，不是 hex 解码后的 32 字节。
 * 另带 `X-OpenClaw-ClientVersion`（官网构建期常量，默认 1.0.0）。
 */
export const WEB_SIGN_SECRET = '2fc7c82b2cdc2a6083239d343843adf314b571dd0ee036163b61fb209be47492';
export const webSignSecret = () => process.env.QPP_WEB_SIGN_SECRET || WEB_SIGN_SECRET;
export const webClientVersion = () => process.env.QPP_WEB_CLIENT_VERSION || '1.0.0';

export function webSignHeaders(body, { secret = webSignSecret(), timestamp = Date.now() } = {}) {
  const ts = String(timestamp);
  const str = [...Object.keys(body), 'timestamp'].sort().map(k => {
    if (k === 'timestamp') return 'timestamp=' + ts;
    const v = body[k];
    return k + '=' + (v == null ? '' : typeof v === 'string' ? v : String(v));
  }).join('&');
  return {
    'x-sign-timestamp': ts,
    'x-sign-signature': crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex'),
    'x-openclaw-clientversion': webClientVersion()
  };
}

/** 网页通道调用：匿名 + 签名。业务错误码**原样返回**（登录要看具体是哪一步拒的），只有传输层失败才抛。 */
export async function webCall(apiId, body, { timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetch(new URL(`data/${apiId}/forward`, jprxBase()).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...webSignHeaders(body) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    throw new BusError(`登录通道不可达 (${apiId}): ${e.message}`, { apiId, transport: true });
  }
  const json = await res.json().catch(() => null);
  if (!json) throw new BusError(`登录通道 ${apiId} 返回非 JSON (HTTP ${res.status})`, { http: res.status, apiId, transport: true });
  const resp = json?.data?.resp ?? json?.resp ?? json?.data ?? json;
  const common = resp?.common ?? (resp?.code !== undefined ? { code: resp.code, message: resp.msg } : null);
  return {
    code: Number(common?.code ?? -1),
    message: String(common?.message ?? ''),
    data: resp?.data ?? null
  };
}

/** 扫码登录第一步：state 必须由服务端签发并绑在 guid 上（自造的 state 会被 4026 以「state 无效或已过期」拒掉）。 */
export async function webLoginState(guid, opts) {
  const r = await webCall(BUS.wxLoginState, { guid }, opts);
  if (!r.data?.state) throw new BusError(`${BUS.wxLoginState} 未返回 state: ${r.code} ${r.message}`, { code: r.code, apiId: BUS.wxLoginState });
  return r.data.state;
}

/** 网页通道的设备 guid：官网用 `qclawmp_<uuid>`（不是桌面端那串 64 hex），换 state 与兑换必须同一个。 */
export function webGuid() { return process.env.QPP_WEB_GUID || 'qclawmp_' + crypto.randomUUID(); }

export async function busCall(apiId, body, auth, { timeoutMs = 15000 } = {}) {
  const url = new URL(`data/${apiId}/forward`, jprxBase()).href;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: busHeaders(auth),
      body: JSON.stringify({ ...body, ...WEB }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    throw new BusError(`总线不可达 (${apiId}): ${e.message}`, { apiId });
  }
  const text = await res.text().catch(() => '');
  let json;
  try { json = JSON.parse(text); } catch {
    throw new BusError(`总线 ${apiId} 返回非 JSON (HTTP ${res.status})`, { http: res.status, apiId });
  }
  if (!res.ok) throw new BusError(`总线 ${apiId} HTTP ${res.status}`, { http: res.status, apiId });
  return unwrap(json);
}

/** 可用模型清单（id / name / 能力 / 上下文窗口） */
export async function busModelList(auth, opts) {
  const data = await busCall(BUS.modelStatus, {}, auth, opts);
  const list = data?.model_status_list || [];
  return list.map(m => ({
    id: m.display_id || m.id,
    name: m.name || m.id,
    description: m.description,
    capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
    contextWindow: Number(m.context_window) || 0
  }));
}

/**
 * 各模型的积分计费口径（4327）。"深度思考"是否可用看 4320 的 capabilities，
 * 一次调用花多少积分看这里的 input/output_rate —— 客户端要按 token 预算规划就得知道倍率。
 */
export async function busModelRates(auth, modelIds, opts) {
  const data = await busCall(BUS.modelRates, { model_ids: modelIds }, auth, opts);
  const out = {};
  for (const r of data?.rates || []) {
    out[r.model_id] = {
      tier: r.model_tier || '',
      inputRate: Number(r.input_rate) || 0,
      outputRate: Number(r.output_rate) || 0,
      multiplier: r.rate_multiplier || '',
      note: r.note || ''
    };
  }
  return out;
}

/** 该账号调用 aizone 推理要用的 sk- 密钥（服务端按账号固定返回） */
export async function busCreateApiKey(auth, opts) {
  const data = await busCall(BUS.createApiKey, {}, auth, opts);
  if (!data?.key) throw new BusError('4055 未返回 key');
  return data;
}

/**
 * 该账号的免费额度状态（4708）。号池靠它判断"这个号还有没有额度"，
 * 而不是等请求失败才发现账号已耗尽。
 */
export async function busQuota(auth, opts) {
  const data = await busCall(BUS.quota, { deduct: false }, auth, opts);
  return {
    canUse: data?.can_use === true,
    source: data?.source || '',
    reason: data?.reason || '',
    trialType: data?.trial_type ?? 0,
    remaining: data?.trial_remaining ?? null,
    used: data?.trial_used ?? null,
    trialExpiresAt: data?.trial_expires_at || '',
    purchaseExpiresAt: data?.purchase_expires_at || ''
  };
}

/**
 * 用授权 code 换登录态。默认接口 4026 现被服务端下线，所以 apiId 由调用方给定，
 * 便于扫码后按实际抓到的接口直接配置重试。
 * 成功返回 {token, openclaw_channel_token, user_info, loginKey}
 */
export async function busExchange(apiId, { guid, code, state, loginKey, account }, opts) {
  const data = await busCall(apiId, { guid, code, state },
    { guid, account: account || '1', jwt: '', token: loginKey }, opts);
  if (!data?.token) throw new BusError(`${apiId} 未返回 token`);
  return data;
}

/**
 * 账号余额（4110，QClaw 客户端"积分"面板的同一个接口）。
 * 这才是免费额度的真口径：balance 是剩余积分，items[] 是各笔赠送（活动/订阅/积分包）及其到期日。
 * 推理按 4327 的倍率扣积分，所以"还能不能继续用"要看这里，不是看 token 数。
 */
export async function busCredits(auth, opts) {
  const d = await busCall(BUS.qpoint, {}, auth, opts);
  const det = d?.balance_detail || {};
  const money = v => Math.round((Number(v) || 0) * 100) / 100;
  return {
    balance: money(d?.balance),
    activity: money(det.activity_q),
    subscription: money(det.subscription_q),
    package: money(det.package_q),
    dailyFree: money(det.daily_free),
    totalDailyFreeGranted: money(d?.total_daily_free_granted),
    items: (Array.isArray(det.items) ? det.items : []).map(i => ({
      label: i.label || '',
      total: money(i.total_amount),
      remain: money(i.remain_amount),
      expireAt: i.expire_time || '',
      productType: Number(i.product_type) || 0
    })),
    asOf: new Date().toISOString()
  };
}

/**
 * 今日 token 用量与 RPM（4075）。和积分是两回事：积分是钱包，这个是当日的流量闸口，
 * 两个都留着才能解释"有积分却被限流"和"积分见底"这两种不同的失败。
 */
export async function busTokens(auth, opts) {
  const d = await busCall(BUS.todayTokens, {}, auth, opts);
  const limit = Number(d?.daily_token_limit) || 0;
  const used = Number(d?.daily_token_used) || 0;
  return {
    dailyLimit: limit,
    dailyUsed: used,
    remaining: Math.max(0, limit - used),
    usedPct: limit ? +(used / limit * 100).toFixed(2) : 0,
    rpmLimit: Number(d?.rpm_limit) || 0,
    asOf: new Date().toISOString()
  };
}

/**
 * 账号身份（4027）。unionid 是同一微信用户在开放平台下的稳定标识：
 * 同一微信号多次扫码上号时靠它认出"还是那个号"，避免在池子里堆成多条记录。
 * 注意 openid 按 appid 变、管家 accountId 与 QClaw user_id 也不同源，只有 unionid 能当主键。
 */
export async function busIdentity(auth, opts) {
  const d = await busCall(BUS.userInfo, {}, auth, opts);
  return {
    userId: d?.user_id ?? auth.account ?? null,
    openid: d?.openid || '',
    unionid: d?.unionid || '',
    nickname: d?.nickname || '',
    avatar: d?.head_img_url || ''
  };
}

/** 总线原始调用：不做「必须返回 token」的断言，供登录探测未知接口时用。 */
export async function busCallRaw(apiId, body, auth, opts) {
  return busCall(apiId, body, auth, opts);
}

// 管家网页登录中继页（security.guanjia.qq.com/login 的 /wxLogin 父页）真正调的兑换接口。
// 走 luban 网关而不是 jprx：不带签名、不带 cookie，jprx 的 4026/4050/4072 整族下线后
// 这是唯一还在应答的 code 兑换入口。
export const LUBAN_DEFAULT = 'https://luban.m.qq.com/api/public/pcmgr/';
export const lubanBase = () => process.env.QPP_LUBAN_BASE || LUBAN_DEFAULT;

/**
 * 微信授权 code → 管家会话。
 * 返回 retCode：0=成功，2=code 无效/已使用/已过期，50=账号已注销；
 * 成功时带 {loginkey, accountId, thirdPartyAccInfo:{accessToken, refreshToken, unionId, nickName, headUrl}}。
 * loginAccType：管家网页硬编码 32，中继页给 QClaw 传 2，所以两者都试。
 */
export async function sendLoginCode({ code, guid, loginAccType = 2 }, { timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetch(new URL('sendLoginCode', lubanBase()).href, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: 'https://security.guanjia.qq.com',
        referer: 'https://security.guanjia.qq.com/',
        'user-agent': 'QClaw'
      },
      body: JSON.stringify({ code, guid, loginAccType }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    throw new BusError(`sendLoginCode 不可达: ${e.message}`);
  }
  const json = await res.json().catch(() => null);
  if (!json?.result?.resp) {
    throw new BusError(`sendLoginCode HTTP ${res.status}: ${(JSON.stringify(json) || '').slice(0, 180)}`);
  }
  return { ...json.result.resp, traceid: json.traceid || '' };
}
