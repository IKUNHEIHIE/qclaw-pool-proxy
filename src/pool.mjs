import { busQuota, busCredits, busTokens, busIdentity, busModelRates } from './qclaw-api.mjs';
import { fetchModels, bareModel, UpstreamError } from './upstream.mjs';
import { supportsThinking } from './reasoning.mjs';

const now = () => Date.now();
const RATES_TTL = 10 * 60 * 1000;

/**
 * 号池：维护每个账号的健康度、冷却与目录缓存，并按策略挑选账号。
 * 纯内存状态 + 计数，无外部依赖，适合 1c1g。
 */
export class Pool {
  constructor(cfg, { persist = null } = {}) {
    this.persist = persist;
    this.cfg = cfg;
    this.state = new Map();
    this.cursor = 0;
    this.rates = { at: 0, byModel: {} };
    this.stats = { requests: 0, successes: 0, failures: 0, retries: 0, byAccount: {} };
  }

  accounts() {
    return this.cfg.accounts;
  }

  account(id) {
    return this.cfg.accounts.find(a => a.id === id);
  }

  runtime(id) {
    let s = this.state.get(id);
    if (!s) {
      s = { cooldownUntil: 0, failStreak: 0, ok: true, lastError: null, lastCheck: 0, lastLatencyMs: null, requests: 0, successes: 0, failures: 0, catalog: [], catalogAt: 0, quota: null, credits: null, tokens: null, identity: null };
      this.state.set(id, s);
    }
    return s;
  }

  /** 该账号是否能服务这个模型 */
  serves(account, model) {
    if (account.type === 'openclaw-gateway') {
      // agent 路由：任何模型都能落到一个 agent 上，除非显式限制了 supportedModels
      if (Array.isArray(account.supportedModels) && account.supportedModels.length) {
        const b = bareModel(model, 'qclaw/');
        return account.supportedModels.some(m => bareModel(m, 'qclaw/') === b);
      }
      return true;
    }
    const b = bareModel(model, 'qclaw/');
    // 没写 models 时以已加载的目录为准。目录一条都没有就**不接**：
    // 以前这里 return true（"没信息就当什么都能服务"），于是启动期 refreshAll 还没跑完时，
    // 未知模型名会被打到上游换回 400 → 客户端看到 502，而不是干净的 404。
    // 手工往 config 里加、且不带 models 的账号，由 /admin/accounts/upsert 立刻刷一次目录来兜。
    const listed = (Array.isArray(account.models) && account.models.length)
      ? account.models
      : (this.runtime(account.id).catalog || []).map(m => m.id);
    if (!listed.length) return false;
    return listed.some(m => bareModel(m, 'qclaw/') === b);
  }

  available(model, exclude = new Set()) {
    const t = now();
    return this.cfg.accounts.filter(a =>
      !exclude.has(a.id) &&
      a.enabled !== false &&
      this.runtime(a.id).cooldownUntil <= t &&
      this.serves(a, model)
    );
  }

  /**
   * 调用优先级：号池序号越小越优先；没编号的排在最后（9999）。
   *
   * 这里绝不能写 Number(a.priority)：Number(null) 与 Number('') 都是 0，
   * 于是"没编号"的老账号会集体抢到最高优先级 —— 语义正好反了。
   */
  static pri(a) {
    const v = a?.priority;
    if (v === null || v === undefined || v === '') return 9999;
    const n = Number(v);
    return Number.isFinite(n) ? n : 9999;
  }

