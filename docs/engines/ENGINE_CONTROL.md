# ENGINE CONTROL — SERVICE CONTROL CENTER (Phase 3)

> **PART 33**: The SCC is a control plane. Every action maps to a real endpoint;
> every displayed value comes from the backend. No fabricated data.

## API Surface

| Endpoint (backend) | Method | Purpose |
|--------------------|--------|---------|
| `/api/services/engines` | GET | List all engines + status |
| `/api/services/engines/summary` | GET | Overall health summary |
| `/api/services/engines/{id}/start` | POST | Start (native engines only) |
| `/api/services/engines/{id}/stop` | POST | Stop (native engines only) |
| `/api/services/engines/{id}/restart` | POST | Restart |
| `/api/services/engines/broker/trading` | GET | Trading broker status |
| `/api/services/engines/broker/market-data` | GET | Market data broker status |
| `/api/services/engines/broker/list` | GET | Available broker adapters |
| `/api/services/engines/broker/switch/{kind}` | POST | Switch trading OR market-data broker |

## Frontend Proxy

`app/api/services/engines/route.ts` (root) + `[...path]/route.ts` (subpaths)
proxy to `http://localhost:8000`. **The root route was ADDED** to fix the 404
that caused "Loading engines…" to hang forever (Next.js only matched paths with
≥1 segment).

## Frontend Behaviour

- `usePoll` polls each endpoint; on non-2xx/parse-failure it sets an `error`
  string instead of silently keeping stale data.
- `enginesList = Array.isArray(engines) ? engines : null` — a non-array body is
  TREATED AS LOADING (never rendered as data).
- Diagnostics banner lists every failing endpoint + its real error; a Retry
  button forces an immediate re-poll.
- While `enginesList == null` the UI shows loading skeletons + real error text
  (not infinite spinning).
- Broker selection is **isolated by kind**: TRADING list uses
  `capabilities.trading`, MARKET DATA list uses `capabilities.marketData`.

## Honesty Rules

1. `state REGISTERED` is never shown as running.
2. `health UNKNOWN` is shown as-is (no green-washing).
3. Load errors show the actual HTTP status / message.
4. Broker adapters marked `implemented: false` are shown `NOT IMPLEMENTED`
   and cannot be selected.

---

*Generated: 2026-09-14 | Part 33*