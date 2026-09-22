// OpenAI Responses API（/v1/responses）⇄ Chat Completions 互转。
//
// 为什么需要：ChatGPT / Codex 系的新客户端走的是 Responses 而不是 chat/completions，
// 只支持 chat 接口的反代对它们等于不可用。上游（aizone）只有 chat/completions，
// 所以这里做双向映射：请求拆成 messages，响应再包回 response 对象，流式则重放
// Responses 那一套事件名。
//
// 有意为之的取舍：
//  - 工具调用：上游是 chat 协议，tool_calls 与 function_call 一一对应地搬过去/搬回来。
//  - 推理模型（pool-*）会把预算花在 reasoning_content 上，这里映射成 reasoning 项，
//    否则调用方只看到一个空正文会以为失败了。
//  - Responses 的 conversation / previous_response_id 等有状态特性不做：
//    上游没有会话存储，假装支持比明确拒绝更容易埋坑。带这些字段时直接 400。

import { randomUUID } from 'node:crypto';

import { estimateTokens } from './keys.mjs';
import { applyReasoning } from './reasoning.mjs';

const UNSUPPORTED = ['conversation', 'previous_response_id', 'store', 'background', 'truncation'];

/** Responses 请求体 → Chat Completions 请求体 */
export function responsesToChat(body) {
  for (const f of UNSUPPORTED) {
    if (body[f] !== undefined) {
      throw Object.assign(new Error(`/v1/responses 不支持 ${f}（上游无会话存储，请每次自带完整 input）`),
        { statusCode: 400, errType: 'invalid_request_error', errCode: 'unsupported_field' });
    }
  }
  const messages = [];
  const sys = body.instructions;
  if (typeof sys === 'string' && sys.trim()) messages.push({ role: 'system', content: sys });

  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }]
    : Array.isArray(body.input) ? body.input : [];

  for (const it of items) {
    if (!it || typeof it !== 'object') {
      if (typeof it === 'string') messages.push({ role: 'user', content: it });
      continue;
    }
    // 简化形式：{role, content}
    if (it.role && it.content !== undefined && !it.type) {
      messages.push({ role: it.role, content: flattenContent(it.content) });
      continue;
    }
    if (it.type === 'function_call_output' || it.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: it.call_id || it.tool_call_id || '',
        content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output ?? '')
      });
      continue;
    }
    if (it.type === 'function_call') {
      messages.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: it.call_id || randomUUID(), type: 'function',
          function: { name: it.name, arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {}) } }]
      });
      continue;
    }
    if (it.type === 'message' || it.content) {
      messages.push({ role: it.role || 'user', content: flattenContent(it.content) });
    }
  }
  if (!messages.length) throw Object.assign(new Error('input 为空，没有可发送的消息'),
    { statusCode: 400, errType: 'invalid_request_error' });

  const out = { ...body, messages };
  delete out.input; delete out.instructions; delete out.max_output_tokens; delete out.include;
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.text?.format?.type === 'json_object' || body.response_format) {
    out.response_format = body.response_format || { type: 'json_object' };
    delete out.text;
  }
  // Responses 的工具是扁平的（{type:'function',name,parameters}），上游 chat 要嵌套 function 对象。
  // 不转的结果不是"没工具"，而是上游 400 proxy_param_error —— 以前会被号池翻译成 502，更难查。
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.filter(t => t && typeof t === 'object').map(t => (
      t.function ? t : { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || t.input_schema } }
    ));
  } else delete out.tools;
  if (body.tool_choice !== undefined) out.tool_choice = mapToolChoice(body.tool_choice);
  applyReasoning(out);
  return out;
}

function mapToolChoice(c) {
  if (typeof c === 'string') return c === 'required' ? 'required' : c;   // 'auto' / 'none' 原样
  if (c && typeof c === 'object') {
    if (c.type === 'function' && (c.name || c.function?.name)) return { type: 'function', function: { name: c.name || c.function.name } };
    if (c.type === 'mcp' || c.type === 'custom' || c.type === 'shell' || c.type === 'local_shell') {
      throw Object.assign(new Error(`/v1/responses 不支持 tool_choice.type=${c.type}（上游只有 chat 函数工具）`),
        { statusCode: 400, errType: 'invalid_request_error', errCode: 'unsupported_field' });
    }
  }
  return 'auto';
}

/** input 里的 content 可能是字符串，也可能是 [{type:'input_text',text}] */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map(c => typeof c === 'string' ? c : String(c.text ?? '')).join('');
}

const finishMap = { stop: 'completed', length: 'incomplete', tool_calls: 'completed', content_filter: 'incomplete' };

