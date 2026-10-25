'use client';

export function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <div className="h-4 w-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        Loading...
      </div>
    </div>
  );
}