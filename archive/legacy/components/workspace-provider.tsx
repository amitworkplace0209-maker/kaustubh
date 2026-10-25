'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getWorkspaceByPath, type WorkspaceId } from '@/lib/workspace-nav';

interface WorkspaceContextValue {
  workspace: WorkspaceId;
  setWorkspace: (id: WorkspaceId) => void;
  switchWorkspace: (id: WorkspaceId) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspace: 'trading',
  setWorkspace: () => {},
  switchWorkspace: () => {},
});

export function useWorkspace() {
  return useContext(WorkspaceContext);
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [workspace, setWorkspace] = useState<WorkspaceId>('trading');

  // Sync workspace from URL
  useEffect(() => {
    const detected = getWorkspaceByPath(pathname);
    setWorkspace(detected);
  }, [pathname]);

  const switchWorkspace = useCallback((id: WorkspaceId) => {
    setWorkspace(id);
    // Navigate to the default page of the workspace
    const defaultRoutes: Record<WorkspaceId, string> = {
      trading: '/trading/dashboard',
      data: '/data-saver/dashboard',
      services: '/services/system',
      ai: '/ai/dashboard',
    };
    router.push(defaultRoutes[id]);
  }, [router]);

  return (
    <WorkspaceContext.Provider value={{ workspace, setWorkspace, switchWorkspace }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
