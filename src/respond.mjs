// 上游响应 → 客户端报文的四个象限：{OpenAI, Anthropic} × {JSON, SSE}。
//
// 单独成模块的唯一理由是**可测**：这段逻辑原来内联在 server 的请求处理里，
// 想验证就必须有一个活着的号池和网络，于是它成了整个项目里最容易腐烂、
// 又最没人管的一段。这里把它和 IO 解耦：`res` 只要有 writeHead/write/end/on 就够了，
// `up` 只要有 json() 和可异步迭代的 body 就够了 —— 两者都能用假对象喂。
//
// 两个必须一直盯着的坑，都在这文件里：
//  1) res.write 返回 false 要等 drain，否则不读的客户端会把整段回复堆进本进程内存；
//  2) 客户端断开要停止拉上游（for-await 里 break 会触发迭代器 return，从而取消上游流）。

import { once } from 'node:events';
import { openAIToAnthropic, sseData, openaiStreamToAnthropic } from './translate.mjs';
import { chatToResponse, chatStreamToResponses, newResponseId } from './responses.mjs';
import { estimateTokens } from './keys.mjs';

/**
 * 从 SSE 流里抄一份正文和末尾 usage 出来用于计量。
 * 上游不返回 usage 时（aizone 实测连 stream_options.include_usage 都不给），只能靠字符数粗估，
 * 所以这里宁可少算也不能算错方向：正文和推理一个字都不能漏。
 */
export function createCollector() {
  const acc = { text: '', reasoning: '', usage: null };
  let buf = '';

  const consume = line => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }   // 心跳/注释行
    if (j.usage) acc.usage = j.usage;
    const d = j.choices?.[0]?.delta;
    if (typeof d?.content === 'string') acc.text += d.content;
    if (typeof d?.reasoning_content === 'string') acc.reasoning += d.reasoning_content;
    else if (typeof d?.reasoning === 'string') acc.reasoning += d.reasoning;
    // Anthropic 风格分片：event: content_block_delta / delta.text
    if (j.type === 'content_block_delta' && typeof j.delta?.text === 'string') acc.text += j.delta.text;
  };

  return {
    acc,
    feed(text) {
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { consume(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    /** 收尾：最后一行没有换行符也要处理掉，否则正文尾巴会被静默丢掉、估算偏低 */
    finish() { if (buf) { consume(buf); buf = ''; } }
  };
}

async function waitWrite(res, frame) {
  if (res.write(frame)) return;
  await Promise.race([
    once(res, 'drain').catch(() => {}),
    once(res, 'close').catch(() => {})
  ]);
}

async function pipeThrough(res, iterable, collector, guard) {
  const dec = new TextDecoder();
  for await (const chunk of iterable) {
    if (guard?.gone) break;
    if (collector) collector.feed(dec.decode(chunk, { stream: true }));
    await waitWrite(res, chunk);
  }
  collector?.finish();
}

/**
 * OpenAI 流式且调用方要 usage：aizone 从不返回 usage（带 stream_options.include_usage 也不给），
 * 按 usage 做上下文压缩的客户端会把它当成 0 token，于是永远不触发压缩、一路撑爆窗口。
 * 所以在 [DONE] 之前补一帧估算值 —— 这条路径只在调用方明确要 usage 时才走，
 * 其余情况保持字节级透传。
 */
async function pipeWithUsage(res, dataItems, collector, guard, { model, promptTokens }) {
  let done = false;
  for await (const payload of dataItems) {
    if (guard?.gone) break;
    if (payload !== '[DONE]') {
      const frame = `data: ${payload}\n\n`;
      collector.feed(frame);
      await waitWrite(res, frame);
      continue;
    }
    collector.finish();
    const u = collector.acc.usage || {
      prompt_tokens: promptTokens,
      completion_tokens: estimateTokens(collector.acc.text + collector.acc.reasoning),
      total_tokens: promptTokens + estimateTokens(collector.acc.text + collector.acc.reasoning)
    };
    await waitWrite(res, `data: ${JSON.stringify({ object: 'chat.completion.chunk', created: 0, model, choices: [], usage: u })}\n\n`);
    await waitWrite(res, 'data: [DONE]\n\n');
    done = true;
    break;
  }
  if (!done) { collector.finish(); if (!guard?.gone) await waitWrite(res, 'data: [DONE]\n\n'); }
}

/** 把"生成器产出的帧"逐帧写出去（Anthropic 流式没有现成的上游字节可透传） */
async function pipeFrames(res, frames, collector, guard) {
  for await (const piece of frames) {
    if (guard?.gone) break;
    if (collector) collector.feed(piece);
    await waitWrite(res, piece);
  }
  collector?.finish();
}

function writeJson(res, obj, cors) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': cors
  });
  res.end(body);
}

function sseHead(res, cors, extra = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': cors,
    ...extra
  });
}

/**
 * 把上游响应按客户端期望的报文风格写出去。
 * @returns {{usage: object|null, text: string, reasoning: string, aborted: boolean}} 供调用方计量
 */
export async function respond({ res, up, style = 'openai', stream = false, model, guard, cors = '*', respMeta, promptTokens = 0, wantUsage = false }) {
  const collector = createCollector();
  if (!stream) {
    const json = await up.json();
    // 上游永远是 OpenAI 形状，Anthropic / Responses 风格都只在出参时转换，
    // 所以正文一律从原始 json 读，避免各转一遍再回头取。
    const msg = json.choices?.[0]?.message || {};
    const reasoning = String(msg.reasoning_content || msg.reasoning || '');
    const text = String(msg.content ?? '');
    const payload = style === 'anthropic' ? openAIToAnthropic(json, model, { promptTokens })
      : style === 'responses' ? chatToResponse(json, { model, promptTokens, ...(respMeta || {}) }) : json;
    writeJson(res, payload, cors);
    return { usage: json.usage || null, text, reasoning, aborted: false };
  }
  // x-accel-buffering 只对透传分支有意义：nginx 会吞掉 SSE 的缓冲
  sseHead(res, cors, style === 'anthropic' ? {} : { 'x-accel-buffering': 'no' });
  if (style === 'openai' && wantUsage) {
    await pipeWithUsage(res, sseData(up.body), collector, guard, { model, promptTokens });
  } else if (style === 'openai') await pipeThrough(res, up.body, collector, guard);
  else if (style === 'anthropic') {
    await pipeFrames(res, openaiStreamToAnthropic(sseData(up.body), model, { promptTokens }), collector, guard);
  } else {
    const rid = respMeta?.id || newResponseId();
    const created = respMeta?.created_at || Math.floor(Date.now() / 1000);
    await pipeFrames(res, chatStreamToResponses(up.body, { model, responseId: rid, created, promptTokens }), collector, guard);
  }
  res.end();
  return { usage: collector.acc.usage, text: collector.acc.text, reasoning: collector.acc.reasoning, aborted: !!guard?.gone };
}
