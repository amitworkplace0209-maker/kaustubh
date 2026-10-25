'use client';
/**
 * /services/db-writer/overview — DB Writer Overview (engine controls, WS#2).
 * One of FOUR distinct db-writer pages; each renders a different
 * _pages/db-writer/* file with its own data connection.
 */
import OverviewPage from '@/app/_pages/db-writer/page';

export default function DbWriterOverviewRoute() {
  return <OverviewPage />;
}