  /**
   * 加权轮询；stickyKey 非空时对该 key 固定账号（利于上游缓存）
   *
   * 优先级语义是"先榨干高优先级的号"：只在最小序号那一档内轮询，
   * 而不是按序号排完再整体轮转 —— 后者会让 0 号只拿到 1/N 的流量，
   * 那就退化成加权轮询了。那一档全部冷却/停用后被 available() 滤掉，自然落到下一档。
   */
  pick(model, exclude, stickyKey) {
    const cands = this.available(model, exclude);
    if (!cands.length) return null;
    if (stickyKey && this.cfg.scheduler.stickyRouting) {
      let h = 2166136261;
      for (const ch of String(stickyKey)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
      return cands[Math.abs(h) % cands.length];
    }
    const ranked = [...cands].sort((a, b) =>
      Pool.pri(a) - Pool.pri(b) || (a.weight ?? 100) - (b.weight ?? 100));
    const top = ranked.filter(a => Pool.pri(a) === Pool.pri(ranked[0]));
    this.cursor = (this.cursor + 1) % Math.max(top.length, 1);
    return top[this.cursor % top.length];
  }

  markSuccess(id, latencyMs) {
    const s = this.runtime(id);
    s.ok = true; s.failStreak = 0; s.lastError = null; s.lastCheck = now();
    s.lastLatencyMs = latencyMs; s.requests++; s.successes++;
    this.stats.successes++;
    this.byAccount(id).successes++;
  }

  markFailure(id, err) {
    const s = this.runtime(id);
    const cfg = this.cfg.scheduler;
    if (err?.kind === 'client_param') {
      // 调用方把报文写坏了（上游 400 参数校验），不是这个号坏了：
      // 进冷却就等于允许任何一个客户端用一次坏请求瘫痪整个号池。
      s.requests++;
      s.lastError = err?.message?.slice(0, 300) ?? String(err);
      s.lastCheck = now();
      return;
    }
    s.ok = false; s.failStreak++; s.lastError = err?.message?.slice(0, 300) ?? String(err); s.lastCheck = now();
    s.requests++; s.failures++;
    this.stats.failures++;
    this.byAccount(id).failures++;
    const secs = err?.kind === 'auth' ? cfg.cooldownAuthFailSeconds
      : err?.kind === 'rate_limit' ? cfg.cooldownRateLimitSeconds
      : err?.status >= 500 || err?.kind === 'timeout' || err?.kind === 'network' ? cfg.cooldownServerErrorSeconds
      : cfg.cooldownServerErrorSeconds;
    const backoff = Math.min(secs * Math.max(1, s.failStreak), 15 * 60);
    s.cooldownUntil = now() + backoff * 1000;
  }

  byAccount(id) {
    if (!this.stats.byAccount[id]) this.stats.byAccount[id] = { requests: 0, successes: 0, failures: 0 };
    const t = this.stats.byAccount[id];
    const s = this.runtime(id);
    t.requests = s.requests; t.successes = s.successes; t.failures = s.failures;
    return t;
  }

  /** 尝试调用；失败自动切换账号，最多试 maxAttempts 个。opts.only 用于定向测试某个账号 */
  async run(model, payload, { stickyKey, maxAttempts = 3, only = null, allowUnavailable = false } = {}) {
    const tried = new Set();
    const errors = [];
    this.stats.requests++;
    if (only) {
      const acc = this.account(only);
      if (!acc) throw new UpstreamError(`未知账号 ${only}`, { status: 404, kind: 'unknown_account' });
      // 外部客户端可以用 x-qclaw-account 指定账号，但它不得绕过停用/冷却/服务能力这三道闸 ——
      // 冷却是本产品保护账号与免费额度的核心机制，绕过它等于让单个租户烧穿一个号。
      // 管理端定向测试（/admin/test）传 allowUnavailable 才能打停用或冷却中的号。
      if (!allowUnavailable) {
        if (acc.enabled === false) throw new UpstreamError(`账号 ${only} 已停用`, { status: 403, kind: 'account_disabled' });
        if (this.runtime(only).cooldownUntil > now()) throw new UpstreamError(`账号 ${only} 正在冷却`, { status: 429, kind: 'account_cooling' });
        if (!this.serves(acc, model)) throw new UpstreamError(`账号 ${only} 不服务模型 ${model}`, { status: 404, kind: 'model_not_found' });
      }
      const t0 = now();
      try {
        const res = await (await import('./upstream.mjs')).callChat(acc, model, payload, this.cfg.upstream.timeoutMs);
        this.markSuccess(acc.id, now() - t0);
        return { res, account: acc };
      } catch (e) {
        this.markFailure(acc.id, e);
        throw e;
      }
    }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const acc = this.pick(model, tried, stickyKey);
      if (!acc) break;
      tried.add(acc.id);
      const t0 = now();
      try {
        const res = await (await import('./upstream.mjs')).callChat(acc, model, payload, this.cfg.upstream.timeoutMs);
        this.markSuccess(acc.id, now() - t0);
        return { res, account: acc };
      } catch (e) {
        this.markFailure(acc.id, e);
        // 参数错误原样抛：号池没有"换个好号再试"的意义，包成 502 只会让调用方查错方向
        if (e.kind === 'client_param') throw e;
        errors.push(`${acc.id}: ${e.message}`);
        if (!e.retryable && e.kind !== 'auth') break; // 4xx 参数错误换号也没用
        if (attempt + 1 < maxAttempts) this.stats.retries++;
      }
    }
    const serveable = this.cfg.accounts.some(a => a.enabled !== false && this.serves(a, model));
    if (!serveable) {
      throw new UpstreamError(`没有账号能服务模型 ${model}`, { status: 404, kind: 'model_not_found', safe: `没有账号能服务模型 ${model}` });
    }
    throw new UpstreamError(
      errors.length ? `所有账号均失败: ${errors.join(' ; ')}` : '号池中无可用账号（可能全部处于冷却）',
      {
        status: errors.length ? 502 : 503,
        kind: 'pool_exhausted',
        account: tried,
        safe: errors.length ? '上游全部失败，请稍后重试（各账号的具体原因见 /admin/state 的 lastError）' : '号池暂时不可用（可能全部处于冷却），请稍后重试'
      }
    );
  }

