// 报文转换的离线测试：不需要号池、不需要网络、不需要腾讯活着。
//   node scripts/respond-test.mjs
//
// 这段逻辑原来内联在 server 里，只能靠打真上游来验，于是长期没人验。
// 这里用假 res / 假上游把 {OpenAI, Anthropic} × {JSON, SSE} 四条路都走一遍，
// 并额外盯两件真出事过的行为：背压要等 drain、客户端断开要停止拉上游。
// 后半段是请求侧映射（思考开关、工具定义）—— 那些字段错了不会崩，只会静默不生效，
// 更需要离线钉住。
import { EventEmitter } from 'node:events';
import { respond, createCollector } from '../src/respond.mjs';
import { anthropicToOpenAI, openAIToAnthropic } from '../src/translate.mjs';
import { responsesToChat, chatToResponse } from '../src/responses.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`);
  cond ? pass++ : fail++;
};

class FakeRes extends EventEmitter {
  constructor({ slow = false } = {}) {
    super();
    this.chunks = []; this.ended = false; this.head = null; this.slow = slow; this.drains = 0;
  }
  writeHead(status, headers) { this.head = { status, headers }; return this; }
  write(c) {
    this.chunks.push(Buffer.from(c));
    if (this.slow) { this.drains++; return false; }   // 模拟内核缓冲已满
    return true;
  }
  end(...a) {
    this.ended = true;
    if (typeof a[0] === 'string' || Buffer.isBuffer(a[0])) this.chunks.push(Buffer.from(a[0]));
    const cb = a.find(x => typeof x === 'function');
    cb?.();
    return this;
  }
  get body() { return Buffer.concat(this.chunks).toString('utf8'); }
}

