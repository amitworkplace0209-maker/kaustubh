'use client';

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * Last-resort render guard for the real-time scanner page. If any subtree
 * throws (e.g. an unexpected shape from the live stream), the user sees a
 * contained "reload" card instead of a blank window. Retrying resets state.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: unknown): State {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : 'Unexpected error',
    };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error('[Market Watch] render error:', error);
  }

  private reset = () => this.setState({ hasError: false, message: '' });

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-6 text-center">
          <p className="text-sm font-semibold text-destructive">
            {this.props.fallbackTitle ?? 'Market Watch hit an unexpected error'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{this.state.message}</p>
          <button
            type="button"
            onClick={this.reset}
            className="mt-3 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted/40 transition-colors"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}