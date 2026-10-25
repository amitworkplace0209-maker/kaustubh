'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Package, Plus, Trash2, Send, ChevronDown, ChevronUp, Edit3,
  Copy, AlertTriangle, CheckCircle2, XCircle, Clock, Loader2, Eye,
  Calendar, IndianRupee, BarChart3, History, Check, Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  getBaskets, createBasket, updateBasket, deleteBasket, pushBasket,
  type Basket, type BasketOrder,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { calculateCharges } from '@/lib/charge-engine';

type Props = {
  onStockSelect?: (symbol: string) => void;
};

type BasketStatus = 'draft' | 'active' | 'completed' | 'expired';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-muted/20 text-muted-foreground border-muted/30',
  ready: 'bg-info/15 text-info border-info/30',
  active: 'bg-info/15 text-info border-info/30',
  executing: 'bg-warning/15 text-warning border-warning/30',
  executed: 'bg-success/15 text-success border-success/30',
  completed: 'bg-success/15 text-success border-success/30',
  partially_executed: 'bg-warning/15 text-warning border-warning/30',
  failed: 'bg-destructive/15 text-destructive border-destructive/30',
  cancelled: 'bg-muted/20 text-muted-foreground border-muted/30',
  expired: 'bg-destructive/10 text-destructive/70 border-destructive/20',
};

const ORDER_STATUS_COLORS: Record<string, string> = {
  EXECUTED: 'text-success',
  FILLED: 'text-success',
  SUCCESS: 'text-success',
  PENDING: 'text-warning',
  OPEN: 'text-warning',
  SUBMITTED: 'text-warning',
  FAILED: 'text-destructive',
  REJECTED: 'text-destructive',
  CANCELLED: 'text-muted-foreground',
};

