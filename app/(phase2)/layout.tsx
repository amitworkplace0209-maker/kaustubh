import { Shell } from '@/components/layout/shell';
import { DataSaverProvider } from '@/components/phase2/data-saver-provider';

export default function Phase2Layout({ children }: { children: React.ReactNode }) {
  return (
    <DataSaverProvider>
      <Shell workspace="data-saver">{children}</Shell>
    </DataSaverProvider>
  );
}
