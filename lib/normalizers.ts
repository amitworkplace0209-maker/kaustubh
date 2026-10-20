// ---- Funds / RMS limit normalizer ----
//
// Live Kotak Neo `limits` response (verified against GET /api/trading/funds):
// {
//   "Category": "CLIENT", "EntityId": "account-XBH6H",
//   "Net": "69.55",            <- net available margin (cash + collateral - used)
//   "MarginUsed": "0",         <- margin currently utilized
//   "NotionalCash": "0",       <- actual cash component
//   "CollateralValue": "69.55",<- collateral value backing the margin
//   "Collateral": "0", "RmsCollateral": "0",
//   ... , "stCode": 200, "stat": "Ok"
// }
// An older shape ({ data: { limitObject: { RMS: {...} } } }) is still honoured
// defensively. Every metric is number | null — null means the broker did not
// provide the field; a genuine zero stays 0.

export type NormalizedFunds = {
  availableMargin: number | null;
  usedMargin: number | null;
  blockedMargin: number | null;
  cash: number | null;
};

function fundsPick(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function normalizeFunds(raw: any): NormalizedFunds {
  const flat = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rms =
    flat?.data?.limitObject?.RMS ??
    flat?.limitObject?.RMS ??
    null;

  return {
    // Available to trade right now.
    availableMargin: fundsPick(rms?.available_margin, flat.Net),
    // Currently utilized margin.
    usedMargin: fundsPick(rms?.utilised_debit ?? rms?.used_margin, flat.MarginUsed, flat.AmountUtilizedPrsnt),
    // Collateral/blocked component backing the account margin.
    blockedMargin: fundsPick(
      rms?.collateral_margin,
      flat.CollateralValue, flat.Collateral, flat.RmsCollateral
    ),
    // Actual cash component (never derived from exposure/holdings/market value).
    cash: fundsPick(rms?.cash_margin_available, flat.NotionalCash),
  };
}

export type NormalizedOrderStatus = 'pending' | 'open' | 'executed' | 'partial' | 'cancelled' | 'rejected' | 'expired' | 'unknown';

export function normalizeOrderStatus(raw: string | undefined | null): NormalizedOrderStatus {
  const s = String(raw ?? '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (s === 'complete' || s === 'filled' || s === 'executed') return 'executed';
  if (s === 'partial' || s === 'partially filled') return 'partial';
  if (s === 'cancelled' || s === 'canceled' || s === 'cancelled pending' || s === 'canceled pending') return 'cancelled';
  if (s === 'rejected') return 'rejected';
  if (s === 'pending' || s === 'trigger pending' || s === 'trigger ordered' || s === 'open pending' || s === 'queued') return 'pending';
  if (s === 'open' || s === 'untriggered') return 'open';
  if (s === 'expired') return 'expired';
  return 'unknown';
}

export function orderStatusLabel(status: NormalizedOrderStatus): string {
  switch (status) {
    case 'pending': return 'Pending';
    case 'open': return 'Open';
    case 'executed': return 'Executed';
    case 'partial': return 'Partial';
    case 'cancelled': return 'Cancelled';
    case 'rejected': return 'Rejected';
    case 'expired': return 'Expired';
    default: return 'Unknown';
  }
}

export function orderStatusBadgeClasses(status: NormalizedOrderStatus): string {
  switch (status) {
    case 'executed': return 'bg-success/15 text-success border-success/30';
    case 'partial': return 'bg-info/15 text-info border-info/30';
    case 'pending': return 'bg-warning/15 text-warning border-warning/30';
    case 'open': return 'bg-teal-500/15 text-teal-500 border-teal-500/30';
    case 'cancelled': return 'bg-muted text-muted-foreground border-border';
    case 'rejected': return 'bg-destructive/15 text-destructive border-destructive/30';
    default: return 'bg-muted text-muted-foreground';
  }
}

export type NormalizedPosition = {
  id: string;
  symbol: string;
  companyName: string;
  tradingSymbol: string;
  exchange: string;
  product: string;
  instrumentToken: string;
  side: 'LONG' | 'SHORT' | 'FLAT';
  status: 'OPEN' | 'CLOSED' | 'FLAT';
  netQuantity: number;
  buyQuantity: number;
  sellQuantity: number;
  averageBuyPrice: number;
  averageSellPrice: number;
  netAveragePrice: number;
  ltp: number;
  realizedPnl: number;
  unrealizedPnl: number;
  grossPnl: number;
  netPnl: number;
  buyValue: number;
  sellValue: number;
  charges: number;
  raw: Record<string, unknown>;
};

function num(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function str(v: unknown): string {
  if (v == null) return '';
  return String(v);
}

export function normalizePosition(raw: any): NormalizedPosition {
  const r = raw || {};

  const symbol = str(r.sym || r.symbol || r.symbol_name).split('-')[0];
  const tradingSymbol = str(r.trdSym || r.trdSym_clean || r.trading_symbol || r.tradingsymbol);
  const companyName = str(r.company_name || r.companyName || r.pDesc);
  const exchange = str(r.exSeg || r.exSeg_clean || r.exchange || r.exchange_segment);
  const product = str(r.prod || r.prod_clean || r.product || r.product_type);
  const instrumentToken = str(r.tok || r.instrument_token || r.instrumentToken || r.token);

  const buyQty = num(r.buy_quantity ?? r.buy_qty ?? r.cfBuyQty ?? r.flBuyQty);
  const sellQty = num(r.sell_quantity ?? r.sell_qty ?? r.cfSellQty ?? r.flSellQty);

  const sdkNetQty = num(r.qty ?? r.net_qty ?? r.net_quantity);
  const rawNetQty = sdkNetQty !== 0 ? sdkNetQty : (buyQty - sellQty);
  const absNetQty = Math.abs(rawNetQty);

  const avgBuy = num(r.buy_avg ?? r.buy_average ?? r.avg_price ?? r.average_price);
  const avgSell = num(r.sell_avg ?? r.sell_average);
  const netAvg = num(r.net_average_price ?? r.avg_price ?? r.average_price);
  const buyValue = num(r.buy_value) || (buyQty * avgBuy);
  const sellValue = num(r.sell_value) || (sellQty * avgSell);

  const ltpRaw = num(r.ltp ?? r.last_price);
  const ltp = ltpRaw > 0 ? ltpRaw : 0;
  const lastKnownLtp = r.last_known_ltp != null && num(r.last_known_ltp) > 0 ? num(r.last_known_ltp) : null;

  let side: 'LONG' | 'SHORT' | 'FLAT' = 'FLAT';
  if (rawNetQty > 0) side = 'LONG';
  else if (rawNetQty < 0) side = 'SHORT';
  else {
    const pt = str(r.position_type || r.trnsTp || r.side).toUpperCase();
    if (pt === 'LONG' || pt === 'BUY' || pt === 'B') side = 'LONG';
    else if (pt === 'SHORT' || pt === 'SELL' || pt === 'S') side = 'SHORT';
  }

  const isSquaredOff = str(r.sqrFlg || r.is_squared_off).toUpperCase() === 'Y';
  const isClosed = isSquaredOff || (rawNetQty === 0 && buyQty > 0 && sellQty > 0);
  let status: 'OPEN' | 'CLOSED' | 'FLAT' = 'FLAT';
  if (side !== 'FLAT' && !isClosed) status = 'OPEN';
  else if (isClosed || (rawNetQty === 0 && (buyQty > 0 || sellQty > 0))) status = 'CLOSED';

  let brokerRealized = num(r.realised ?? r.realized ?? r.realized_pnl);
  if (brokerRealized === 0 && rawNetQty === 0 && buyValue > 0 && sellValue > 0) {
    brokerRealized = sellValue - buyValue;
  }
  const brokerUnrealized = num(r.unrealised ?? r.unrealized ?? r.unrealized_pnl);
  const brokerGrossPnl = num(r.gross_pnl);
  const brokerNetPnl = num(r.net_pnl);
  const brokerCharges = num(r.estimated_charges ?? r.charges);

  const effectiveLtp = ltp > 0 ? ltp : (lastKnownLtp != null ? lastKnownLtp : 0);
  const hasLtp = effectiveLtp > 0;

  let realizedPnl = brokerRealized;
  let unrealizedPnl = brokerUnrealized;

  if (status === 'OPEN' && hasLtp && absNetQty > 0) {
    const pp = effectiveLtp - netAvg;
    unrealizedPnl = side === 'LONG' ? pp * absNetQty : -pp * absNetQty;
  }

  const grossPnl = brokerGrossPnl !== 0 ? brokerGrossPnl : realizedPnl + unrealizedPnl;
  const netPnl = brokerNetPnl !== 0 ? brokerNetPnl : grossPnl - brokerCharges;

  return {
    id: instrumentToken || tradingSymbol || symbol,
    symbol, companyName, tradingSymbol: tradingSymbol || symbol,
    exchange, product, instrumentToken,
    side, status, netQuantity: absNetQty,
    buyQuantity: buyQty, sellQuantity: sellQty,
    averageBuyPrice: avgBuy, averageSellPrice: avgSell, netAveragePrice: netAvg,
    ltp: effectiveLtp,
    realizedPnl, unrealizedPnl, grossPnl, netPnl,
    buyValue, sellValue,
    charges: brokerCharges,
    raw: r,
  };
}