function formatINR(val: number): string {
  if (!Number.isFinite(val)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}

function resolveDisplayStatus(basket: Basket): BasketStatus {
  const raw = (basket.status || 'draft').toLowerCase().replace(/\s+/g, '_');
  if (raw === 'executed' || raw === 'completed') return 'completed';
  if (raw === 'partially_executed' || raw === 'executing' || raw === 'ready') return 'active';
  if (raw === 'expired') return 'expired';
  if (raw === 'failed' || raw === 'cancelled') return 'completed';
  return 'draft';
}

function calcBasketSummary(orders: BasketOrder[]) {
  let totalValue = 0;
  let totalCharges = 0;
  let highestValue = 0;
  let requiredMargin = 0;

  for (const o of orders) {
    const qty = parseInt(o.quantity) || 0;
    const price = parseFloat(o.price) || 0;
    const value = qty * price;
    totalValue += value;
    if (value > highestValue) highestValue = value;

    const charges = calculateCharges({
      side: o.transactionType === 'BUY' ? 'BUY' : 'SELL',
      quantity: qty,
      price: price || 0,
      product: o.product,
      exchange: o.exchange,
    });
    totalCharges += charges.totalCharges;
    requiredMargin += o.product === 'MIS' ? value * 0.2 : value;
  }

  return { totalValue, totalCharges, highestValue, requiredMargin };
}

export default function BasketManager({ onStockSelect }: Props) {
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteConfirmLoading, setDeleteConfirmLoading] = useState(false);
  const [newBasketName, setNewBasketName] = useState('');
  const [newBasketOrderCount, setNewBasketOrderCount] = useState('');
  const [newBasketAllotment, setNewBasketAllotment] = useState('');
  const [newBasketExpiry, setNewBasketExpiry] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [executingConfirm, setExecutingConfirm] = useState<Basket | null>(null);
  const [addToBasketDialog, setAddToBasketDialog] = useState<string | null>(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<number>>(new Set());
  const [viewHistoryBasket, setViewHistoryBasket] = useState<Basket | null>(null);
  const { toast } = useToast();

  const fetchBaskets = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getBaskets();
      // The API answers `{ data: [...] }`. Reading `data.baskets` here made this
      // list permanently empty, so no basket was ever visible on this panel.
      setBaskets(Array.isArray(data?.data) ? data.data : []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBaskets();
  }, [fetchBaskets]);

  const resetCreateForm = () => {
    setNewBasketName('');
    setNewBasketOrderCount('');
    setNewBasketAllotment('');
    setNewBasketExpiry('');
  };

  const handleCreate = async () => {
    if (!newBasketName.trim()) return;
    try {
      setCreating(true);
      await createBasket({
        name: newBasketName.trim(),
        orders: [],
        cancelOnFill: true,
        orderCount: newBasketOrderCount ? parseInt(newBasketOrderCount) : undefined,
        allotment: newBasketAllotment ? parseFloat(newBasketAllotment) : undefined,
        expiry: newBasketExpiry || undefined,
      });
      resetCreateForm();
      setShowCreateDialog(false);
      fetchBaskets();
      toast({ title: 'Basket created', description: `"${newBasketName.trim()}" is ready for orders` });
    } catch {
      toast({ title: 'Failed to create basket', variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      setDeleteConfirmLoading(true);
      await deleteBasket(id);
      setDeleteConfirmId(null);
      fetchBaskets();
      toast({ title: 'Basket deleted' });
    } catch {
      toast({ title: 'Failed to delete basket', variant: 'destructive' });
    } finally {
      setDeleteConfirmLoading(false);
    }
  };

  const handlePush = async (id: string) => {
    try {
      setExecutingId(id);
      await pushBasket(id);
      fetchBaskets();
      toast({ title: 'Basket pushed', description: 'Orders sent to exchange' });
    } catch {
      toast({ title: 'Basket push failed', variant: 'destructive' });
    } finally {
      setExecutingId(null);
    }
  };

  const handlePushSelected = async (id: string) => {
    if (selectedOrderIds.size === 0) return;
    try {
      setExecutingId(id);
      const basket = baskets.find((b) => b._id === id);
      if (!basket) return;
      const selectedOrders = (basket.orders || []).filter((_, i) => selectedOrderIds.has(i));
      const updatedOrders = (basket.orders || []).map((o, i) =>
        selectedOrderIds.has(i) ? { ...o } : o,
      );
      await updateBasket(id, { orders: updatedOrders });
      await pushBasket(id);
      setSelectedOrderIds(new Set());
      fetchBaskets();
      toast({ title: 'Selected orders executed', description: `${selectedOrders.length} orders sent to exchange` });
    } catch {
      toast({ title: 'Failed to execute selected orders', variant: 'destructive' });
    } finally {
      setExecutingId(null);
    }
  };

  const handleDuplicate = async (basket: Basket) => {
    try {
      await createBasket({
        name: `${basket.name} (Copy)`,
        orders: basket.orders || [],
        cancelOnFill: basket.cancelOnFill,
      });
      fetchBaskets();
      toast({ title: 'Basket duplicated' });
    } catch {
      toast({ title: 'Failed to duplicate basket', variant: 'destructive' });
    }
  };

  const toggleOrderSelection = (index: number) => {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const toggleAllOrders = (basket: Basket) => {
    const pendingIndices = (basket.orders || [])
      .map((o, i) => (o.status === 'pending' || !o.status) ? i : -1)
      .filter((i) => i !== -1);
    if (selectedOrderIds.size === pendingIndices.length) {
      setSelectedOrderIds(new Set());
    } else {
      setSelectedOrderIds(new Set(pendingIndices));
    }
  };

  const draftBaskets = baskets.filter((b) => {
    const s = resolveDisplayStatus(b);
    return s === 'draft' || s === 'active';
  });
  const completedBaskets = baskets.filter((b) => resolveDisplayStatus(b) === 'completed');
  const expiredBaskets = baskets.filter((b) => resolveDisplayStatus(b) === 'expired');

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
            <Package className="h-5 w-5 text-purple" />
            Baskets
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{baskets.length} basket{baskets.length !== 1 ? 's' : ''}</p>
        </div>
        <Button
          size="sm"
          className="h-9 text-xs font-semibold rounded-lg bg-purple hover:bg-purple/90 text-purple-foreground"
          onClick={() => setShowCreateDialog(true)}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" /> New Basket
        </Button>
      </div>

      {/* Loading */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border/30 bg-muted/50 p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="h-5 w-32 bg-muted/60 animate-pulse rounded" />
                <div className="h-4 w-16 bg-muted/60 animate-pulse rounded ml-auto" />
              </div>
              <div className="h-3 w-48 bg-muted/60 animate-pulse rounded" />
              <div className="h-2 w-full bg-muted/60 animate-pulse rounded-full" />
            </div>
          ))}
        </div>
      ) : baskets.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <div className="w-14 h-14 rounded-2xl bg-purple/5 flex items-center justify-center mb-4">
            <Package className="h-7 w-7 text-purple/20" />
          </div>
          <p className="text-sm font-medium text-muted-foreground">No baskets yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1 max-w-[240px]">
            Create a basket to group and execute multiple orders simultaneously
          </p>
          <Button
            size="sm"
            className="mt-4 h-9 text-xs rounded-lg bg-purple hover:bg-purple/90 text-purple-foreground"
            onClick={() => setShowCreateDialog(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Create First Basket
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Draft / Active Baskets */}
          {draftBaskets.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 px-1">
                Active ({draftBaskets.length})
              </div>
              {draftBaskets.map((basket) => (
                <BasketCard
                  key={basket._id}
                  basket={basket}
                  expanded={expandedId === basket._id}
                  onToggle={() => {
                    setExpandedId(expandedId === basket._id ? null : basket._id);
                    setSelectedOrderIds(new Set());
                  }}
                  onPush={() => handlePush(basket._id)}
                  onPushSelected={() => handlePushSelected(basket._id)}
                  onDelete={() => setDeleteConfirmId(basket._id)}
                  onDuplicate={() => handleDuplicate(basket)}
                  onViewHistory={() => setViewHistoryBasket(basket)}
                  executing={executingId === basket._id}
                  selectedOrderIds={selectedOrderIds}
                  onToggleOrder={toggleOrderSelection}
                  onToggleAll={() => toggleAllOrders(basket)}
                />
              ))}
            </div>
          )}

          {/* Completed Baskets */}
          {completedBaskets.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 px-1">
                Completed ({completedBaskets.length})
              </div>
              {completedBaskets.map((basket) => (
                <BasketCard
                  key={basket._id}
                  basket={basket}
                  expanded={expandedId === basket._id}
                  onToggle={() => {
                    setExpandedId(expandedId === basket._id ? null : basket._id);
                    setSelectedOrderIds(new Set());
                  }}
                  onPush={() => handlePush(basket._id)}
                  onPushSelected={() => handlePushSelected(basket._id)}
                  onDelete={() => setDeleteConfirmId(basket._id)}
                  onDuplicate={() => handleDuplicate(basket)}
                  onViewHistory={() => setViewHistoryBasket(basket)}
                  executing={executingId === basket._id}
                  selectedOrderIds={selectedOrderIds}
                  onToggleOrder={toggleOrderSelection}
                  onToggleAll={() => toggleAllOrders(basket)}
                />
              ))}
            </div>
          )}

          {/* Expired Baskets */}
          {expiredBaskets.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 px-1">
                Expired ({expiredBaskets.length})
              </div>
              {expiredBaskets.map((basket) => (
                <BasketCard
                  key={basket._id}
                  basket={basket}
                  expanded={expandedId === basket._id}
                  onToggle={() => {
                    setExpandedId(expandedId === basket._id ? null : basket._id);
                    setSelectedOrderIds(new Set());
                  }}
                  onPush={() => handlePush(basket._id)}
                  onPushSelected={() => handlePushSelected(basket._id)}
                  onDelete={() => setDeleteConfirmId(basket._id)}
                  onDuplicate={() => handleDuplicate(basket)}
                  onViewHistory={() => setViewHistoryBasket(basket)}
                  executing={executingId === basket._id}
                  selectedOrderIds={selectedOrderIds}
                  onToggleOrder={toggleOrderSelection}
                  onToggleAll={() => toggleAllOrders(basket)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={(open) => { setShowCreateDialog(open); if (!open) resetCreateForm(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Create Basket</DialogTitle>
            <DialogDescription className="text-xs">
              Configure your basket. Add orders from the Trade tab after creation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs font-medium text-muted-foreground">Basket Name *</Label>
              <Input
                value={newBasketName}
                onChange={(e) => setNewBasketName(e.target.value)}
                placeholder="e.g. Morning Breakout"
                className="mt-1.5 h-10 text-sm rounded-lg"
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-medium text-muted-foreground">Total Orders</Label>
                <Input
                  type="number"
                  min="0"
                  value={newBasketOrderCount}
                  onChange={(e) => setNewBasketOrderCount(e.target.value)}
                  placeholder="e.g. 10"
                  className="mt-1.5 h-10 text-sm rounded-lg"
                />
              </div>
              <div>
                <Label className="text-xs font-medium text-muted-foreground">Allotment (₹)</Label>
                <Input
                  type="number"
                  min="0"
                  step="1000"
                  value={newBasketAllotment}
                  onChange={(e) => setNewBasketAllotment(e.target.value)}
                  placeholder="e.g. 500000"
                  className="mt-1.5 h-10 text-sm rounded-lg"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs font-medium text-muted-foreground">Expiry Date</Label>
              <Input
                type="date"
                value={newBasketExpiry}
                onChange={(e) => setNewBasketExpiry(e.target.value)}
                className="mt-1.5 h-10 text-sm rounded-lg"
                min={new Date().toISOString().split('T')[0]}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-9 text-xs rounded-lg" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-9 text-xs rounded-lg bg-purple hover:bg-purple/90 text-purple-foreground"
              onClick={handleCreate}
              disabled={creating || !newBasketName.trim()}
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmId !== null} onOpenChange={() => setDeleteConfirmId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Delete Basket</DialogTitle>
            <DialogDescription className="text-xs">
              This will permanently delete this basket and its configuration. This does NOT cancel any broker orders.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-9 text-xs rounded-lg" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-9 text-xs rounded-lg"
              onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}
              disabled={deleteConfirmLoading}
            >
              {deleteConfirmLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1.5" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Execute Confirmation */}
      <Dialog open={executingConfirm !== null} onOpenChange={() => setExecutingConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" />
              Confirm Execution
            </DialogTitle>
            <DialogDescription className="text-xs">
              This will push all orders in <span className="font-semibold text-foreground">&quot;{executingConfirm?.name}&quot;</span> to the exchange. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-9 text-xs rounded-lg" onClick={() => setExecutingConfirm(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-9 text-xs rounded-lg bg-purple hover:bg-purple/90 text-purple-foreground"
              onClick={() => {
                if (executingConfirm) handlePush(executingConfirm._id);
                setExecutingConfirm(null);
              }}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" />
              Execute All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Execution History Dialog */}
      <Dialog open={viewHistoryBasket !== null} onOpenChange={() => setViewHistoryBasket(null)}>
        <DialogContent className="max-w-md max-h-[70vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <History className="h-4 w-4 text-purple" />
              Execution History
            </DialogTitle>
            <DialogDescription className="text-xs">
              {viewHistoryBasket?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-2 py-2">
            {(viewHistoryBasket?.orders || []).length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No orders in this basket yet</p>
            ) : (
              (viewHistoryBasket?.orders || []).map((order, i) => (
                <div key={i} className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-muted/40 border border-border/20 text-xs">
                  <div className="flex flex-col items-center gap-0.5 pt-0.5">
                    {order.status === 'executed' || order.status === 'success' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                    ) : order.status === 'failed' ? (
                      <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                    ) : order.status === 'cancelled' ? (
                      <XCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <Clock className="h-3.5 w-3.5 text-warning shrink-0" />
                    )}
                    {i < (viewHistoryBasket?.orders?.length || 0) - 1 && (
                      <div className="w-px h-4 bg-border/30" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{order.symbol}</span>
                      <Badge
                        variant="outline"
                        className={cn('text-[9px] px-1 py-0 h-3 border-0 font-bold',
                          order.transactionType === 'BUY' ? 'text-success' : 'text-destructive'
                        )}
                      >
                        {order.transactionType}
                      </Badge>
                      <span className="text-muted-foreground">{order.quantity} × {formatINR(parseFloat(order.price) || 0)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span className={cn('font-semibold', ORDER_STATUS_COLORS[String(order.status ?? '').toUpperCase()] || 'text-muted-foreground')}>
                        {order.status || 'pending'}
                      </span>
                      {order.orderId && <span className="font-mono">#{order.orderId}</span>}
                      {order.error && <span className="text-destructive truncate">{order.error}</span>}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Add to Basket Dialog (from external trigger) */}
      <Dialog open={addToBasketDialog !== null} onOpenChange={() => setAddToBasketDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Add to Basket</DialogTitle>
            <DialogDescription className="text-xs">
              Select a basket or create a new one for this order.
            </DialogDescription>
          </DialogHeader>
          <AddToBasketContent
            baskets={baskets}
            onClose={() => setAddToBasketDialog(null)}
            onCreateAndAdd={async (name) => {
              try {
                const result = await createBasket({ name, orders: [], cancelOnFill: true });
                fetchBaskets();
                toast({ title: 'Basket created', description: `"${name}" ready for orders` });
                return result;
              } catch {
                toast({ title: 'Failed to create basket', variant: 'destructive' });
                return null;
              }
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AddToBasketContent({ baskets, onClose, onCreateAndAdd }: {
  baskets: Basket[];
  onClose: () => void;
  onCreateAndAdd: (name: string) => Promise<any>;
}) {
  const [selectedId, setSelectedId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<'select' | 'create'>('select');
  const { toast } = useToast();

  const draftBaskets = useMemo(() =>
    baskets.filter((b) => !b.status || b.status === 'draft' || b.status === 'active'),
    [baskets],
  );

  const handleCreateNew = async () => {
    if (!newName.trim()) return;
    try {
      setCreating(true);
      await onCreateAndAdd(newName.trim());
      setNewName('');
      setMode('select');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-3 py-2">
      <Tabs value={mode} onValueChange={(v) => setMode(v as 'select' | 'create')}>
        <TabsList className="w-full h-9">
          <TabsTrigger value="select" className="text-xs flex-1">Select Basket</TabsTrigger>
          <TabsTrigger value="create" className="text-xs flex-1">Create New</TabsTrigger>
        </TabsList>
        <TabsContent value="select">
          {draftBaskets.length === 0 ? (
            <p className="text-xs text-muted-foreground/70 py-4 text-center">No draft baskets available. Create one first.</p>
          ) : (
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger className="mt-2 h-10 text-sm rounded-lg">
                <SelectValue placeholder="Choose a basket..." />
              </SelectTrigger>
              <SelectContent>
                {draftBaskets.map((b) => (
                  <SelectItem key={b._id} value={b._id} className="text-xs">
                    {b.name} ({(b.orders || []).length} orders)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </TabsContent>
        <TabsContent value="create">
          <div className="space-y-2 pt-1">
            <Label className="text-xs font-medium text-muted-foreground">New Basket Name</Label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Momentum Play"
              className="h-10 text-sm rounded-lg"
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateNew(); }}
              autoFocus
            />
          </div>
        </TabsContent>
      </Tabs>
      <DialogFooter className="gap-2">
        <Button variant="outline" size="sm" className="h-9 text-xs rounded-lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-9 text-xs rounded-lg bg-purple hover:bg-purple/90 text-purple-foreground"
          onClick={mode === 'select' ? onClose : handleCreateNew}
          disabled={creating || (mode === 'select' && !selectedId) || (mode === 'create' && !newName.trim())}
        >
          {creating ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
          {mode === 'select' ? 'Confirm' : 'Create & Add'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function BasketCard({ basket, expanded, onToggle, onPush, onPushSelected, onDelete, onDuplicate, onViewHistory, executing, selectedOrderIds, onToggleOrder, onToggleAll }: {
  basket: Basket;
  expanded: boolean;
  onToggle: () => void;
  onPush: () => void;
  onPushSelected: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onViewHistory: () => void;
  executing: boolean;
  selectedOrderIds: Set<number>;
  onToggleOrder: (index: number) => void;
  onToggleAll: () => void;
}) {
  const orderList = useMemo(() => basket.orders || [], [basket.orders]);
  const summary = useMemo(() => calcBasketSummary(orderList), [orderList]);
  const orderCount = orderList.length;
  const executedCount = useMemo(() => orderList.filter((o) => o.status === 'executed' || o.status === 'success').length, [orderList]);
  const pendingCount = useMemo(() => orderList.filter((o) => o.status === 'pending' || !o.status).length, [orderList]);
  const remainingCount = orderCount - executedCount;
  const progressPercent = orderCount > 0 ? Math.round((executedCount / orderCount) * 100) : 0;

  const executedValue = useMemo(() => {
    return orderList
      .filter((o) => o.status === 'executed' || o.status === 'success')
      .reduce((sum, o) => sum + (parseInt(o.quantity) || 0) * (parseFloat(o.price) || 0), 0);
  }, [orderList]);
  const remainingValue = summary.totalValue - executedValue;

  const displayStatus = resolveDisplayStatus(basket);
  const statusKey = (basket.status || 'draft').toLowerCase().replace(/\s+/g, '_');
  const statusColor = STATUS_COLORS[statusKey] || STATUS_COLORS[displayStatus] || STATUS_COLORS.draft;
  const isDraft = displayStatus === 'draft';
  const hasPendingOrders = pendingCount > 0;

  return (
    <div className={cn(
      'rounded-xl border overflow-hidden transition-all',
      expanded ? 'border-purple/30 bg-card/80' : 'border-border/30 bg-muted/40 hover:border-border/50',
    )}>
      {/* Main Row */}
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={onToggle}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold truncate">{basket.name}</span>
            <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0 h-4 border-0 font-semibold capitalize', statusColor)}>
              {displayStatus}
            </Badge>
          </div>

          {/* Stats Row */}
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Package className="h-3 w-3" />
              {orderCount} order{orderCount !== 1 ? 's' : ''}
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-success/70" />
              {executedCount} executed
            </span>
            {remainingCount > 0 && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3 text-warning/70" />
                {remainingCount} remaining
              </span>
            )}
          </div>

          {/* Value Row */}
          <div className="flex items-center gap-3 mt-1 text-[11px]">
            {summary.totalValue > 0 && (
              <span className="font-semibold font-mono">{formatINR(summary.totalValue)}</span>
            )}
            {executedValue > 0 && (
              <span className="text-success font-mono">{formatINR(executedValue)} done</span>
            )}
            {remainingValue > 0 && remainingValue !== summary.totalValue && (
              <span className="text-muted-foreground font-mono">{formatINR(remainingValue)} left</span>
            )}
          </div>

          {/* Progress Bar */}
          {orderCount > 0 && (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-muted-foreground/70 font-medium">
                  {progressPercent}% executed
                </span>
                <span className="text-[10px] text-muted-foreground/70 font-mono">
                  {executedCount}/{orderCount}
                </span>
              </div>
              <Progress
                value={progressPercent}
                className="h-1.5"
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 rounded-lg"
            onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
            aria-label="Duplicate basket"
          >
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 rounded-lg"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            aria-label="Delete basket"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive/60 hover:text-destructive" />
          </Button>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-border/20 pt-3">
          {/* Summary Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <SummaryTile label="Total Value" value={formatINR(summary.totalValue)} icon={<IndianRupee className="h-3 w-3" />} />
            <SummaryTile label="Executed" value={formatINR(executedValue)} icon={<CheckCircle2 className="h-3 w-3 text-success" />} />
            <SummaryTile label="Remaining" value={formatINR(remainingValue)} icon={<Clock className="h-3 w-3 text-warning" />} />
            <SummaryTile label="Est. Charges" value={formatINR(summary.totalCharges)} icon={<BarChart3 className="h-3 w-3" />} />
          </div>

          {/* Orders Section */}
          {orderList.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Orders</div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[10px] px-2 text-muted-foreground"
                    onClick={(e) => { e.stopPropagation(); onToggleAll(); }}
                  >
                    {selectedOrderIds.size === orderList.filter((o) => o.status === 'pending' || !o.status).length ? 'Deselect All' : 'Select All Pending'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[10px] px-2 text-muted-foreground"
                    onClick={(e) => { e.stopPropagation(); onViewHistory(); }}
                  >
                    <History className="h-3 w-3 mr-1" />
                    History
                  </Button>
                </div>
              </div>

              {orderList.map((order, i) => {
                const orderValue = (parseInt(order.quantity) || 0) * (parseFloat(order.price) || 0);
                const isSelected = selectedOrderIds.has(i);
                const isPending = order.status === 'pending' || !order.status;
                const isExecuted = order.status === 'executed' || order.status === 'success';

                return (
                  <div
                    key={i}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-colors',
                      isSelected ? 'bg-purple/10 border-purple/30' : 'bg-muted/50 border-border/20',
                      !isPending && 'opacity-60',
                    )}
                  >
                    {isPending && (
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => onToggleOrder(i)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                    )}

                    <span className="font-mono text-muted-foreground w-5 text-right shrink-0">{i + 1}</span>

                    <Badge
                      variant="outline"
                      className={cn('text-[9px] px-1.5 py-0 h-3.5 border-0 font-bold shrink-0',
                        order.transactionType === 'BUY' ? 'text-success' : 'text-destructive'
                      )}
                    >
                      {order.transactionType}
                    </Badge>

                    <span className="font-semibold shrink-0">{order.symbol}</span>
                    <span className="text-muted-foreground shrink-0">{order.product}</span>

                    <span className="font-mono text-muted-foreground shrink-0">
                      {order.quantity} × {formatINR(parseFloat(order.price) || 0)}
                    </span>

                    {orderValue > 0 && (
                      <span className="font-mono text-foreground/70 shrink-0">{formatINR(orderValue)}</span>
                    )}

                    <div className="ml-auto flex items-center gap-2 shrink-0">
                      {isExecuted && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-success/10 text-success">
                          LTP captured
                        </span>
                      )}
                      <span className={cn('font-semibold text-[11px] capitalize', ORDER_STATUS_COLORS[String(order.status ?? '').toUpperCase()] || 'text-muted-foreground')}>
                        {order.status || 'pending'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            {hasPendingOrders && (
              <>
                <Button
                  size="sm"
                  className="h-9 text-xs font-semibold rounded-lg bg-purple hover:bg-purple/90 text-purple-foreground"
                  onClick={onPush}
                  disabled={executing}
                >
                  {executing ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Execute All
                </Button>

                {selectedOrderIds.size > 0 && (
                  <Button
                    size="sm"
                    className="h-9 text-xs font-semibold rounded-lg bg-info hover:bg-info/90 text-info-foreground"
                    onClick={onPushSelected}
                    disabled={executing}
                  >
                    {executing ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Execute Selected ({selectedOrderIds.size})
                  </Button>
                )}
              </>
            )}

            {executedCount === orderCount && orderCount > 0 && (
              <div className="flex items-center gap-1.5 text-success text-xs font-medium">
                <CheckCircle2 className="h-4 w-4" />
                All orders executed
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryTile({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/60/40 border border-border/20 px-3 py-2">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] text-muted-foreground/70 font-medium uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-sm font-semibold font-mono mt-0.5">{value}</div>
    </div>
  );
}
