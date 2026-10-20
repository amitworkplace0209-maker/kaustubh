'use client';

import { useEffect } from 'react';

/**
 * Root error boundary that replaces the entire <html>/<body> tree.
 * Next.js App Router requires this file at the app root; without it the server
 * returns "missing required error components" and the whole app shows a blank
 * screen. This guarantees the root can always recover with a readable state.
 */
export default function GlobalError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error]', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#060a08', color: '#fff', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ maxWidth: 480, width: '100%' }}>
            <div style={{ borderRadius: 16, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)', padding: 24 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Application error</h2>
              <p style={{ marginTop: 6, fontSize: 14, color: 'rgba(255,255,255,0.4)' }}>
                A critical error occurred while rendering this application.
              </p>
              <p style={{ marginTop: 6, fontSize: 12, fontWeight: 500, color: '#fcd34d' }}>
                {error?.message || 'An unexpected runtime error occurred.'}
              </p>
              <button
                onClick={() => reset()}
                style={{ marginTop: 16, padding: '8px 16px', borderRadius: 8, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
