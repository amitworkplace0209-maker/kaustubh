import { Shell } from '@/components/layout/shell';

export default function ServicesLayout({ children }: { children: React.ReactNode }) {
  return <Shell workspace="services">{children}</Shell>;
}