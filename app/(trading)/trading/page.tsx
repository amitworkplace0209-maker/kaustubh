import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** /trading has no page of its own — the Trading group opens on Trade. */
export default function TradingRootPage() {
  redirect('/trading/trade');
}
