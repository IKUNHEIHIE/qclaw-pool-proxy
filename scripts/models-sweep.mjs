// 逐个模型打一遍，确认号池里的模型真的能吐 token（交付验收用）。
//   node scripts/models-sweep.mjs <baseUrl> <clientKey>
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const KEY = process.argv[3];
if (!KEY) {
  console.error('用法: node scripts/models-sweep.mjs <baseUrl> <clientKey>');
  process.exit(2);
}
const HEADERS = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` };

const models = await (await fetch(BASE + '/v1/models', { headers: HEADERS })).json();
console.log(`${BASE} — ${models.data.length} 个模型\n`);
let ok = 0;
for (const m of models.data) {
  const t0 = Date.now();
  let line;
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 600 }),
      signal: AbortSignal.timeout(180000)
    });
    const j = await r.json();
    const ch = j.choices?.[0];
    const text = (ch?.message?.content || '').trim();
    const echo = j.model === m.id.replace(/^qclaw\//, '');
    if (r.ok && text) ok++;
    line = `${r.status} ${String(Date.now() - t0).padStart(5)}ms echo=${echo ? 'Y' : 'N'} finish=${ch?.finish_reason} ${JSON.stringify(text.slice(0, 24))}`;
  } catch (e) {
    line = `ERR ${e.message}`;
  }
  console.log(`${m.id.padEnd(36)} ${line}`);
}
console.log(`\n${ok}/${models.data.length} 个模型返回了非空内容`);
process.exit(ok === models.data.length ? 0 : 1);
