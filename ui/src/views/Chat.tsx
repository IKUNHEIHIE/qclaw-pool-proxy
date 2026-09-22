import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MessageSquarePlus, Send, Square, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Pill } from '@/components/bits';
import { chatOnce, LS } from '@/lib/api';
import { useCopyFallback } from '@/components/copy';
import type { ChatMsg, Conversation } from '@/types';
import type { ConsoleProps } from '@/App';

const newId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/**
 * 会话列表存在浏览器里。老版本只有一串 qpp.hist 不分会话，
 * 第一次加载时把它并成一条会话 —— 否则升级完用户发现自己的对话没了。
 */
function loadConvs(): Conversation[] {
  const raw = localStorage.getItem(LS.convs);
  if (raw) {
    try {
      const list = JSON.parse(raw) as Conversation[];
      if (Array.isArray(list) && list.length) return list;
    } catch { /* 落到迁移分支 */ }
  }
  let hist: ChatMsg[] = [];
  try { hist = JSON.parse(localStorage.getItem(LS.hist) || '[]') as ChatMsg[]; } catch { hist = []; }
  const sys = localStorage.getItem(LS.sys) || '';
  const conv: Conversation = {
    id: newId(),
    title: hist[0]?.content?.slice(0, 18) || '新对话',
    sys,
    msgs: hist.map(m => ({ role: m.role, content: m.content, reasoning: m.reasoning, meta: m.meta }))
  };
  return [conv];
}

const saveConvs = (list: Conversation[]) => localStorage.setItem(LS.convs, JSON.stringify(list));

