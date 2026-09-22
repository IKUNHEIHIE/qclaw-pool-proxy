// 对外 API 密钥：签发、吊销、轮换、限流、配额、模型白名单、用量计量。
//
// 设计约束：1c1g 上不能每请求写盘，所以用量先在内存里累加，由 flush() 定时落进 config.json；
// 限流用滑动时间窗（不依赖外部存储），配额按 UTC 日切。

import crypto from 'node:crypto';

const WINDOW_MS = 60 * 1000;
const MAX_LOG = 500;

export function maskKey(k) {
  if (!k) return '';
  return k.length <= 12 ? '•'.repeat(k.length) : `${k.slice(0, 7)}…${k.slice(-4)}`;
}

export function newKey() { return 'vk-' + crypto.randomBytes(16).toString('hex'); }

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * 无 usage 字段时的 token 估算：中日韩近似 1 字 1 token，其余 4 字 1 token。
 * 只扫前 64KB 且绝不物化匹配数组 —— 请求体上限 32MB，用 s.match(/.../g) 计数会
 * 为每个 CJK 字符分配一个数组元素，单个请求就能把 220MB 的堆顶爆。
 */
export const ESTIMATE_CAP = 65536;
const CJK_RANGES = [0x3000,0x30ff,0x3400,0x4dbf,0x4e00,0x9fff,0xf900,0xfaff,0xac00,0xd7af];
export function estimateTokens(text) {
  const s = String(text || '');
  const end = Math.min(s.length, ESTIMATE_CAP);
  let cjk = 0;
  for (let i = 0; i < end; i++) {
    const c = s.charCodeAt(i);
    for (let j = 0; j < CJK_RANGES.length; j += 2) {
      if (c >= CJK_RANGES[j] && c <= CJK_RANGES[j + 1]) { cjk++; break; }
    }
  }
  return cjk + Math.ceil((end - cjk) / 4);
}

/** 旧配置里 clientKeys 可能是字符串数组，统一成对象 */
export function normalizeKey(raw) {
  if (typeof raw === 'string') return { key: raw, name: '未命名', createdAt: new Date().toISOString() };
  return { createdAt: new Date().toISOString(), ...raw };
}

