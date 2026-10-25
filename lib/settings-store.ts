'use client';

import { useSyncExternalStore } from 'react';
import { getSettings, updateSetting } from '@/lib/api';

/**
 * Single source of truth for the account mode.
 * - 'demo'    : virtual/paper account (demo engine)
 * - 'api'     : real broker (Kotak Neo / Shoonya) account
 */
export type AccountMode = 'demo' | 'api';

/**
 * Canonical, UI-facing terminal identity.
 * - 'dummy'     : Dummy Trading Engine (server-side /api/demo) — virtual fills,
 *                 no broker involvement.
 * - 'kotak-neo' : Real Kotak Neo broker account (/api/trading).
 * - 'shoonya'   : Real Shoonya broker account (/api/terminal, OAuth).
 */
export type TradingMode = 'dummy' | 'kotak-neo' | 'shoonya';

/** The backend pandas/broker terminal id that maps to a TradingMode. */
export type TerminalId = 'kotak' | 'shoonya' | 'dummy';

/** Persist-format converter: canonical mode -> legacy 'demo' | 'api' value. */
export function toAccountMode(mode: TradingMode): AccountMode {
  return mode === 'kotak-neo' || mode === 'shoonya' ? 'api' : 'demo';
}

/** Persist-format converter: legacy 'demo' | 'api' | 'live' -> canonical mode. */
export function toTradingMode(mode: AccountMode | 'live'): TradingMode {
  return mode === 'api' || mode === 'live' ? 'kotak-neo' : 'dummy';
}

/** Map a UI TradingMode to the backend terminal id (used by /api/terminal/*). */
export function toTerminalId(mode: TradingMode): TerminalId {
  if (mode === 'kotak-neo') return 'kotak';
  if (mode === 'shoonya') return 'shoonya';
  return 'dummy';
}

/** Reverse map: backend terminal id -> UI TradingMode. */
export function fromTerminalId(id: TerminalId | string): TradingMode {
  if (id === 'shoonya') return 'shoonya';
  if (id === 'kotak') return 'kotak-neo';
  return 'dummy';
}

export type OrderDefaults = {
  side: 'BUY' | 'SELL';
  product: string;
  orderType: string;
  quantity: number;
  exchange: string;
  segment: string;
  validity: string;
  disclosedQty: number;
};

export type RiskSettings = {
  maxOrderValue: number;
  maxDailyLoss: number;
  maxDailyProfitTarget: number;
  maxDailyOrders: number;
  maxOpenPositions: number;
  maxQtyPerPosition: number;
  maxExposure: number;
  maxDemoRisk: number;
  maxLiveRisk: number;
};

export type TargetSettings = {
  enabled: boolean;
  mode: 'PERCENT' | 'FIXED' | 'AMOUNT';
  value: number;
};

export type StopLossSettings = {
  enabled: boolean;
  mode: 'PERCENT' | 'FIXED' | 'AMOUNT';
  value: number;
};

export type SquareOffSettings = {
  enabled: boolean;
  time: string;
  timezone: string;
  applyTo: string;
};

export type NotificationEventSettings = {
  orderPlaced: boolean;
  orderCompleted: boolean;
  orderRejected: boolean;
  orderCancelled: boolean;
  targetReached: boolean;
  stopLossTriggered: boolean;
  squareOffExecuted: boolean;
  marginWarning: boolean;
  riskLimitReached: boolean;
  brokerDisconnected: boolean;
  brokerSessionExpired: boolean;
  marketOpen: boolean;
  marketClosed: boolean;
};

export type NotificationChannelSettings = {
  inApp: boolean;
  browser: boolean;
  sound: boolean;
};

export type SoundSettings = {
  enabled: boolean;
  volume: number;
  orderSuccess: boolean;
  orderRejection: boolean;
  target: boolean;
  stopLoss: boolean;
  squareOff: boolean;
};

export type MarketDataSettings = {
  refreshInterval: string;
  showLTP: boolean;
  showBid: boolean;
  showAsk: boolean;
  showVolume: boolean;
  showOHLC: boolean;
  showCircuit: boolean;
  showAvgPrice: boolean;
};