  async refreshCatalog(id) {
    const acc = this.account(id);
    if (!acc) throw new Error('未知账号 ' + id);
    // 总线失败抛的是 BusError（没有 statusCode），会被错误处理当成 400 客户端错误；
    // 目录拉不到是上游问题，必须归成可重试的 502，否则调用方以为是自己请求写错了。
    let models;
    try {
      models = await fetchModels(acc, Math.min(this.cfg.upstream.timeoutMs, 15000));
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(`目录拉取失败 (${id}): ${e.message}`, { status: 502, kind: 'catalog', retryable: true, account: id });
    }
    const s = this.runtime(id);
    s.catalog = models; s.catalogAt = now(); s.ok = true; s.lastError = null; s.lastCheck = now();
    // 额度/积分/身份查询失败都不该让整次刷新失败，但各自要留下错误原因
    if (acc.type === 'qclaw-aizone') {
      const auth = { guid: acc.guid, account: acc.account, jwt: acc.jwt };
      const grab = (fn, box) => fn(auth, { timeoutMs: 10000 }).then(v => { s[box] = v; }, e => { s[box] = { error: e.message }; });
      await Promise.all([
        grab(busQuota, 'quota'),
        // 4110 = 积分余额（QClaw 面板上那个数），4075 = 今日 token 与 RPM，两回事都要
        grab(busCredits, 'credits'),
        grab(busTokens, 'tokens'),
        // unionid 是"同一个微信号"的稳定身份，第四项靠它去重
        grab(busIdentity, 'identity').then(() => this.persistIdentity(acc)),
        this.refreshRates(acc, models)
      ]);
    }
    return models;
  }

