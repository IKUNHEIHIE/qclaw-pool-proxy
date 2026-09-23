import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MoreHorizontal, QrCode, RefreshCw, Stethoscope, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Field, Meter, Mono, Pill } from '@/components/bits';
import { CopyButton } from '@/components/copy';
import { api, LS } from '@/lib/api';
import { fmtMs, num, pt } from '@/lib/format';
import type { Account, LoginSession, Probe } from '@/types';
import type { ConsoleProps } from '@/App';

const statusPill = (a: Account) =>
  !a.enabled ? <Pill tone="warn">已停用</Pill>
    : a.needLogin ? <Pill tone="bad">需要重新登录</Pill>
      : a.cooldownSecondsLeft > 0 ? <Pill tone="warn">冷却 {a.cooldownSecondsLeft}s</Pill>
        : a.ok ? <Pill tone="ok">健康</Pill> : <Pill tone="bad">异常</Pill>;

/** 体检结论：查得到积分就是通，查不到就是掉线/被封，没连通则不定罪 */
const probePill = (p?: Probe) =>
  !p ? null : p.state === 'running' ? <Pill tone="dim">查询中…</Pill>
    : p.state === 'alive' ? <Pill tone="ok" title={p.reason || ''}>通 {p.ms}ms{p.balance != null ? ` · ${pt(p.balance)} 分` : ''}</Pill>
      : p.state === 'need_login' ? <Pill tone="bad" title={p.reason || ''}>需要重新登录</Pill>
        : p.state === 'unreachable' ? <Pill tone="warn" title={p.reason || ''}>暂不可达</Pill>
          : <Pill tone="bad" title={p.reason || ''}>不通</Pill>;

/** 积分余额（4110）—— QClaw 客户端右上角那个数，也是"这个号还能不能用"的真口径 */
function CreditsCell({ c }: { c: Account['credits'] }) {
  if (!c) return <span className="text-muted-foreground text-xs">未查询</span>;
  if (c.error) return <span className="text-destructive text-xs" title={c.error}>查不到积分</span>;
  const granted = (c.items || []).reduce((s, i) => s + (Number(i.total) || 0), 0);
  const pct = granted ? Math.min(100, Math.max(0, (1 - (Number(c.balance) || 0) / granted) * 100)) : 0;
  const detail = (c.items || []).map(i => `${i.label}：剩 ${i.remain} / 共 ${i.total}${i.expireAt ? '（至 ' + String(i.expireAt).slice(0, 10) + '）' : ''}`).join('\n');
  return (
    <div title={detail || '余额 ' + c.balance} className="whitespace-nowrap text-xs">
      <b className="tabular-nums">{pt(c.balance)}</b> 分 · 已用 {Math.round(pct)}%
      <Meter pct={pct} />
      <div className="text-[11px] text-muted-foreground">活动 {pt(c.activity)} · 订阅 {pt(c.subscription)} · 包 {pt(c.package)}</div>
    </div>
  );
}

/** 今日 token 与 RPM（4075）：与积分是两回事，它解释的是"有积分却被限流" */
function TokensCell({ t }: { t: Account['tokens'] }) {
  if (!t) return <span className="text-muted-foreground text-xs">未查询</span>;
  if (t.error) return <span className="text-muted-foreground text-xs" title={t.error}>查询失败</span>;
  if (!t.dailyLimit) return <span className="text-muted-foreground text-xs">无日额度</span>;
  const k = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n));
  return (
    <div className="whitespace-nowrap text-xs" title={`日额度 ${num(t.dailyLimit)}，RPM 上限 ${t.rpmLimit || '—'}`}>
      {k(t.dailyUsed || 0)} / {k(t.dailyLimit)}
      <Meter pct={t.usedPct || 0} />
      <div className="text-[11px] text-muted-foreground">RPM {t.rpmLimit || '—'}</div>
    </div>
  );
}

