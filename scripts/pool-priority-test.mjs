// 号池调用优先级的离线单测：只碰 Pool.pick()，不打网络、不需要凭据。
//
//   node scripts/pool-priority-test.mjs
//
// 为什么值得单独立一个文件：优先级是"先榨干 0 号"这种语义，和加权轮询只差一句话，
// 但它决定了积分花在哪个号上。这类语义靠肉眼读 sort 的比较函数是看不住的。
import { Pool } from '../src/pool.mjs';

const MODEL = 'qclaw/pool-glm-5.2';

const acct = (id, priority, extra = {}) => ({
  id, type: 'qclaw-aizone', base: 'https://example.invalid/v1/',
  apiKey: 'sk-' + id, jwt: 'jwt-' + id, guid: 'g-' + id, account: 1,
  models: ['pool-glm-5.2'], priority, ...extra
});

const mkPool = accounts => new Pool({
  accounts,
  scheduler: { stickyRouting: true, cooldownAuthFailSeconds: 90, cooldownRateLimitSeconds: 120, cooldownServerErrorSeconds: 30 },
  upstream: { timeoutMs: 1000 }
});

const checks = [];
const ok = (name, pass, note) => checks.push([name, !!pass, note]);

// ---- 1. 只在最小序号那一档内轮转 ----
{
  const p = mkPool([acct('a', 1), acct('b', 0), acct('c', 0), acct('d', 5)]);
  const seen = new Set();
  for (let i = 0; i < 12; i++) seen.add(p.pick(MODEL, new Set(), null).id);
  ok('0 号档之外的账号一次都拿不到流量', [...seen].every(x => x === 'b' || x === 'c'), [...seen].join(','));
  ok('同一档内仍然轮转（不是把 0 号写死成一个号）', seen.size === 2 && seen.has('b') && seen.has('c'), [...seen].join(','));
}

// ---- 2. 高档位全部不可用时自然落到下一档 ----
{
  const p = mkPool([acct('a', 1), acct('b', 0), acct('c', 0)]);
  p.runtime('b').cooldownUntil = Date.now() + 60_000;
  ok('0 号档只剩一个号时全部落到它', p.pick(MODEL, new Set(), null).id === 'c');
  p.runtime('c').cooldownUntil = Date.now() + 60_000;
  ok('0 号档全冷却后落到序号 1 的号（不是"没号了"）', p.pick(MODEL, new Set(), null).id === 'a');
  const p2 = mkPool([acct('a', 1), acct('b', 0)]);
  p2.account('b').enabled = false;
  ok('停用的号不占档位', p2.pick(MODEL, new Set(), null).id === 'a');
}

// ---- 3. 没编号的老账号排最后，且彼此仍可轮转 ----
{
  const p = mkPool([acct('old1', null), acct('num', 3), acct('old2', null)]);
  const got = p.pick(MODEL, new Set(), null).id;
  ok('未编号（priority=null）排在已编号之后', got === 'num', got);
  p.account('num').enabled = false;
  const seen = new Set();
  for (let i = 0; i < 8; i++) seen.add(p.pick(MODEL, new Set(), null).id);
  ok('未编号的号之间照常轮转', seen.size === 2 && seen.has('old1') && seen.has('old2'), [...seen].join(','));
}

// ---- 4. weight 只在同档内做次级排序，不会盖过序号 ----
{
  const p = mkPool([acct('rich', 0, { weight: 500 }), acct('poor', 4, { weight: 1 })]);
  const seen = new Set();
  for (let i = 0; i < 6; i++) seen.add(p.pick(MODEL, new Set(), null).id);
  ok('序号优先于 weight（weight 大的排在后面也拿不到流量）', seen.size === 1 && seen.has('rich'), [...seen].join(','));
}

// ---- 5. 粘路由仍优先于序号：同一个会话不该因为改序号而换号 ----
{
  const p = mkPool([acct('a', 0), acct('b', 1), acct('c', 2)]);
  const first = p.pick(MODEL, new Set(), 'session-xyz');
  let same = true;
  for (let i = 0; i < 10; i++) same = same && p.pick(MODEL, new Set(), 'session-xyz').id === first.id;
  ok('带会话标识时结果稳定（sticky 不被序号打散）', same, first.id);
}

// ---- 6. /admin/state 看得到序号，界面才编得动 ----
{
  const p = mkPool([acct('a', 0), acct('b', null)]);
  const s = p.snapshot();
  ok('snapshot 透出 priority（有编号的）', s.find(x => x.id === 'a').priority === 0);
  ok('snapshot 透出 priority 为空表示"未编号"而不是 0', s.find(x => x.id === 'b').priority === null);
}

let bad = 0;
for (const [name, pass, note] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && note ? '  :: ' + note : ''}`);
  if (!pass) bad++;
}
console.log(`\n合计 ${checks.length - bad} 通过 / ${bad} 失败`);
process.exit(bad ? 1 : 0);
