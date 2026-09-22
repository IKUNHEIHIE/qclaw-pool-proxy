// 思考深度（reasoning / thinking）参数的跨入口归一。
//
// 上游 aizone 的实测契约（re/probe-effort-tools.mjs、re/probe-usage-graded.mjs）：
//  - `reasoning_effort` 是**被校验**的字段：给对象会 400 invalid_request，给字符串才收。
//  - 只有 `'none'` 有可观察效果（reasoning_content 直接消失）；minimal/low/medium/high
//    之间没有单调差异（同一 prompt 三个档位分别 556/1071/611 字符，属噪声）。
//  - `thinking:{type:'disabled'|'enabled'}` 与之一致，`budget_tokens` 不封顶（预算 60 仍产出 ~850 token 推理）。
//  - 传未知字段一律被忽略，所以"参数没生效"在这条链路上是静默的 —— 只能靠这里显式归一，
//    并在 /v1/models 的 capabilities 里把"这个模型会不会思考"告诉调用方。
//
// 结论：开关跨入口对齐，档位原样透传但不承诺效果。

const OFF = new Set(['none', 'off', 'false', 'disabled']);

/** 从三种客户端报文里取出"要不要思考"，返回 true/false/null（null=没说） */
export function thinkingWanted(body = {}) {
  const t = body.thinking;
  if (t && typeof t === 'object') {
    if (t.type === 'disabled') return false;
    if (t.type === 'enabled' || t.type === 'auto') return true;
  }
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.trim().toLowerCase() : '';
  if (effort) return !OFF.has(effort);
  const nested = body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : null;
  if (nested && typeof nested.effort === 'string') return !OFF.has(nested.effort.trim().toLowerCase());
  return null;
}

/**
 * 把调用方的思考意图翻译成上游认识的 `thinking` + `reasoning_effort`，就地改 chat 报文。
 * @returns {{on: boolean|null, effort: string}} 归一结果，供响应侧决定是否回带 reasoning 块
 */
export function applyReasoning(chat) {
  const on = thinkingWanted(chat);
  let effort = typeof chat.reasoning_effort === 'string' ? chat.reasoning_effort.trim().toLowerCase() : '';
  if (!effort && chat.reasoning && typeof chat.reasoning === 'object' && typeof chat.reasoning.effort === 'string') {
    effort = chat.reasoning.effort.trim().toLowerCase();
  }
  delete chat.reasoning;
  if (on === false) {
    chat.thinking = { type: 'disabled' };
    chat.reasoning_effort = 'none';
    return { on: false, effort: effort || 'none' };
  }
  if (on === true) chat.thinking = { type: 'enabled' };
  else delete chat.thinking;
  if (effort && !OFF.has(effort)) chat.reasoning_effort = effort;
  else delete chat.reasoning_effort;
  return { on: on === null ? null : true, effort };
}

/** 4320 的能力标签里有没有"深度思考" */
export function supportsThinking(capabilities) {
  return (capabilities || []).some(c => String(c).includes('深度思考'));
}
