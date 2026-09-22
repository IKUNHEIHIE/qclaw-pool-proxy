// OpenAI ⇄ Anthropic 报文互转（含流式）。
// 两种上游账号类型最终都以 OpenAI chat/completions 形态暴露，所以这里只需要
// "Anthropic 入口 → OpenAI 上游 → Anthropic 出口" 这一条转换链。

import { estimateTokens } from './keys.mjs';
import { applyReasoning } from './reasoning.mjs';

let seq = 0;
const nextId = p => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (b?.type === 'text' ? b.text : '')).join('');
}

function mapRoleMessage(role, content) {
  if (typeof content === 'string') return { role, content };
  const texts = [];
  const images = [];
  const toolCalls = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') texts.push(b.text);
    else if (b.type === 'image' && b.source?.url) images.push({ type: 'image_url', image_url: { url: b.source.url } });
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
    else if (b.type === 'tool_result') return { role: 'tool', tool_call_id: b.tool_use_id, content: blocksToText(b.content) };
  }
  const parts = [...(texts.length ? [{ type: 'text', text: texts.join('') }] : []), ...images];
  const msg = { role, content: parts.length ? parts : texts.join('') };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return msg;
}

export function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === 'string' ? body.system : blocksToText(body.system);
    if (sys) messages.push({ role: 'system', content: sys });
  }
  for (const m of body.messages || []) messages.push(mapRoleMessage(m.role, m.content));
  const out = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 4096,
    stream: !!body.stream
  };
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    if (body.tool_choice) {
      out.tool_choice = body.tool_choice.type === 'tool' ? { type: 'function', function: { name: body.tool_choice.name } }
        : body.tool_choice.type === 'any' ? 'required'
        : body.tool_choice.type;
    }
  }
  // Anthropic 用 thinking:{type,budget_tokens} 控制思考，上游认的是 reasoning_effort/thinking
  if (body.thinking && typeof body.thinking === 'object') out.thinking = body.thinking;
  applyReasoning(out);
  return out;
}

const FINISH_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'stop_sequence' };

/** 上游的推理正文字段不统一：aizone 用 reasoning_content，别的网关用 reasoning */
export const reasoningOf = o => String(o?.reasoning_content ?? o?.reasoning ?? '');

export function openAIToAnthropic(oai, modelId, { promptTokens = 0 } = {}) {
  const ch = oai.choices?.[0] ?? {};
  const msg = ch.message ?? {};
  const content = [];
  const thinking = reasoningOf(msg);
  // thinking 块必须排在 text/tool_use 之前：Anthropic 的语义里思考发生在回答之前
  if (thinking) content.push({ type: 'thinking', thinking, signature: '' });
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = { _raw: tc.function?.arguments }; }
    content.push({ type: 'tool_use', id: tc.id || nextId('toolu'), name: tc.function?.name, input });
  }
  const usage = oai.usage ?? {};
  return {
    id: nextId('msg'), type: 'message', role: 'assistant', model: modelId ?? oai.model,
    content, stop_reason: FINISH_MAP[ch.finish_reason] ?? 'end_turn', stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? promptTokens,
      output_tokens: usage.completion_tokens ?? estimateTokens(String(msg.content || '') + thinking)
    }
  };
}

/** 逐行解析 SSE，产出 data: 后的字符串 */
export async function* sseData(chunks) {
  let buf = '';
  for await (const c of chunks) {
    buf += typeof c === 'string' ? c : new TextDecoder().decode(c, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}

const sseEvent = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * 把上游的 OpenAI SSE 流转成 Anthropic 的 event 流。
 * 产出字符串片段，由调用方写进响应。
 *
 * 分块是动态开的：上游先吐 reasoning_content 再吐 content，思考块必须早于正文块，
 * 而只吐 content 时又不该凭空多出一个空 thinking 块 —— 所以 index 边流边分配。
 */
export async function* openaiStreamToAnthropic(dataItems, modelId, { promptTokens = 0 } = {}) {
  const msgId = nextId('msg');
  const blocks = [];               // 已分配的 content_block，用于收尾时回填
  let openIdx = null;              // 当前打开的块下标
  let outChars = '';
  const pendingTools = new Map();
  let finish = null;
  let usage = {};

  yield sseEvent('message_start', {
    type: 'message_start',
    message: { id: msgId, type: 'message', role: 'assistant', model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: promptTokens, output_tokens: 0 } }
  });

  const close = () => {
    if (openIdx === null) return '';
    const f = sseEvent('content_block_stop', { type: 'content_block_stop', index: openIdx });
    openIdx = null;
    return f;
  };
  const open = block => {
    let f = close();
    blocks.push(block);
    const idx = blocks.length - 1;
    openIdx = idx;
    f += sseEvent('content_block_start', { type: 'content_block_start', index: idx, content_block: block });
    return f;
  };

  for await (const raw of dataItems) {
    if (raw === '[DONE]') break;
    let chunk;
    try { chunk = JSON.parse(raw); } catch { continue; }
    const d = chunk.choices?.[0]?.delta;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
    if (!d) continue;

    const reasoning = reasoningOf(d);
    if (reasoning) {
      if (openIdx === null || blocks[openIdx].type !== 'thinking') {
        yield open({ type: 'thinking', thinking: '', signature: '' });
      }
      outChars += reasoning;
      yield sseEvent('content_block_delta', { type: 'content_block_delta', index: openIdx, delta: { type: 'thinking_delta', thinking: reasoning } });
    }
    if (typeof d.content === 'string' && d.content) {
      if (openIdx === null || blocks[openIdx].type !== 'text') {
        yield open({ type: 'text', text: '' });
      }
      outChars += d.content;
      yield sseEvent('content_block_delta', { type: 'content_block_delta', index: openIdx, delta: { type: 'text_delta', text: d.content } });
    }
    for (const tc of d.tool_calls || []) {
      const idx = tc.index ?? 0;
      if (!pendingTools.has(idx)) pendingTools.set(idx, { id: tc.id, name: tc.function?.name ?? '', args: '' });
      const t = pendingTools.get(idx);
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name += tc.function.name;
      if (tc.function?.arguments) t.args += tc.function.arguments;
    }
  }

  yield close();
  // 工具调用在流式里是"参数分片"，必须用 input_json_delta 逐段给出，
  // 否则只读流的客户端拿到的 input 永远是空对象。
  for (const t of pendingTools.values()) {
    yield open({ type: 'tool_use', id: t.id || nextId('toolu'), name: t.name, input: {} });
    if (t.args) {
      yield sseEvent('content_block_delta', { type: 'content_block_delta', index: openIdx, delta: { type: 'input_json_delta', partial_json: t.args } });
    }
    outChars += t.args;
    yield close();
  }

  const completion = usage.completion_tokens ?? estimateTokens(outChars);
  yield sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: FINISH_MAP[finish] ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: completion } });
  yield sseEvent('message_stop', { type: 'message_stop' });
}
