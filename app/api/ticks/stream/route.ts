import { backendBase } from '@/lib/backend';

export const revalidate = 0;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Live tick SSE passthrough.
 *
 * The browser cannot open a cross-origin EventSource to the Python service in
 * this deployment (a request to 127.0.0.1:8000 from the page never completes,
 * while the same host reached as "localhost" does), so the shared tick fanout
 * used to hang and the order ticket froze on its seed price.
 *
 * This route makes the stream SAME-ORIGIN. The browser opens
 * `/api/ticks/stream`, this handler opens one upstream connection to the
 * backend, and the bytes are forwarded verbatim — no parsing, no filtering, no
 * fabricated values. Backpressure is respected: we only pull the next chunk
 * after the client has consumed the previous one, so a slow tab cannot make the
 * server buffer the whole market, and an aborted client tears the upstream down.
 */
export async function GET(req: Request) {
  const upstream = `${backendBase()}/api/ticks/stream`;

  let closed = false;
  const onAbort = () => {
    closed = true;
  };
  req.signal.addEventListener('abort', onAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: req.signal,
    });
  } catch (err) {
    req.signal.removeEventListener('abort', onAbort);
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`,
      { status: 502, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  if (!res.ok || !res.body) {
    req.signal.removeEventListener('abort', onAbort);
    return new Response('Backend tick stream unavailable', { status: 502 });
  }

  const reader = res.body.getReader();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch {
        controller.close();
      }
    },
    cancel(reason) {
      closed = true;
      req.signal.removeEventListener('abort', onAbort);
      void reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops any reverse proxy between here and the browser from buffering the
      // stream into uselessness (nginx honours this).
      'X-Accel-Buffering': 'no',
    },
  });
}