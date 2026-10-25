'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Package, Plus, ChevronDown, ChevronUp, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { getBaskets, updateBasket, type Basket, type BasketOrder } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

type Props = {
  symbol: string;
  exchange: string;
  token: string;
  transactionType: 'BUY' | 'SELL';
  product: string;
  orderType: string;
  quantity: string;
  price: string;
};

function formatINR(val: number): string {
  if (!Number.isFinite(val)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}

export default function BasketOrderPanel({
  symbol, exchange, token, transactionType, product, orderType, quantity, price,
}: Props) {
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [selectedBasketId, setSelectedBasketId] = useState<string>('');
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const { toast } = useToast();

  const fetchBaskets = useCallback(async () => {
    try {
      const data = await getBaskets();
      const list = (Array.isArray(data?.data) ? data.data : []) as Basket[];
      setBaskets(list);
      if (!selectedBasketId && list.length > 0) {
        setSelectedBasketId(list[0]._id);
      }
    } catch {
      // ignore
    }
  }, [selectedBasketId]);

  useEffect(() => {
    fetchBaskets();
  }, [fetchBaskets]);

  const selectedBasket = useMemo(
    () => baskets.find((b) => b._id === selectedBasketId) || null,
    [baskets, selectedBasketId],
  );

  const stockInBasket = useMemo(() => {
    if (!selectedBasket) return false;
    return (selectedBasket.orders || []).some(
      (o) => o.symbol?.toUpperCase() === symbol?.toUpperCase() && o.exchange === exchange,
    );
  }, [selectedBasket, symbol, exchange]);

  const handleAddToBasket = async () => {
    if (!selectedBasket) return;
    try {
      setAdding(true);
      const existingOrders = selectedBasket.orders || [];
      const newOrder: BasketOrder = {
        symbol,
        token,
        exchange,
        transactionType,
        product,
        orderType,
        quantity,
        price: price || '0',
        triggerPrice: '0',
        status: 'pending',
        orderId: null,
        error: null,
      };
      await updateBasket(selectedBasket._id, {
        orders: [...existingOrders, newOrder],
      });
      setAdded(true);
      fetchBaskets();
      toast({ title: 'Added to basket', description: `${symbol} added to "${selectedBasket.name}"` });
      setTimeout(() => setAdded(false), 2000);
    } catch {
      toast({ title: 'Failed to add to basket', variant: 'destructive' });
    } finally {
      setAdding(false);
    }
  };

  const draftBaskets = baskets.filter((b) => !b.status || b.status === 'draft');

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl border border-purple/20 bg-purple/[0.03] overflow-hidden">
        <CollapsibleTrigger asChild>
          <button className="w-full flex items-center justify-between px-4 py-3 hover:bg-purple/5 transition-colors">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-purple" />
              <span className="text-sm font-medium text-foreground/80">Basket</span>
              {selectedBasket && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-purple/30 text-purple bg-purple/10">
                  {selectedBasket.name}
                </Badge>
              )}
              {stockInBasket && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-success/30 text-success bg-success/10">
                  <Check className="h-2.5 w-2.5 mr-0.5" /> In Basket
                </Badge>
              )}
            </div>
            {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 pb-4 space-y-3 border-t border-purple/10 pt-3">
            {/* Basket Selector */}
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Select Basket</label>
              {draftBaskets.length === 0 ? (
                <p className="text-xs text-muted-foreground/70 mt-1">No draft baskets. Create one in the Basket tab.</p>
              ) : (
                <Select value={selectedBasketId} onValueChange={setSelectedBasketId}>
                  <SelectTrigger className="mt-1.5 h-9 text-xs rounded-lg bg-muted/50 border-purple/20">
                    <SelectValue placeholder="Select a basket" />
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
            </div>

            {/* Current Stock in Basket */}
            {selectedBasket && (
              <div className="rounded-lg bg-muted/40 border border-border/20 px-3 py-2 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Basket Orders</span>
                  <span className="font-semibold">{(selectedBasket.orders || []).length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Current Stock</span>
                  <span className="font-semibold">{symbol}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Basket Order</span>
                  <span className="font-mono font-semibold">{transactionType} {quantity} {product}</span>
                </div>
              </div>
            )}

            {/* Add to Basket */}
            {selectedBasket && (
              <Button
                size="sm"
                className={cn(
                  'w-full h-9 text-xs font-semibold rounded-lg transition-all',
                  added
                    ? 'bg-success text-success-foreground'
                    : stockInBasket
                      ? 'bg-muted text-foreground/80 hover:bg-muted/80'
                      : 'bg-purple hover:bg-purple/90 text-purple-foreground'
                )}
                onClick={handleAddToBasket}
                disabled={adding || draftBaskets.length === 0}
              >
                {adding ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : added ? (
                  <Check className="h-3.5 w-3.5 mr-1.5" />
                ) : (
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                )}
                {added ? 'Added!' : stockInBasket ? 'Update in Basket' : 'Add to Basket'}
              </Button>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
