// 上游适配层：把一次"模型调用"翻译成具体账号的 HTTP 请求。
//
// 三种账号类型：
//   qclaw-aizone —— QClaw 免费额度模型的真实上游（免签直连，服务器上无需 QClaw）。
//     POST https://mmgrcalltoken.3g.qq.com/aizone/v1/chat/completions
//     Authorization: Bearer <sk->（由总线 4055 按账号签发）+ X-OpenClaw-Token: <登录 JWT>
//     + X-Conversation-Request-ID: <uuid>（缺了会 400 invalid_request）。
//     model 用裸 pool-* 名，不加任何前缀。
//   openclaw-gateway —— QClaw 内嵌的 OpenClaw 网关（本机 127.0.0.1:33187 一类）。
//     它只按 agent 路由：POST /v1/chat/completions + model=openclaw/<agentId>，
//     鉴权用 ~/.qclaw/openclaw.json 里的 gateway.auth.token。
//     模型选择靠 modelAgents 把 qclaw/pool-* 映射到绑定了该模型的 agent。
//   openai-compat —— 标准 OpenAI 兼容上游。
//     POST {base}/chat/completions + Bearer apiKey，model 原样透传。

import { randomUUID } from 'node:crypto';

import { AIZONE_BASE, busModelList } from './qclaw-api.mjs';

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