/** Chat Completions 响应 → Responses 的 response 对象 */
export function chatToResponse(chat, req = {}) {
  const ch = chat.choices?.[0] || {};
  const msg = ch.message || {};
  const output = [];
  const reasoning = msg.reasoning_content || msg.reasoning || chat.reasoning_content || '';
  if (reasoning) output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] });
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    for (const tc of msg.tool_calls) {
      output.push({ type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments });
    }
  }
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text || !output.length) {
    output.push({
      type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }]
    });
  }
  return {
    id: chat.id ? `resp_${chat.id.replace(/[^a-zA-Z0-9]/g, '').slice(-24) || randomUUID().slice(0, 24)}` : `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: finishMap[ch.finish_reason] || 'completed',
    error: null, incomplete_details: ch.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null,
    model: chat.model ? (req.modelPrefix ? req.modelPrefix + chat.model : chat.model) : (req.model || ''),
    output, output_text: text,
    usage: mapUsage(chat.usage, { promptTokens: req.promptTokens, text, reasoning }),
    parallel_tool_calls: req.parallel_tool_calls ?? true,
    tools: req.tools || [], tool_choice: req.tool_choice || 'auto',
    temperature: req.temperature ?? 1, top_p: req.top_p ?? 1,
    max_output_tokens: req.max_output_tokens ?? null,
    previous_response_id: null, conversation: null
  };
}

function mapUsage(u, { promptTokens = 0, text = '', reasoning = '' } = {}) {
  // aizone 实测既不给非流式 usage、也不给流式 usage（连 stream_options.include_usage 都不返回），
  // 全 0 会让 Codex 这类客户端以为上下文还是空的、不做压缩。所以缺字段时按字符数补一份估算。
  const pt = u?.prompt_tokens ?? promptTokens;
  const rt = u?.completion_tokens_details?.reasoning_tokens ?? (reasoning ? estimateTokens(reasoning) : 0);
  const ct = u?.completion_tokens ?? (estimateTokens(text) + rt);
  return {
    input_tokens: pt,
    input_tokens_details: { cached_tokens: u?.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: ct,
    output_tokens_details: { reasoning_tokens: rt },
    total_tokens: u?.total_tokens ?? (pt + ct)
  };
}

const ev = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;

/**
 * 上游 chat SSE 流 → Responses SSE 事件流。
 * 事件顺序按 Responses 规范：created / in_progress / 每个输出项 added→(delta)→done / completed。
 */
export async function* chatStreamToResponses(chunks, { model, responseId, created, promptTokens = 0 }) {
  const base = { id: responseId, object: 'response', created_at: created, model, status: 'in_progress', output: [] };
  yield ev('response.created', { response: { ...base, status: 'queued' } });
  yield ev('response.in_progress', { response: base });

  let msgOpen = false, reasonOpen = false;
  let text = '', reasoning = '', usage = null, finish = null;
  const toolCalls = new Map();     // index → {id,name,arguments}
  let buf = '';

  const openReasoning = () => {
    if (reasonOpen) return '';
    reasonOpen = true;
    return ev('response.output_item.added', { output_index: 0, item: { type: 'reasoning', summary: [] } });
  };
  const openMessage = () => {
    if (msgOpen) return '';
    msgOpen = true;
    return ev('response.output_item.added', {
      output_index: 1,
      item: { type: 'message', role: 'assistant', status: 'in_progress', content: [] }
    }) + ev('response.content_part.added', {
      item_id: responseId, output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] }
    });
  };

  for await (const raw of chunks) {
    buf += typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta;
      const fr = j.choices?.[0]?.finish_reason;
      if (fr) finish = fr;
      if (!d) continue;

      const reasoningDelta = d.reasoning_content || d.reasoning;
      if (reasoningDelta) {
        const pre = openReasoning(); if (pre) yield pre;
        reasoning += reasoningDelta;
        yield ev('response.reasoning_summary_text.delta', { item_id: responseId, output_index: 0, summary_index: 0, delta: reasoningDelta });
      }
      if (typeof d.content === 'string' && d.content) {
        const pre = openMessage(); if (pre) yield pre;
        text += d.content;
        yield ev('response.output_text.delta', { item_id: responseId, output_index: 1, content_index: 0, delta: d.content });
      }
      for (const tc of d.tool_calls || []) {
        const key = tc.index ?? toolCalls.size;
        const cur = toolCalls.get(key) || { id: '', name: '', arguments: '', outIndex: toolCalls.size + 2 };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        if (!toolCalls.has(key)) {
          yield ev('response.output_item.added', {
            output_index: cur.outIndex,
            item: { type: 'function_call', call_id: cur.id, name: cur.name, arguments: '' }
          });
        }
        toolCalls.set(key, cur);
        if (tc.function?.arguments) {
          yield ev('response.function_call_arguments.delta', {
            item_id: responseId, output_index: cur.outIndex, call_id: cur.id, delta: tc.function.arguments
          });
        }
      }
    }
  }
  if (buf.trim() && buf.trim().startsWith('data:')) { /* 末尾无换行的分片已被上面循环漏掉时在此兜底 */ }

  if (reasonOpen) yield ev('response.reasoning_summary_text.done', { item_id: responseId, output_index: 0, summary_index: 0, text: reasoning });
  if (reasonOpen) yield ev('response.output_item.done', { output_index: 0, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] } });
  if (msgOpen) {
    yield ev('response.output_text.done', { item_id: responseId, output_index: 1, content_index: 0, text });
    yield ev('response.content_part.done', { item_id: responseId, output_index: 1, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
    yield ev('response.output_item.done', {
      output_index: 1,
      item: { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    });
  }
  for (const [, tc] of toolCalls) {
    yield ev('response.function_call_arguments.done', { item_id: responseId, output_index: tc.outIndex, call_id: tc.id, arguments: tc.arguments });
    yield ev('response.output_item.done', {
      output_index: tc.outIndex,
      item: { type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments }
    });
  }

  const output = [];
  if (reasonOpen) output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] });
  if (msgOpen) output.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  for (const [, tc] of toolCalls) output.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments });

  yield ev('response.completed', {
    response: {
      id: responseId, object: 'response', created_at: created,
      status: finish === 'length' ? 'incomplete' : 'completed',
      error: null, incomplete_details: finish === 'length' ? { reason: 'max_output_tokens' } : null,
      model, output, output_text: text, usage: mapUsage(usage, { promptTokens, text, reasoning })
    }
  });
  yield 'data: [DONE]\n\n';
}

export function newResponseId() { return `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`; }
