import type { SettingsFieldDef, SettingsSectionDef } from './types';

/**
 * Data Saver Settings schema — a single declarative map of every section/group/
 * field in the Settings Control Center. Each field references a `sourceKey`
 * that MUST exist in the backend DEFAULTS store (python-service
 * `services/settings_service.py`) so persistence, validation and reset all go
 * through the one existing backend contract.
 *
 * `apply` reflects how the backend honours the key:
 *   - `live`    → consumed by the runtime bridge within ~5s (scheduler / WS / tick)
 *   - `restart` → applied to read-once config at backend startup
 *   - `saved`   → persisted server-side; no instant runtime effect (honest label)
 *
 * Fields marked `readOnly` are live status from the backend, never controls.
 */

export const SECTIONS: SettingsSectionDef[] = [
  {
    id: 'general',
    label: 'General',
    shortLabel: 'General',
    icon: 'LayoutGrid',
    description: 'Language, timezone, formatting and landing behaviour.',
    keywords: ['language', 'timezone', 'date', 'time', 'landing', 'refresh', 'animation', 'format', 'profile'],
    nav: true,
    groups: [
      {
        id: 'preferences',
        label: 'Preferences',
        fields: [
          {
            key: 'general_language',
            label: 'Language',
            description: 'Display language for the interface.',
            type: 'select',
            sourceKey: 'general_language',
            options: [{ value: 'en', label: 'English' }],
          },
          {
            key: 'general_timezone',
            label: 'Time zone',
            description: 'Used for all market and history timestamps.',
            type: 'select',
            sourceKey: 'general_timezone',
            options: [{ value: 'Asia/Kolkata', label: 'India (IST, UTC+05:30)' }, { value: 'UTC', label: 'UTC' }],
          },
          {
            key: 'general_date_format',
            label: 'Date format',
            type: 'select',
            sourceKey: 'general_date_format',
            options: [
              { value: 'YYYY-MM-DD', label: '2026-09-05' },
              { value: 'DD-MM-YYYY', label: '05-09-2026' },
              { value: 'DD/MM/YYYY', label: '05/09/2026' },
            ],
          },
          {
            key: 'general_time_format',
            label: 'Time format',
            type: 'select',
            sourceKey: 'general_time_format',
            options: [
              { value: '24h', label: '24-hour' },
              { value: '12h', label: '12-hour' },
            ],
          },
        ],
      },
      {
        id: 'behaviour',
        label: 'Behaviour',
        fields: [
          {
            key: 'general_landing_page',
            label: 'Default landing page',
            description: 'Shown after login.',
            type: 'select',
            sourceKey: 'general_landing_page',
            options: [
              { value: '/data-saver/dashboard', label: 'Data Saver dashboard' },
              { value: '/data-saver/trading', label: 'Live trading' },
              // The canonical Market Watch route inside the Data Saver shell.
              // (Was '/data-saver/market-watch', which does not exist.)
              { value: '/data-saver/watch', label: 'Market watch' },
              { value: '/data-saver/downloads', label: 'Downloads' },
            ],
          },
          {
            key: 'general_auto_refresh',
            label: 'Auto-refresh data views',
            description: 'Background polling on list views.',
            type: 'boolean',
            sourceKey: 'general_auto_refresh',
            apply: 'saved',
          },
          {
            key: 'general_animation',
            label: 'UI animations',
            description: 'Transitions across page changes and updates.',
            type: 'boolean',
            sourceKey: 'general_animation',
            apply: 'saved',
          },
        ],
      },
    ],
  },

  {
    id: 'appearance',
    label: 'Appearance',
    shortLabel: 'Appearance',
    icon: 'Palette',
    description: 'Theme, density, accent and layout behaviour. Full theme studio lives on the Theme page.',
    keywords: ['theme', 'dark', 'light', 'amoled', 'accent', 'density', 'sidebar', 'topbar', 'colour'],
    nav: true,
    groups: [
      {
        id: 'theme',
        label: 'Theme & accent',
        description: 'The role-based theme engine with 30+ presets is on the dedicated Theme page.',
        fields: [
          {
            key: 'appearance_theme',
            label: 'Theme mode',
            description: 'Active brightness mode.',
            type: 'select',
            sourceKey: 'appearance_theme',
            options: [
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'amoled', label: 'Amoled' },
              { value: 'system', label: 'Follow system' },
            ],
            apply: 'saved',
          },
          {
            key: 'appearance_accent',
            label: 'Accent colour',
            description: 'Primary highlight used across the UI.',
            type: 'color',
            sourceKey: 'appearance_accent',
            apply: 'saved',
          },
        ],
      },
      {
        id: 'layouts',
        label: 'Layout',
        fields: [
          {
            key: 'appearance_density',
            label: 'UI density',
            type: 'select',
            sourceKey: 'appearance_density',
            options: [
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ],
          },
          {
            key: 'appearance_sidebar_behavior',
            label: 'Sidebar behaviour',
            type: 'select',
            sourceKey: 'appearance_sidebar_behavior',
            options: [
              { value: 'default', label: 'Default' },
              { value: 'collapsible', label: 'Collapsible' },
              { value: 'overlay', label: 'Overlay' },
            ],
          },
          {
            key: 'appearance_topbar_behavior',
            label: 'Top bar behaviour',
            type: 'select',
            sourceKey: 'appearance_topbar_behavior',
            options: [
              { value: 'default', label: 'Default' },
              { value: 'sticky', label: 'Sticky' },
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'theme',
    label: 'Theme studio',
    shortLabel: 'Theme',
    icon: 'Sparkles',
    description: 'Pick a preset or build a custom role-based theme — every colour token updates live.',
    keywords: ['theme', 'preset', 'colour', 'accent', 'mode', 'brightness'],
    nav: true,
    groups: [],
  },

  {
    id: 'data-saver',
    label: 'Data Saver',
    shortLabel: 'Data Saver',
    icon: 'Save',
    description: 'Live data collection, the tick pipeline and the Market Watch scanner.',
    keywords: ['tick', 'collection', 'pipeline', 'batch', 'flush', 'scanner', 'retention', 'cache', 'auto'],
    nav: true,
    groups: [
      {
        id: 'collection',
        label: 'Collection',
        fields: [
          {
            key: 'ds_collection_enabled',
            label: 'Data collection',
            description: 'Enables the live tick pipeline (MongoDB writes start/stay stopped immediately).',
            type: 'boolean',
            sourceKey: 'ds_collection_enabled',
            apply: 'live',
          },
          {
            key: 'ds_market_watch_scanner',
            label: 'Market Watch scanner',
            description: 'Automatically scan the watchlist on the configured interval.',
            type: 'boolean',
            sourceKey: 'ds_market_watch_scanner',
            apply: 'saved',
          },
          {
            key: 'ds_scanner_interval_sec',
            label: 'Scanner interval',
            type: 'number',
            sourceKey: 'ds_scanner_interval_sec',
            min: 10,
            max: 300,
            step: 5,
            unit: 's',
            apply: 'saved',
          },
          {
            key: 'ds_intraday_only',
            label: 'Intraday data only',
            description: 'Only collect intraday ticks (no end-of-day shaping).',
            type: 'boolean',
            sourceKey: 'ds_intraday_only',
            apply: 'saved',
          },
        ],
      },
      {
        id: 'pipeline',
        label: 'Tick pipeline',
        description: 'These knobs are consumed live by the backend flush loop.',
        fields: [
          {
            key: 'ds_batch_size',
            label: 'Ticks per write batch',
            description: 'Maximum ticks written in a single bulk insert.',
            type: 'number',
            sourceKey: 'ds_batch_size',
            min: 50,
            max: 5000,
            step: 50,
            apply: 'live',
          },
          {
            key: 'flush_interval_ms',
            label: 'Flush interval',
            type: 'number',
            sourceKey: 'flush_interval_ms',
            min: 250,
            max: 30000,
            step: 250,
            unit: 'ms',
            apply: 'live',
          },
          {
            key: 'buffer_size',
            label: 'Buffer capacity',
            description: 'Soft trigger: flush when buffered ticks reach this many.',
            type: 'number',
            sourceKey: 'buffer_size',
            min: 500,
            max: 100000,
            step: 500,
            apply: 'live',
          },
          {
            key: 'retry_count',
            label: 'Write retries',
            type: 'number',
            sourceKey: 'retry_count',
            min: 0,
            max: 10,
            apply: 'live',
          },
          {
            key: 'auto_save',
            label: 'Auto-save',
            description: 'Automatically persist collected data.',
            type: 'boolean',
            sourceKey: 'auto_save',
            apply: 'live',
          },
        ],
      },
      {
        id: 'scanner',
        label: 'Market Watch scanner',
        fields: [
          {
            key: 'ds_max_price',
            label: 'Max stock price',
            description: 'Only instruments under this price enter the scan.',
            type: 'number',
            sourceKey: 'ds_max_price',
            min: 100,
            max: 100000,
            step: 100,
            unit: '₹',
            apply: 'saved',
          },
          {
            key: 'ds_max_daily_change_pct',
            label: 'Max daily change',
            type: 'number',
            sourceKey: 'ds_max_daily_change_pct',
            min: 1,
            max: 100,
            step: 1,
            unit: '%',
            apply: 'saved',
          },
          {
            key: 'ds_circuit_safety',
            label: 'Circuit limit safety',
            description: 'Skip instruments trading too close to their circuit band.',
            type: 'boolean',
            sourceKey: 'ds_circuit_safety',
            apply: 'saved',
          },
          {
            key: 'ds_circuit_buffer_pct',
            label: 'Circuit buffer',
            type: 'number',
            sourceKey: 'ds_circuit_buffer_pct',
            min: 0,
            max: 50,
            step: 1,
            unit: '%',
            apply: 'saved',
          },
        ],
      },
      {
        id: 'engine-storage',
        label: 'Market Watch engine',
        description: 'What the Market Watch engine saves to MongoDB. Takes effect on the next tick — no restart.',
        fields: [
          {
            key: 'mwr_persist_ticks',
            label: 'Save ticks',
            description:
              'Write every Market Watch tick to the market_ticks collection. Turning this off stops new writes immediately and drops anything still buffered.',
            type: 'boolean',
            sourceKey: 'mwr_persist_ticks',
            apply: 'live',
          },
          {
            key: 'mwr_persist_candles',
            label: 'Save candles',
            description: 'Save the 1m / 5m / 10m / 30m candles used by the movers and decliners boards.',
            type: 'boolean',
            sourceKey: 'mwr_persist_candles',
            apply: 'live',
          },
          {
            key: 'mwr_persist_decisions',
            label: 'Save decisions',
            description:
              'Save block and re-entry decisions (and the end-of-day report) so the decision history has real data.',
            type: 'boolean',
            sourceKey: 'mwr_persist_decisions',
            apply: 'live',
          },
          {
            key: 'mwr_tick_retention_days',
            label: 'Tick retention',
            description: 'Days to keep saved Market Watch ticks before the nightly cleanup removes them.',
            type: 'number',
            sourceKey: 'mwr_tick_retention_days',
            min: 1,
            max: 30,
            step: 1,
            unit: 'd',
            apply: 'saved',
          },
        ],
      },
    ],
  },

  {
    id: 'market-data',
    label: 'Market Data',
    shortLabel: 'Market',
    icon: 'Radar',
    description: 'Quote refresh, live stream preference and fallback behaviour.',
    keywords: ['quote', 'refresh', 'websocket', 'rest', 'stale', 'market hours', 'nse'],
    nav: true,
    groups: [
      {
        id: 'sources',
        label: 'Data source',
        fields: [
          {
            key: 'md_broker_source',
            label: 'Broker data source',
            type: 'select',
            sourceKey: 'md_broker_source',
            options: [{ value: 'kotak', label: 'Kotak Neo' }],
          },
          {
            key: 'md_websocket_usage',
            label: 'WebSocket for live data',
            description: 'Streams quotes over the broker WebSocket.',
            type: 'boolean',
            sourceKey: 'md_websocket_usage',
            apply: 'saved',
          },
          {
            key: 'md_rest_fallback',
            label: 'REST fallback',
            description: 'Fall back to REST quotes automatically when the stream is unavailable.',
            type: 'boolean',
            sourceKey: 'md_rest_fallback',
            apply: 'saved',
          },
        ],
      },
      {
        id: 'refresh',
        label: 'Quotes & staleness',
        fields: [
          {
            key: 'md_quote_refresh_ms',
            label: 'Quote refresh interval',
            type: 'number',
            sourceKey: 'md_quote_refresh_ms',
            min: 250,
            max: 60000,
            step: 250,
            unit: 'ms',
            apply: 'saved',
          },
          {
            key: 'md_stale_threshold_ms',
            label: 'Stale data threshold',
            description: 'Quotes older than this are flagged stale.',
            type: 'number',
            sourceKey: 'md_stale_threshold_ms',
            min: 1000,
            max: 60000,
            step: 1000,
            unit: 'ms',
            apply: 'saved',
          },
          {
            key: 'md_market_hours_behavior',
            label: 'Outside market hours',
            type: 'select',
            sourceKey: 'md_market_hours_behavior',
            options: [
              { value: 'market_hours', label: 'Only during market hours' },
              { value: 'always', label: 'Always fetch' },
            ],
          },
          {
            key: 'md_nse_universe',
            label: 'NSE universe',
            type: 'select',
            sourceKey: 'md_nse_universe',
            options: [{ value: 'nse_cm', label: 'NSE cash market (CM)' }],
          },
        ],
      },
    ],
  },

  {
    id: 'websocket',
    label: 'WebSocket',
    shortLabel: 'WebSocket',
    icon: 'PlugZap',
    description: 'Broker feed connection, reconnection policy and persistence.',
    keywords: ['ws', 'feed', 'reconnect', 'backoff', 'heartbeat', 'persist', 'retention'],
    nav: true,
    groups: [
      {
        id: 'connection',
        label: 'Connection',
        fields: [
          {
            key: 'ws_enabled',
            label: 'Broker WebSocket',
            description: 'Connects the live feed during the market window.',
            type: 'boolean',
            sourceKey: 'ws_enabled',
            apply: 'live',
          },
          {
            key: 'ws_auto_reconnect',
            label: 'Auto-reconnect',
            description: 'Reconnect automatically after an unexpected disconnect.',
            type: 'boolean',
            sourceKey: 'ws_auto_reconnect',
            apply: 'live',
          },
          {
            key: 'ws_max_reconnect_attempts',
            label: 'Max reconnect attempts',
            description: '0 = keep retrying.',
            type: 'number',
            sourceKey: 'ws_max_reconnect_attempts',
            min: 0,
            max: 100,
            apply: 'live',
          },
          {
            key: 'ws_reconnect_delay_ms',
            label: 'Reconnect base delay',
            type: 'number',
            sourceKey: 'ws_reconnect_delay_ms',
            min: 500,
            max: 120000,
            step: 500,
            unit: 'ms',
            apply: 'live',
          },
          {
            key: 'ws_backoff',
            label: 'Exponential backoff',
            description: 'Grow the delay on each retry (capped at the base delay).',
            type: 'boolean',
            sourceKey: 'ws_backoff',
            apply: 'live',
          },
          {
            key: 'ws_heartbeat',
            label: 'Heartbeat / ping',
            description: 'Periodic keep-alive to detect dead connections.',
            type: 'boolean',
            sourceKey: 'ws_heartbeat',
            apply: 'live',
          },
        ],
      },
      {
        id: 'data',
        label: 'Feed data',
        fields: [
          {
            key: 'ws_error_logging',
            label: 'Error logging',
            type: 'boolean',
            sourceKey: 'ws_error_logging',
            apply: 'live',
          },
          {
            key: 'ws_history_retention_days',
            label: 'History retention',
            type: 'number',
            sourceKey: 'ws_history_retention_days',
            min: 1,
            max: 90,
            unit: 'days',
            apply: 'live',
          },
        ],
      },
    ],
  },

  {
    id: 'database',
    label: 'Database',
    shortLabel: 'Database',
    icon: 'Database',
    description: 'MongoDB target for collected ticks and connection details.',
    keywords: ['mongodb', 'uri', 'database', 'collection', 'connection', 'storage'],
    nav: true,
    groups: [
      {
        id: 'target',
        label: 'Storage target',
        fields: [
          {
            key: 'mongodb_uri',
            label: 'Connection URI',
            description: 'Applies after the backend restarts.',
            type: 'string',
            sourceKey: 'mongodb_uri',
            sensitive: true,
            excludeFromExport: true,
            apply: 'restart',
          },
          {
            key: 'mongodb_database',
            label: 'Database name',
            type: 'string',
            sourceKey: 'mongodb_database',
            apply: 'restart',
          },
          {
            key: 'mongodb_collection',
            label: 'Collection name',
            type: 'string',
            sourceKey: 'mongodb_collection',
            apply: 'restart',
          },
        ],
      },
      {
        id: 'retention',
        label: 'Retention',
        fields: [
          {
            key: 'ds_data_retention_days',
            label: 'Tick data retention',
            type: 'number',
            sourceKey: 'ds_data_retention_days',
            min: 1,
            max: 365,
            unit: 'days',
            apply: 'saved',
          },
        ],
      },
    ],
  },

  {
    id: 'scheduler',
    label: 'Scheduler',
    shortLabel: 'Scheduler',
    icon: 'Timer',
    description: 'Automatic login / WebSocket / logout session lifecycle for trading days.',
    keywords: ['login', 'logout', 'ws start', 'ws stop', 'timing', 'session', 'enabled'],
    nav: true,
    groups: [
      {
        id: 'times',
        label: 'Session times (IST)',
        description: 'Edited times are consumed live by the scheduler within a few seconds.',
        fields: [
          {
            key: 'sched_login_time',
            label: 'Login time',
            type: 'time',
            sourceKey: 'sched_login_time',
            apply: 'live',
          },
          {
            key: 'sched_ws_start_time',
            label: 'WebSocket start',
            type: 'time',
            sourceKey: 'sched_ws_start_time',
            apply: 'live',
          },
          {
            key: 'sched_ws_stop_time',
            label: 'WebSocket stop',
            type: 'time',
            sourceKey: 'sched_ws_stop_time',
            apply: 'live',
          },
          {
            key: 'sched_logout_time',
            label: 'Logout time',
            type: 'time',
            sourceKey: 'sched_logout_time',
            apply: 'live',
          },
        ],
      },
      {
        id: 'policy',
        label: 'Session policy',
        fields: [
          {
            key: 'sched_enabled',
            label: 'Scheduler enabled',
            description: 'Runs the automatic session lifecycle on trading days.',
            type: 'boolean',
            sourceKey: 'sched_enabled',
            apply: 'live',
          },
          {
            key: 'sched_market_timezone',
            label: 'Market time zone',
            type: 'select',
            sourceKey: 'sched_market_timezone',
            options: [{ value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' }],
            apply: 'live',
          },
          {
            key: 'sched_trading_day_behavior',
            label: 'Trading-day behaviour',
            type: 'select',
            sourceKey: 'sched_trading_day_behavior',
            options: [
              { value: 'trading_days', label: 'Exchange trading days only' },
            ],
            apply: 'live',
          },
        ],
      },
    ],
  },

  {
    id: 'notifications',
    label: 'Notifications',
    shortLabel: 'Notifications',
    icon: 'Bell',
    description: 'Notifications, like alerts, are created only from real backend events — never simulated. This section controls when a real event becomes a notification you see.',
    keywords: ['channel', 'browser', 'pwa', 'sound', 'severity', 'engine', 'category', 'realtime', 'retention', 'dedupe', 'recovery', 'desktop'],
    nav: true,
    groups: [
      {
        id: 'engine',
        label: 'Notification engine',
        description: 'Applied live, backend-side. Every notification is created from a real Event Ledger event, never generated in the browser. Unread notifications are never deleted automatically.',
        fields: [
          {
            key: 'notif_enabled',
            label: 'Enable notifications',
            description: 'Master switch for platform notifications (engine + channels).',
            type: 'boolean',
            sourceKey: 'notif_enabled',
            apply: 'live',
          },
          {
            key: 'notif_severity',
            label: 'Minimum severity',
            description: 'Only events at or above this severity produce a notification.',
            type: 'select',
            sourceKey: 'notif_severity',
            options: [
              { value: 'all', label: 'All severities' },
              { value: 'warning', label: 'Warning and above' },
              { value: 'error', label: 'Errors only' },
            ],
            apply: 'live',
          },
          {
            key: 'notif_dedup_window_seconds',
            label: 'Dedupe / grouping window',
            description: 'Repeated events within this window bump one notification instead of creating new ones.',
            type: 'number',
            sourceKey: 'notif_dedup_window_seconds',
            min: 30,
            max: 86400,
            unit: 's',
            apply: 'live',
          },
          {
            key: 'notif_recovery_notifications',
            label: 'Recovery notifications',
            description: 'Create a read notification when a real recovery event resolves an incident.',
            type: 'boolean',
            sourceKey: 'notif_recovery_notifications',
            apply: 'live',
          },
          {
            key: 'notif_realtime',
            label: 'Realtime updates',
            description: 'Push new / updated notifications over the SSE stream as they happen.',
            type: 'boolean',
            sourceKey: 'notif_realtime',
            apply: 'live',
          },
        ],
      },
      {
        id: 'channels',
        label: 'Delivery channels',
        fields: [
          {
            key: 'notif_channel_inapp',
            label: 'In-app',
            description: 'Show in the notifications center.',
            type: 'boolean',
            sourceKey: 'notif_channel_inapp',
            apply: 'saved',
          },
          {
            key: 'notif_browser',
            label: 'Browser notifications',
            description: 'Native browser/toast notifications.',
            type: 'boolean',
            sourceKey: 'notif_browser',
            apply: 'saved',
          },
          {
            key: 'notif_pwa',
            label: 'PWA notifications',
            description: 'Notifications via the installed app.',
            type: 'boolean',
            sourceKey: 'notif_pwa',
            apply: 'saved',
          },
          {
            key: 'notif_sound_on',
            label: 'Sound',
            type: 'boolean',
            sourceKey: 'notif_sound_on',
            apply: 'saved',
          },
        ],
      },
      {
        id: 'categories',
        label: 'Notification categories',
        description: 'The backend only creates notifications for enabled categories — no spam. Category and severity gates apply together.',
        fields: [
          { key: 'notif_cat_market', label: 'Market', description: 'Market open / close and symbol activity.', type: 'boolean', sourceKey: 'notif_cat_market', apply: 'live' },
          { key: 'notif_cat_websocket', label: 'WebSocket feed', description: 'Feed connect, disconnect and auth events.', type: 'boolean', sourceKey: 'notif_cat_websocket', apply: 'live' },
          { key: 'notif_cat_session', label: 'Session', description: 'Login / logout and mode switches.', type: 'boolean', sourceKey: 'notif_cat_session', apply: 'live' },
          { key: 'notif_cat_downloads', label: 'Downloads', description: 'History / bulk download activity.', type: 'boolean', sourceKey: 'notif_cat_downloads', apply: 'live' },
          { key: 'notif_cat_exports', label: 'Exports', description: 'Exports and account-level products.', type: 'boolean', sourceKey: 'notif_cat_exports', apply: 'live' },
          { key: 'notif_cat_subscriptions', label: 'Subscriptions', description: 'Subscription and feed activity.', type: 'boolean', sourceKey: 'notif_cat_subscriptions', apply: 'live' },
          { key: 'notif_cat_scheduler', label: 'Scheduler', description: 'Scheduled job starts, crashes and completions.', type: 'boolean', sourceKey: 'notif_cat_scheduler', apply: 'live' },
          { key: 'notif_cat_data', label: 'Data quality', description: 'Quality issues and their resolution.', type: 'boolean', sourceKey: 'notif_cat_data', apply: 'live' },
          { key: 'notif_cat_settings', label: 'Settings changes', description: 'Settings changed from any surface.', type: 'boolean', sourceKey: 'notif_cat_settings', apply: 'live' },
          { key: 'notif_cat_system', label: 'System events', description: 'Network, persist and pipeline events.', type: 'boolean', sourceKey: 'notif_cat_system', apply: 'live' },
        ],
      },
      {
        id: 'retention',
        label: 'Retention',
        description: 'Read notifications are kept for the window below, then deleted. Alerts expire 24h after their first occurrence regardless of status.',
        fields: [
          {
            key: 'notif_retention_days',
            label: 'Keep read notifications for (days)',
            description: 'Read notifications older than this many days are automatically removed. Unread notifications are never deleted.',
            type: 'number',
            sourceKey: 'notif_retention_days',
            min: 1,
            max: 365,
            apply: 'live',
          },
        ],
      },
    ],
  },

  {
    id: 'alerts',
    label: 'Alerts',
    shortLabel: 'Alerts',
    icon: 'Activity',
    description: 'Live Alert Center — the event-driven engine that turns real ledger events into alerts.',
    keywords: ['alert', 'websocket', 'database', 'scheduler', 'download', 'quality', 'scanner', 'system', 'severity', 'dedupe', 'recovery'],
    nav: true,
    groups: [
      {
        id: 'engine',
        label: 'Alert engine',
        description: 'Applied live, backend-side. Alerts are only ever created from real events. Every alert expires 24h after it was created (MongoDB TTL).',
        fields: [
          {
            key: 'alerts_enabled',
            label: 'Enable alert engine',
            description: 'Turn alert creation on/off globally. Notifications keep flowing.',
            type: 'boolean',
            sourceKey: 'alerts_enabled',
            apply: 'live',
          },
          {
            key: 'alerts_severity_threshold',
            label: 'Minimum severity',
            description: 'Only alerts at or above this severity are created from real events.',
            type: 'select',
            sourceKey: 'alerts_severity_threshold',
            options: [
              { value: 'all', label: 'All severities' },
              { value: 'warning', label: 'Warning and above' },
              { value: 'error', label: 'Errors only' },
              { value: 'critical', label: 'Critical only' },
            ],
            apply: 'live',
          },
          {
            key: 'alerts_dedup_window_seconds',
            label: 'Dedupe / grouping window',
            description: 'Repeated events within this window bump one alert instead of creating new ones.',
            type: 'number',
            sourceKey: 'alerts_dedup_window_seconds',
            min: 60,
            max: 86400,
            unit: 's',
            apply: 'live',
          },
          {
            key: 'alerts_recovery_enabled',
            label: 'Recovery alerts',
            description: 'Auto-resolve open alerts when a real recovery event fires.',
            type: 'boolean',
            sourceKey: 'alerts_recovery_enabled',
            apply: 'live',
          },
          {
            key: 'alerts_desktop_notifications',
            label: 'Desktop notifications',
            description: 'Trigger browser desktop notifications for new alerts.',
            type: 'boolean',
            sourceKey: 'alerts_desktop_notifications',
            apply: 'saved',
          },
        ],
      },
      {
        id: 'rules',
        label: 'Event categories',
        description: 'The backend only creates notifications for enabled categories — no spam.',
        fields: [
          {
            key: 'notif_websocket_alerts',
            label: 'WebSocket feed',
            type: 'boolean',
            sourceKey: 'notif_websocket_alerts',
            apply: 'live',
          },
          {
            key: 'notif_database_alerts',
            label: 'Database',
            type: 'boolean',
            sourceKey: 'notif_database_alerts',
            apply: 'live',
          },
          {
            key: 'notif_scheduler_alerts',
            label: 'Scheduler',
            type: 'boolean',
            sourceKey: 'notif_scheduler_alerts',
            apply: 'live',
          },
          {
            key: 'notif_download_alerts',
            label: 'Downloads',
            type: 'boolean',
            sourceKey: 'notif_download_alerts',
            apply: 'live',
          },
          {
            key: 'notif_quality_alerts',
            label: 'Data quality',
            type: 'boolean',
            sourceKey: 'notif_quality_alerts',
            apply: 'live',
          },
          {
            key: 'notif_scanner_alerts',
            label: 'Scanner',
            type: 'boolean',
            sourceKey: 'notif_scanner_alerts',
            apply: 'live',
          },
          {
            key: 'notif_system_events',
            label: 'System events',
            type: 'boolean',
            sourceKey: 'notif_system_events',
            apply: 'live',
          },
        ],
      },
      {
        id: 'center-rules',
        label: 'Alert Center rule toggles',
        description: 'Per-rule toggles for the event-driven Alert Rule Engine (real ledger events only). Retention for read notifications lives under the Notifications section.',
        fields: [
          {
            key: 'alert_ws_connected_enabled',
            label: 'WebSocket connected',
            type: 'boolean',
            sourceKey: 'alert_ws_connected_enabled',
            apply: 'live',
          },
          {
            key: 'alert_ws_disconnected_enabled',
            label: 'WebSocket disconnected',
            type: 'boolean',
            sourceKey: 'alert_ws_disconnected_enabled',
            apply: 'live',
          },
          {
            key: 'alert_ws_auth_failed_enabled',
            label: 'WebSocket auth failed',
            type: 'boolean',
            sourceKey: 'alert_ws_auth_failed_enabled',
            apply: 'live',
          },
          {
            key: 'alert_db_connected_enabled',
            label: 'Database connected',
            type: 'boolean',
            sourceKey: 'alert_db_connected_enabled',
            apply: 'live',
          },
          {
            key: 'alert_db_disconnected_enabled',
            label: 'Database disconnected',
            type: 'boolean',
            sourceKey: 'alert_db_disconnected_enabled',
            apply: 'live',
          },
          {
            key: 'alert_market_open_enabled',
            label: 'Market opened',
            type: 'boolean',
            sourceKey: 'alert_market_open_enabled',
            apply: 'live',
          },
          {
            key: 'alert_market_close_enabled',
            label: 'Market closed',
            type: 'boolean',
            sourceKey: 'alert_market_close_enabled',
            apply: 'live',
          },
          {
            key: 'alert_subscriptions_enabled',
            label: 'Subscriptions',
            type: 'boolean',
            sourceKey: 'alert_subscriptions_enabled',
            apply: 'live',
          },
          {
            key: 'alert_network_enabled',
            label: 'Network restored',
            type: 'boolean',
            sourceKey: 'alert_network_enabled',
            apply: 'live',
          },
          {
            key: 'alert_broker_error_enabled',
            label: 'Broker error',
            type: 'boolean',
            sourceKey: 'alert_broker_error_enabled',
            apply: 'live',
          },
          {
            key: 'alert_quality_enabled',
            label: 'Data quality issue',
            type: 'boolean',
            sourceKey: 'alert_quality_enabled',
            apply: 'live',
          },
          {
            key: 'alert_quality_resolved_enabled',
            label: 'Data quality resolved',
            type: 'boolean',
            sourceKey: 'alert_quality_resolved_enabled',
            apply: 'live',
          },
          {
            key: 'alert_persistence_enabled',
            label: 'Persist failure',
            type: 'boolean',
            sourceKey: 'alert_persistence_enabled',
            apply: 'live',
          },
          {
            key: 'alert_pipeline_enabled',
            label: 'Tick pipeline',
            type: 'boolean',
            sourceKey: 'alert_pipeline_enabled',
            apply: 'live',
          },
          {
            key: 'alert_scheduler_enabled',
            label: 'Scheduler',
            type: 'boolean',
            sourceKey: 'alert_scheduler_enabled',
            apply: 'live',
          },
          {
            key: 'alert_scheduler_crash_enabled',
            label: 'Scheduler crash',
            type: 'boolean',
            sourceKey: 'alert_scheduler_crash_enabled',
            apply: 'live',
          },
          {
            key: 'alert_login_enabled',
            label: 'Login events',
            type: 'boolean',
            sourceKey: 'alert_login_enabled',
            apply: 'live',
          },
          {
            key: 'alert_mode_enabled',
            label: 'Mode switch',
            type: 'boolean',
            sourceKey: 'alert_mode_enabled',
            apply: 'live',
          },
          {
            key: 'alert_settings_enabled',
            label: 'Settings change',
            type: 'boolean',
            sourceKey: 'alert_settings_enabled',
            apply: 'live',
          },
          {
            key: 'alert_download_enabled',
            label: 'Downloads',
            type: 'boolean',
            sourceKey: 'alert_download_enabled',
            apply: 'live',
          },
          {
            key: 'alert_export_enabled',
            label: 'Exports',
            type: 'boolean',
            sourceKey: 'alert_export_enabled',
            apply: 'live',
          },
          {
            key: 'alert_scanner_enabled',
            label: 'Scanner',
            type: 'boolean',
            sourceKey: 'alert_scanner_enabled',
            apply: 'live',
          },
        ],
      },
    ],
  },

  {
    id: 'security',
    label: 'Security',
    shortLabel: 'Security',
    icon: 'Shield',
    description: 'Session, app lock and security history for the Data Saver UI.',
    keywords: ['lock', 'session', 'pin', 'timeout', 'security', 'history', 'auth'],
    nav: true,
    groups: [
      {
        id: 'session',
        label: 'Session & app lock',
        fields: [
          {
            key: 'sec_app_lock',
            label: 'App lock',
            description: 'Lock the Data Saver UI after the configured inactivity timeout.',
            type: 'boolean',
            sourceKey: 'sec_app_lock',
            apply: 'saved',
          },
          {
            key: 'sec_auto_lock',
            label: 'Auto-lock',
            type: 'boolean',
            sourceKey: 'sec_auto_lock',
            apply: 'saved',
          },
          {
            key: 'sec_auto_lock_timeout_min',
            label: 'Lock timeout',
            type: 'select',
            sourceKey: 'sec_auto_lock_timeout_min',
            options: [
              { value: '1', label: '1 minute' },
              { value: '5', label: '5 minutes' },
              { value: '15', label: '15 minutes' },
              { value: '30', label: '30 minutes' },
              { value: '60', label: '1 hour' },
            ],
            apply: 'saved',
          },
          {
            key: 'sec_lock_on_background',
            label: 'Lock on background',
            description: 'Lock when the app is sent to the background.',
            type: 'boolean',
            sourceKey: 'sec_lock_on_background',
            apply: 'saved',
          },
          {
            key: 'session_timeout',
            label: 'Session timeout',
            type: 'number',
            sourceKey: 'session_timeout',
            min: 1,
            max: 1440,
            unit: 'min',
            apply: 'saved',
          },
        ],
      },
      {
        id: 'history',
        label: 'Security history',
        fields: [
          {
            key: 'sec_security_event_history',
            label: 'Record security events',
            description: 'Keep a log of lock / unlock / login security events.',
            type: 'boolean',
            sourceKey: 'sec_security_event_history',
            apply: 'saved',
          },
        ],
      },
    ],
  },

  {
    id: 'app-lock',
    label: 'App lock',
    shortLabel: 'Lock',
    icon: 'Lock',
    description: 'Lock screen behaviour: auto-lock timeout, background locking and unlock enforcement.',
    keywords: ['lock', 'unlock', 'timeout', 'background', 'minimize', 'auth'],
    nav: true,
    groups: [
      {
        id: 'unlock',
        label: 'Unlock',
        fields: [
          {
            key: 'sec_require_auth_unlock',
            label: 'Require authentication',
            description: 'Unlocking must confirm the session, not just dismiss the screen.',
            type: 'boolean',
            sourceKey: 'sec_require_auth_unlock',
            apply: 'saved',
          },
          {
            key: 'sec_lock_on_minimize',
            label: 'Lock on minimise',
            description: 'Lock when the app is minimised / backgrounded on mobile.',
            type: 'boolean',
            sourceKey: 'sec_lock_on_minimize',
            apply: 'saved',
          },
        ],
      },
    ],
  },

  {
    id: 'biometric',
    label: 'Biometric',
    shortLabel: 'Biometric',
    icon: 'Fingerprint',
    description: 'Fingerprint / face unlock for the Data Saver app (WebAuthn with graceful fallback).',
    keywords: ['fingerprint', 'face', 'webauthn', 'biometric', 'unlock'],
    nav: true,
    groups: [
      {
        id: 'status',
        label: 'Status',
        fields: [
          {
            key: 'sec_biometric_supported',
            label: 'Platform biometric available',
            description: 'Whether the current device exposes WebAuthn biometric unlock.',
            type: 'boolean',
            sourceKey: 'sec_biometric_supported',
            readOnly: true,
            apply: 'saved',
          },
          {
            key: 'security_biometric',
            label: 'Biometric unlock',
            description: 'Enables fingerprint / face unlock when supported.',
            type: 'boolean',
            sourceKey: 'security_biometric',
            apply: 'saved',
          },
        ],
      },
    ],
  },

  {
    id: 'pwa',
    label: 'PWA & install',
    shortLabel: 'PWA',
    icon: 'ShieldCheck',
    description: 'Installed-app identity, offline behaviour and app updates.',
    keywords: ['install', 'offline', 'update', 'manifest', 'service worker', 'sw'],
    nav: true,
    groups: [],
  },

  {
    id: 'privacy',
    label: 'Privacy & data',
    shortLabel: 'Privacy',
    icon: 'HardDrive',
    description: 'What persists, export / import of your settings (secrets excluded) and local data.',
    keywords: ['export', 'import', 'clear', 'local', 'data', 'secrets', 'privacy'],
    nav: true,
    groups: [
      {
        id: 'controls',
        label: 'Controls',
        fields: [
          {
            key: 'sec_clear_local_session',
            label: 'Clear local session on logout',
            description: 'Remove local cache and session data when you log out.',
            type: 'boolean',
            sourceKey: 'sec_clear_local_session',
            apply: 'saved',
          },
        ],
      },
    ],
  },

  {
    id: 'storage',
    label: 'Storage',
    shortLabel: 'Storage',
    icon: 'Database',
    description: 'MongoDB footprint, retention and cache usage.',
    keywords: ['mongo', 'storage', 'retention', 'disk', 'usage', 'cache', 'purge'],
    nav: true,
    groups: [],
  },

  {
    id: 'performance',
    label: 'Performance',
    shortLabel: 'Performance',
    icon: 'Gauge',
    description: 'Refresh, animation and latency-minded knobs.',
    keywords: ['refresh', 'animation', 'performance', 'latency', 'polling'],
    nav: true,
    groups: [
      {
        id: 'tuning',
        label: 'Tuning',
        fields: [
          {
            key: 'general_auto_refresh',
            label: 'Auto-refresh data views',
            description: 'Backend polling for live views.',
            type: 'boolean',
            sourceKey: 'general_auto_refresh',
            apply: 'saved',
          },
          {
            key: 'general_animation',
            label: 'Animations',
            description: 'Disabling reduces jank on low-power devices.',
            type: 'boolean',
            sourceKey: 'general_animation',
            apply: 'saved',
          },
        ],
      },
    ],
  },

  {
    id: 'accessibility',
    label: 'Accessibility',
    shortLabel: 'Accessibility',
    icon: 'Printer',
    description: 'Motion, contrast and scaling preferences.',
    keywords: ['motion', 'reduce', 'contrast', 'font', 'scale', 'accessibility'],
    nav: true,
    groups: [],
  },

  {
    id: 'advanced',
    label: 'Advanced',
    shortLabel: 'Advanced',
    icon: 'Terminal',
    description: 'Protocol timeouts, retries and the danger zone.',
    keywords: ['timeout', 'retry', 'polling', 'advanced', 'reset', 'danger'],
    nav: true,
    groups: [
      {
        id: 'protocols',
        label: 'Backend protocols',
        fields: [
          {
            key: 'adv_order_timeout',
            label: 'Order API timeout',
            type: 'number',
            sourceKey: 'adv_order_timeout',
            min: 5,
            max: 120,
            unit: 's',
            apply: 'restart',
          },
          {
            key: 'adv_quote_timeout',
            label: 'Quote timeout',
            type: 'number',
            sourceKey: 'adv_quote_timeout',
            min: 2,
            max: 60,
            unit: 's',
            apply: 'restart',
          },
          {
            key: 'adv_retry_count',
            label: 'Retry count',
            type: 'number',
            sourceKey: 'adv_retry_count',
            min: 0,
            max: 10,
            apply: 'restart',
          },
          {
            key: 'adv_retry_delay',
            label: 'Retry delay',
            type: 'number',
            sourceKey: 'adv_retry_delay',
            min: 100,
            max: 30000,
            step: 100,
            unit: 'ms',
            apply: 'restart',
          },
          {
            key: 'adv_order_polling',
            label: 'Order polling interval',
            type: 'number',
            sourceKey: 'adv_order_polling',
            min: 1000,
            max: 60000,
            step: 1000,
            unit: 'ms',
            apply: 'restart',
          },
          {
            key: 'adv_position_refresh',
            label: 'Position refresh interval',
            type: 'number',
            sourceKey: 'adv_position_refresh',
            min: 1000,
            max: 60000,
            step: 1000,
            unit: 'ms',
            apply: 'restart',
          },
        ],
      },
    ],
  },

  {
    id: 'about',
    label: 'About',
    shortLabel: 'About',
    icon: 'Info',
    description: 'Version, backend and platform information.',
    keywords: ['version', 'about', 'backend', 'build', 'help', 'docs'],
    nav: true,
    groups: [],
  },
];

export const SECTION_INDEX = new Map(SECTIONS.map((s) => [s.id, s]));

export const ALL_FIELDS: SettingsFieldDef[] = SECTIONS.flatMap((s) =>
  s.groups.flatMap((g) => g.fields),
);

export const FIELD_INDEX = new Map(ALL_FIELDS.map((f) => [f.key, f]));

/** Every persisted source key the schema touches (for export). */
export const SCHEMA_KEYS = Array.from(new Set(ALL_FIELDS.map((f) => f.sourceKey)));

/**
 * Backend keys the runtime engine consumes live (kept in sync with python-service).
 *
 * `ws_tick_persistence` and `ds_live_tick_collection` were removed here: no
 * backend consumer ever read them, so they were dead controls claiming an
 * instant effect. The two real tick-persistence switches are
 * `ds_collection_enabled` (Data Saver raw ticks) and `mwr_persist_ticks`
 * (Market Watch ticks).
 */
export const LIVE_KEYS: ReadonlySet<string> = new Set([
  'sched_enabled', 'sched_login_time', 'sched_ws_start_time', 'sched_ws_stop_time',
  'sched_logout_time', 'sched_market_timezone', 'sched_trading_day_behavior',
  'ws_enabled', 'ws_auto_reconnect', 'ws_max_reconnect_attempts',
  'ws_reconnect_delay_ms', 'ws_backoff', 'ws_heartbeat',
  'ws_error_logging', 'ws_history_retention_days',
  'ds_collection_enabled', 'ds_batch_size',
  'batch_size', 'buffer_size', 'bulk_insert_size', 'flush_interval_ms',
  'retry_count', 'auto_save',
  'mwr_ranking_interval_seconds', 'mwr_max_pins', 'mwr_initial_section_limit',
  'mwr_page_size', 'mwr_stale_threshold_seconds', 'mwr_universe_refresh_seconds',
  'mwr_persist_ticks', 'mwr_persist_candles', 'mwr_persist_decisions',
]);

export function searchSections(query: string, max = 10): SettingsSectionDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return SECTIONS.filter((s) => s.nav).slice(0, max);
  const scored = SECTIONS.filter((s) => s.nav).map((s) => {
    let score = 0;
    const words = q.split(/\s+/);
    const label = s.label.toLowerCase();
    const short = (s.shortLabel ?? '').toLowerCase();
    const catMatches = s.keywords.filter((k) => words.some((w) => k.toLowerCase().includes(w)));
    const fieldHits = s.groups.flatMap((g) => g.fields).filter((f) =>
      words.some((w) => f.label.toLowerCase().includes(w) || (f.description ?? '').toLowerCase().includes(w)),
    );
    const catHits = s.keywords.filter((k) => k.toLowerCase().includes(q));
    if (label.startsWith(q)) score += 10;
    else if (label.includes(q)) score += 6;
    if (short.includes(q)) score += 4;
    score += catMatches.length * 2 + catHits.length * 3 + fieldHits.length * 4;
    return { s, score, fieldHits: fieldHits.length };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.s);
}