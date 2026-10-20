'use client';

import { Component, ReactNode } from 'react';

interface SafeRegionProps {
  label: string;
  children: ReactNode;
  resetKey?: unknown;
}

interface SafeRegionState {
  error: Error | null;
}

export class SafeRegion extends Component<SafeRegionProps, SafeRegionState> {
  state: SafeRegionState = { error: null };

  static getDerivedStateFromError(error: Error): SafeRegionState {
    return { error };
  }

  componentDidCatch(error: Error, info: any) {
    console.error(`[SafeRegion/${this.props.label}]`, error, info);
  }

  componentDidUpdate(prevProps: SafeRegionProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-destructive/30 bg-destructive/[0.06] p-3 text-xs text-destructive">
          <p className="font-bold">{this.props.label} could not render.</p>
          <p className="mt-0.5 break-words text-[11px] text-destructive/90">
            {this.state.error.message || 'Unknown error'}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Nothing was sent to the exchange. Retry, or pick the stock again.
          </p>
          <button type="button" onClick={this.retry} className="mt-2 rounded-lg border border-destructive/40 bg-card px-3 py-1.5 text-[11px] font-bold text-destructive hover:bg-destructive/10">
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}