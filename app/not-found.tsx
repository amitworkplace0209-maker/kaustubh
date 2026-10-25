'use client';

import Link from 'next/link';

/**
 * Required App-Router 404 component at the app root.
 * Without it Next.js reports missing required error components and the app
 * fails to render. Provides a clean "page not found" state.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#060a08] p-4">
      <div className="w-full max-w-lg text-center">
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-8">
          <p className="text-6xl font-black text-white/20">404</p>
          <h2 className="mt-2 text-lg font-bold text-white">Page not found</h2>
          <p className="mt-2 text-sm text-white/40">
            The page you are looking for does not exist or may have been moved.
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex items-center justify-center gap-2 rounded-lg bg-white/[0.06] border border-white/[0.1] px-5 py-2 text-sm font-medium text-white hover:bg-white/[0.1] transition-colors"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
