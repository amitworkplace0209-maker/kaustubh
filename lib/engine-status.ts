/**
 * Engine-status payload normalisation.
 *
 * Two real sources exist for the same data:
 *   - WebSocket #2 `engine.status` frames carry `data.engines` as a map
 *     keyed by `engineId`;
 *   - `GET /api/services/engines` returns `{ ok, data: [...] }` (a list).
 *
 * The trade page (and the engine grids) must render the same count no matter
 * which source answered. This pure helper is deliberately free of React and
 * fetch so it can be unit-tested and reused by the hook.
 */

export type EngineStatusMap = Record<string, any>;

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Return a map keyed by engine id, or `null` when the payload is not an
 * engine snapshot at all. An empty list/map is valid (zero engines), not null.
 */
export function normalizeEngineStatusPayload(value: unknown): EngineStatusMap | null {
  if (Array.isArray(value)) {
    const map: EngineStatusMap = {};
    for (const row of value) {
      if (!isRecord(row)) continue;
      const id = String(row.engineId ?? row.engine_id ?? row.id ?? '').trim();
      if (id) map[id] = row;
    }
    return map;
  }

  if (!isRecord(value)) return null;

  // Realtime frame body: { type, generatedAt, count, engines: { ... } }
  if (isRecord(value.engines)) return normalizeEngineStatusPayload(value.engines);

  // Already a keyed map. Ignore envelopes such as { ok, data } — the caller
  // passes `body.data` for REST, so an envelope here is a malformed payload.
  const entries = Object.entries(value).filter(([, row]) => isRecord(row));
  if (entries.length === 0) {
    return Object.keys(value).length === 0 ? {} : null;
  }
  return Object.fromEntries(entries);
}
