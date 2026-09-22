import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Pill } from '@/components/bits';
import { api } from '@/lib/api';
import { num } from '@/lib/format';
import { useCopyFallback } from '@/components/copy';
import type { ConsoleProps } from '@/App';
import type { LogRow } from '@/types';

type LogResp = { log: LogRow[]; totals: { todayRequests: number; requests: number; denied: number; errorRate: number } };

export default function Logs({ logTick }: ConsoleProps) {
  const [data, setData] = useState<LogResp | null>(null);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');
  const { copy, dialog } = useCopyFallback();

  useEffect(() => {
    let live = true;
    api<LogResp>('/admin/log?limit=200')
      .then(r => { if (live) { setData(r); setErr(''); } })
      .catch(e => { if (live) setErr(String((e as Error).message)); });
    return () => { live = false; };
  }, [logTick]);

  const rows = (data?.log || []).filter(x =>
    filter === '' ? true : filter === 'err' ? !x.ok : filter === '429' ? x.status === 429 : x.status === 401 || x.status === 403);
  const t = data?.totals;

  return (
    <Card>
      <CardHeader className="flex-row items-end justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>请求日志</CardTitle>
          <CardDescription>
            {t ? `今日 ${num(t.todayRequests)} · 累计 ${num(t.requests)} · 拒绝 ${num(t.denied)} · 失败率 ${((t.errorRate || 0) * 100).toFixed(1)}%` : '读取中…'}
            <span className="ml-2">内存环形缓冲（最近 500 条），重启清零；密钥累计用量会写进 config.json，不受重启影响。</span>
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={v => setFilter(v === 'all' ? '' : v)}>
            <SelectTrigger id="logFilter" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="err">只看失败</SelectItem>
              <SelectItem value="429">429 限流</SelectItem>
              <SelectItem value="401">401/403 鉴权</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => copy(rows.map(r =>
            [new Date(r.at).toISOString(), r.key, r.model, r.account, r.status, r.ms + 'ms', r.error || ''].join('\t')).join('\n'))}>
            复制当前列表
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {err && <p className="mb-3 text-sm text-destructive">{err}</p>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead><TableHead>密钥</TableHead><TableHead>模型</TableHead><TableHead>服务账号</TableHead>
              <TableHead>状态</TableHead><TableHead>耗时</TableHead><TableHead>token（估）</TableHead><TableHead>流式</TableHead><TableHead>错误</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(r.at).toLocaleTimeString()}</TableCell>
                <TableCell>{r.key}</TableCell>
                <TableCell><span className="font-mono text-xs">{r.model}</span></TableCell>
                <TableCell><span className="font-mono text-xs text-muted-foreground">{r.account}</span></TableCell>
                <TableCell><Pill tone={r.ok ? 'ok' : r.status === 429 ? 'warn' : 'bad'}>{r.status}</Pill></TableCell>
                <TableCell className="tabular-nums">{r.ms || ''}</TableCell>
                <TableCell className="tabular-nums">
                  {(r.promptTokens || r.completionTokens) ? `${num(r.promptTokens)}+${num(r.completionTokens)}` : '—'}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.stream ? 'SSE' : ''}</TableCell>
                <TableCell className="max-w-[22rem] truncate text-xs text-muted-foreground" title={r.error || ''}>{r.error || ''}</TableCell>
              </TableRow>
            ))}
            {!rows.length && <TableRow><TableCell colSpan={9} className="text-muted-foreground">暂无记录</TableCell></TableRow>}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">
          提示：日志里 <span className="font-mono">400</span> 多为调用方报文被上游拒绝（不会因此冷却号池账号），
          <span className="font-mono"> 429</span> 是网关侧按密钥限额或上游日额度拦的，
          <span className="font-mono"> 21004</span> 才是登录态失效。
        </p>
        {dialog}
      </CardContent>
    </Card>
  );
}

export type { LogRow };
