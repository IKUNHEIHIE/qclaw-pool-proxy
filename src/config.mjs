import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_CONFIG = {
  listen: { host: '0.0.0.0', port: 8787, adminAllowFrom: [], trustProxy: false },
  adminToken: '${env:PROXY_ADMIN_TOKEN}',
  clientKeys: [],
  cors: { origin: '*' },
  accounts: [],
  scheduler: {
    cooldownAuthFailSeconds: 90,
    cooldownRateLimitSeconds: 120,
    cooldownServerErrorSeconds: 30,
    maxFailureSamples: 5,
    stickyRouting: true
  },
  upstream: { timeoutMs: 120000, modelPrefix: 'qclaw/' }
};

function expand(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([A-Z0-9_]+)\}/gi, (_, n) => process.env[n] ?? '');
  }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expand(v);
    return out;
  }
  return value;
}

function merge(base, extra) {
  if (Array.isArray(extra)) return extra.slice();
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function configPathFromArgv(argv) {
  const i = argv.findIndex(a => a === '--config' || a === '-c');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  if (process.env.PROXY_CONFIG) return path.resolve(process.env.PROXY_CONFIG);
  return path.resolve(process.cwd(), 'config.json');
}

export function defaultConfigPath() {
  return path.join(os.homedir(), '.qclaw-proxy', 'config.json');
}

export function loadConfig(file) {
  let raw = {};
  if (fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const cfg = expand(merge(DEFAULT_CONFIG, raw));
  cfg._file = file;
  validate(cfg);
  return cfg;
}

export function validate(cfg) {
  const errors = [];
  if (!cfg.listen?.port) errors.push('listen.port 缺失');
  if (!cfg.adminToken) errors.push('adminToken 未设置（可用 PROXY_ADMIN_TOKEN 环境变量）');
  for (const [i, a] of cfg.accounts.entries()) {
    if (!a.id) errors.push(`accounts[${i}].id 缺失`);
    if (!a.base) errors.push(`accounts[${i}].base 缺失`);
    if (!['openclaw-gateway', 'openai-compat', 'qclaw-aizone'].includes(a.type)) {
      errors.push(`accounts[${i}].type 必须是 openclaw-gateway / openai-compat / qclaw-aizone`);
    }
    if (!a.token && !a.apiKey) errors.push(`accounts[${i}] 需要 token 或 apiKey`);
  }
  const ids = cfg.accounts.map(a => a.id);
  if (new Set(ids).size !== ids.length) errors.push('accounts[].id 必须唯一');
  if (errors.length) throw new Error('配置无效:\n  - ' + errors.join('\n  - '));
  return cfg;
}

export function saveConfig(cfg) {
  const { _file, ...rest } = cfg;
  const tmp = _file + '.tmp';
  fs.mkdirSync(path.dirname(_file), { recursive: true });
  // 配置里存着全部 sk- 与 JWT，必须 0600 —— writeFileSync 的 mode 只在创建时生效，所以再显式 chmod。
  fs.writeFileSync(tmp, JSON.stringify(rest, null, 2) + '\n', { mode: 0o600 });
  // 整份覆盖写，所以先留一版上一状态：号池账号唯一的删除路径是管理端 DELETE，
  // 一次误点或被旧进程覆盖就会把 sk-/JWT 全丢掉，只能重新登录补号。
  try { if (fs.existsSync(_file)) fs.copyFileSync(_file, _file + '.bak'); } catch { /* 备份失败不该拖垮保存 */ }
  fs.renameSync(tmp, _file);
  try { fs.chmodSync(_file, 0o600); } catch { /* Windows 上无意义 */ }
}