/** 模型名去掉 qclaw/ 前缀后再比对，客户端两种写法都能用 */
function normModel(m, prefix) {
  const s = String(m || '');
  return prefix && s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

export class KeyStore {
  constructor(cfg) {
    this.cfg = cfg;
    cfg.clientKeys = (cfg.clientKeys || []).map(normalizeKey);
    this.live = new Map();          // key -> { hits: [ts], day, dayCount }
    // 日配额必须跨重启成立：snapshotForSave() 写进了 k.usage，启动时原样读回来，
    // 否则每次部署都等于给所有密钥重置了一遍配额。
    const today = utcDay();
    for (const k of cfg.clientKeys) {
      if (k.usage && k.usage.day === today) {
        this.live.set(k.key, { hits: [], day: today, dayCount: Number(k.usage.requests) || 0 });
      }
    }
    this.requests = [];             // 对外请求日志（环形，供 WebUI/审计看）
    this.totals = { requests: 0, ok: 0, failed: 0, denied: 0, promptTokens: 0, completionTokens: 0 };
  }

  all() { return this.cfg.clientKeys; }

  /**
   * 密钥索引。所有增删改都走 KeyStore，所以手动维护比每请求线性扫更可靠；
   * rotate 会原地改 key 值，必须同步换键，否则旧值还能查到、新值查不到。
   */
  reindex() {
    this.index = new Map(this.cfg.clientKeys.map(k => [k.key, k]));
    const alive = new Set(this.index.keys());
    for (const k of this.live.keys()) if (!alive.has(k)) this.live.delete(k);   // 清掉被外部改配置留下的孤儿计数
    return this.index;
  }

  find(key) { return (this.index || this.reindex()).get(key) || null; }

  /** 给管理端看的视图：带用量汇总，密钥原文保留（能拿到 adminToken 的人本来就能读 config.json） */
  list() {
    return this.cfg.clientKeys.map(k => ({
      key: k.key,
      masked: maskKey(k.key),
      name: k.name || '未命名',
      note: k.note || '',
      createdAt: k.createdAt || '',
      expiresAt: k.expiresAt || null,
      enabled: k.enabled !== false,
      models: k.models || [],
      rpm: k.rpm || 0,
      dailyRequests: k.dailyRequests || 0,
      maxTokens: k.maxTokens || 0,
      stats: k.stats || { requests: 0, ok: 0, failed: 0, promptTokens: 0, completionTokens: 0, lastUsedAt: null },
      today: this.#live(k.key).dayCount
    }));
  }

  #live(key) {
    let l = this.live.get(key);
    if (!l) { l = { hits: [], day: utcDay(), dayCount: 0 }; this.live.set(key, l); }
    const d = utcDay();
    if (l.day !== d) { l.day = d; l.dayCount = 0; }
    return l;
  }

  create(raw) {
    const { name, note, models, rpm, dailyRequests, maxTokens, expiresDays } = raw || {};
    const rec = {
      key: newKey(),
      name: String(name || '').trim() || '未命名',
      note: String(note || '').trim(),
      createdAt: new Date().toISOString(),
      enabled: true
    };
    if (Array.isArray(models) && models.length) rec.models = models.map(String);
    if (Number(rpm) > 0) rec.rpm = Math.floor(Number(rpm));
    if (Number(dailyRequests) > 0) rec.dailyRequests = Math.floor(Number(dailyRequests));
    if (Number(maxTokens) > 0) rec.maxTokens = Math.floor(Number(maxTokens));
    if (Number(expiresDays) > 0) {
      rec.expiresAt = new Date(Date.now() + Number(expiresDays) * 86400000).toISOString();
    }
    this.cfg.clientKeys.push(rec);
    this.index = null;
    return rec;
  }

  update(key, raw) {
    const rec = this.find(key);
    if (!rec) return null;
    const patch = raw || {};
    for (const f of ['name', 'note']) if (patch[f] !== undefined) rec[f] = String(patch[f]);
    for (const f of ['rpm', 'dailyRequests', 'maxTokens']) {
      if (patch[f] === undefined) continue;
      const n = Math.floor(Number(patch[f]));
      if (n > 0) rec[f] = n; else delete rec[f];
    }
    if (patch.models !== undefined) {
      if (Array.isArray(patch.models) && patch.models.length) rec.models = patch.models.map(String);
      else delete rec.models;
    }
    if (patch.enabled !== undefined) rec.enabled = !!patch.enabled;
    if (patch.expiresAt !== undefined) {
      if (patch.expiresAt) rec.expiresAt = new Date(patch.expiresAt).toISOString();
      else delete rec.expiresAt;
    }
    // 编辑面板用"还剩几天"更直观，语义与创建时保持一致；0 = 清除有效期
    if (patch.expiresDays !== undefined) {
      const d = Math.floor(Number(patch.expiresDays));
      if (d > 0) rec.expiresAt = new Date(Date.now() + d * 86400000).toISOString();
      else delete rec.expiresAt;
    }
    return rec;
  }

  rotate(key) {
    const rec = this.find(key);
    if (!rec) return null;
    const fresh = 'vk-' + crypto.randomBytes(16).toString('hex');
    this.live.delete(rec.key);
    rec.key = fresh;
    this.index = null;   // 键值变了，旧索引必须作废
    return rec;
  }

  remove(key) {
    const i = this.cfg.clientKeys.findIndex(k => k.key === key);
    if (i < 0) return false;
    this.cfg.clientKeys.splice(i, 1);
    this.live.delete(key);
    this.index = null;
    return true;
  }

  /** 该密钥能用的模型（供 /v1/models 过滤） */
  allowsModel(rec, model) {
    const allow = rec?.models;
    if (!allow || !allow.length) return true;
    const prefix = this.cfg.upstream?.modelPrefix || '';
    const want = normModel(model, prefix);
    return allow.some(a => normModel(a, prefix) === want || a === '*');
  }

  /** 模型白名单单独校验：请求体解析出来之后才知道要访问哪个模型 */
  requireModel(rec, model) {
    if (this.allowsModel(rec, model)) return;
    throw Object.assign(
      new Error(`该密钥无权访问模型 ${model}（白名单：${(rec.models || []).join(', ')}）`),
      { statusCode: 403, errType: 'permission_denied', errCode: 'model_not_allowed', _model: model, _keyName: rec?.name }
    );
  }

  /**
   * 入站鉴权 + 授权。通过返回 { record }；不通过抛 { status, type, message, headers? }，
   * 由 server 直接转成 OpenAI 风格的错误体。
   */
  authorize(rawKey, { model } = {}) {
    // errCode 是给外部 SDK 分支用的稳定机器码：中文 message 会被改，code 不会
    const deny = (status, type, message, headers, errCode) => {
      const e = Object.assign(new Error(message), { statusCode: status, errType: type, errCode, headers });
      throw e;
    };
    if (!(this.cfg.clientKeys || []).length) {
      // 一个密钥都没配 = 全部拒绝。这是防误配，不是开放。
      deny(503, 'insufficient_quota', '本代理尚未签发任何客户端密钥（管理端「密钥」页创建一个后再调用）',
        null, 'no_keys_configured');
    }
    if (!rawKey) deny(401, 'authentication_error', '缺少 API 密钥（Authorization: Bearer vk-…）', null, 'missing_api_key');
    const rec = this.find(rawKey);
    if (!rec) deny(401, 'authentication_error', 'API 密钥无效', null, 'invalid_api_key');
    if (rec.enabled === false) deny(403, 'permission_denied', '该密钥已被停用', null, 'key_disabled');
    if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
      deny(401, 'authentication_error', `该密钥已于 ${rec.expiresAt} 过期`, null, 'key_expired');
    }
    const l = this.#live(rec.key);
    if (rec.rpm > 0) {
      const now = Date.now();
      l.hits = l.hits.filter(t => now - t < WINDOW_MS);
      if (l.hits.length >= rec.rpm) {
        const wait = Math.ceil((WINDOW_MS - (now - l.hits[0])) / 1000);
        deny(429, 'rate_limit_exceeded', `超出该密钥的速率限制（${rec.rpm} 次/分钟）`,
          { 'retry-after': String(Math.max(1, wait)), 'x-ratelimit-limit': String(rec.rpm) }, 'rpm_exceeded');
      }
      l.hits.push(now);
    }
    if (rec.dailyRequests > 0 && l.dayCount >= rec.dailyRequests) {
      deny(429, 'insufficient_quota', `该密钥今日请求数已达上限（${rec.dailyRequests} 次/天，UTC 日切）`,
        { 'retry-after': String(Math.max(1, Math.ceil((86400000 - (Date.now() % 86400000)) / 1000))) }, 'daily_quota_exceeded');
    }
    if (model && !this.allowsModel(rec, model)) {
      deny(403, 'model_not_allowed', `该密钥无权访问模型 ${model}（白名单：${(rec.models || []).join(', ')}）`,
        null, 'model_not_allowed');
    }
    l.dayCount++;
    this.totals.requests++;
    if (!rec.stats) rec.stats = { requests: 0, ok: 0, failed: 0, promptTokens: 0, completionTokens: 0, lastUsedAt: null };
    rec.stats.requests++;
    rec.stats.lastUsedAt = new Date().toISOString();
    return { record: rec, live: l };
  }

  /** 请求结束时记账。tokens 缺失时按字符数粗估，标注 est 让 UI 别把它当账单。 */
  record(rec, { ok, model, account, ms, status, promptTokens, completionTokens, promptText = '', stream, error }) {
    const t = this.totals;
    if (ok) t.ok++; else t.failed++;
    const p = promptTokens ?? estimateTokens(promptText);
    const c = completionTokens ?? 0;
    if (rec?.stats) {
      rec.stats[ok ? 'ok' : 'failed'] = (rec.stats[ok ? 'ok' : 'failed'] || 0) + 1;
      rec.stats.promptTokens = (rec.stats.promptTokens || 0) + p;
      rec.stats.completionTokens = (rec.stats.completionTokens || 0) + c;
    }
    t.promptTokens += p; t.completionTokens += c;
    this.requests.unshift({
      at: new Date().toISOString(),
      key: rec?.name || rec?.key || '-',
      model: model || '-', account: account || '-', status: status ?? (ok ? 200 : 500),
      ms: Math.round(ms || 0), stream: !!stream, ok: !!ok,
      promptTokens: p, completionTokens: c, error: error || null
    });
    if (this.requests.length > MAX_LOG) this.requests.length = MAX_LOG;
  }

  denied(error) {
    this.totals.denied++;
    this.requests.unshift({
      at: new Date().toISOString(), key: error?._keyName || '-', model: error?._model || '-',
      account: '-', status: error?.statusCode || 400, ms: 0, stream: false, ok: false,
      promptTokens: 0, completionTokens: 0, error: error?.message || String(error)
    });
    if (this.requests.length > MAX_LOG) this.requests.length = MAX_LOG;
  }

  /**
   * 已通过鉴权、但在后续环节被拒（模型白名单、请求体非法、超大…）。
   * authorize() 已经扣过 rpm/日配额，这类请求若不记账就会静默消耗预算且日志里查不到 ——
   * 而 /admin/log 正是对外解释"你为什么被限流"的唯一凭据。
   */
  recordDenied(rec, error) {
    this.totals.denied++;
    this.totals.failed++;
    if (rec?.stats) rec.stats.failed = (rec.stats.failed || 0) + 1;
    this.requests.unshift({
      at: new Date().toISOString(), key: rec?.name || '-', model: error?._model || '-',
      account: '-', status: error?.statusCode || 400, ms: 0, stream: false, ok: false,
      promptTokens: 0, completionTokens: 0, error: error?.message || String(error)
    });
    if (this.requests.length > MAX_LOG) this.requests.length = MAX_LOG;
  }

  /** 最近的对外请求日志（给 WebUI 与审计看） */
  recent(limit = 80) { return this.requests.slice(0, limit); }

  summary() {
    const keys = this.cfg.clientKeys;
    const active = keys.filter(k => k.enabled !== false && (!k.expiresAt || new Date(k.expiresAt) > new Date()));
    return {
      total: keys.length, active: active.length,
      todayRequests: keys.reduce((n, k) => n + this.#live(k.key).dayCount, 0),
      ...this.totals,
      errorRate: this.totals.requests ? +(this.totals.failed / this.totals.requests).toFixed(4) : 0
    };
  }

  /** 把内存里的用量写回 cfg.clientKeys[].stats/usage，由调用方决定何时 saveConfig */
  snapshotForSave() {
    for (const k of this.cfg.clientKeys) {
      const l = this.#live(k.key);
      k.usage = { day: l.day, requests: l.dayCount };
    }
    return this.cfg.clientKeys;
  }
}
