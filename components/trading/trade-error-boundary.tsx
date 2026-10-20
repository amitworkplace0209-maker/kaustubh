'use client';

import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw, Home, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface TradeErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class TradeErrorBoundary extends Component<
  { children?: ReactNode; fallback?: ReactNode },
  TradeErrorBoundaryState
> {
  state: TradeErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  static getDerivedStateFromError(error: Error): Partial<TradeErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ error, errorInfo });
    console.error('[TradePage] Error caught:', error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  private handleHome = () => {
    if (typeof window !== 'undefined') {
      window.location.href = '/trading/dashboard';
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const error = this.state.error;
      const isNetworkError = error?.message?.includes('network') || 
                             error?.message?.includes('fetch') ||
                             error?.message?.includes('timeout');

      return (
        <div className="flex min-h-[60vh] items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardContent className="pt-6 pb-8 px-6 text-center">
              <div className={cn('mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full', isNetworkError ? 'bg-warning/10 text-warning' : 'bg-destructive/10 text-destructive')}>
                <AlertCircle className="h-8 w-8" />
              </div>
              
              <h2 className="mb-2 text-lg font-bold">Something went wrong</h2>
              
              <p className="mb-4 text-sm text-muted-foreground">
                {isNetworkError 
                  ? 'Unable to connect to the trading engine. Please check your connection and try again.'
                  : 'The trading page encountered an unexpected error. Your session and orders are safe.'
                }
              </p>

              {process.env.NODE_ENV === 'development' && error && (
                <details className="mb-4 text-left text-xs text-muted-foreground">
                  <summary className="cursor-pointer mb-1">Error details</summary>
                  <pre className="whitespace-pre-wrap break-words rounded bg-muted p-2">{error.message}</pre>
                  {this.state.errorInfo?.componentStack && (
                    <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted p-2">{this.state.errorInfo.componentStack}</pre>
                  )}
                </details>
              )}

              <div className="flex gap-2 justify-center">
                <Button 
                  onClick={this.handleRetry} 
                  className="flex-1"
                  size="lg"
                >
                  <RefreshCw className="mr-2 h-4 w-4" /> Try Again
                </Button>
                <Button 
                  variant="outline" 
                  onClick={this.handleHome} 
                  className="flex-1"
                  size="lg"
                >
                  <Home className="mr-2 h-4 w-4" /> Dashboard
                </Button>
              </div>

              <Button 
                variant="ghost" 
                onClick={() => window.location.reload()} 
                className="mt-3 w-full text-xs text-muted-foreground hover:text-foreground"
              >
                <Wrench className="mr-1 h-3 w-3 inline" /> Full Page Reload
              </Button>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

export function TradeErrorFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
  return (
    <TradeErrorBoundary fallback={
      <div className="flex min-h-[60vh] items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 pb-8 px-6 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertCircle className="h-8 w-8" />
            </div>
            <h2 className="mb-2 text-lg font-bold">Trading Page Error</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              {error.message || 'An unexpected error occurred'}
            </p>
            <Button onClick={resetErrorBoundary} size="lg" className="w-full">
              <RefreshCw className="mr-2 h-4 w-4" /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    }>
    </TradeErrorBoundary>
  );
}