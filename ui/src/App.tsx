import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Moon, RefreshCw, Server, Sun, LogOut } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { adminToken, api, LS, setAdminToken } from '@/lib/api';
import type { KeyRec, State } from '@/types';
import Overview from '@/views/Overview';
import Keys from '@/views/Keys';
import Pool from '@/views/Pool';
import Chat from '@/views/Chat';
import Logs from '@/views/Logs';
import ApiDocs from '@/views/ApiDocs';
import { toast } from 'sonner';

export const VIEWS = [
  { id: 'overview', label: '概览' },
  { id: 'keys', label: '密钥' },
  { id: 'pool', label: '号池' },
  { id: 'chat', label: '对话' },
  { id: 'log', label: '日志' },
  { id: 'api', label: '接入' }
] as const;

export type ViewId = (typeof VIEWS)[number]['id'];

/** 每个视图都拿得到这几样：全局状态、密钥列表、当前对话密钥、重取 */
export type ConsoleProps = {
  s: State;
  keys: KeyRec[];
  ck: string;
  setCk: (k: string) => void;
  reload: () => Promise<void>;
  logTick: number;
  /** 跨视图跳转用（号池页的「用它对话」要切到对话页）。别去点 DOM：Radix 的 tab 只认 pointer 事件 */
  go: (v: ViewId) => void;
};

function themeOf(pref: string | null): boolean {
  if (pref === 'light') return false;
  if (pref === 'dark') return true;
  return true;   // 运营台默认深色：盯着看一整天不刺眼
}

export default function App() {
  const [authed, setAuthed] = useState(() => !!adminToken());
  const [token, setToken] = useState(() => adminToken());
  const [view, setView] = useState<ViewId>(() => {
    const v = localStorage.getItem(LS.view) as ViewId | null;
    return v && VIEWS.some(x => x.id === v) ? v : 'overview';
  });
  const [s, setS] = useState<State | null>(null);
  const [keys, setKeys] = useState<KeyRec[]>([]);
  const [ck, setCkState] = useState(() => localStorage.getItem(LS.ckey) || '');
  const [auto, setAuto] = useState(() => localStorage.getItem('qpp.auto') === '1');
  const [dark, setDark] = useState(() => themeOf(localStorage.getItem('qpp.theme')));
  const [logTick, setLogTick] = useState(0);

  const setCk = useCallback((k: string) => {
    setCkState(k);
    localStorage.setItem(LS.ckey, k);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('qpp.theme', dark ? 'dark' : 'light');
  }, [dark]);

  useEffect(() => { localStorage.setItem(LS.view, view); }, [view]);

  const reload = useCallback(async () => {
    try {
      const next = await api<State>('/admin/state');
      setS(next);
      setLogTick(t => t + 1);
      let list: KeyRec[];
      try { list = (await api<{ keys: KeyRec[] }>('/admin/keys')).keys; } catch { list = []; }
      setKeys(list);
      if (!list.some(k => k.key === ck)) setCk(list.find(k => k.enabled !== false)?.key || '');
    } catch (e) {
      if (/token|令牌/i.test((e as Error).message)) { setAuthed(false); return; }
      toast.error('加载失败: ' + (e as Error).message);
    }
  }, [ck, setCk]);

  useEffect(() => { if (authed) void reload(); }, [authed]);    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!authed || !auto) return;
    const t = setInterval(() => void reload(), 8000);
    return () => clearInterval(t);
  }, [authed, auto, reload]);

  const uptime = useMemo(() => {
    if (!s) return '';
    const sec = Math.floor(s.uptimeMs / 1000);
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return d ? `${d}d${h}h` : h ? `${h}h${m}m` : m ? `${m}m${sec % 60}s` : sec + 's';
  }, [s]);

  if (!authed) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <Card className="w-full max-w-sm">
          <div className="flex items-center gap-2 pb-1">
            <Server className="size-4 text-primary" />
            <h1 className="text-base font-semibold">QClaw 号池代理</h1>
          </div>
          <CardContent className="grid gap-4 pt-2">
            <div className="grid gap-2">
              <Label htmlFor="tok">管理令牌</Label>
              <Input
                id="tok" type="password" placeholder="PROXY_ADMIN_TOKEN" autoComplete="current-password"
                className="font-mono" value={token} onChange={e => setToken(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') document.getElementById('btnLogin')?.click(); }}
              />
            </div>
            <Button id="btnLogin" className="w-full" onClick={() => {
              if (!token.trim()) return toast.error('请输入令牌');
              setAdminToken(token);
              setAuthed(true);
            }}>进入控制台</Button>
            <p className="text-xs text-muted-foreground">
              令牌即服务端 <span className="font-mono">PROXY_ADMIN_TOKEN</span>，只保存在本机浏览器 localStorage。
              没有它，这台服务的管理面一个端点都读不到。
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-5 py-2.5">
          <div className="flex items-center gap-2">
            <Server className="size-4 text-primary" />
            <h1 className="text-sm font-semibold tracking-tight">QClaw 号池代理</h1>
            <Badge variant="outline" className="font-mono text-[11px] font-normal text-muted-foreground">
              v{s?.version ?? '—'}
            </Badge>
          </div>
          <Tabs value={view} onValueChange={v => setView(v as ViewId)} className="min-w-0">
            <TabsList>
              {VIEWS.map(v => <TabsTrigger key={v.id} value={v.id} data-v={v.id}>{v.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
              <Activity className="size-3.5" />
              {s ? `${s.accounts.length} 账号 · ${s.models.length} 模型 · 运行 ${uptime}` : '连接中…'}
            </span>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch id="autoRef" checked={auto} onCheckedChange={v => { setAuto(v); localStorage.setItem('qpp.auto', v ? '1' : '0'); }} />
              自动刷新
            </label>
            <Button id="btnRefresh" variant="outline" size="sm" onClick={() => { void reload(); void 0; }}>
              <RefreshCw className="size-3.5" />刷新
            </Button>
            <Button variant="ghost" size="icon" title={dark ? '切到浅色' : '切到深色'}
              onClick={() => setDark(d => !d)}>
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <Button id="btnLogout" variant="ghost" size="sm" onClick={() => { setAdminToken(''); setAuthed(false); setS(null); }}>
              <LogOut className="size-3.5" />退出
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1400px] gap-4 px-5 pt-5 pb-16">
        {!s && <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">正在读取 /admin/state…</CardContent></Card>}
        {s && view === 'overview' && <Overview s={s} keys={keys} ck={ck} setCk={setCk} reload={reload} logTick={logTick} go={setView} />}
        {s && view === 'keys' && <Keys s={s} keys={keys} ck={ck} setCk={setCk} reload={reload} logTick={logTick} go={setView} />}
        {s && view === 'pool' && <Pool s={s} keys={keys} ck={ck} setCk={setCk} reload={reload} logTick={logTick} go={setView} />}
        {s && view === 'chat' && <Chat s={s} keys={keys} ck={ck} setCk={setCk} reload={reload} logTick={logTick} go={setView} />}
        {s && view === 'log' && <Logs s={s} keys={keys} ck={ck} setCk={setCk} reload={reload} logTick={logTick} go={setView} />}
        {s && view === 'api' && <ApiDocs s={s} keys={keys} ck={ck} setCk={setCk} reload={reload} logTick={logTick} go={setView} />}
      </main>
    </div>
  );
}
