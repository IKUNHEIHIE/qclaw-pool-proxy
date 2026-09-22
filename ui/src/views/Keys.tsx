import { useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Meter, Pill, Field } from '@/components/bits';
import { CopyButton, useCopyFallback } from '@/components/copy';
import { api, LS } from '@/lib/api';
import { day, num } from '@/lib/format';
import type { ConsoleProps } from '@/App';
import type { KeyRec } from '@/types';

type Draft = {
  key?: string; name: string; note: string; rpm: string; dailyRequests: string;
  maxTokens: string; expiresDays: string; models: string[]; expiresAt?: number | string | null;
};

const empty: Draft = { name: '', note: '', rpm: '', dailyRequests: '', maxTokens: '', expiresDays: '', models: [] };

export default function Keys({ s, keys, ck, setCk, reload }: ConsoleProps) {
  const [show, setShow] = useState(() => localStorage.getItem(LS.showKeys) === '1');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const { copy, dialog } = useCopyFallback();

  const toggle = () => {
    const next = !show;
    setShow(next);
    localStorage.setItem(LS.showKeys, next ? '1' : '0');
  };

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return toast.error('名称必填');
    const body = {
      name: draft.name.trim(), note: draft.note.trim(),
      rpm: Number(draft.rpm) || 0, dailyRequests: Number(draft.dailyRequests) || 0,
      maxTokens: Number(draft.maxTokens) || 0, expiresDays: Number(draft.expiresDays) || 0,
      models: draft.models
    };
    setBusy(true);
    try {
      if (draft.key) {
        await api('/admin/keys/' + encodeURIComponent(draft.key), { method: 'PATCH', body: JSON.stringify(body) });
        setDraft(null);
        await reload();
        toast.success('限额已更新');
        return;
      }
      const r = await api<{ key: string; name: string }>('/admin/keys', { method: 'POST', body: JSON.stringify(body) });
      setDraft(null);
      setCk(r.key);
      localStorage.setItem(LS.ckey, r.key);
      await reload();
      await copy(r.key);
      toast.success(`已创建 ${r.name}，密钥已复制到剪贴板`);
    } catch (e) {
      toast.error('失败: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-end justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>对外 API 密钥</CardTitle>
          <CardDescription>
            限额在网关侧强制执行：超出 <span className="font-mono">429</span>、白名单外模型 <span className="font-mono">403</span>、
            停用/过期 <span className="font-mono">401/403</span>。用量随请求累加并定期写回 config.json。
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button id="btnShowKeys" variant="outline" size="sm" onClick={toggle}>
            {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}{show ? '隐藏明文' : '显示明文'}
          </Button>
          <Button id="btnNewKey" size="sm" onClick={() => setDraft({ ...empty })}>
            <KeyRound className="size-3.5" />新建密钥
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead><TableHead>密钥</TableHead><TableHead>限额</TableHead>
              <TableHead>可用模型</TableHead><TableHead>用量</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map(k => {
              const expired = !!k.expiresAt && new Date(k.expiresAt) < new Date();
              return (
                <TableRow key={k.key}>
                  <TableCell>
                    <div className="font-medium">{k.name}</div>
                    {k.note && <div className="text-xs text-muted-foreground">{k.note}</div>}
                    <div className="text-xs text-muted-foreground">{day(k.createdAt)}</div>
                  </TableCell>
                  <TableCell className="max-w-[16rem] break-all">
                    {k.key === ck && <Pill tone="acc" className="mr-1">对话中</Pill>}
                    <span className="font-mono text-xs">{show ? k.key : k.masked}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {limits(k)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {k.models && k.models.length ? k.models.map(m => m.replace(/^qclaw\//, '')).join(', ') : '全部'}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {num(k.stats.requests)} 次 · {num((k.stats.promptTokens || 0) + (k.stats.completionTokens || 0))} tok
                    {k.dailyRequests ? <Meter pct={(k.today / k.dailyRequests) * 100} title={`今日 ${k.today}/${k.dailyRequests}`} /> : null}
                  </TableCell>
                  <TableCell>
                    {!k.enabled ? <Pill tone="warn">已停用</Pill> : expired ? <Pill tone="bad">已过期</Pill> : <Pill tone="ok">生效中</Pill>}
                    {k.expiresAt && <div className="text-xs text-muted-foreground">{day(k.expiresAt)}</div>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1">
                      <CopyButton text={k.key} size="sm" variant="ghost">复制</CopyButton>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setCk(k.key); toast.success(`对话面板已改用 ${k.key.slice(0, 7)}…`); }}>用它对话</Button>
                      <Button size="sm" variant="ghost" disabled={busy}
                        onClick={() => setDraft({
                          ...empty, key: k.key, name: k.name, note: k.note || '',
                          rpm: String(k.rpm || ''), dailyRequests: String(k.dailyRequests || ''),
                          maxTokens: String(k.maxTokens || ''), expiresDays: '', models: k.models || [], expiresAt: k.expiresAt || null
                        })}>编辑</Button>
                      <Button size="sm" variant="ghost" disabled={busy}
                        onClick={() => act(() => api('/admin/keys/' + encodeURIComponent(k.key), {
                          method: 'PATCH', body: JSON.stringify({ enabled: k.enabled === false })
                        }), k.enabled === false ? `已启用 ${k.name}` : `已停用 ${k.name}：使用该密钥的客户端会立刻 401`)}>
                        {k.enabled === false ? '启用' : '停用'}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy}
                        onClick={() => act(async () => {
                          const r = await api<{ key: string }>(`/admin/keys/${encodeURIComponent(k.key)}/rotate`, { method: 'POST' });
                          if (ck === k.key) setCk(r.key);
                          await copy(r.key);
                          toast.success('新密钥已复制到剪贴板（旧密钥立即失效）');
                        })}>轮换</Button>
                      <Button size="sm" variant="ghost" className="text-destructive" disabled={busy}
                        onClick={() => {
                          if (!confirm(`删除密钥 ${k.key.slice(0, 7)}… ？使用它的客户端会立刻 401。`)) return;
                          void act(() => api('/admin/keys/' + encodeURIComponent(k.key), { method: 'DELETE' }), '已删除');
                        }}>删除</Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!keys.length && (
              <TableRow><TableCell colSpan={7} className="text-muted-foreground">
                还没有密钥 —— 一把密钥都没配时 <span className="font-mono">/v1/*</span> 会返回 503 拒绝所有调用，点右上「新建密钥」签发第一把。
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">
          模型清单来自 /admin/state：{s.models.length} 个对外模型。白名单全不勾 = 不限制。
        </p>
      </CardContent>

      <Dialog open={!!draft} onOpenChange={o => { if (!o) setDraft(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{draft?.key ? `编辑密钥 · ${draft.name}` : '新建密钥'}</DialogTitle>
            <DialogDescription>限额与白名单建完还能改，不必回去 curl 管理端。</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="grid gap-3">
              <Field label="名称"><Input id="fName" value={draft.name} placeholder="如 web-prod / 小吴"
                onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field>
              <Field label="备注"><Input id="fNote" value={draft.note} placeholder="可选"
                onChange={e => setDraft({ ...draft, note: e.target.value })} /></Field>
              <Field label="速率限制"><Input id="fRpm" type="number" min={0} value={draft.rpm} placeholder="0 = 不限（次/分钟）"
                onChange={e => setDraft({ ...draft, rpm: e.target.value })} /></Field>
              <Field label="日配额"><Input id="fDaily" type="number" min={0} value={draft.dailyRequests} placeholder="0 = 不限（次/天，UTC 日切）"
                onChange={e => setDraft({ ...draft, dailyRequests: e.target.value })} /></Field>
              <Field label="max_tokens 上限"><Input id="fMaxTok" type="number" min={0} value={draft.maxTokens} placeholder="0 = 不限（防推理模型吃满额度）"
                onChange={e => setDraft({ ...draft, maxTokens: e.target.value })} /></Field>
              <Field label="有效期"><Input id="fExp" type="number" min={0} value={draft.expiresDays} placeholder="0 = 永久（单位：天）"
                onChange={e => setDraft({ ...draft, expiresDays: e.target.value })} />
                {draft.expiresAt && <p className="mt-1 text-xs text-muted-foreground">当前到期：{new Date(draft.expiresAt).toLocaleString()}</p>}
              </Field>
              <Field label="可用模型">
                <div id="fModels" role="group" aria-label="可用模型白名单"
                  className="flex max-h-40 flex-wrap gap-x-3 gap-y-1.5 overflow-auto rounded-md border p-2.5">
                  {s.models.map(m => (
                    <label key={m.id} className="flex items-center gap-1.5 text-xs">
                      <Checkbox checked={draft.models.includes(m.id)}
                        onCheckedChange={v => setDraft({
                          ...draft,
                          models: v ? [...draft.models, m.id] : draft.models.filter(x => x !== m.id)
                        })} />
                      {m.id.replace(/^qclaw\//, '')}
                    </label>
                  ))}
                  {!s.models.length && <span className="text-xs text-muted-foreground">目录为空，去「号池」页重载目录</span>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">全不勾 = 不限制；也可在配置里手写 <span className="font-mono">"*"</span> 表示全部</p>
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>取消</Button>
            <Button disabled={busy} onClick={() => void save()}>{draft?.key ? '保存' : '创建'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {dialog}
    </Card>
  );
}

function limits(k: KeyRec) {
  const bits: string[] = [];
  if (k.rpm) bits.push(k.rpm + '/min');
  if (k.dailyRequests) bits.push(k.dailyRequests + '/天');
  if (k.maxTokens) bits.push('≤' + k.maxTokens + ' tok');
  return bits.length ? bits.join(' · ') : <span className="text-muted-foreground">不限</span>;
}

