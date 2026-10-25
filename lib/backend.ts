import { NextResponse } from 'next/server';

/**
 * Server-side bridge to the real Python FastAPI backend (port 8000).
 * All Data Saver (Phase 2) API routes proxy through here so the UI is
 * always fed by the LIVE backend â€” never fabricated values.
 */

const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

/**
 * The backend origin, for callers that need to build an absolute URL
 * themselves (streaming passthroughs that must NOT go through
 * `backendFetch`, because that helper buffers and JSON-parses the body).
 * Server-side only — never send this to the browser.
 */
export function backendBase(): string {
  return BACKEND.replace(/\/+$/, '');
}

export async function backendFetch<T = any>(
  path: string,
  init?: RequestInit & { timeoutMs?: number; on404?: T },
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const { timeoutMs = 12000, ...rest } = (init ?? {}) as any;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  try {
    const res = await fetch(`${BACKEND}${path}`, {
      ...rest,
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...((rest.headers as Record<string, string>) || {}),
      },
    });
    let data: T | null = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: timedOut ? `Request timed out after ${timeoutMs}ms` : (err?.message || 'Backend unreachable'),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function backendJson(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<any> {
  const res = await backendFetch(path, init);
  return res.data;
}

/**
 * Raw (non-JSON) backend response, for CSV/TEXT exports where JSON.parse
 * would destroy the payload. Returns the body verbatim.
 */
export async function backendText(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<{ ok: boolean; status: number; text: string; contentType?: string; error?: string }> {
  const { timeoutMs = 20000, ...rest } = (init ?? {}) as any;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  try {
    const res = await fetch(`${BACKEND}${path}`, {
      ...rest,
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      text,
      contentType: res.headers.get('content-type') || undefined,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: timedOut ? `Request timed out after ${timeoutMs}ms` : (err?.message || 'Backend unreachable'),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function emptyJson<T extends Record<string, any>>(base: T): NextResponse {
  return NextResponse.json(base);
}

export function proxyFail(message = 'Backend unreachable', status = 502): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