export class UpstreamError extends Error {
  constructor(message, { status = 0, kind = 'upstream', retryable = false, account, safe = '' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.kind = kind;
    this.retryable = retryable;
    this.account = account;
    // 对外可见的措辞。message 里带账号 id 与上游原文，那些是号池拓扑与内部信息，
    // 只能进日志和管理端，不能顺着 /v1/* 发给任意持密钥的租户。
    this.safe = safe;
  }
}

function authHeaders(account) {
  const token = account.token || account.apiKey;
  return { authorization: `Bearer ${token}` };
}

/** 剥掉客户端可能带的 provider 前缀，得到裸模型 id */
export function bareModel(model, prefix) {
  if (!model) return model;
  const m = String(model).trim();
  if (prefix && m.startsWith(prefix)) return m.slice(prefix.length);
  if (m.startsWith('qclaw/')) return m.slice('qclaw/'.length);
  return m;
}

const withSlash = b => (b.endsWith('/') ? b : b + '/');

/** 解析请求的模型在该账号下应当走哪个 agent（仅 openclaw-gateway 有意义） */
export function resolveAgent(account, model) {
  const bare = bareModel(model, 'qclaw/');
  if (bare.startsWith('agent:')) return bare.slice(6);
  if (bare.startsWith('openclaw/')) return bare.slice('openclaw/'.length) || account.defaultAgent || 'main';
  const map = account.modelAgents || {};
  if (map[bare]) return map[bare];
  if (map[model]) return map[model];
  const anyKey = Object.keys(map).find(k => bareModel(k, 'qclaw/') === bare);
  if (anyKey) return map[anyKey];
  return account.defaultAgent || 'main';
}

export function chatRequest(account, { model, payload }) {
  const headers = { ...JSON_HEADERS, ...authHeaders(account), ...(account.headers || {}) };
  if (account.type === 'qclaw-aizone') {
    const base = withSlash(account.base || AIZONE_BASE);
    return {
      url: new URL('chat/completions', base).href,
      headers: {
        ...headers,
        'x-openclaw-token': account.jwt || '',
        'x-conversation-request-id': randomUUID()
      },
      body: { ...payload, model: bareModel(model, 'qclaw/') }
    };
  }
  if (account.type === 'openclaw-gateway') {
    const agent = resolveAgent(account, model);
    return {
      url: new URL('v1/chat/completions', account.base.endsWith('/') ? account.base : account.base + '/').href,
      headers,
      body: { ...payload, model: `openclaw/${agent}` }
    };
  }
  const base = account.base.endsWith('/') ? account.base : account.base + '/';
  return {
    url: new URL('chat/completions', base).href,
    headers,
    body: { ...payload, model: bareModel(model, 'qclaw/') }
  };
}

export async function fetchModels(account, timeoutMs) {
  if (account.type === 'qclaw-aizone') {
    // 目录走总线 4320，不是 aizone（后者没有 /models）。
    const models = await busModelList(
      { guid: account.guid, account: account.account, jwt: account.jwt },
      { timeoutMs }
    );
    return models.map(m => ({ id: m.id, owned_by: 'qclaw-aizone', name: m.name, capabilities: m.capabilities || [], contextWindow: m.contextWindow || 0 }));
  }
  const roots = [withSlash(account.catalogBase || account.base), withSlash(account.base)];
  const candidates = account.type === 'openclaw-gateway'
    ? ['proxy/llm/models', 'v1/models']
    : ['models'];
  const errs = [];
  for (const root of [...new Set(roots)]) {
    for (const p of candidates) {
      const url = new URL(p, root).href;
      try {
        const res = await fetch(url, {
          headers: { ...authHeaders(account), accept: 'application/json', ...(account.headers || {}) },
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) { errs.push(`${url} -> ${res.status}`); continue; }
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { errs.push(`${url} -> 非 JSON 响应`); continue; }
        if (!data?.data) { errs.push(`${url} -> 缺少 data 字段`); continue; }
        return data.data.map(m => ({ id: m.id, owned_by: m.owned_by || account.type, contextWindow: m.contextWindow, name: m.name }));
      } catch (e) {
        errs.push(`${url} -> ${e.name}: ${e.message}`);
      }
    }
  }
  throw new UpstreamError(`目录拉取失败: ${errs.join(' | ')}`, { kind: 'catalog', retryable: true, account: account.id });
}

/**
 * 发起一次对话补全。返回原始 fetch Response（调用方负责流式消费）。
 */
export async function callChat(account, model, payload, timeoutMs) {
  const req = chatRequest(account, { model, payload });
  let res;
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    throw new UpstreamError(timedOut ? `上游超时 (${account.id})` : `上游不可达 (${account.id}): ${e.message}`, {
      status: 0, kind: timedOut ? 'timeout' : 'network', retryable: true, account: account.id
    });
  }
  if (res.ok) return await absorbBusError(res, account);

  const text = (await res.text().catch(() => '')).slice(0, 500);
  // 上游的参数校验错误（proxy_param_error / invalid_request / bad_request）是**调用方**写错了报文：
  // 换号没用、冷却账号更不该算在账号头上。不区分的话，客户端一个坏参数就能把整个号池打进冷却，
  // 等于让单个租户对着公共池子做拒绝服务，而且返回的还是语义错误的 502。
  const paramErr = isParamError(res.status, text);
  const brief = paramErr ? briefParamError(text) : text.slice(0, 160);
  throw new UpstreamError(`上游 ${paramErr ? 400 : res.status} (${account.id}): ${brief || res.statusText}`, {
    status: paramErr ? 400 : res.status,
    kind: paramErr ? 'client_param' : res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : 'upstream',
    retryable: !paramErr && (res.status === 429 || res.status >= 500),
    account: account.id,
    safe: paramErr ? `请求参数被上游拒绝：${brief}` : ''
  });
}

const PARAM_ERR_TYPES = new Set(['proxy_param_error', 'invalid_request', 'invalid_request_error', 'bad_request']);

export function isParamError(status, text) {
  if (status !== 400) return false;
  try {
    const j = JSON.parse(text);
    const t = String(j?.error?.type || j?.type || '');
    const c = String(j?.error?.code || j?.code || '');
    return PARAM_ERR_TYPES.has(t) || c === '1400';
  } catch { return false; }
}

function briefParamError(text) {
  try {
    const j = JSON.parse(text);
    return String(j?.error?.message || j?.message || text).slice(0, 160);
  } catch { return text.slice(0, 160); }
}

/**
 * 总线/AIGW 的失败经常是 HTTP 200 + {"common":{"code":21004}}（登录态失效）。
 * 不识别它就会把错误当结果透给客户端，号池也不会切号。
 * 只在 content-type 是 JSON 时缓冲正文；SSE 流直接原样返回。
 */
async function absorbBusError(res, account) {
  if (!res.headers.get('content-type')?.includes('json')) return res;
  const text = await res.text();
  const init = { status: res.status, statusText: res.statusText, headers: res.headers };
  let code;
  try { code = JSON.parse(text)?.common?.code; } catch { return new Response(text, init); }
  if (code === undefined || Number(code) === 0) return new Response(text, init);
  throw new UpstreamError(`上游业务码 ${code} (${account.id}): 登录态可能已失效`, {
    status: res.status,
    kind: Number(code) === 21004 ? 'auth' : 'upstream',
    retryable: false,
    account: account.id
  });
}