function QuotaCell({ q }: { q: Account['quota'] }) {
  if (!q) return <span className="text-muted-foreground text-xs">—</span>;
  if (q.error) return <span className="text-muted-foreground text-xs" title={q.error}>查询失败</span>;
  const bits: string[] = [];
  if (q.remaining) bits.push(`剩 ${q.remaining.toLocaleString()}`);
  if (q.used) bits.push(`用 ${q.used.toLocaleString()}`);
  if (q.trialExpiresAt) bits.push(`试用至 ${String(q.trialExpiresAt).slice(0, 10)}`);
  if (q.purchaseExpiresAt) bits.push(`购买至 ${String(q.purchaseExpiresAt).slice(0, 10)}`);
  return <span className="text-xs">{bits.length ? bits.join(' · ') : <span className="text-muted-foreground">无试用/购买</span>}</span>;
}

const byPriority = (a: Account, b: Account) =>
  (a.priority ?? 9999) - (b.priority ?? 9999) || a.id.localeCompare(b.id);

export default function Pool({ s, reload, go }: ConsoleProps) {
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [batch, setBatch] = useState(false);
  const [session, setSession] = useState<LoginSession | null>(null);
  const [qrInfo, setQrInfo] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [imp, setImp] = useState('');
  const [impOut, setImpOut] = useState('');
  const pollRef = useRef<number | null>(null);

  const accts = s.accounts.slice().sort(byPriority);

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => stopPoll, []);

  const setProbe = (id: string, p: Probe | undefined) =>
    setProbes(prev => { const n = { ...prev }; if (p) n[id] = p; else delete n[id]; return n; });

  /**
   * 单个账号体检 = 查积分。走 /admin/accounts/:id/probe：一次 4110 总线查询，
   * 既刷新余额又判定生死，不烧推理额度（真发一次要占 64 token）。
   */
  const checkOne = useCallback(async (id: string, quiet = false) => {
    setProbe(id, { state: 'running' });
    try {
      const r = await api<Probe>(`/admin/accounts/${encodeURIComponent(id)}/probe`, { method: 'POST', body: '{}' });
      setProbe(id, r);
      if (!quiet) (r.state === 'alive' ? toast.success : toast.error)(`${id}：${r.reason || r.state}`);
      return r.state;
    } catch (e) {
      setProbe(id, { state: 'bad', reason: (e as Error).message });
      if (!quiet) toast.error(`${id} 体检失败：${(e as Error).message}`);
      return 'bad';
    }
  }, []);

  /** 深度测活：真发一次推理，验的是"积分之外整条链还通不通"（sk-、模型目录），代价是额度 */
  const deepTest = useCallback(async (id: string) => {
    setProbe(id, { state: 'running' });
    const t0 = Date.now();
    try {
      const r = await api<{ account: string; reply: string | null }>(`/admin/accounts/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' });
      setProbe(id, { state: 'alive', ms: Date.now() - t0, reason: `回了：${(r.reply || '(空正文)').slice(0, 20)}` });
      toast.success(`${id} 推理通 ${Date.now() - t0}ms：${(r.reply || '').slice(0, 24)}`);
    } catch (e) {
      setProbe(id, { state: 'bad', ms: Date.now() - t0, reason: (e as Error).message });
      toast.error(`${id} 推理不通：${(e as Error).message}`);
    }
  }, []);

  /**
   * 一键体检按序号顺序逐个查，不并发：并发会把"谁先掉线"这种顺序信息搅成一团，
   * 而且总线对同 IP 的突发请求并不友好（实测偶发单接口不可达）。
   */
  const checkAll = async () => {
    setBatch(true);
    const dead: string[] = [];
    const unreachable: string[] = [];
    for (const a of accts) {
      const st = await checkOne(a.id, true);
      if (st === 'need_login' || st === 'bad') dead.push(a.id);
      else if (st === 'unreachable') unreachable.push(a.id);
    }
    setBatch(false);
    const parts = [`${accts.length - dead.length - unreachable.length}/${accts.length} 查得到积分`];
    if (dead.length) parts.push(`需要重新登录：${dead.join('、')}`);
    if (unreachable.length) parts.push(`暂不可达（重试即可）：${unreachable.join('、')}`);
    const msg = parts.join(' · ');
    (dead.length ? toast.error : unreachable.length ? toast.info : toast.success)(msg);
    void reload();
  };

  const savePriority = async (id: string, raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return toast.error('序号必须是 ≥0 的整数');
    try {
      await api(`/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ priority: n }) });
      await reload();
      toast.success(`${id} 的调用优先级已设为 ${n}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  /** 按当前显示顺序重排成连续的 0..N-1 —— 删过号的池子总有洞 */
  const resequence = async () => {
    for (let i = 0; i < accts.length; i++) {
      if (accts[i].priority === i) continue;
      await api(`/admin/accounts/${encodeURIComponent(accts[i].id)}`, { method: 'PATCH', body: JSON.stringify({ priority: i }) });
    }
    await reload();
    toast.success('已按当前顺序重排为 0…' + Math.max(0, accts.length - 1));
  };

  const poll = useCallback((id: string) => {
    stopPoll();
    pollRef.current = window.setInterval(async () => {
      try {
        const r = await api<LoginSession>('/admin/login/' + encodeURIComponent(id));
        setSession(r);
        if (r.status === 'done') {
          stopPoll();
          setQrInfo(r.reused
            ? `这个微信号本来就在池里：已就地更新 ${r.reused} 的凭据，号池数量不变（${r.poolSize ?? '?'} 个）`
            : `已新增账号 ${r.account?.id}${r.poolSize ? `，号池共 ${r.poolSize} 个` : ''}`);
          if (r.reused) toast('扫出来的号已在池里，只换了凭据 —— 要加新号得用另一个微信号扫码');
          else toast.success('新账号已入池');
          void reload();
        } else if (r.status === 'expired' || r.status === 'failed') {
          stopPoll();
          setQrInfo(r.status === 'expired' ? '二维码已过期，请重新生成' : '失败（原因见下方日志）');
        } else {
          setQrInfo(r.status === 'saving' ? '已取到凭据，正在写入号池…'
            : r.status === 'scanned' ? '已扫码，请在手机上确认' : '等待扫码');
        }
      } catch (e) {
        stopPoll();
        setQrInfo('轮询失败: ' + (e as Error).message);
      }
    }, 2500);
  }, [reload]);

  const startQr = async () => {
    setQrInfo('申请中…');
    setSession(null);
    try {
      const r = await api<LoginSession>('/admin/login/start', { method: 'POST', body: '{}' });
      setSession(r);
      setQrInfo('等待扫码');
      void poll(r.loginId);
    } catch (e) {
      setQrInfo('失败: ' + (e as Error).message);
    }
  };

  const cancelQr = async () => {
    if (!session?.loginId) return;
    try {
      await api(`/admin/login/${encodeURIComponent(session.loginId)}/cancel`, { method: 'POST' });
      stopPoll();
      setSession(null);
      setQrInfo('已取消，浏览器已回收');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const importJson = async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(imp.trim()); }
    catch (e) { setImpOut('不是合法 JSON: ' + (e as Error).message); return; }
    const list = (Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.accounts) ? (parsed as any).accounts : [parsed]) as Account[];
    const bad = list.findIndex(a => !a || !(a as Account).id || !(a as Account).type);
    if (bad >= 0) { setImpOut(`第 ${bad + 1} 条缺少 id 或 type`); return; }
    const lines: string[] = [];
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      try {
        await api('/admin/accounts/upsert', { method: 'POST', body: JSON.stringify(list[i]) });
        ok++; lines.push(`✓ ${list[i].id} (${list[i].type})`);
      } catch (e) { lines.push(`✗ ${list[i].id}: ${(e as Error).message}`); }
      setImpOut(`导入中 ${i + 1}/${list.length}\n` + lines.join('\n'));
    }
    setImpOut(`完成：${ok}/${list.length} 已入池\n` + lines.join('\n'));
    void reload();
  };

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast.success(ok); await reload(); }
    catch (e) { toast.error((e as Error).message); }
  };

  const dead = accts.filter(a => a.needLogin);

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-end justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle>账号池</CardTitle>
            <CardDescription>
              <span className="ml-1">「序号」即调用优先级：<b>数字越小越优先</b>，同号池内先榨干序号最小的那一档。</span>
              <span className="ml-1"><b>「查积分」就是测活</b>：一次积分查询既刷新余额又判定生死，不占推理额度；<b>查不到积分即说明该号已掉线或被封</b>，需重新扫码登录。登录态取自 JWT 的 <span className="font-mono">exp</span>。</span>
            </CardDescription>
            {!!dead.length && (
              <div className="text-xs text-destructive">
                {dead.length} 个号查不到积分（{dead.map(a => a.id).join('、')}）—— 用下方「生成登录二维码」让<b>同一个微信号</b>再扫一次即可就地换回凭据。
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => act(() => api('/admin/catalog/refresh', { method: 'POST' }), '目录已重载')}>
              <RefreshCw className="size-3.5" />重载全部目录
            </Button>
            <Button id="btnProbeAll" size="sm" variant="outline" disabled={batch || !accts.length} onClick={() => void checkAll()}>
              <Stethoscope className="size-3.5" />{batch ? '查询中…' : '全部查积分'}
            </Button>
            <Button id="btnResequence" size="sm" variant="ghost" onClick={() => void resequence()}>按顺序重排序号</Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">序号</TableHead>
                <TableHead>账号</TableHead><TableHead>类型 / 地址</TableHead><TableHead>状态</TableHead>
                <TableHead>请求/成功/失败 · 延迟</TableHead><TableHead>模型</TableHead>
                <TableHead>积分余额</TableHead><TableHead>今日 token</TableHead><TableHead>试用/购买</TableHead>
                <TableHead>登录态</TableHead><TableHead>体检</TableHead><TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accts.map((a, idx) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Input
                      id={'prio-' + a.id} type="number" min={0} step={1} defaultValue={a.priority ?? idx}
                      className="h-7 w-14 text-center font-mono text-xs"
                      onBlur={e => { const v = e.target.value; if (v === '' || Number(v) === (a.priority ?? idx)) return; void savePriority(a.id, v); }}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    />
                  </TableCell>
                  <TableCell className="max-w-[18rem]">
                    <div className="font-medium">{a.id}</div>
                    <Mono className="text-muted-foreground">{a.secretHint}</Mono>
                    {a.identity?.unionid && (
                      <div className="text-xs text-muted-foreground" title={a.identity.unionid}>
                        微信 {a.identity.nickname || '(无昵称)'} · unionid …{String(a.identity.unionid).slice(-6)}
                      </div>
                    )}
                    {a.lastError && <div className="max-w-[18rem] text-xs text-destructive">{a.lastError.slice(0, 140)}</div>}
                  </TableCell>
                  <TableCell><Mono>{a.type}</Mono><div className="text-xs text-muted-foreground">{a.base}</div></TableCell>
                  <TableCell>{statusPill(a)}<div className="mt-1 text-xs text-muted-foreground">连败 {a.failStreak}</div></TableCell>
                  <TableCell className="tabular-nums text-xs">
                    {a.requests} / {a.successes} / {a.failures}
                    <div className="text-muted-foreground">{fmtMs(a.lastLatencyMs)}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">{a.catalogCount || '—'}</TableCell>
                  <TableCell><CreditsCell c={a.credits} /></TableCell>
                  <TableCell><TokensCell t={a.tokens} /></TableCell>
                  <TableCell><QuotaCell q={a.quota} /></TableCell>
                  <TableCell className="text-xs">
                    {a.jwtExp
                      ? <span className={a.jwtExp.daysLeft < 7 ? 'text-warning' : ''}>至 {a.jwtExp.at}（剩 {a.jwtExp.daysLeft}d）</span>
                      : '—'}
                  </TableCell>
                  <TableCell>{probePill(probes[a.id])
                    || (a.needLogin ? <Pill tone="bad">需要重新登录</Pill> : <span className="text-xs text-muted-foreground">未查</span>)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="ghost" disabled={batch} title="刷新积分余额，并以此判定该号是否还活着"
                        onClick={() => void checkOne(a.id)}>查积分</Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" title="更多操作" aria-label={'更多操作 ' + a.id}>
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onClick={() => {
                            localStorage.setItem(LS.useAcct, a.id);
                            go('chat');
                          }}>用它对话</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void deepTest(a.id)}>
                            深度测活（真发一次推理，占 64 token 额度）
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void act(
                            () => api('/admin/accounts/' + encodeURIComponent(a.id) + '/' + (a.enabled ? 'disable' : 'enable'), { method: 'POST' }),
                            a.enabled ? '已停用 ' + a.id + '：号池不再把它派给任何请求' : '已启用 ' + a.id + '（冷却状态已一并清除）'
                          )}>{a.enabled ? '停用这个号' : '启用这个号'}</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => {
                            if (!confirm('删除账号 ' + a.id + '？')) return;
                            void act(() => api('/admin/accounts/' + encodeURIComponent(a.id), { method: 'DELETE' }), '已删除');
                          }}>删除</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!accts.length && (
                <TableRow><TableCell colSpan={12} className="text-muted-foreground">
                  号池为空 —— 点下方「生成登录二维码」让对方微信扫码即可自动入池（<b>要用一个还没进过池的微信号</b>，
                  扫已入池的号只会就地更新凭据、不会多个号）；也可以在任意一台<b>已登录 QClaw</b> 的机器上执行
                  <span className="font-mono"> node src/bootstrap.mjs --push …</span>（下面那条命令可直接复制）。
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">扫码登录新账号 <Pill tone="ok">可直接入池</Pill></CardTitle>
          <CardDescription>
            <div>
              点一下出微信二维码，<b>让对方用微信扫一扫并确认</b> —— 服务端会自己走完官网那条扫码登录通道：
              先向 <span className="font-mono">4050</span> 领一个绑定本设备的 <span className="font-mono">state</span>，
              扫码回调拿到授权码后带 HMAC 签名打 <span className="font-mono">4026</span> 换出 QClaw 登录 JWT，
              再取 sk- 与模型清单<b>自动入池</b>，全程不需要对方装任何东西。<br />
              之前判定"扫码不可行"是误判：缺签名时 <span className="font-mono">4026</span> 回的是
              <span className="font-mono"> 21004 鉴权不通过，请升级最新版本</span>，看着像接口下线，其实是签名没过。
              同一微信号重复扫会按 unionid 认出来就地更新，不会堆成两条。<br />
              二维码 5 分钟过期；失败原因（含每一次兑换的服务端返回）都展开在下面，并落盘到
              <span className="font-mono"> login-trail.log</span>。老的「从其他机器补号」仍然可用，两条路互补。
            </div>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-start gap-5">
            {session?.qrImage && (
              <div className="grid gap-1.5">
                <img src={session.qrImage} alt="登录二维码" id="qrImg"
                  className="size-56 rounded-lg border bg-white p-1.5 object-contain" />
                <div id="qrState" className="font-mono text-xs text-muted-foreground">
                  {session.status}{session.expiresAt ? ' · 有效至 ' + new Date(session.expiresAt).toLocaleTimeString() : ''}
                </div>
              </div>
            )}
            <div className="min-w-[16rem] flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Button id="btnLoginStart" size="sm" onClick={() => void startQr()}><QrCode className="size-3.5" />生成登录二维码</Button>
                {session && <Button id="btnLoginCancel" size="sm" variant="outline" className="text-destructive" onClick={() => void cancelQr()}><X className="size-3.5" />取消</Button>}
                <span id="loginInfo" className="font-mono text-xs text-muted-foreground">{qrInfo}</span>
              </div>
              {(session?.log?.length || session?.seen?.length) ? (
                <pre id="loginLog" className="mt-3 max-h-52 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                  {(session!.log || []).join('\n')}
                  {session!.seen?.length ? '\n—— 浏览器经过的登录/回调地址 ——\n' + session!.seen.join('\n') : ''}
                </pre>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>从其他机器补号</CardTitle>
          <CardDescription>在任意一台<b>已登录 QClaw</b> 的机器上执行下面这条命令，账号会直接推进本号池，不必手改 config.json。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex items-start gap-2">
            <pre id="pushCmd" className="min-w-0 flex-1 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
              {`node src/bootstrap.mjs --id <这台机器名> --push ${location.origin} --admin-token ${localStorage.getItem(LS.admin) || ''}`}
            </pre>
            <CopyButton id="btnCopyPush" text={() => document.getElementById('pushCmd')?.textContent || ''}>复制命令</CopyButton>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="impJson">或者把 bootstrap 打印的 JSON 粘进来批量导入</Label>
            <Textarea id="impJson" className="min-h-24 font-mono text-xs" value={imp} onChange={e => setImp(e.target.value)}
              placeholder={'支持三种形态：单个账号对象、账号数组、或 {"accounts":[...]}'} />
            <div className="flex items-center gap-3">
              <Button id="btnImport" size="sm" onClick={() => void importJson()}>导入</Button>
              {impOut && <span className="font-mono text-xs text-muted-foreground">{impOut.split('\n')[0]}</span>}
            </div>
            {impOut && <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">{impOut}</pre>}
          </div>
          <div>
            <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>手动添加 / 更新账号</Button>
            <span className="ml-2 text-xs text-muted-foreground">粘贴 JWT 或直连凭据</span>
          </div>
        </CardContent>
      </Card>

      <AddAccountDialog open={addOpen} onClose={() => setAddOpen(false)} onSaved={async () => { setAddOpen(false); await reload(); }} />
    </>
  );
}

function AddAccountDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({
    id: '', base: '', token: '', type: 'qclaw-aizone', agent: '', weight: '', guid: '', account: '', jwt: '', priority: ''
  });
  const [info, setInfo] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLSelectElement>) =>
    setF({ ...f, [k]: (e.target as HTMLInputElement).value });

  const save = async () => {
    const a: Record<string, unknown> = {
      id: f.id.trim(), type: f.type,
      base: f.base.trim() || (f.type === 'qclaw-aizone' ? 'https://mmgrcalltoken.3g.qq.com/aizone/v1/' : ''),
      defaultAgent: f.agent.trim() || 'main', weight: Number(f.weight) || 100
    };
    if (f.priority.trim() !== '') a.priority = Number(f.priority);
    a[f.type === 'openclaw-gateway' ? 'token' : 'apiKey'] = f.token.trim();
    if (f.type === 'qclaw-aizone') {
      a.jwt = f.jwt.trim(); a.guid = f.guid.trim(); a.account = f.account.trim();
      if (!a.jwt || !a.guid) return setInfo('qclaw-aizone 需要 jwt 与 guid');
    }
    if (!a.id || !a.base) return setInfo('id 和 base 必填');
    try {
      await api('/admin/accounts/upsert', { method: 'POST', body: JSON.stringify(a) });
      setInfo('已保存');
      await onSaved();
      toast.success(`已保存 ${a.id}`);
    } catch (e) { setInfo('失败: ' + (e as Error).message); }
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>手动添加 / 更新账号</DialogTitle>
          <DialogDescription>unionid 命中池里已有微信号时会就地更新凭据，不会多出一个号。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="id"><Input id="nId" value={f.id} placeholder="如 qclaw-a" onChange={set('id') as any} /></Field>
          <Field label="类型">
            <Select value={f.type} onValueChange={v => setF({ ...f, type: v })}>
              <SelectTrigger id="nType"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="qclaw-aizone">qclaw-aizone（免签直连，推荐）</SelectItem>
                <SelectItem value="openclaw-gateway">openclaw-gateway</SelectItem>
                <SelectItem value="openai-compat">openai-compat</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="base"><Input id="nBase" value={f.base} placeholder="留空用直连默认" onChange={set('base') as any} /></Field>
          <Field label="token / apiKey"><Input id="nToken" type="password" value={f.token} placeholder="token 或 apiKey" onChange={set('token') as any} /></Field>
          <Field label="jwt"><Input id="nJwt" type="password" value={f.jwt} placeholder="X-OpenClaw-Token 登录态" onChange={set('jwt') as any} /></Field>
          <Field label="guid"><Input id="nGuid" value={f.guid} placeholder="qclaw-aizone 必填，64 位 hex" onChange={set('guid') as any} /></Field>
          <Field label="account"><Input id="nAcct" value={f.account} placeholder="account / user_id" onChange={set('account') as any} /></Field>
          <Field label="defaultAgent"><Input id="nAgent" value={f.agent} placeholder="main" onChange={set('agent') as any} /></Field>
          <Field label="weight"><Input id="nWeight" type="number" value={f.weight} placeholder="100" onChange={set('weight') as any} /></Field>
          <Field label="序号（优先级）"><Input id="nPriority" type="number" min={0} value={f.priority} placeholder="留空 = 排到队尾" onChange={set('priority') as any} /></Field>
        </div>
        <DialogFooter>
          <span className="mr-auto text-xs text-muted-foreground">{info}</span>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => void save()}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
