import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Pill } from '@/components/bits';
import { CopyButton } from '@/components/copy';
import { num } from '@/lib/format';
import type { ConsoleProps } from '@/App';

export default function ApiDocs({ s, keys, ck }: ConsoleProps) {
  const [pick, setPick] = useState(ck || keys[0]?.key || '');
  const K = pick || ck || '<你的密钥>';
  const o = location.origin;
  const id = keys.find(k => k.key === pick)?.key || ck || keys[0]?.key || '';

  const snip: Record<string, string> = {
    snipOpenai:
`# OpenAI SDK / 一切兼容 OpenAI 的客户端
base_url = "${o}/v1"
api_key  = "${K}"

curl ${o}/v1/chat/completions \\
  -H "Authorization: Bearer ${K}" -H "content-type: application/json" \\
  -d '{"model":"qclaw/pool-glm-5.2","messages":[{"role":"user","content":"你好"}],"max_tokens":2048}'`,
    snipResp:
`# Responses API —— ChatGPT / Codex 等新客户端走这个，不是 chat/completions
curl ${o}/v1/responses \\
  -H "Authorization: Bearer ${K}" -H "content-type: application/json" \\
  -d '{"model":"qclaw/pool-glm-5.2","input":"你好","max_output_tokens":2048,"stream":true}'

# 也支持 instructions + input 数组（content 用 input_text）
{"model":"qclaw/pool-glm-5.2","instructions":"简洁回答",
 "input":[{"role":"user","content":[{"type":"input_text","text":"你好"}]}]}

返回是 response 对象：output[]（message / reasoning / function_call）、output_text、usage.input_tokens|output_tokens。
流式重放 Responses 事件：response.created → in_progress → output_item.added → output_text.delta → …done → response.completed。
不支持 conversation / previous_response_id / store 等有状态特性（上游没有会话存储，会明确返回 400 而不是假装支持）。`,
    snipAnth:
`# Anthropic SDK（走 /v1/messages，报文自动互转）
base_url = "${o}"
api_key  = "${K}"

curl ${o}/v1/messages \\
  -H "Authorization: Bearer ${K}" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \\
  -d '{"model":"qclaw/pool-glm-5.2","max_tokens":2048,"messages":[{"role":"user","content":"你好"}]}'`,
    snipStream:
`加 "stream": true 即为 SSE。分片里 choices[0].delta.content 是正文，
delta.reasoning_content 是思考过程（pool-* 多为推理模型）。结束标志 data: [DONE]。

注意：这些模型会先消耗预算写思考，max_tokens 太小会得到空正文 + finish_reason=length，建议 ≥1024。
想省积分就显式关思考：chat 传 "reasoning_effort":"none"，Anthropic 传 "thinking":{"type":"disabled"}，三个入口都认。`,
    snipOpts:
`x-qclaw-session: <会话id>   同一会话固定落到同一个账号（KV 缓存更友好）；不带则按号池序号加权轮询
x-qclaw-account: <账号id>   强制指定号池里的某个账号（调试用；不得绕过停用/冷却/服务能力三道闸）
GET /v1/models              只返回该密钥白名单内的模型；带 capabilities（会不会思考）、creditRate（积分倍率）
"stream_options":{"include_usage":true}   上游从不返回 usage，网关会在 [DONE] 前补一帧估算值

错误语义：400 请求参数被上游拒绝（不会因此冷却号池账号）· 401 密钥无效/过期 · 403 已停用或模型不在白名单
· 429 触发限流或日配额（带 retry-after）· 5xx 上游异常
限流与配额都在网关侧按密钥执行，见「密钥」页每把的限额。`,
    snipTools:
`# 工具调用：三个入口都可用（上游原生支持 chat 工具，实测 finish_reason=tool_calls）
curl ${o}/v1/chat/completions -H "Authorization: Bearer ${K}" -H "content-type: application/json" -d '{
  "model":"qclaw/pool-deepseek-v4-flash","max_tokens":1024,"tool_choice":"auto",
  "messages":[{"role":"user","content":"上海现在天气怎么样？必须调用工具查询。"}],
  "tools":[{"type":"function","function":{"name":"get_weather","description":"查询城市天气",
    "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]
}'
# 把结果按 tool_call_id 以 role:"tool" 回传即可续写（多轮工具链已实测通过）
# /v1/messages 用 Anthropic 的 tools + input_schema，出口转成 tool_use 块（参数走 input_json_delta）
# /v1/responses 用扁平 tools（{type,name,parameters}），出口转成 function_call 项

# 思考深度：上游只实现「开 / 关」，档位无效
{"reasoning_effort":"none"}        关掉思考（默认开）—— 实测 reasoning_content 直接为空
{"thinking":{"type":"disabled"}}   同上，Anthropic 写法，三个入口都认
# low / medium / high 与 thinking.budget_tokens 都不改变思考量（同一题目实测 556/1071/611 字符，属噪声），
# 所以别按档位规划积分；哪些模型会思考看 GET /v1/models 的 capabilities 含「深度思考」/ canThink。
# 思考内容回传：chat = delta.reasoning_content，Anthropic = thinking 块（排在正文前），Responses = reasoning 项`
  };

  const rows: [string, string, string][] = [
    ['OpenAI 兼容（Chat Completions）', 'snipOpenai', 'snipOpenai'],
    ['OpenAI Responses（ChatGPT / Codex 系客户端）', 'snipResp', 'snipResp'],
    ['Anthropic 兼容（Messages）', 'snipAnth', 'snipAnth'],
    ['流式', 'snipStream', 'snipStream'],
    ['可选项', 'snipOpts', 'snipOpts'],
    ['工具调用与思考深度', 'snipTools', 'snipTools']
  ];

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-end justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle>接入方式</CardTitle>
            <CardDescription>换下面这把密钥，示例里的 api_key 会跟着变；明文只在你复制时进入剪贴板。</CardDescription>
          </div>
          <Select value={id} onValueChange={setPick}>
            <SelectTrigger id="apiKey" className="w-72 font-mono"><SelectValue placeholder="选择密钥" /></SelectTrigger>
            <SelectContent>
              {keys.map(k => <SelectItem key={k.key} value={k.key}>{k.name} · {k.masked}</SelectItem>)}
              {!keys.length && <SelectItem value="__none__">（无密钥）</SelectItem>}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="grid gap-4">
          {rows.map(([title, sid]) => (
            <div key={sid} className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{title}</h3>
                <CopyButton text={() => document.getElementById(sid)?.textContent || ''} variant="ghost">复制</CopyButton>
              </div>
              <pre id={sid} className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words">
                {snip[sid]}
              </pre>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>模型清单 <span className="text-sm font-normal text-muted-foreground">({s.models.length})</span></CardTitle>
          <CardDescription>目录为空时到「号池」页点「重载全部目录」。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>model</TableHead><TableHead>名称</TableHead><TableHead>说明</TableHead>
                <TableHead>context</TableHead><TableHead>能力</TableHead><TableHead>积分倍率</TableHead><TableHead>可服务账号</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.models.map(m => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono text-xs">{m.id}</TableCell>
                  <TableCell>{m.name || ''}</TableCell>
                  <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">{(m.description || '').slice(0, 60)}</TableCell>
                  <TableCell className="tabular-nums">{m.contextWindow ? num(m.contextWindow) : '—'}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {(m.capabilities || []).map(c => (
                      <Pill key={c} tone={c.includes('深度思考') ? 'ok' : 'dim'} className="mr-1">{c}</Pill>
                    ))}
                    {!(m.capabilities || []).length && <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="tabular-nums text-xs" title={m.creditRate?.note || '未取到计费倍率'}>
                    {m.creditRate ? (m.creditRate.multiplier || '×' + m.creditRate.inputRate) : '—'}
                  </TableCell>
                  <TableCell><span className="font-mono text-xs text-muted-foreground">{m.accounts.join(', ')}</span></TableCell>
                </TableRow>
              ))}
              {!s.models.length && (
                <TableRow><TableCell colSpan={7} className="text-muted-foreground">—</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
