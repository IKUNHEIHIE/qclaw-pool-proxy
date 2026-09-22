import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Meter, Pill } from '@/components/bits';
import { ago, fmtMs, num } from '@/lib/format';
import type { ConsoleProps } from '@/App';

const toneOf = (a: ConsoleProps['s']['accounts'][number]) =>
  !a.enabled ? '停用' : a.cooldownSecondsLeft > 0 ? `冷却 ${a.cooldownSecondsLeft}s` : a.ok ? '健康' : '异常';

const pillOf = (a: ConsoleProps['s']['accounts'][number]) =>
  (!a.enabled || a.cooldownSecondsLeft > 0) ? 'warn' : a.ok ? 'ok' : 'bad';

export default function Overview({ s, keys }: ConsoleProps) {
  const healthy = s.accounts.filter(a => a.ok && a.enabled);
  const k = s.keys || {};
  const cards: [string, string][] = [
    ['在线账号', `${healthy.length} / ${s.accounts.length}`],
    ['对外模型', String(s.models.length)],
    ['有效密钥', `${k.active ?? 0} / ${k.total ?? 0}`],
    ['今日请求', num(k.todayRequests)],
    ['累计请求', num(k.requests)],
    ['失败率', `${((k.errorRate || 0) * 100).toFixed(2)}%`],
    ['换号重试', num(s.stats.retries)],
    ['运行时长', Math.round(s.uptimeMs / 1000) + 's']
  ];

  const soon = s.accounts.filter(a => a.jwtExp && a.jwtExp.daysLeft < 7);
  const off = s.accounts.filter(a => a.enabled === false);
  const cool = s.accounts.filter(a => a.cooldownSecondsLeft > 0);
  const banners: { bad: boolean; text: string }[] = [];
  if (k.total === 0) banners.push({ bad: true, text: '还没有任何对外密钥：/v1/* 一律返回 503 拒绝所有调用（这是防误配的默认拒绝，不是开放模式）。到「密钥」页签发第一把即恢复。' });
  if (!healthy.length) banners.push({ bad: true, text: '号池里没有健康账号，所有请求都会失败。' });
  if (soon.length) banners.push({ bad: false, text: `${soon.length} 个账号的登录态 7 天内到期：${soon.map(a => a.id + '(' + a.jwtExp!.daysLeft + 'd)').join('、')}。到期后需在那台机器重新登录再推送。` });
  if (off.length) banners.push({ bad: false, text: `${off.length} 个账号已被停用（${off.map(a => a.id).join('、')}）：不会再接到任何请求，要恢复在「号池」页点「启用」。` });
  if (cool.length) banners.push({ bad: false, text: `${cool.length} 个账号正在冷却（${cool.map(a => a.id + ' ' + a.cooldownSecondsLeft + 's').join('、')}）。` });

  return (
    <>
      {banners.map((b, i) => (
        <div key={i}
          className={`flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm ${
            b.bad ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-warning/40 bg-warning/10 text-warning'}`}>
          {b.bad ? <ShieldAlert className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
          <span>{b.text}</span>
        </div>
      ))}

      <Card>
        <CardHeader><CardTitle>运行状况</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cards.map(([t, v]) => (
            <div key={t} className="rounded-lg border bg-card/50 px-3 py-2.5">
              <div className="text-2xl font-semibold tabular-nums leading-tight">{v}</div>
              <div className="text-xs text-muted-foreground">{t}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>号池健康</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>账号</TableHead><TableHead>状态</TableHead><TableHead>今日请求</TableHead>
                  <TableHead>成功率</TableHead><TableHead>延迟</TableHead><TableHead>登录态剩余</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.accounts.map(a => {
                  const tot = a.requests || 0;
                  return (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">{a.id}</TableCell>
                      <TableCell><Pill tone={pillOf(a)}>{toneOf(a)}</Pill></TableCell>
                      <TableCell className="tabular-nums">{tot}</TableCell>
                      <TableCell className="tabular-nums">{tot ? ((a.successes / tot) * 100).toFixed(1) + '%' : '—'}</TableCell>
                      <TableCell className="tabular-nums">{fmtMs(a.lastLatencyMs)}</TableCell>
                      <TableCell className="tabular-nums">
                        {a.jwtExp
                          ? <span className={a.jwtExp.daysLeft < 7 ? 'text-warning' : ''}>剩 {a.jwtExp.daysLeft} 天</span>
                          : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!s.accounts.length && (
                  <TableRow><TableCell colSpan={6} className="text-muted-foreground">号池为空</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>密钥用量 Top</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead><TableHead>请求</TableHead><TableHead>今日</TableHead>
                  <TableHead>失败</TableHead><TableHead>token（估）</TableHead><TableHead>最近使用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.slice().sort((a, b) => (b.stats.requests || 0) - (a.stats.requests || 0)).slice(0, 8).map(x => (
                  <TableRow key={x.key}>
                    <TableCell className="font-medium">{x.name}</TableCell>
                    <TableCell className="tabular-nums">{num(x.stats.requests)}</TableCell>
                    <TableCell className="tabular-nums">
                      {num(x.today)}
                      {x.dailyRequests ? <Meter pct={(x.today / x.dailyRequests) * 100} className="w-20" /> : null}
                    </TableCell>
                    <TableCell className={`tabular-nums ${x.stats.failed ? 'text-destructive' : ''}`}>{num(x.stats.failed)}</TableCell>
                    <TableCell className="tabular-nums">{num((x.stats.promptTokens || 0) + (x.stats.completionTokens || 0))}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{ago(x.stats.lastUsedAt)}</TableCell>
                  </TableRow>
                ))}
                {!keys.length && (
                  <TableRow><TableCell colSpan={6} className="text-muted-foreground">还没有密钥</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