export type DisplaySettings = {
  theme: string;
  density: 'compact' | 'comfortable' | 'spacious';
  numberFormat: 'indian' | 'international';
  decimalPlaces: number;
};

export type BrokerSettings = {
  name: string;
  connected: boolean;
  sessionValid: boolean;
  accountMasked: string;
  availableMargin: number;
  lastSync: string;
};

export type AdvancedSettings = {
  orderApiTimeout: number;
  quoteTimeout: number;
  retryCount: number;
  retryDelay: number;
  orderPollingInterval: number;
  positionRefreshInterval: number;
  historyRefreshInterval: number;
};

export type ConfirmSettings = {
  confirmBuy: boolean;
  confirmSell: boolean;
  confirmSquareOff: boolean;
  confirmLiveOrder: boolean;
};

export type TradingSettings = {
  accountMode: AccountMode;
  orderDefaults: OrderDefaults;
  risk: RiskSettings;
  target: TargetSettings;
  stopLoss: StopLossSettings;
  squareOff: SquareOffSettings;
  notifications: NotificationEventSettings;
  notificationChannels: NotificationChannelSettings;
  sound: SoundSettings;
  marketData: MarketDataSettings;
  display: DisplaySettings;
  broker: BrokerSettings;
  advanced: AdvancedSettings;
  confirm: ConfirmSettings;
};

const DEFAULT_SETTINGS: TradingSettings = {
  accountMode: 'demo',
  orderDefaults: {
    side: 'BUY',
    product: 'MIS',
    orderType: 'MKT',
    quantity: 1,
    exchange: 'nse_cm',
    segment: 'NSE_CM',
    validity: 'DAY',
    disclosedQty: 0,
  },
  risk: {
    maxOrderValue: 500000,
    maxDailyLoss: 50000,
    maxDailyProfitTarget: 100000,
    maxDailyOrders: 50,
    maxOpenPositions: 10,
    maxQtyPerPosition: 500,
    maxExposure: 2000000,
    maxDemoRisk: 100000,
    maxLiveRisk: 500000,
  },
  target: {
    enabled: false,
    mode: 'PERCENT',
    value: 2,
  },
  stopLoss: {
    enabled: false,
    mode: 'PERCENT',
    value: 1,
  },
  squareOff: {
    enabled: false,
    time: '15:15',
    timezone: 'Asia/Kolkata',
    applyTo: 'MIS',
  },
  notifications: {
    orderPlaced: true,
    orderCompleted: true,
    orderRejected: true,
    orderCancelled: true,
    targetReached: true,
    stopLossTriggered: true,
    squareOffExecuted: true,
    marginWarning: true,
    riskLimitReached: true,
    brokerDisconnected: true,
    brokerSessionExpired: true,
    marketOpen: true,
    marketClosed: true,
  },
  notificationChannels: {
    inApp: true,
    browser: false,
    sound: true,
  },
  sound: {
    enabled: true,
    volume: 75,
    orderSuccess: true,
    orderRejection: true,
    target: true,
    stopLoss: true,
    squareOff: true,
  },
  marketData: {
    refreshInterval: '1000',
    showLTP: true,
    showBid: true,
    showAsk: true,
    showVolume: true,
    showOHLC: true,
    showCircuit: true,
    showAvgPrice: true,
  },
  display: {
    theme: 'dark',
    density: 'comfortable',
    numberFormat: 'indian',
    decimalPlaces: 2,
  },
  broker: {
    name: 'KOTAK NEO',
    connected: false,
    sessionValid: false,
    accountMasked: '',
    availableMargin: 0,
    lastSync: '',
  },
  advanced: {
    orderApiTimeout: 30,
    quoteTimeout: 10,
    retryCount: 3,
    retryDelay: 1000,
    orderPollingInterval: 5000,
    positionRefreshInterval: 5000,
    historyRefreshInterval: 10000,
  },
  confirm: {
    confirmBuy: true,
    confirmSell: true,
    confirmSquareOff: true,
    confirmLiveOrder: true,
  },
};

type Listener = () => void;

const LOCAL_STORAGE_KEY = 'kaustubh_settings';
const MODE_KEY = 'kaustubh_terminal_mode';
const PER_MODE_KEY = 'kaustubh_per_mode';

