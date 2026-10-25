# Target Engine

**STATUS: CURRENT — 2026-09-23 — 4-WS model (Service Phase Trading)**

## Purpose

Price-target alert/trigger engine for `PROFIT` / `LOSS` targets on a symbol. `PERCENT | FIXED | AMOUNT` types, `autoExecute` flag, lifecycle `ACTIVE → TRIGGERED → EXECUTED | CANCELLED`. Dummy-scoped in practice (real targets route via `Order Engine` / `Risk Engine` decisions); the engine therefore states its scope honestly instead of pretending a registry `target_engine` exists.

## Ownership

- **Backend module:** `core/engines/target_engine.py` — in-memory `_TARGETS` (`terminal:symbol:product → {targetValue, createdAt, status}`), not registered in `EngineRegistry` (intentional: dummy-only, `get_targets/place_target/delete_target` via `api/terminal.py` + `api/dummy.py`).
- **Concept owner:** `Order Engine` family (capability inside `order-engine.md`); `Target Engine` UI surfaces under `/services/target-engine`.
- **Not registered:** `docs/SERVICE_PHASE_ENGINE_PAGE_INVENTORY.md:18 F` correctly notes *no doc* legacy; this file closes that gap.

## Inputs

- Symbol (`RELIANCE-EQ`), `targetType`, `value`, `direction`, `autoExecute` from `POST /api/terminal/target` or `WS#4 target_set` (via `api/ws_gateway.py` generic handler → `target_engine.set_target`).

## Outputs

- Target rows (`symbol, targetType, value, direction, status, triggeredAt, executedAt`) to `/services/target-engine` and `Order Engine` basket.

## REST

- `GET /api/dummy/targets` (list armed targets), `POST /api/terminal/target` (arm), `DELETE /api/terminal/target/{symbol}` (disarm). Honest zero when none armed.

## WebSocket

- **WS#3:** `engines` channel status via `useEngineStatus('target_engine')` would show `UNKNOWN` (no registry engine) — UI instead shows `SCOPE: Dummy-mode target alerts (no registry engine)`.
- **WS#4:** `target_set / target_remove` actions via `WS /ws/realtime` command router (generic handler in `api/ws_gateway.py`) → `target_engine` when applicable.
- **Future:** when a real `target_engine` registry id appears, page will auto-migrate to `useEngineStatus('target_engine', '/api/services/engines/target_engine')` without UI change.

## Event Bus / Database

- No `EngineEventBus` events (in-memory loss on restart is design limitation, not data loss — targets are user-intent, not ledger).
- No broker touch; risk gate lives in `Order Engine`.

## Lifecycle

- `START: engine import` (module load), `STOP: process exit` (in-memory clear). No scheduler phase.

## Failure handling / Reconnect

- `POST` failure → `error` badge, not fabricated row. Reconnect re-fetches `GET /api/dummy/targets` via `useBackend` (`useBackend` is one-shot, not interval poll).

## Security / Observability

- `POST /api/terminal/target` requires `auth_gate(trading)` when `terminal=kotak`; dummy path is `isDemoMode()` gated.

## Tests

- `python-service/tests/test_target_engine.py` (in `test_dummy_*` family) + frontend `components/orders/trade/target-panel.tsx` exercises `placeTarget`.

## Frontend consumers

- `app/_pages/target-engine/page.tsx` (`/services/target-engine`) — `useBackend(getTargets)` + arm form + `StatusBadge TRIGGERED/ACTIVE/CANCELLED`. Connected to Connection Manager via `ws_gateway` generic command (future) and shows real `GET /api/terminal/target` rows.

## Connection Manager / Frontend WebSocket Linkage

- Channel: `orders` (target alerts reuse order lifecycle semantics) + `notifications` for trigger alerts. Page subscribes to `notifications` via `useFrontendRealtime().subscribe([{channel:'notifications'}])` for live trigger toast (implemented 2026-09-23).
- Delivery: `Connection Manager → WS#3` `notification.new` when target hits (via `notification_engine`).

## Feature Completeness (Service Phase)

- `Arm target` form (PERCENT/FIXED/AMOUNT × PROFIT/LOSS) — **IMPLEMENTED**
- `List armed targets` with status + `Delete` — **IMPLEMENTED**
- `Broker-scoped target` (kotak vs dummy) — **PARTIAL → now documented; dummy-scoped label shown**
- `Realtime trigger` via WS#3 — **IMPLEMENTED 2026-09-23** (listens on `notifications` channel)
