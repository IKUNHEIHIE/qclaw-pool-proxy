export type JwtExp = { at: string; daysLeft: number } | null;

export type CreditItem = { label: string; remain: number; total: number; expireAt?: string | null };

export type Credits = {
  balance?: number; activity?: number; subscription?: number; package?: number;
  items?: CreditItem[]; error?: string;
} | null;

export type Tokens = { dailyLimit?: number; dailyUsed?: number; usedPct?: number; rpmLimit?: number | null; error?: string } | null;

export type Quota = {
  remaining?: number; used?: number; trialExpiresAt?: string; purchaseExpiresAt?: string; error?: string;
} | null;

export type Identity = {
  userId?: number | null; openid?: string; unionid?: string; nickname?: string; avatar?: string;
} | null;

/**
 * 体检结果贴在浏览器侧的行上，不来自 /admin/state。
 * alive=查到了积分；need_login=服务端带码拒了（掉线/被封）；unreachable=没连通，不定罪；
 * bad 只用于下拉里的深度测活（真发一次推理）。
 */
export type Probe = { state: 'running' | 'alive' | 'need_login' | 'unreachable' | 'bad'; ms?: number; balance?: number; reason?: string };

export type Account = {
  id: string; type: string; base: string; enabled: boolean; weight: number;
  priority: number | null;
  defaultAgent: string; modelAgents: Record<string, string>;
  ok: boolean; failStreak: number; lastError: string | null; lastCheck: number;
  needLogin?: boolean;
  lastLatencyMs: number | null; requests: number; successes: number; failures: number;
  cooldownUntil: number; cooldownSecondsLeft: number;
  catalogCount: number; catalogAt: number;
  quota: Quota; credits: Credits; tokens: Tokens; identity: Identity;
  jwtExp: JwtExp; secretHint: string | null;
};

export type CreditRate = { inputRate?: number; outputRate?: number; multiplier?: string; note?: string; tier?: string } | null;

export type Model = {
  id: string; object?: string; created?: number; owned_by?: string;
  name?: string; description?: string; contextWindow: number;
  capabilities: string[]; canThink: boolean; creditRate: CreditRate; accounts: string[];
};

export type KeyStats = {
  requests: number; failed: number; promptTokens?: number; completionTokens?: number;
  lastUsedAt?: number | string | null;
};

export type KeyRec = {
  key: string; masked: string; name: string; note?: string; enabled: boolean;
  createdAt?: number | string; expiresAt?: number | string | null;
  rpm?: number; dailyRequests?: number; maxTokens?: number; models?: string[] | null;
  today: number; stats: KeyStats;
};

export type PoolStats = { requests: number; successes: number; failures: number; retries: number };

export type State = {
  version: string; startedAt: number; uptimeMs: number; stats: PoolStats;
  scheduler: { stickyRouting?: boolean } & Record<string, unknown>;
  accounts: Account[]; models: Model[];
  rates?: { byModel: Record<string, unknown>; error?: string } | null;
  keys: { total?: number; active?: number; requests?: number; todayRequests?: number; errorRate?: number; denied?: number };
  noKeysConfigured: boolean; configPath: string;
};

export type LogRow = {
  at: number; key: string; model: string; account: string; status: number; ok: boolean;
  ms: number; promptTokens?: number; completionTokens?: number; stream?: boolean; error?: string | null;
};

export type LoginSession = {
  loginId: string;
  status: 'waiting' | 'scanned' | 'saving' | 'done' | 'failed' | 'expired';
  qrImage?: string | null;
  expiresAt?: number | null;
  error?: string | null;
  log?: string[];
  seen?: string[];
  account?: { id: string; models?: number } | null;
  reused?: string | null;
  poolSize?: number | null;
};

export type ChatMsg = {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  pending?: boolean;
  meta?: string;
};

export type Conversation = { id: string; title: string; sys: string; msgs: ChatMsg[] };
