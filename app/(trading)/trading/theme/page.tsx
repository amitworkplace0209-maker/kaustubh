'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** /trading/theme no longer has its own sidebar entry — the Theme studio now
 *  lives inside /trading/settings. This redirect keeps old bookmarks working. */
export default function TradingThemePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/trading/settings');
  }, [router]);
  return null;
}