export default function Chat({ s, keys, ck, setCk }: ConsoleProps) {
  const [convs, setConvs] = useState<Conversation[]>(loadConvs);
  const [activeId, setActiveId] = useState(() => localStorage.getItem(LS.activeConv) || '');
  const [input, setInput] = useState('');
  const [model, setModel] = useState('qclaw/modelroute');
  const [account, setAccount] = useState('');
  const [maxTok, setMaxTok] = useState('4096');
  const [temp, setTemp] = useState('');
  const [stream, setStream] = useState(true);
  const [think, setThink] = useState(() => localStorage.getItem(LS.think) !== '0');
  const [showSys, setShowSys] = useState(() => !!(localStorage.getItem(LS.sys) || ''));
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { copy, dialog } = useCopyFallback();

  const active = useMemo(
    () => convs.find(c => c.id === activeId) || convs[0],
    [convs, activeId]);

  useEffect(() => { if (active) localStorage.setItem(LS.activeConv, active.id); }, [active]);
  useEffect(() => { saveConvs(convs); }, [convs]);
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [active?.msgs, busy]);

  // 「用它对话」：号池页写一个一次性信箱，这里挂载时取走。
  // 不用自定义事件：切过来的一瞬间本组件还没挂载，监听器还不存在，事件会静默丢掉。
  useEffect(() => {
    const want = localStorage.getItem(LS.useAcct);
    if (!want) return;
    localStorage.removeItem(LS.useAcct);
    setAccount(want);
  }, []);

  useEffect(() => {
    if (!s.models.length) return;
    setModel(m => (s.models.some(x => x.id === m) ? m : s.models[0].id));
  }, [s.models]);

  const patch = (fn: (c: Conversation) => Conversation) =>
    setConvs(list => list.map(c => (c.id === active?.id ? fn(c) : c)));

  const createConv = () => {
    const c: Conversation = { id: newId(), title: '新对话', sys: active?.sys || '', msgs: [] };
    setConvs(list => [c, ...list]);
    setActiveId(c.id);
    localStorage.setItem(LS.activeConv, c.id);
    toast.success('已新建对话');
  };

  const dropConv = (id: string) => {
    setConvs(list => {
      const next = list.filter(c => c.id !== id);
      const safe = next.length ? next : [{ id: newId(), title: '新对话', sys: '', msgs: [] } as Conversation];
      if (id === active?.id) setActiveId(safe[0].id);
      return safe;
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!ck) return toast.error('还没有可用的客户端密钥，先到「密钥」页创建');
    const key = keys.find(k => k.key === ck) || null;
    if (!key) return toast.error('当前对话密钥已不在列表里，请重新选择');
    const sys = (active?.sys || '').trim();
    const prior = (active?.msgs || []).filter(m => !m.pending).map(m => ({ role: m.role, content: m.content }));
    const messages = [...(sys ? [{ role: 'system', content: sys }] : []), ...prior, { role: 'user', content: text }];
    const reply: ChatMsg = { role: 'assistant', content: '', reasoning: '', pending: true, meta: '生成中…' };
    const convId = active?.id;
    patch(c => ({
      ...c,
      title: c.msgs.length ? c.title : text.slice(0, 18),
      msgs: [...c.msgs, { role: 'user', content: text }, reply]
    }));
    setInput('');
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    const t0 = Date.now();
    const paint = (patchFn: (m: ChatMsg) => ChatMsg) =>
      setConvs(list => list.map(c => (c.id === convId
        ? { ...c, msgs: c.msgs.map((m, i) => (i === c.msgs.length - 1 ? patchFn(m) : m)) }
        : c)));
    try {
      const r = await chatOnce({
        key: ck, model, messages,
        maxTokens: Number(maxTok) || 1024,
        temperature: temp === '' ? undefined : Number(temp),
        stream, account: account || undefined, think, signal: ctl.signal
      }, part => paint(m => ({
        ...m,
        content: m.content + (part.content || ''),
        reasoning: (m.reasoning || '') + (part.reasoning || ''),
        meta: `${((Date.now() - t0) / 1000).toFixed(1)}s · ${(m.content + (part.content || '')).length} 字（流式中）`
      })));
      paint(m => {
        const tok = r.usage ? `${r.usage.prompt_tokens || 0}+${r.usage.completion_tokens || 0} tok`
          : `≈${Math.round((r.content.length + text.length) / 3)} tok(估)`;
        let meta = `${(r.ms / 1000).toFixed(1)}s · ${r.content.length} 字 · ${tok}`
          + (r.reasoning.length ? ` · 思考 ${r.reasoning.length} 字` : '')
          + (r.account ? ` · ${r.account}` : '') + (r.finish ? ` · ${r.finish}` : '');
        // pool-* 多是推理模型：预算被思考吃光时正文是空串，必须说清楚而不是显示空气泡
        if (!r.content && r.reasoning) meta += ' —— 思考占满了 max_tokens，正文为空；把预算调大或关掉思考再问';
        else if (!r.content) meta += ' —— 上游没返回正文';
        return { ...m, content: r.content, reasoning: r.reasoning, pending: false, meta };
      });
    } catch (e) {
      paint(m => ({ ...m, pending: false, meta: (e as Error).name === 'AbortError' ? '已停止' : '失败: ' + (e as Error).message }));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const resendLast = () => {
    if (!active) return;
    const msgs = active.msgs;
    let u = msgs.length - 1;
    while (u >= 0 && msgs[u].role !== 'user') u--;
    if (u < 0) return;
    const text = msgs[u].content;
    patch(c => ({ ...c, msgs: c.msgs.slice(0, u) }));
    setInput(text);
  };

  const curlFor = (text: string) => `curl ${location.origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${ck || '<你的密钥>'}" -H "content-type: application/json" \\
  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: text }], max_tokens: Number(maxTok) || 1024, stream: false }).replace(/'/g, "'\\''")}'`;

  const canThink = s.models.find(m => m.id === model)?.canThink;

  return (
    <Card>
      <CardContent className="grid gap-4 pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button id="cNew" size="sm" variant="outline" onClick={createConv}>
            <MessageSquarePlus className="size-3.5" />新建对话
          </Button>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {convs.map(c => (
              <span key={c.id} className="flex items-center">
                <Button size="sm" variant={c.id === active?.id ? 'secondary' : 'ghost'}
                  onClick={() => setActiveId(c.id)} title={c.title}>
                  {c.title || '新对话'}
                </Button>
                {convs.length > 1 && (
                  <Button size="icon" variant="ghost" className="size-6 text-muted-foreground hover:text-destructive"
                    title={`删除对话「${c.title || '新对话'}」，不影响其他对话`} onClick={() => dropConv(c.id)}><X className="size-3" /></Button>
                )}
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger id="cModel" className="min-w-[15rem] flex-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(s.models.length ? s.models : [{ id: 'qclaw/modelroute' } as any]).map((m: any) => (
                <SelectItem key={m.id} value={m.id}>{m.id}{m.name && m.name !== m.id ? ' · ' + m.name : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={account || '__auto__'} onValueChange={v => setAccount(v === '__auto__' ? '' : v)}>
            <SelectTrigger id="cAcct" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">自动选号</SelectItem>
              {s.accounts.map(a => <SelectItem key={a.id} value={a.id}>{a.id}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={ck} onValueChange={setCk}>
            <SelectTrigger id="cKey" className="w-44"><SelectValue placeholder="选择客户端密钥" /></SelectTrigger>
            <SelectContent>
              {keys.filter(k => k.enabled !== false).map(k => (
                <SelectItem key={k.key} value={k.key}>{k.name} · {k.masked}</SelectItem>
              ))}
              {!keys.length && <SelectItem value="__none__">（无密钥）</SelectItem>}
            </SelectContent>
          </Select>
          <Input id="cMax" type="number" value={maxTok} onChange={e => setMaxTok(e.target.value)} className="w-24" title="max_tokens" />
          <Input id="cTemp" type="number" step="0.1" value={temp} placeholder="temp" onChange={e => setTemp(e.target.value)} className="w-20" title="temperature" />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch id="cStream" checked={stream} onCheckedChange={setStream} />
            流式
          </label>
          <label className="flex items-center gap-2 text-xs" title="上游只实现了「开/关」两档：关掉即 reasoning_effort=none，档位与 budget 都无效">
            <Switch id="cThink" checked={think} onCheckedChange={v => { setThink(v); localStorage.setItem(LS.think, v ? '1' : '0'); }} />
            <span className={think ? 'text-foreground' : 'text-muted-foreground'}>
              <Sparkles className="mr-1 inline size-3.5" />思考
            </span>
            {canThink === false && <Pill tone="dim">该模型不产出思考</Pill>}
            {canThink && <Pill tone="ok">会思考</Pill>}
          </label>
          <Button size="sm" variant="outline" id="cSys" onClick={() => setShowSys(v => !v)}>System</Button>
        </div>

        {showSys && (
          <Textarea
            id="cSysTxt" placeholder="系统提示词（可选，按会话保存）" className="min-h-16"
            value={active?.sys || ''}
            onChange={e => { const v = e.target.value; setShowSys(true); patch(c => ({ ...c, sys: v })); }}
          />
        )}

        <div id="chat" ref={boxRef} className="max-h-[58vh] min-h-[24vh] space-y-3 overflow-auto pr-1">
          {!active?.msgs.length && (
            <p className="text-sm text-muted-foreground">
              还没有对话。这里用的是<b>真实对外链路</b>：带客户端密钥打 /v1/chat/completions，和外部客户端一模一样。
            </p>
          )}
          {(active?.msgs || []).map((m, i) => (
            <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className="shrink-0 pt-1.5 text-xs text-muted-foreground">{m.role === 'user' ? '你' : '模型'}</div>
              <div className={`min-w-0 flex-1 rounded-lg border px-3 py-2.5 text-sm ${
                m.role === 'user' ? 'bg-primary/10 border-primary/25' : 'bg-muted/40'}`}>
                <div className="whitespace-pre-wrap break-words">
                  {m.content}
                  {m.pending && <span className="ml-0.5 animate-pulse">▋</span>}
                </div>
                {m.reasoning ? (
                  <details className="mt-1.5 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">思考过程 ({m.reasoning.length} 字)</summary>
                    <div className="mt-1 whitespace-pre-wrap">{m.reasoning}</div>
                  </details>
                ) : null}
                {m.meta && <div className="mt-1.5 text-xs text-muted-foreground">{m.meta}</div>}
                {m.role === 'assistant' && !m.pending && (
                  <div className="mt-1.5 flex gap-3 text-xs">
                    <button className="text-muted-foreground underline-offset-2 hover:underline" onClick={resendLast}>重新提问上一条</button>
                    <button className="text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => {
                        const msgs = active!.msgs;
                        let u = i - 1; while (u >= 0 && msgs[u].role !== 'user') u--;
                        if (u < 0) return;
                        void copy(curlFor(msgs[u].content));
                      }}>复制为 curl</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-end gap-2">
          <Textarea
            id="cInput" value={input} className="min-h-14 flex-1"
            placeholder="输入消息，Enter 发送 / Shift+Enter 换行"
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          />
          <Button id="cSend" disabled={busy} onClick={() => void send()}><Send className="size-3.5" />发送</Button>
          {busy && <Button id="cStop" variant="outline" className="text-destructive"
            onClick={() => abortRef.current?.abort()}><Square className="size-3.5" />停止</Button>}
        </div>
        <p className="text-xs text-muted-foreground">
          对话与系统提示词只存在本机浏览器 localStorage；换浏览器不会带走，也不会泄给服务端。
        </p>
      </CardContent>
      {dialog}
    </Card>
  );
}
