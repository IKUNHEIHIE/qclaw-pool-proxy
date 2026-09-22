// 一键回归：串行跑完五个离线套件并汇总断言数。
//
//   npm test
//
// 为什么串行：admin-guard 要真网卡、login-e2e 要起无头浏览器，1c1g 上并发只会互相拖慢。
// 为什么没有 live：这些套件一律不打真腾讯、不需要任何凭据，所以绿了就说明"我们自己的逻辑
// 没退化"。"腾讯那条链路今天还认不认我们"是另一件事，只有 npm run verify:live 能给结论 ——
// 把 live 混进默认测试，迟早会让人把一个离线绿灯当成链路活着（我们为此绕过大半晚）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  { name: '报文转换（OpenAI ⇄ Anthropic ⇄ Responses）', script: 'scripts/respond-test.mjs', args: [], needs: null },
  { name: '号池调用优先级与测活语义', script: 'scripts/pool-priority-test.mjs', args: [], needs: null },
  { name: '管理面来源闸 adminAllowFrom', script: 'scripts/admin-guard-test.mjs', args: [], needs: '需要一块非回环网卡' },
  { name: '扫码登录链路（桩登录页 + 桩总线）', script: 'scripts/login-e2e.mjs', args: [], needs: '需要本机有 Chrome/Edge' },
  { name: '端到端契约（自桩代理实例）', script: 'scripts/verify.mjs', args: ['--self'], needs: null }
];

function run(cmd) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const emit = d => { out += d; process.stdout.write(d); };
    p.stdout.on('data', emit);
    p.stderr.on('data', d => { out += d; process.stderr.write(d); });
    p.on('close', code => {
      // 各套件的"合计 N 通过 / M 失败"是断言计数唯一可靠的来源（退出码只说有没有失败）
      const m = [...out.matchAll(/合计 (\d+) 通过 \/ (\d+) 失败/g)].pop();
      resolve({ code: code ?? 1, pass: m ? Number(m[1]) : null, fail: m ? Number(m[2]) : null, out });
    });
  });
}

const results = [];
for (const [i, s] of SUITES.entries()) {
  console.log(`\n${'─'.repeat(72)}\n[${i + 1}/${SUITES.length}] ${s.name}${s.needs ? `  ·  ${s.needs}` : ''}\n`);
  const r = await run([path.join(ROOT, s.script), ...s.args]);
  // 退出码 0 但一条断言都没报数，等于没验 —— 宁可标成失败也不给静默的绿灯
  const counted = r.pass !== null || r.fail !== null;
  const bad = r.code !== 0 || !counted || (r.fail ?? 0) > 0;
  results.push({ name: s.name, ok: !bad, pass: r.pass, fail: r.fail, counted, code: r.code });
  if (bad && !counted) console.log(`（该套件没打印断言计数，退出码 ${r.code} —— 按失败处理）`);
}

console.log(`\n${'═'.repeat(72)}`);
for (const r of results) {
  const n = r.counted ? `${r.pass ?? 0} 项` : '未计数';
  console.log(`${r.ok ? '✓' : '✗'} ${String(r.name).padEnd(46)} ${n}${(r.fail ?? 0) > 0 ? ` / ${r.fail} 失败` : ''}`);
}
const total = results.reduce((n, r) => n + (r.pass || 0), 0);
const broke = results.filter(r => !r.ok);
console.log(`\n${broke.length ? `${broke.length} 个套件失败` : `全部通过：${total} 项断言`}`);
console.log('提示：以上全绿只说明本地逻辑没退化。要打真号池请 npm run verify:live。');
process.exit(broke.length ? 1 : 0);
