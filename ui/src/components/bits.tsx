import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const TONES = {
  ok: 'bg-success/12 text-success border-success/30',
  warn: 'bg-warning/12 text-warning border-warning/30',
  bad: 'bg-destructive/12 text-destructive border-destructive/30',
  dim: 'bg-muted text-muted-foreground',
  acc: 'bg-primary/12 text-primary border-primary/30'
} as const;

export type Tone = keyof typeof TONES;

export function Pill({ tone, children, title, className }:
  { tone: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <Badge variant="outline" title={title} className={cn('font-normal tabular-nums', TONES[tone], className)}>
      {children}
    </Badge>
  );
}

/** 余量条：pct 是"已消耗百分比"，>90% 红、>70% 黄 */
export function Meter({ pct, className, title }: { pct: number; className?: string; title?: string }) {
  const v = Math.min(100, Math.max(0, pct || 0));
  return (
    <div title={title} className={cn('mt-1 h-1 w-28 overflow-hidden rounded-full bg-muted', className)}>
      <div
        className={cn('h-full rounded-full', v > 90 ? 'bg-destructive' : v > 70 ? 'bg-warning' : 'bg-success')}
        style={{ width: v + '%' }}
      />
    </div>
  );
}

export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn('font-mono text-xs', className)}>{children}</span>;
}

/** 表单里「左标签右控件」的一行；弹层表单和筛选条共用 */
export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-[8.5rem_1fr] items-center gap-3', className)}>
      <Label className="text-muted-foreground font-normal">{label}</Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
