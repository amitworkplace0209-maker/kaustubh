import { Suspense } from 'react';
import { WorkspaceProvider } from '@/components/workspace-provider';
import { WorkspaceSidebar } from '@/components/workspace-sidebar';
import { WorkspaceTopBar } from '@/components/workspace-topbar';
import { SystemProvider } from '@/components/system-provider';
import { Toaster } from '@/components/ui/toaster';
import { SettingsBootstrap } from '@/components/settings-bootstrap';

export default function DataLayout({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceProvider>
      <SettingsBootstrap>
        <SystemProvider>
          <div className="ws-data flex h-screen flex-col">
            <WorkspaceTopBar />
            <div className="flex flex-1 overflow-hidden">
              <WorkspaceSidebar />
              <main className="flex-1 overflow-auto p-3 pb-20 md:p-6 md:pb-6">
                <Suspense fallback={<LoadingFallback />}>
                  {children}
                </Suspense>
              </main>
            </div>
            <Toaster />
          </div>
        </SystemProvider>
      </SettingsBootstrap>
    </WorkspaceProvider>
  );
}

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="flex items-center gap-2 text-white/40 text-sm">
        <div className="h-4 w-4 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin" />
        Loading...
      </div>
    </div>
  );
}
