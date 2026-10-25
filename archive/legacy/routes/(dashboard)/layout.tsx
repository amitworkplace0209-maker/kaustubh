import { Sidebar, TopBar } from '@/components/sidebar';
import { Toaster } from '@/components/ui/toaster';
import { SettingsBootstrap } from '@/components/settings-bootstrap';
import { SystemProvider } from '@/components/system-provider';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SettingsBootstrap>
      <SystemProvider>
        <div className="flex h-screen flex-col">
          <TopBar />
          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            <main className="flex-1 overflow-auto p-3 pb-20 md:p-6 md:pb-6">
              {children}
            </main>
          </div>
          <Toaster />
        </div>
      </SystemProvider>
    </SettingsBootstrap>
  );
}