/** Per-mode trading setting groups (the flat keys routed per-terminal). */
export const PER_MODE_GROUPS = ['orderDefaults', 'risk', 'target', 'stopLoss', 'squareOff', 'confirm'] as const;
export type PerModeGroup = (typeof PER_MODE_GROUPS)[number];

export type PerModePreset = Pick<
  TradingSettings,
  'orderDefaults' | 'risk' | 'target' | 'stopLoss' | 'squareOff' | 'confirm'
>;

type PerModePresets = Partial<Record<TradingMode, PerModePreset>>;

function normalizeMode(v: unknown): AccountMode {
  return v === 'api' || v === 'live' ? 'api' : 'demo';
}

class SettingsStore {
  private settings: TradingSettings = { ...DEFAULT_SETTINGS };
  private listeners: Set<Listener> = new Set();
  private loaded = false;
  private loading = false;

  /** Canonical TradingMode — the durable identity persisted to the backend as
   *  `terminal_mode`. This is the source of truth for which mode the session is
   *  in; settings.accountMode is the legacy mirror used by older consumers. */
  private canonicalMode: TradingMode = 'dummy';
  /** Per-mode overrides of the trading-relevant setting groups (shallow clone
   *  of each group keyed by TradingMode). */
  private perMode: PerModePresets = {};

  constructor() {
    this.loadFromLocalStorage();
  }

  getSettings(): TradingSettings {
    return this.settings;
  }

  getMode(): AccountMode {
    return this.settings.accountMode;
  }

  /** Canonical dual-mode identity. */
  getTradingMode(): TradingMode {
    return this.canonicalMode;
  }

  getPerMode(): PerModePresets {
    return this.perMode;
  }

  /** Snapshot the current trading setting groups into perMode[mode] so the
   *  mode's profile is seeded before any per-field edits are applied. */
  private seedPerMode(target: TradingMode) {
    if (this.perMode[target]) return;
    this.perMode[target] = {
      orderDefaults: { ...this.settings.orderDefaults },
      risk: { ...this.settings.risk },
      target: { ...this.settings.target },
      stopLoss: { ...this.settings.stopLoss },
      squareOff: { ...this.settings.squareOff },
      confirm: { ...this.settings.confirm },
    };
  }

  /** Switch terminal mode (canonical). Persists to both canonical and legacy
   *  keys and overlays the per-mode trading setting groups onto `settings`. */
  async setMode(mode: TradingMode): Promise<boolean> {
    if (
      mode === this.canonicalMode
      && this.perMode[mode]
      && this.settings.accountMode === toAccountMode(mode)
    ) {
      return true;
    }
    // Snapshot the *target* mode's overrides (if they exist) so switching back
    // will restore them exactly. The seed comes from the current settings only
    // if no snapshot is stored yet (first visit to the mode).
    this.seedPerMode(mode);

    // Overlay the per-mode group snapshot onto settings so every dependent
    // consumer (order form, risk panel, …) reflects the stored profile.
    const snapshot = this.perMode[mode];
    const next: TradingSettings = { ...this.settings };
    if (snapshot) {
      next.orderDefaults = { ...next.orderDefaults, ...snapshot.orderDefaults };
      next.risk = { ...next.risk, ...snapshot.risk };
      next.target = { ...next.target, ...snapshot.target };
      next.stopLoss = { ...next.stopLoss, ...snapshot.stopLoss };
      next.squareOff = { ...next.squareOff, ...snapshot.squareOff };
      next.confirm = { ...next.confirm, ...snapshot.confirm };
    }
    next.accountMode = toAccountMode(mode);
    this.settings = next;
    this.canonicalMode = mode;
    this.persist();
    this.notify();

    // Best-effort: persist canonical + legacy keys to the backend. Local state is
    // already committed above, so this is genuinely optional — a failed write must
    // NOT roll the switch back, but it also must not escape as an unhandledRejection.
    // `updateSetting` is async, so a synchronous `try/catch` can never observe its
    // failure: every call has to be collected and settled as a batch instead.
    const persist: Promise<unknown>[] = [
      updateSetting('trading_mode', toAccountMode(mode)),
      updateSetting('terminal_mode', toTerminalId(mode)),
    ];
    // Sync per-mode group flat keys so backend denormalised values match the
    // active mode (best effort — backend returns false if it can't write).
    for (const group of PER_MODE_GROUPS) {
      const snap = snapshot?.[group] ?? next[group] as any;
      for (const [key, val] of Object.entries(snap)) {
        const backendKey = this.backendKeyMap[`${group}.${key}`];
        if (backendKey) persist.push(updateSetting(backendKey, val));
      }
    }
    // allSettled attaches a handler to every member, so one unreachable backend
    // can no longer flood the console with ~30 orphaned rejections per switch.
    void Promise.allSettled(persist);
    return true;
  }

