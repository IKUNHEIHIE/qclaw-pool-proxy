import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { copyText } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * 复制。navigator.clipboard 只在安全上下文里存在，而这个控制台最常见的形态是
 * http://<服务器IP>:8787 —— 那里它是 undefined，execCommand 兜底也可能被拒。
 * 所以最后一级不是"请手动选中"这句话，而是把内容摊在一个已全选的弹层里。
 */
export function useCopyFallback() {
  const [pending, setPending] = useState<string | null>(null);

  const copy = async (text: string) => {
    const s = String(text ?? '');
    if (!s) { toast.error('没有可复制的内容'); return; }
    if (await copyText(s) === 'rejected') {
      setPending(s);
      toast.error('剪贴板被浏览器拒绝，已改为可全选弹层');
    }
  };

  const dialog = (
    <Dialog open={!!pending} onOpenChange={o => { if (!o) setPending(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>浏览器不允许网页写剪贴板</DialogTitle>
          <DialogDescription>
            非 HTTPS 环境下这是浏览器的硬限制。内容已全选在下面框里，按 Ctrl/Cmd+C 即可。
            建议给这个控制台套一层 HTTPS，或用 <code className="font-mono">ssh -L 8787:127.0.0.1:8787</code> 走 localhost。
          </DialogDescription>
        </DialogHeader>
        <Textarea
          readOnly className="min-h-40 font-mono text-xs" value={pending || ''}
          onFocus={e => e.currentTarget.select()}
          onClick={e => (e.currentTarget as HTMLTextAreaElement).select()}
        />
        <Button className="w-fit" onClick={() => setPending(null)}>完成</Button>
      </DialogContent>
    </Dialog>
  );

  return { copy, dialog };
}

export function CopyButton({ text, children = '复制', className, id, variant = 'outline', size = 'sm' }: {
  text: string | (() => string);
  children?: ReactNode;
  className?: string;
  id?: string;
  variant?: 'outline' | 'ghost' | 'secondary';
  size?: 'sm' | 'icon' | 'default';
}) {
  const { copy, dialog } = useCopyFallback();
  return (
    <>
      <Button id={id} variant={variant} size={size} className={cn(className)}
        onClick={() => copy(typeof text === 'function' ? text() : text)}>
        {children}
      </Button>
      {dialog}
    </>
  );
}
