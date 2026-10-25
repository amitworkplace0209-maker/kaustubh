'use client';

import { useEffect } from 'react';

/**
 * Root App-Router error boundary (route/segment level).
 *
 * Next.js App Router REQUIRES an `error.tsx` at the app root. Without it the
 * dev/prod server emits "missing required error components" and the whole
 * page fails to render as a blank/500 screen. This boundary guarantees the
 * user always sees a readable, retry-able error state instead of a blank page.
 */
export default function GlobalError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app/error]', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#060a08] p-4">
      <div className="w-full max-w-lg">
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-red-500/10 border border-red-500/20">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-400">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold text-white">Something went wrong</h2>
              <p className="mt-1 text-sm text-white/40">
                This section failed to render. The rest of the application is unaffected.
              </p>
              <p className="mt-1 text-[12px] font-medium text-amber-300/90">
                {error?.message || 'An unexpected runtime error occurred.'}
              </p>
              <p className="mt-1 text-[11px] text-white/30">
                {typeof window !== 'undefined'
                  ? new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST · ' + window.location.pathname
                  : 'rendering'}
              </p>
              <button
                onClick={() => reset()}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.06] border border-white/[0.1] text-white text-sm font-medium hover:bg-white/[0.1] transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M8 16H3v5" />
                </svg>
                Try again
              </button>
              <p className="mt-4 text-[11px] leading-relaxed text-white/30">
                Check the browser console for the logged error and the backend logs for the cause.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
