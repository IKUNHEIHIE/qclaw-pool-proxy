export const num = (n?: number | null) => (n ?? 0).toLocaleString();

export const fmtMs = (ms?: number | null) =>
  ms == null ? '—' : ms > 9999 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';

export const ago = (t?: number | string | null) => {
  if (!t) return '—';
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (Number.isNaN(s)) return '—';
  if (s < 60) return Math.round(s) + 's 前';
  if (s < 3600) return Math.round(s / 60) + 'm 前';
  if (s < 86400) return Math.round(s / 3600) + 'h 前';
  return new Date(t).toLocaleDateString();
};

export const day = (t?: number | string | null) => (t ? new Date(t).toLocaleDateString() : '');

/** 积分/额度这类小数：大的取整，小的留两位，别在 0.35 前面印一堆零 */
export const pt = (n?: number | null) => {
  const v = Number(n) || 0;
  return v >= 1000 ? num(Math.round(v)) : String(Math.round(v * 100) / 100);
};

/** 余量条的颜色口径：>90% 已用完是红，>70% 是黄 */
export const barColor = (pct: number) =>
  pct > 90 ? 'bg-destructive' : pct > 70 ? 'bg-warning' : 'bg-success';
