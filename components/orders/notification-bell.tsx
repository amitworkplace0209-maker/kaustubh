'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Bell, CheckCheck, Trash2, X, MoreVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  getNotifications, markNotificationRead, markAllNotificationsRead,
  deleteNotification,
} from '@/lib/api';
import { useRouter } from 'next/navigation';

type Notification = {
  _id: string;
  type: string;
  category?: string;
  title: string;
  message: string;
  severity?: string;
  level?: string;
  read: boolean;
  ts: string;
  symbol?: string;
  orderId?: string;
  entityType?: string;
  entityId?: string;
  [key: string]: any;
};

const SEVERITY_COLORS: Record<string, string> = {
  success: 'text-success',
  info: 'text-info',
  warn: 'text-warning',
  warning: 'text-warning',
  error: 'text-destructive',
};

const SEVERITY_DOT: Record<string, string> = {
  success: 'bg-success',
  info: 'bg-info',
  warn: 'bg-warning',
  warning: 'bg-warning',
  error: 'bg-destructive',
};

function formatIst(ts: string): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch { return ''; }
}

function formatTimeAgo(ts: string): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  } catch { return ''; }
}

export default function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [recent, setRecent] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const router = useRouter();
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const notificationPath = '/trading/notifications';

  const fetchUnreadCount = useCallback(async () => {
    try {
      const data = await getNotifications('?unread_only=true');
      const count = data?.unreadCount ?? 0;
      setUnreadCount(count);
    } catch { /* ignore */ }
  }, []);

  const fetchRecent = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getNotifications('');
      const items = data?.notifications || data?.data || [];
      setRecent(Array.isArray(items) ? items.slice(0, 5) : []);
      const count = data?.unreadCount ?? unreadCount;
      setUnreadCount(count);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [unreadCount]);

  useEffect(() => {
    fetchUnreadCount();
    pollRef.current = setInterval(fetchUnreadCount, 30000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchUnreadCount]);

  const handleOpen = () => {
    setOpen(!open);
    if (!open) fetchRecent();
  };

  const handleMarkRead = async (id: string) => {
    try {
      await markNotificationRead(id);
      setRecent((prev) => prev.map((n) => n._id === id ? { ...n, read: true } : n));
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch { /* ignore */ }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead();
      setRecent((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteNotification(id);
      setRecent((prev) => prev.filter((n) => n._id !== id));
      if (!recent.find((n) => n._id === id)?.read) {
        setUnreadCount((prev) => Math.max(0, prev - 1));
      }
      setDeleteConfirm(null);
    } catch { /* ignore */ }
  };

  const handleNotificationClick = (n: Notification) => {
    if (!n.read) handleMarkRead(n._id);
    setOpen(false);
    const type = n.entityType || n.type || '';
    if (type === 'order' || type === 'ORDER') router.push('/trading/trade');
    else if (type === 'position' || type === 'POSITION') router.push('/trading/positions');
    else if (type === 'basket' || type === 'BASKET') router.push('/trading/trade');
    else if (type === 'DOWNLOAD') router.push('/data-saver/downloads');
  };

  const displayCount = unreadCount > 99 ? '99+' : unreadCount > 0 ? String(unreadCount) : '';

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0 relative text-muted-foreground hover:text-foreground"
        onClick={handleOpen}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
      >
        <Bell className="h-4 w-4" />
        {displayCount && (
          <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] px-0.5 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center animate-in fade-in zoom-in-95">
            {displayCount}
          </span>
        )}
      </Button>

      {/* Dropdown Panel */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-80 max-h-[440px] bg-popover border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">Notifications</span>
                {unreadCount > 0 && (
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-destructive/30 text-destructive bg-destructive/10">
                    {unreadCount}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={handleMarkAllRead}
                  >
                    <CheckCheck className="h-3 w-3 mr-1" /> Mark all read
                  </Button>
                )}
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setOpen(false)}>
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            </div>

            {/* List */}
            <div className="max-h-[300px] overflow-y-auto">
              {loading && recent.length === 0 ? (
                <div className="p-8 text-center text-xs text-muted-foreground">Loading...</div>
              ) : recent.length === 0 ? (
                <div className="p-8 text-center">
                  <Bell className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                  <p className="text-sm font-medium text-muted-foreground">No notifications</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">You&apos;re all caught up</p>
                </div>
              ) : (
                recent.map((n) => (
                  <div
                    key={n._id}
                    className={cn(
                      'flex items-start gap-3 px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer border-b border-border/50 last:border-0',
                      !n.read && 'bg-muted/30'
                    )}
                    onClick={() => handleNotificationClick(n)}
                  >
                    <div className={cn(
                      'h-2 w-2 rounded-full mt-1.5 shrink-0',
                      SEVERITY_DOT[n.severity ?? n.level ?? 'info'] || 'bg-muted-foreground/40'
                    )} />
                    <div className="flex-1 min-w-0">
                      <span className={cn(
                        'text-xs font-semibold',
                        SEVERITY_COLORS[n.severity ?? n.level ?? 'info'] || 'text-foreground'
                      )}>
                        {n.title}
                      </span>
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">{n.message}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-muted-foreground/50 font-mono">{formatTimeAgo(n.ts)}</span>
                        {n.ts && (
                          <span className="text-[10px] text-muted-foreground/30 font-mono">{formatIst(n.ts)} IST</span>
                        )}
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0 opacity-0 group-hover:opacity-100 hover:opacity-100">
                          <MoreVertical className="h-3 w-3 text-muted-foreground/60" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        {!n.read && (
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleMarkRead(n._id); }}>
                            <CheckCheck className="h-3.5 w-3.5 mr-2" /> Mark as read
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setDeleteConfirm(n._id); }} className="text-destructive">
                          <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-border px-4 py-2.5">
              <button
                className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground font-medium py-1 transition-colors"
                onClick={() => { setOpen(false); router.push(notificationPath); }}
              >
                View all notifications →
              </button>
            </div>
          </div>
        </>
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirm !== null} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Delete notification?</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">This will only remove the notification. It will not affect any orders or positions.</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button size="sm" variant="destructive" className="h-8 text-xs" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
