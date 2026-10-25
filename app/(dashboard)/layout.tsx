import { Shell } from '@/components/layout/shell';

/**
 * Legacy `(dashboard)` compatibility shell — the top-level legacy URLs
 * (/dashboard, /stocks, /live-ticks, /downloads, /positions, ...) are reskinned
 * through the SAME canonical AppShell frame as every other phase instead of
 * their old duplicated Sidebar/TopBar. Nothing is deleted and nothing is
 * redirected: existing URLs keep resolving, bookmarks/links/API-nav keep
 * working, and there is exactly ONE shell implementation in the app.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Shell workspace="trading">{children}</Shell>;
}