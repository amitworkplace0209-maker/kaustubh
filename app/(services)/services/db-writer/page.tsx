'use client';
/**
 * /services/db-writer — overview (engine controls + snapshot read).
 * One of FOUR distinct db-writer pages; each renders a different
 * _pages/db-writer/* file with its own data connection.
 */
import OriginalPage from '@/app/_pages/db-writer/page';

export default function ServicesDbWriterPage() {
  return <OriginalPage />;
}
