export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * Canonical Data Saver dashboard endpoint at the preferred path
 * `GET /api/data-saver/dashboard`. Alias of the canonical `/api/phase2/dashboard`
 * implementation — shares the same module cache (single-flight + TTL), so there
 * is ONE payload shape and ONE poll loop, never duplicate logic.
 */
export { GET } from '@/app/api/phase2/dashboard/route';