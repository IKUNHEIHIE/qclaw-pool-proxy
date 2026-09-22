import { toast } from 'sonner';

export const LS = {
  admin: 'qpp.admin', ckey: 'qpp.ckey', view: 'qpp.view', convs: 'qpp.convs',
  activeConv: 'qpp.conv', sys: 'qpp.sys', hist: 'qpp.hist', showKeys: 'qpp.showKeys',
  session: 'qpp.session', think: 'qpp.think', useAcct: 'qpp.useAcct'
};

export const adminToken = () => localStorage.getItem(LS.admin) || '';

export function setAdminToken(v: string) {
  const t = v.trim();
  if (t) localStorage.setItem(LS.admin, t); else localStorage.removeItem(LS.admin);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** 管理面统一入口：带 Bearer，非 2xx 一律抛错并把服务端 message 抬出来 */
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken(), ...(init.headers || {}) }
  });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new ApiError(data?.error?.message || data?.message || text.slice(0, 200) || ('HTTP ' + r.status), r.status);
  return data as T;
}

export const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

/**
 * 复制。navigator.clipboard 只在安全上下文（https 或 localhost）里存在，
 * 而这个控制台最常见的用法就是 http://<服务器IP>:8787 —— 那里它是 undefined，
 * 所以必须留 execCommand 兜底；兜底也可能失败（要用户手势），那时摊出可全选弹层由调用方处理。
 */
export async function copyText(s: string): Promise<'clipboard' | 'rejected'> {
  const text = String(s ?? '');
  if (!text) { toast.error('没有可复制的内容'); return 'rejected'; }
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      toast.success('已复制');
      return 'clipboard';
    }
  } catch { /* 落到兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) { toast.success('已复制'); return 'clipboard'; }
  } catch { /* 下面返回 rejected */ }
  return 'rejected';
}

/** 会话标识：同一会话粘在同一个账号上（上游 KV 缓存更友好） */
export function sessionId(): string {
  let s = localStorage.getItem(LS.session);
  if (!s) { s = 'web-' + Math.random().toString(36).slice(2, 12); localStorage.setItem(LS.session, s); }
  return s;
}

export type ChatRequest = {
  key: string; model: string; messages: { role: string; content: string }[];
  maxTokens: number; temperature?: number; stream: boolean;
  account?: string; think: boolean; signal?: AbortSignal;
};

export type ChatResult = {
  content: string; reasoning: string; usage: any | null; finish: string | null;
  account: string; ms: number; usageEstimated: boolean;
};

/**
 * 走真实对外链路（/v1/chat/completions + 客户端密钥），与外部客户端完全同一条路。
 * 思考开关：上游只实现"开/关"，关 = reasoning_effort:'none'；传档位是无效的，别传。
 */
export async function chatOnce(req: ChatRequest, onDelta: (part: { content?: string; reasoning?: string }) => void): Promise<ChatResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + req.key,
    'x-qclaw-session': sessionId()
  };
  if (req.account) headers['x-qclaw-account'] = req.account;
  const body: Record<string, unknown> = {
    model: req.model, messages: req.messages, max_tokens: req.maxTokens, stream: req.stream
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (!req.think) body.reasoning_effort = 'none';
  const t0 = Date.now();
  const res = await fetch('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
  const account = res.headers.get('x-qclaw-account') || '';
  if (!res.ok) throw new ApiError((await res.text()).slice(0, 300), res.status);
  let content = '', reasoning = '', usage: any = null, finish: string | null = null;
  if (req.stream) {
    const rd = res.body!.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const ln of lines) {
        if (!ln.startsWith('data:')) continue;
        const p = ln.slice(5).trim();
        if (p === '[DONE]') continue;
        let j: any;
        try { j = JSON.parse(p); } catch { continue; }
        const c = j.choices?.[0];
        if (c?.finish_reason) finish = c.finish_reason;
        if (c?.delta?.content) { content += c.delta.content; onDelta({ content: c.delta.content }); }
        if (c?.delta?.reasoning_content) { reasoning += c.delta.reasoning_content; onDelta({ reasoning: c.delta.reasoning_content }); }
        if (j.usage) usage = j.usage;
      }
    }
  } else {
    const j: any = await res.json();
    const c = j.choices?.[0];
    finish = c?.finish_reason ?? null;
    usage = j.usage ?? null;
    content = c?.message?.content || '';
    reasoning = c?.message?.reasoning_content || '';
    onDelta({ content, reasoning });
  }
  return { content, reasoning, usage, finish, account, ms: Date.now() - t0, usageEstimated: !usage };
}