const sseBytes = (...objs) => objs.map(o => `data: ${JSON.stringify(o)}\n\n`).join('');
const openaiStream = () => [
  { choices: [{ delta: { role: 'assistant', reasoning_content: '想一下' } }] },
  { choices: [{ delta: { content: '反向' } }] },
  { choices: [{ delta: { content: '代理' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { usage: { prompt_tokens: 11, completion_tokens: 2 }, choices: [] },
  '[DONE]'
].map(o => o === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`);

const bodyOf = parts => (async function* () { for (const p of parts) yield Buffer.from(p); })();
const upJson = json => ({ json: async () => json });
const NON_STREAM_JSON = {
  id: 'cmpl-1', model: 'pool-glm-5.2',
  choices: [{ message: { role: 'assistant', content: '反向代理' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 7, completion_tokens: 4 }
};

/** 上游可观察的假流：记录被消费了几个分片，用来证明断开时真的停了 */
function watchable(parts) {
  const seen = { taken: 0 };
  const it = (async function* () { for (const p of parts) { seen.taken++; yield Buffer.from(p); } })();
  return { body: it, seen };
}

// ---------- 象限 1：OpenAI JSON ----------
{
  const res = new FakeRes();
  const r = await respond({ res, up: upJson(NON_STREAM_JSON), style: 'openai', stream: false, model: 'qclaw/pool-glm-5.2' });
  const j = JSON.parse(res.body);
  ok('[1] OpenAI 非流式：原样透传 + 取到 usage',
    res.ended && j.choices[0].message.content === '反向代理' && r.usage?.completion_tokens === 4 && r.text === '反向代理',
    `text=${JSON.stringify(r.text)} usage=${JSON.stringify(r.usage)}`);
}

// ---------- 象限 2：Anthropic JSON ----------
{
  const res = new FakeRes();
  const r = await respond({ res, up: upJson(NON_STREAM_JSON), style: 'anthropic', stream: false, model: 'qclaw/pool-glm-5.2' });
  const j = JSON.parse(res.body);
  ok('[2] Anthropic 非流式：转成 message/content[].text',
    j.type === 'message' && j.content?.[0]?.type === 'text' && j.content[0].text === '反向代理'
    && j.stop_reason === 'end_turn' && res.head.headers['content-type'].includes('json'),
    `type=${j.type} text=${JSON.stringify(j.content?.[0]?.text)} stop=${j.stop_reason}`);
}

// ---------- 象限 3：OpenAI SSE ----------
{
  const res = new FakeRes();
  const parts = openaiStream();
  const { body, seen } = watchable(parts);
  const r = await respond({ res, up: { body }, style: 'openai', stream: true, model: 'qclaw/pool-glm-5.2' });
  ok('[3] OpenAI 流式：字节原样透传（分片数与内容都不许变）',
    res.head.headers['content-type'].includes('event-stream') && res.ended
    && res.body.includes('data: [DONE]') && parts.every(p => res.body.includes(p.trim())),
    `写出 ${res.body.length} 字节`);
  ok('[3] 流式计量：正文拼回"反向代理"且末尾 usage 被抄到',
    r.text === '反向代理' && r.usage?.prompt_tokens === 11,
    `text=${JSON.stringify(r.text)} usage=${JSON.stringify(r.usage)}`);
  ok('[3] 上游分片被完整消费', seen.taken === parts.length, `${seen.taken}/${parts.length}`);
}

// ---------- 象限 4：Anthropic SSE ----------
{
  const res = new FakeRes();
  const r = await respond({ res, up: { body: bodyOf(openaiStream()) }, style: 'anthropic', stream: true, model: 'qclaw/pool-glm-5.2' });
  const evs = [...res.body.matchAll(/^event: (\S+)$/gm)].map(m => m[1]);
  ok('[4] Anthropic 流式：完整事件序列且含正文增量',
    evs.includes('message_start') && evs.includes('content_block_delta') && evs.includes('message_stop')
    && res.body.includes('message_stop'),
    `事件=${evs.filter((v, i, a) => a.indexOf(v) === i).join(',')}`);
  ok('[4] 流式计量走 delta.text 而不是正则捞字符串',
    r.text === '反向代理', `text=${JSON.stringify(r.text)}`);
}

// ---------- 背压 ----------
{
  const res = new FakeRes({ slow: true });
  const parts = openaiStream();
  const t0 = Date.now();
  // write() 一直返回 false 且没人 emit drain → 会一直等；这里用定时器扮演可写事件
  const drainTimer = setInterval(() => res.emit('drain'), 30);
  const r = await respond({ res, up: { body: bodyOf(parts) }, style: 'openai', stream: true, model: 'qclaw/x' });
  clearInterval(drainTimer);
  ok('[背压] write 返回 false 时确实等待了 drain（没有把整段堆进内存）',
    res.drains >= parts.length - 1 && Date.now() - t0 >= 30 && res.body.includes('[DONE]'),
    `等待 drain ${res.drains} 次，耗时 ${Date.now() - t0}ms`);
}

// ---------- 客户端断开要停止拉上游 ----------
{
  const res = new FakeRes();
  const parts = openaiStream();
  const { body, seen } = watchable(parts);
  const guard = { gone: false };
  res.on('close', () => { guard.gone = true; });
  const origWrite = res.write.bind(res);
  let n = 0;
  res.write = c => { if (++n === 2) res.emit('close'); return origWrite(c); };
  await respond({ res, up: { body }, style: 'openai', stream: true, model: 'qclaw/x', guard });
  ok('[断开] 客户端走掉后不再向上游要分片', seen.taken < parts.length, `只取了 ${seen.taken}/${parts.length} 个分片`);
}

// ---------- 收集器边界 ----------
{
  const c = createCollector();
  c.feed('data: {"choices":[{"delta":{"content":"甲"}}]}\n\n');
  c.feed('data: {"choices":[{"delta":{"content":"乙"}}]}');   // 结尾没有换行
  c.finish();
  ok('[收集器] 末尾未以换行结束的分片不被吞掉', c.acc.text === '甲乙', `text=${JSON.stringify(c.acc.text)}`);

  const c2 = createCollector();
  c2.feed(': ping\n\nevent: foo\ndata: {"usage":{"prompt_tokens":3}}\n\n');
  c2.finish();
  ok('[收集器] 心跳/非 data 行不影响，usage 仍能拿到', c2.acc.text === '' && c2.acc.usage?.prompt_tokens === 3,
    JSON.stringify(c2.acc));
}

// ---------- 思考内容回传：Anthropic ----------
{
  const THINKING_JSON = {
    id: 'c2', model: 'pool-deepseek-v4-pro',
    choices: [{ message: { role: 'assistant', reasoning_content: '先算脚数', content: '鸡23兔12' }, finish_reason: 'stop' }]
  };
  const j = openAIToAnthropic(THINKING_JSON, 'qclaw/pool-deepseek-v4-pro', { promptTokens: 11 });
  ok('[思考] 上游 reasoning_content 转成 Anthropic thinking 块，且排在正文前',
    j.content[0]?.type === 'thinking' && j.content[0].thinking === '先算脚数' && j.content[1]?.type === 'text',
    `blocks=${j.content.map(b => b.type).join(',')}`);
  ok('[思考] 上游不给 usage 时按估算填，不让客户端看到全 0',
    j.usage.input_tokens === 11 && j.usage.output_tokens > 0, JSON.stringify(j.usage));
}

// ---------- 思考 + 工具流式：Anthropic ----------
{
  const parts = [
    { choices: [{ delta: { role: 'assistant', reasoning_content: '先想' } }] },
    { choices: [{ delta: { content: '答案' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ].map(o => o === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`);
  const res = new FakeRes();
  await respond({ res, up: { body: bodyOf(parts) }, style: 'anthropic', stream: true, model: 'qclaw/x', promptTokens: 5 });
  const starts = [...res.body.matchAll(/content_block_start[\s\S]*?"index":(\d+),\s*"content_block":\{"type":"(\w+)"/g)]
    .map(m => m[2] + '@' + m[1]);
  ok('[思考] Anthropic 流式按 thinking→text→tool_use 顺序开块，下标连续',
    JSON.stringify(starts) === JSON.stringify(['thinking@0', 'text@1', 'tool_use@2']), starts.join(' '));
  ok('[思考] 推理增量用 thinking_delta 事件下发', res.body.includes('"type":"thinking_delta"'));
  ok('[工具] 流式工具参数走 input_json_delta（旧实现只发空 input，参数全丢）',
    res.body.includes('"type":"input_json_delta"') && res.body.includes('上海'), '');
  ok('[工具] stop_reason 映射为 tool_use', res.body.includes('"stop_reason":"tool_use"'));
}

// ---------- OpenAI 流式补 usage ----------
{
  const parts = [
    { choices: [{ delta: { content: '反向' } }] },
    { choices: [{ delta: { content: '代理' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]'
  ].map(o => o === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`);
  const res = new FakeRes();
  await respond({ res, up: { body: bodyOf(parts) }, style: 'openai', stream: true, model: 'qclaw/x', promptTokens: 7, wantUsage: true });
  const usageIdx = res.body.indexOf('"usage"');
  ok('[usage] include_usage 时在 [DONE] 之前补一帧估算 usage',
    usageIdx > 0 && res.body.indexOf('[DONE]') > usageIdx && res.body.includes('"prompt_tokens":7'),
    res.body.slice(usageIdx - 12, usageIdx + 120).replace(/\n/g, ''));
  ok('[usage] 正文分片仍然逐帧保留（没有因为补帧而丢内容）',
    res.body.includes('反向') && res.body.includes('代理'));

  const res2 = new FakeRes();
  await respond({ res: res2, up: { body: bodyOf(parts) }, style: 'openai', stream: true, model: 'qclaw/x', promptTokens: 7 });
  ok('[usage] 没要求 usage 时保持字节级透传，不多写一帧',
    !res2.body.includes('"usage"') && parts.every(p => res2.body.includes(p.trim())), `${res2.body.length} 字节`);
}

// ---------- 请求侧：思考参数归一 ----------
{
  const a = anthropicToOpenAI({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, thinking: { type: 'disabled', budget_tokens: 100 } });
  ok('[思考] Anthropic thinking=disabled → 上游 reasoning_effort=none + thinking.disabled',
    a.reasoning_effort === 'none' && a.thinking?.type === 'disabled', JSON.stringify({ r: a.reasoning_effort, t: a.thinking }));

  const b = anthropicToOpenAI({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, thinking: { type: 'enabled', budget_tokens: 2000 } });
  ok('[思考] Anthropic thinking=enabled → 只承诺开关，不谎报预算',
    b.thinking?.type === 'enabled' && b.reasoning_effort === undefined, JSON.stringify(b.thinking));

  const c = anthropicToOpenAI({
    model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10,
    tools: [{ name: 'get_weather', input_schema: { type: 'object' } }], tool_choice: { type: 'any' }
  });
  ok('[工具] Anthropic tools/tool_choice 映射为 chat 形态（any→required）',
    c.tools[0].function.name === 'get_weather' && c.tools[0].function.parameters.type === 'object' && c.tool_choice === 'required',
    JSON.stringify(c.tool_choice));

  const r = responsesToChat({
    model: 'm', input: '天气', max_output_tokens: 20, reasoning: { effort: 'none' },
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'get_weather' }
  });
  ok('[工具] Responses 扁平 tools 转成上游要求的嵌套 function（不转会 400）',
    r.tools[0].function?.name === 'get_weather' && r.tools[0].function?.parameters?.type === 'object',
    JSON.stringify(r.tools[0]));
  ok('[工具] Responses tool_choice 扁平 name → chat 嵌套', JSON.stringify(r.tool_choice) === '{"type":"function","function":{"name":"get_weather"}}',
    JSON.stringify(r.tool_choice));
  ok('[思考] Responses reasoning.effort=none → 关掉上游思考',
    r.reasoning_effort === 'none' && r.thinking?.type === 'disabled' && r.reasoning === undefined,
    JSON.stringify({ r: r.reasoning_effort, t: r.thinking }));

  let rejected = null;
  try { responsesToChat({ model: 'm', input: 'x', tool_choice: { type: 'shell' } }); } catch (e) { rejected = e; }
  ok('[工具] 上游没有的 tool_choice 类型明确 400，而不是静默降级',
    rejected?.statusCode === 400 && rejected?.errCode === 'unsupported_field', rejected?.message || '没拒绝');

  const resp = chatToResponse({
    choices: [{ message: { role: 'assistant', reasoning_content: '想了想', content: '好' }, finish_reason: 'stop' }]
  }, { model: 'qclaw/x', promptTokens: 9 });
  ok('[usage] Responses 非流式 usage 用估算补齐',
    resp.usage.input_tokens === 9 && resp.usage.output_tokens_details.reasoning_tokens > 0 && resp.usage.total_tokens > 9,
    JSON.stringify(resp.usage));
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
