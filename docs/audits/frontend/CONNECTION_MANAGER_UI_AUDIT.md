# Connection Manager UI Audit

What the Connection Manager Service Control Center currently is.

Specification: `docs/engines/connection-manager.md`.
Implementation record: `docs/implementation/027-connection-manager-ui-redesign.md`.
Verification: `docs/verification/027-connection-manager-ui-redesign.md`.

Last verified: 2026-10-07 (IST), against a live backend and live routes.

---

## 1. Routes

Mandated by `docs/frontend/FRONTEND_ROUTE_MAP.md:166-172`. Four routes; each has a shell
that dynamically imports the shared implementation.

| Route | Shell | Implementation |
|---|---|---|
| `/services/connection-manager` | `(services)/services/connection-manager/page.tsx` | `_pages/connection-manager/page.tsx` |
| `/services/connection-manager/connections` | `.../connections/page.tsx` | `_pages/connection-manager/connections.tsx` |
| `/services/connection-manager/events` | `.../events/page.tsx` | `_pages/connection-manager/events.tsx` |
| `/services/connection-manager/configuration` | `.../configuration/page.tsx` | `_pages/connection-manager/configuration.tsx` |

There is no `/profile` route. The engine profile lives at the canonical shared route
`/services/system/connection_manager` and `/services/system/profile/connection_manager`
(`lib/system-engines.ts:191-192`).

All four routes verified HTTP 200 on the running dev server.

## 2. Shared implementation — `app/_pages/connection-manager/`

| File | Lines | Purpose |
|---|---|---|
| `cm-shared.tsx` | ~700 | Backend-exact types, API clients, hooks, formatters, tone maps, shared primitives |
| `page.tsx` | ~520 | Overview |
| `connections.tsx` | ~420 | Connections (spec §50) |
| `events.tsx` | ~350 | Event inspector |
| `configuration.tsx` | ~400 | Configuration + field catalogue |

`connection-manager-data.ts` was removed — its types were partly wrong, which was the
origin of the field-name defect class, and its formatters duplicated `lib/` copies.

## 3. Navigation

`components/layout/nav.ts:507-512` — Services → Engines → Connection Manager, with four
children (Overview, Connections, Events, Configuration). Icons `Cable`, `Activity`,
`ScrollText`, `SettingsIcon`. `lib/navigation/registry.ts` derives search and breadcrumbs
automatically. `tests/nav-utils.test.ts:60,111,160-161,185,190` asserts nav integrity, so
ids and hrefs must not change.

`lib/system-engines.ts:173` maps `connection_manager` → `/services/connection-manager`.

## 4. Data sources

All calls use the relative Next.js proxy, so auth cookies and the backend base stay in one
place.

| Endpoint | Consumer | Purpose |
|---|---|---|
| `/api/services/engines/connection_manager` | Overview, Connections | engine record + `connectionEngine` |
| `/api/realtime/health` | Overview | `health()` |
| `/api/realtime/events` | Events | bounded event ring |
| `/api/realtime/config` | Configuration | read-only configuration |
| `/api/realtime/fields` | Configuration | field availability catalogue |
| `/api/realtime/sessions` | `cm-shared` (available) | live gateway sessions |
| `/api/realtime/architecture` | Overview | WS#1–#4 / REST / Event Bus ownership |
| `/api/realtime/order-feed` | Overview | WS#2 feed state, observed not owned |
| `/api/realtime/connections/{id}` | Connections | one connection's diagnostics |

`lib/api.ts` is not used by these pages any more. Previously two of them called it, which
defaulted to `http://127.0.0.1:8000` cross-origin while the rest used the proxy.

## 5. Realtime

- Overview and Connections render from the `engine.status` push on the `engines`
  channel via `useEngineStatus` (`lib/engine-realtime.ts`). The REST fallback fires once
  on mount and is superseded by the first realtime frame.
- Every page header states provenance through `LiveIndicator`: `live` (realtime frame),
  `REST snapshot (no live frame yet)`, or `offline`.
- Events is deliberately snapshot-only — it reads a bounded ring on demand.
- No page installs a polling interval.

## 6. Spec conformance

| Spec clause | Where it is honoured |
|---|---|
| §7 connection registry | Connections page, one row per `session_records()` entry |
| §8 consumer types | Configuration shows only the types the gateway reports |
| §10 field availability | Connections field-availability panel; Configuration catalogue |
| §11 source management | Configuration sources + aliases |
| §13 control vs data plane | Every page is read-only; no write controls are invented |
| §23 connection states | `connectionTone()` classifies the spec's states; unknown stays neutral |
| §26 backpressure | Overview backpressure card with per-class drop counts |
| §28 health vs data quality | Overview shows two independent badges, never blended |
| §29 failure isolation | Connections notes one consumer's error does not imply others failed |
| §31 UI connection model | Connections empty state explains registration is automatic |
| §38 API for control/status | Connections states pause/resume/delete are not offered |
| §39 event model | Events offers only event types present in the ring |
| §47 data ownership | Overview transport ownership panel from `/architecture` |
| §50 diagnostics | Connections, the ten fields in the spec's own order |
| §51 health dashboard | Overview, all thirteen metrics, each provenance-tagged |
| §56 stale data | Overview freshness card + thresholds; Connections stale filter |
| §65 logging | Events notes the gateway never records credentials |

## 7. Honesty behaviour

A value the backend does not send is never invented:

- missing scalar → `—`
- missing spec metric with no backend source → `NOT_PROVIDED` with the reason
- derived metric → tagged `derived` with the derivation spelled out in the tooltip
- spec view with no endpoint → a panel naming the gap

Two spec §51 metrics are `NOT_PROVIDED`: **bytes/sec** and **average delivery latency**.
The backend measures neither.

## 8. Design-system reuse

From `components/design-system.tsx`: `PageHeader`, `SectionCard`, `StatusBadge`,
`EmptyState`, `LoadingState`, `ErrorState`, `LiveIndicator`.

From `components/ui/`: `Table` family, `Input`, `Button`.

Four local primitives in `cm-shared.tsx` replaced roughly twelve duplicated
label/value implementations: `KV`, `KVGrid`, `AggregateTile`, `TokenList`.

No Connection Manager component exists in `components/connection-manager/` — the UI is
self-contained under `_pages`, consistent with the rest of the project.

## 9. Known defects and limitations

| # | Item | Severity | Status |
|---|---|---|---|
| U1 | Rendered appearance never verified in a browser | high | open |
| U2 | Realtime path never observed under real tick traffic (feed was `NO_DATA`, WS#1/WS#2 disconnected) | medium | open |
| U3 | 16 KB WS-record projection can trim `connectionEngine`; degradation untested | low | mitigated, unproven |
| U4 | Formatters duplicated across `lib/system-engines.ts`, `design-system.tsx`, `sm-shared.tsx`, `cm-shared.tsx` | low | open (cross-cutting) |
| U5 | `lib/api.ts:380-381` `getRealtimeHealth` / `getRealtimeConfig` unused | trivial | open (left alone) |
| U6 | No unit or component tests for any page in this area | medium | open |

## 10. Verification status

| Area | Status |
|---|---|
| Route existence and compilation | verified — 4 × HTTP 200 |
| Field contract against live payloads | verified — 137 assertions, 0 failures |
| Negative assertions for the old broken keys | verified |
| TypeScript | verified — exit 0 |
| Lint | verified — exit 0, 0 warnings |
| API proxies | verified — 4 × HTTP 200 `ok=true` |
| Rendered UI | **NOT VERIFIED** |
| Live socket behaviour | **NOT VERIFIED** |