  getOrderDefaults(): OrderDefaults {
    return this.settings.orderDefaults;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }

  private loadFromLocalStorage(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      const cached = raw ? JSON.parse(raw) : null;

      // Canonical TradingMode — first source of truth.
      const savedMode = localStorage.getItem(MODE_KEY) as TradingMode | null;
      if (savedMode === 'kotak-neo' || savedMode === 'shoonya' || savedMode === 'dummy') {
        this.canonicalMode = savedMode;
      } else if (cached?.accountMode === 'api' || cached?.accountMode === 'live') {
        // Legacy accountMode hint: map to the Kotak canonical id (consistent
        // with the existing switcher defaulting API users to kotak-neo).
        this.canonicalMode = 'kotak-neo';
      } else {
        this.canonicalMode = 'dummy';
      }

      // Per-mode overrides.
      try {
        const pmRaw = localStorage.getItem(PER_MODE_KEY);
        if (pmRaw) this.perMode = JSON.parse(pmRaw) as PerModePresets;
      } catch { /* ignore */ }

      const d = DEFAULT_SETTINGS;
      this.settings = {
        // The canonical TradingMode (MODE_KEY above) is the source of truth.
        // The legacy `accountMode` mirror must never contradict it: a stale
        // mirror here is what routed Dummy funds/orders through the Kotak
        // adapter ("Dummy me AVAIL C0").
        accountMode: toAccountMode(this.canonicalMode),
        orderDefaults: { ...d.orderDefaults, ...(cached?.orderDefaults ?? {}) },
        risk: { ...d.risk, ...(cached?.risk ?? {}) },
        target: { ...d.target, ...(cached?.target ?? {}) },
        stopLoss: { ...d.stopLoss, ...(cached?.stopLoss ?? {}) },
        squareOff: { ...d.squareOff, ...(cached?.squareOff ?? {}) },
        notifications: { ...d.notifications, ...(cached?.notifications ?? {}) },
        notificationChannels: { ...d.notificationChannels, ...(cached?.notificationChannels ?? {}) },
        sound: { ...d.sound, ...(cached?.sound ?? {}) },
        marketData: { ...d.marketData, ...(cached?.marketData ?? {}) },
        display: { ...d.display, ...(cached?.display ?? {}) },
        broker: { ...d.broker, ...(cached?.broker ?? {}) },
        advanced: { ...d.advanced, ...(cached?.advanced ?? {}) },
        confirm: { ...d.confirm, ...(cached?.confirm ?? {}) },
      };
    } catch { /* corrupted cache -> keep defaults */ }
  }

  private persist(): void {
    if (typeof window === 'undefined') return;
    try { localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
    try { localStorage.setItem(MODE_KEY, this.canonicalMode); } catch { /* ignore */ }
    try { localStorage.setItem(PER_MODE_KEY, JSON.stringify(this.perMode)); } catch { /* ignore */ }
  }

  async loadFromBackend(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const data = await getSettings();
      const s = data?.settings || {};

      // Canonical TradingMode: adopt backend `terminal_mode` ONLY when it was
      // persisted (has an updatedAt timestamp) — never for legacy installs
      // that never wrote the key, so existing demo users aren't flipped to
      // kotak on first load.
      const terminalMode = s.terminal_mode?.value;
      const hadTerminalMode = Boolean(s.terminal_mode?.updatedAt) && typeof terminalMode === 'string';
      if (hadTerminalMode && (terminalMode === 'kotak' || terminalMode === 'shoonya' || terminalMode === 'dummy')) {
        this.canonicalMode = fromTerminalId(terminalMode);
      }

      // Per-mode profiles persisted as one JSON blob (terminal_mode_presets).
      try {
        const presets = typeof s.terminal_mode_presets?.value === 'string'
          ? JSON.parse(s.terminal_mode_presets.value)
          : (s.terminal_mode_presets?.value || {});
        if (presets && typeof presets === 'object') this.perMode = presets as PerModePresets;
      } catch { /* corrupted presets -> keep local */ }

      this.settings = {
        // Legacy mirror only — the canonical TradingMode decided above always
        // wins, or TradingService would route the wrong backend ("Dummy me
        // AVAIL C0" came from a stale backend `trading_mode = api`).
        accountMode: toAccountMode(this.canonicalMode),
        orderDefaults: {
          side: s.order_default_side?.value ?? this.settings.orderDefaults.side,
          product: s.default_product?.value ?? this.settings.orderDefaults.product,
          orderType: s.default_order_type?.value ?? this.settings.orderDefaults.orderType,
          quantity: s.default_quantity?.value ?? this.settings.orderDefaults.quantity,
          exchange: s.default_exchange?.value ?? this.settings.orderDefaults.exchange,
          segment: s.default_segment?.value ?? this.settings.orderDefaults.segment,
          validity: s.default_validity?.value ?? this.settings.orderDefaults.validity,
          disclosedQty: s.default_disclosed_qty?.value ?? this.settings.orderDefaults.disclosedQty,
        },
        risk: {
          maxOrderValue: s.risk_max_order_value?.value ?? this.settings.risk.maxOrderValue,
          maxDailyLoss: s.risk_max_daily_loss?.value ?? this.settings.risk.maxDailyLoss,
          maxDailyProfitTarget: s.risk_max_daily_profit?.value ?? this.settings.risk.maxDailyProfitTarget,
          maxDailyOrders: s.risk_max_daily_orders?.value ?? this.settings.risk.maxDailyOrders,
          maxOpenPositions: s.risk_max_open_positions?.value ?? this.settings.risk.maxOpenPositions,
          maxQtyPerPosition: s.risk_max_qty_per_position?.value ?? this.settings.risk.maxQtyPerPosition,
          maxExposure: s.risk_max_exposure?.value ?? this.settings.risk.maxExposure,
          maxDemoRisk: s.risk_max_demo?.value ?? this.settings.risk.maxDemoRisk,
          maxLiveRisk: s.risk_max_live?.value ?? this.settings.risk.maxLiveRisk,
        },
        target: {
          enabled: s.target_enabled?.value ?? this.settings.target.enabled,
          mode: s.target_mode?.value ?? this.settings.target.mode,
          value: s.target_value?.value ?? this.settings.target.value,
        },
        stopLoss: {
          enabled: s.sl_enabled?.value ?? this.settings.stopLoss.enabled,
          mode: s.sl_mode?.value ?? this.settings.stopLoss.mode,
          value: s.sl_value?.value ?? this.settings.stopLoss.value,
        },
        squareOff: {
          enabled: s.square_off_enabled?.value ?? this.settings.squareOff.enabled,
          time: s.square_off_time?.value ?? this.settings.squareOff.time,
          timezone: s.square_off_timezone?.value ?? this.settings.squareOff.timezone,
          applyTo: s.square_off_apply_to?.value ?? this.settings.squareOff.applyTo,
        },
        notifications: {
          orderPlaced: s.notif_order_placed?.value ?? this.settings.notifications.orderPlaced,
          orderCompleted: s.notif_order_completed?.value ?? this.settings.notifications.orderCompleted,
          orderRejected: s.notif_order_rejected?.value ?? this.settings.notifications.orderRejected,
          orderCancelled: s.notif_order_cancelled?.value ?? this.settings.notifications.orderCancelled,
          targetReached: s.notif_target_reached?.value ?? this.settings.notifications.targetReached,
          stopLossTriggered: s.notif_sl_triggered?.value ?? this.settings.notifications.stopLossTriggered,
          squareOffExecuted: s.notif_squareoff_executed?.value ?? this.settings.notifications.squareOffExecuted,
          marginWarning: s.notif_margin_warning?.value ?? this.settings.notifications.marginWarning,
          riskLimitReached: s.notif_risk_limit?.value ?? this.settings.notifications.riskLimitReached,
          brokerDisconnected: s.notif_broker_disconnected?.value ?? this.settings.notifications.brokerDisconnected,
          brokerSessionExpired: s.notif_broker_expired?.value ?? this.settings.notifications.brokerSessionExpired,
          marketOpen: s.notif_market_open?.value ?? this.settings.notifications.marketOpen,
          marketClosed: s.notif_market_closed?.value ?? this.settings.notifications.marketClosed,
        },
        notificationChannels: {
          inApp: s.notif_channel_inapp?.value ?? this.settings.notificationChannels.inApp,
          browser: s.notif_channel_browser?.value ?? this.settings.notificationChannels.browser,
          sound: s.notif_channel_sound?.value ?? this.settings.notificationChannels.sound,
        },
        sound: {
          enabled: s.sound_enabled?.value ?? this.settings.sound.enabled,
          volume: s.sound_volume?.value ?? this.settings.sound.volume,
          orderSuccess: s.sound_order_success?.value ?? this.settings.sound.orderSuccess,
          orderRejection: s.sound_order_rejection?.value ?? this.settings.sound.orderRejection,
          target: s.sound_target?.value ?? this.settings.sound.target,
          stopLoss: s.sound_sl?.value ?? this.settings.sound.stopLoss,
          squareOff: s.sound_squareoff?.value ?? this.settings.sound.squareOff,
        },
        marketData: {
          refreshInterval: s.market_refresh_interval?.value ?? this.settings.marketData.refreshInterval,
          showLTP: s.market_show_ltp?.value ?? this.settings.marketData.showLTP,
          showBid: s.market_show_bid?.value ?? this.settings.marketData.showBid,
          showAsk: s.market_show_ask?.value ?? this.settings.marketData.showAsk,
          showVolume: s.market_show_volume?.value ?? this.settings.marketData.showVolume,
          showOHLC: s.market_show_ohlc?.value ?? this.settings.marketData.showOHLC,
          showCircuit: s.market_show_circuit?.value ?? this.settings.marketData.showCircuit,
          showAvgPrice: s.market_show_avg_price?.value ?? this.settings.marketData.showAvgPrice,
        },
        display: {
          theme: s.display_theme?.value ?? this.settings.display.theme,
          density: s.display_density?.value ?? this.settings.display.density,
          numberFormat: s.display_number_format?.value ?? this.settings.display.numberFormat,
          decimalPlaces: s.display_decimal_places?.value ?? this.settings.display.decimalPlaces,
        },
        broker: {
          name: 'KOTAK NEO',
          connected: s.broker_connected?.value ?? this.settings.broker.connected,
          sessionValid: s.broker_session_valid?.value ?? this.settings.broker.sessionValid,
          accountMasked: s.broker_account_masked?.value ?? this.settings.broker.accountMasked,
          availableMargin: s.broker_available_margin?.value ?? this.settings.broker.availableMargin,
          lastSync: s.broker_last_sync?.value ?? this.settings.broker.lastSync,
        },
        advanced: {
          orderApiTimeout: s.adv_order_timeout?.value ?? this.settings.advanced.orderApiTimeout,
          quoteTimeout: s.adv_quote_timeout?.value ?? this.settings.advanced.quoteTimeout,
          retryCount: s.adv_retry_count?.value ?? this.settings.advanced.retryCount,
          retryDelay: s.adv_retry_delay?.value ?? this.settings.advanced.retryDelay,
          orderPollingInterval: s.adv_order_polling?.value ?? this.settings.advanced.orderPollingInterval,
          positionRefreshInterval: s.adv_position_refresh?.value ?? this.settings.advanced.positionRefreshInterval,
          historyRefreshInterval: s.adv_history_refresh?.value ?? this.settings.advanced.historyRefreshInterval,
        },
        confirm: {
          confirmBuy: s.confirm_buy?.value ?? this.settings.confirm.confirmBuy,
          confirmSell: s.confirm_sell?.value ?? this.settings.confirm.confirmSell,
          confirmSquareOff: s.confirm_squareoff?.value ?? this.settings.confirm.confirmSquareOff,
          confirmLiveOrder: true,
        },
      };
      this.loaded = true;
      this.persist();
      this.notify();
    } catch {
      this.loaded = true;
    } finally {
      this.loading = false;
    }
  }

  private backendKeyMap: Record<string, string> = {
    accountMode: 'trading_mode',
    'orderDefaults.side': 'order_default_side',
    'orderDefaults.product': 'default_product',
    'orderDefaults.orderType': 'default_order_type',
    'orderDefaults.quantity': 'default_quantity',
    'orderDefaults.exchange': 'default_exchange',
    'orderDefaults.segment': 'default_segment',
    'orderDefaults.validity': 'default_validity',
    'orderDefaults.disclosedQty': 'default_disclosed_qty',
    'risk.maxOrderValue': 'risk_max_order_value',
    'risk.maxDailyLoss': 'risk_max_daily_loss',
    'risk.maxDailyProfitTarget': 'risk_max_daily_profit',
    'risk.maxDailyOrders': 'risk_max_daily_orders',
    'risk.maxOpenPositions': 'risk_max_open_positions',
    'risk.maxQtyPerPosition': 'risk_max_qty_per_position',
    'risk.maxExposure': 'risk_max_exposure',
    'risk.maxDemoRisk': 'risk_max_demo',
    'risk.maxLiveRisk': 'risk_max_live',
    'target.enabled': 'target_enabled',
    'target.mode': 'target_mode',
    'target.value': 'target_value',
    'stopLoss.enabled': 'sl_enabled',
    'stopLoss.mode': 'sl_mode',
    'stopLoss.value': 'sl_value',
    'squareOff.enabled': 'square_off_enabled',
    'squareOff.time': 'square_off_time',
    'squareOff.timezone': 'square_off_timezone',
    'squareOff.applyTo': 'square_off_apply_to',
    'notifications.orderPlaced': 'notif_order_placed',
    'notifications.orderCompleted': 'notif_order_completed',
    'notifications.orderRejected': 'notif_order_rejected',
    'notifications.orderCancelled': 'notif_order_cancelled',
    'notifications.targetReached': 'notif_target_reached',
    'notifications.stopLossTriggered': 'notif_sl_triggered',
    'notifications.squareOffExecuted': 'notif_squareoff_executed',
    'notifications.marginWarning': 'notif_margin_warning',
    'notifications.riskLimitReached': 'notif_risk_limit',
    'notifications.brokerDisconnected': 'notif_broker_disconnected',
    'notifications.brokerSessionExpired': 'notif_broker_expired',
    'notifications.marketOpen': 'notif_market_open',
    'notifications.marketClosed': 'notif_market_closed',
    'notificationChannels.inApp': 'notif_channel_inapp',
    'notificationChannels.browser': 'notif_channel_browser',
    'notificationChannels.sound': 'notif_channel_sound',
    'sound.enabled': 'sound_enabled',
    'sound.volume': 'sound_volume',
    'sound.orderSuccess': 'sound_order_success',
    'sound.orderRejection': 'sound_order_rejection',
    'sound.target': 'sound_target',
    'sound.stopLoss': 'sound_sl',
    'sound.squareOff': 'sound_squareoff',
    'marketData.refreshInterval': 'market_refresh_interval',
    'marketData.showLTP': 'market_show_ltp',
    'marketData.showBid': 'market_show_bid',
    'marketData.showAsk': 'market_show_ask',
    'marketData.showVolume': 'market_show_volume',
    'marketData.showOHLC': 'market_show_ohlc',
    'marketData.showCircuit': 'market_show_circuit',
    'marketData.showAvgPrice': 'market_show_avg_price',
    'display.theme': 'display_theme',
    'display.density': 'display_density',
    'display.numberFormat': 'display_number_format',
    'display.decimalPlaces': 'display_decimal_places',
    'broker.connected': 'broker_connected',
    'broker.sessionValid': 'broker_session_valid',
    'broker.accountMasked': 'broker_account_masked',
    'broker.availableMargin': 'broker_available_margin',
    'broker.lastSync': 'broker_last_sync',
    'advanced.orderApiTimeout': 'adv_order_timeout',
    'advanced.quoteTimeout': 'adv_quote_timeout',
    'advanced.retryCount': 'adv_retry_count',
    'advanced.retryDelay': 'adv_retry_delay',
    'advanced.orderPollingInterval': 'adv_order_polling',
    'advanced.positionRefreshInterval': 'adv_position_refresh',
    'advanced.historyRefreshInterval': 'adv_history_refresh',
    'confirm.confirmBuy': 'confirm_buy',
    'confirm.confirmSell': 'confirm_sell',
    'confirm.confirmSquareOff': 'confirm_squareoff',
  };

  private setNestedValue(obj: any, path: string, value: any): void {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((acc, part) => acc?.[part], obj);
  }

  async updateSetting(path: string, value: any): Promise<boolean> {
    const backendKey = this.backendKeyMap[path];
    if (!backendKey) {
      this.applyUpdate(path, value);
      this.notify();
      return true;
    }

    const backendValue = path === 'accountMode'
      ? (value === 'api' || value === 'live' ? 'api' : 'demo')
      : value;

    // A per-mode group edit also updates the CURRENT mode's snapshot and the
    // JSON blobs so switching away and back restores the per-mode profile.
    const group = path.split('.')[0];
    const isPerMode = (PER_MODE_GROUPS as readonly string[]).includes(group);

    // Mirror the change into perMode[activeMode] (mutable copy, then save).
    if (isPerMode) {
      const mode = this.canonicalMode;
      this.seedPerMode(mode);
      const preset = this.perMode[mode];
      if (preset) {
        const leaf = path.slice(group.length + 1);
        (preset as any)[group as PerModeGroup] = { ...(preset as any)[group], [leaf]: value };
      }
    }

    try {
      await updateSetting(backendKey, backendValue);
      this.applyUpdate(path, value);
      if (isPerMode) this.persistPerModePresets();
      this.persist();
      this.notify();
      return true;
    } catch {
      // Backend unavailable -> keep the change locally so the preference
      // still survives reloads (localStorage cache), and report partial success.
      this.applyUpdate(path, value);
      if (isPerMode) this.persistPerModePresets();
      this.persist();
      this.notify();
      return false;
    }
  }

  /** Best-effort persist the per-mode JSON blob to the backend setting key. */
  private persistPerModePresets(): void {
    try { void updateSetting('terminal_mode_presets', this.perMode); } catch { /* best-effort */ }
  }

  /** Replace the settings object with a shallow clone carrying the new value,
   * so external-store snapshots get a fresh identity on every update. */
  private applyUpdate(path: string, value: any): void {
    const next: TradingSettings = { ...this.settings };
    this.setNestedValue(next, path, value);
    this.settings = next;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  reset(): void {
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.perMode = {};
    this.persist();
    this.notify();
  }
}

