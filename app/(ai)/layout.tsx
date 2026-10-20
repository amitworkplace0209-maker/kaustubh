import { Shell } from '@/components/layout/shell';

export default function AiLayout({ children }: { children: React.ReactNode }) {
  return <Shell workspace="khumbha-ai">{children}</Shell>;
}