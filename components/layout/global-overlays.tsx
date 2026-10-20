'use client';

import { Toaster } from '@/components/ui/toaster';

/** Global overlays that live outside the phase shell (toasts, etc.). */
export function GlobalOverlays() {
  return <Toaster />;
}