  /**
   * 模型积分倍率（4327）。这是全账号共用的计费表，所以整个池子只拉一份、按 TTL 复用；
   * 拉不到只影响展示，不该拖垮目录刷新。
   */
  async refreshRates(acc, models) {
    if (this.rates.at && now() - this.rates.at < RATES_TTL) return;
    try {
      const byModel = await busModelRates(
        { guid: acc.guid, account: acc.account, jwt: acc.jwt },
        models.map(m => bareModel(m.id, 'qclaw/')),
        { timeoutMs: 10000 }
      );
      this.rates = { at: now(), byModel };
    } catch (e) {
      this.rates = { at: 0, byModel: this.rates.byModel || {}, error: e.message };
    }
  }

  /**
   * 把查到的身份写回配置记录。不写的话，本次改动之前入池的账号永远没有 identity，
   * 重复上号时就认不出"这是同一个微信号"，只能靠 id 撞。
   */
  persistIdentity(acc) {
    const id = this.runtime(acc.id).identity;
    if (!id || id.error || !id.unionid) return;
    if (acc.identity && acc.identity.unionid === id.unionid && acc.identity.userId === id.userId) return;
    acc.identity = { userId: id.userId, openid: id.openid, unionid: id.unionid, nickname: id.nickname, avatar: id.avatar };
    this.persist?.();
  }

  async refreshAll() {
    const out = {};
    await Promise.all(this.cfg.accounts.map(async a => {
      try { out[a.id] = { ok: true, models: await this.refreshCatalog(a.id) }; }
      catch (e) { out[a.id] = { ok: false, error: e.message }; }
    }));
    return out;
  }

  /** 对外可声明的模型清单（各账号目录并集 + 别名） */
  modelIndex() {
    const seen = new Map();
    for (const a of this.cfg.accounts) {
      if (a.enabled === false) continue;
      for (const m of this.runtime(a.id).catalog) {
        const bare = bareModel(m.id, 'qclaw/');
        const id = 'qclaw/' + bare;
        if (!seen.has(id)) {
          const rate = this.rates.byModel[bare] || this.rates.byModel[id] || null;
          seen.set(id, {
            id, object: 'model', created: 0, owned_by: 'qclaw', name: m.name,
            contextWindow: m.contextWindow || 0,
            capabilities: m.capabilities || [],
            canThink: supportsThinking(m.capabilities),
            creditRate: rate,
            accounts: []
          });
        }
        seen.get(id).accounts.push(a.id);
      }
    }
    return [...seen.values()];
  }

  snapshot() {
    return this.cfg.accounts.map(a => {
      const s = this.runtime(a.id);
      return {
        id: a.id, type: a.type, base: a.base, enabled: a.enabled !== false,
        weight: a.weight ?? 100, priority: a.priority ?? null, defaultAgent: a.defaultAgent || 'main',
        modelAgents: a.modelAgents || {},
        ok: s.ok, failStreak: s.failStreak, lastError: s.lastError, lastCheck: s.lastCheck,
        lastLatencyMs: s.lastLatencyMs, requests: s.requests, successes: s.successes, failures: s.failures,
        cooldownUntil: s.cooldownUntil, cooldownSecondsLeft: Math.max(0, Math.ceil((s.cooldownUntil - now()) / 1000)),
        catalogCount: s.catalog.length, catalogAt: s.catalogAt, quota: s.quota,
        credits: s.credits, tokens: s.tokens, identity: s.identity || a.identity || null,
        jwtExp: jwtExp(a.jwt),
        secretHint: hint(a.token || a.apiKey)
      };
    });
  }
}

/** 解出登录 JWT 的到期日，让运营者看得见号池什么时候会集体失效 */
function jwtExp(jwt) {
  if (!jwt) return null;
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    if (!p.exp) return null;
    return {
      at: new Date(p.exp * 1000).toISOString().slice(0, 10),
      daysLeft: Math.round((p.exp * 1000 - Date.now()) / 86400000)
    };
  } catch { return null; }
}

function hint(v) {
  if (!v) return null;
  const s = String(v);  return s.length <= 10 ? '•'.repeat(s.length) : `${s.slice(0, 5)}…${s.slice(-4)} (${s.length})`;
}
