'use client';

import type { DecisionKind, InstrumentSelection } from '@/components/orders/trade/types';

export type BasketLegDraft = {
  key: string;
  instrument: InstrumentSelection;
  side: 'BUY' | 'SELL';
  product: string;
  orderType: string;
  quantity: string;
  price: string;
  triggerPrice: string;
  validity: string;
};

export type BasketLegPrecheck = {
  key: string;
  symbol: string;
  kind: DecisionKind;
  label: string;
  reasons: string[];
  status: 'pending' | 'checking' | 'done';
};

export type BasketExecResult = {
  index: number;
  symbol: string;
  accepted: boolean;
  orderId: string | null;
  status: string | null;
  error: string | null;
  raw: Record<string, any>;
};

export type BasketExecState =
  | { phase: 'idle' }
  | { phase: 'placing'; at: string }
  | { phase: 'done'; results: BasketExecResult[] }
  | { phase: 'failed'; message: string };