let _store: SettingsStore | null = null;

export function getSettingsStore(): SettingsStore {
  if (!_store) {
    _store = new SettingsStore();
  }
  return _store;
}

function subscribeStore(listener: Listener): () => void {
  return getSettingsStore().subscribe(listener);
}

export function useTradingSettings(): TradingSettings {
  return useSyncExternalStore(
    subscribeStore,
    () => getSettingsStore().getSettings(),
    () => DEFAULT_SETTINGS,
  );
}

/** Reactive account mode. Server snapshot is the default ('demo') so
 * prerendered HTML and hydrated markup always agree. */
export function useAccountMode(): AccountMode {
  return useSyncExternalStore(
    subscribeStore,
    () => getSettingsStore().getMode(),
    (): AccountMode => 'demo',
  );
}

/** Reactive canonical trading mode (KOTAK NEO | DUMMY MODE). */
export function useTradingMode(): TradingMode {
  return useSyncExternalStore(
    subscribeStore,
    () => getSettingsStore().getTradingMode(),
    (): TradingMode => 'dummy',
  );
}

export function formatCurrency(amount: number, mode: TradingMode): string {
  if (mode === 'dummy') {
    return `${amount.toLocaleString('en-IN')} Coins`;
  }
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatCompact(amount: number): string {
  if (amount >= 1e7) return (amount / 1e7).toFixed(1) + 'Cr';
  if (amount >= 1e5) return (amount / 1e5).toFixed(1) + 'L';
  if (amount >= 1e3) return (amount / 1e3).toFixed(1) + 'K';
  return amount.toLocaleString('en-IN');
}
