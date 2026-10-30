/**
 * Normalise the backend auth error envelope for the browser.
 *
 * `api/auth_app.py` raises `HTTPException(detail={ok:false,message,error,...})`.
 * FastAPI's application-level handler (python-service/app.py) wraps that in
 * `{"ok": false, "detail": <payload>}` for every router. The login page reads
 * `message`, `code` and `database` from the TOP level, so relaying the wrapped
 * body makes every real error look like a generic failure — including the
 * database-unavailable retry state.
 *
 * This helper only unwraps an object `detail`; string/array details (FastAPI
 * validation errors) are left untouched.
 */
export function normalizeAuthPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const detail = record.detail;
  if (
    record.ok === false
    && detail
    && typeof detail === 'object'
    && !Array.isArray(detail)
  ) {
    // Keep the inner fields (message/error/code/database) and force ok=false.
    return { ...(detail as Record<string, unknown>), ok: false };
  }
  return payload;
}
