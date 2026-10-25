import { Shell } from '@/components/layout/shell';

export default function TradingLayout({ children }: { children: React.ReactNode }) {
  return <Shell workspace="trading">{children}</Shell>;
}