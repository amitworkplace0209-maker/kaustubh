'use client';

import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ChevronDown } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Production error boundary — a component crash must NEVER turn the whole
 * screen black. Instead we render a controlled "temporarily unavailable"
 * recovery UI with the real reason, a Retry, and inspectable technical details.
 *
 * The error is logged with timestamp, current route, component, message and
 * stack. No environment secrets are ever rendered or logged.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    const payload = {
      timestamp: new Date().toISOString(),
      route: typeof window !== 'undefined' ? window.location.pathname : '(ssr)',
      component: 'ErrorBoundary',
      message: error?.message ?? 'Unknown error',
      componentStack: errorInfo?.componentStack ?? null,
      stack: error?.stack ?? null,
    };
    console.error('[ErrorBoundary] caught error', payload);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const err = this.state.error;
      const cls = classifyError(err);
      const frontend = cls === 'render';
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#060a08] p-4">
          <div className="w-full max-w-lg">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-6">
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-red-500/10 border border-red-500/20">
                  <AlertTriangle className="h-5 w-5 text-red-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-bold text-white">
                    {frontend ? 'UI rendering error' : 'Service temporarily unavailable'}
                  </h2>
                  <p className="mt-1 text-sm text-white/40 break-words">
                    {frontend
                      ? 'Unable to render this section.'
                      : 'The upstream service is currently unreachable — this is not a UI bug.'}
                  </p>
                  <p className="mt-1 text-[12px] font-medium text-amber-300/90">
                    Technical detail: {err?.message || 'An unexpected runtime error occurred.'}
                  </p>
                  <p className="mt-1 text-[11px] text-white/30">
                    {typeof window !== 'undefined'
                      ? new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' · ' + window.location.pathname
                      : 'rendering'}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => this.setState({ hasError: false, error: null })}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.06] border border-white/[0.1] text-white text-sm font-medium hover:bg-white/[0.1] transition-colors"
                    >
                      <RefreshCw className="h-4 w-4" /> Retry
                    </button>
                  </div>

                  <details className="mt-4 rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2">
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40 hover:text-white/70">
                      Technical details <ChevronDown className="h-3 w-3" />
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[10px] leading-relaxed text-white/40">
                      {err?.stack || err?.message || 'No stack available'}
                    </pre>
                  </details>

                  <p className="mt-4 text-[11px] leading-relaxed text-white/30">
                    The rest of the application is unaffected. If this keeps
                    happening, check the browser console for the logged error and
                    the backend logs.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

type ErrorClass = 'render' | 'service';

/**
 * Distinguish a frontend render bug (ReferenceError/TypeError/etc.) from an
 * upstream service/network failure so the recovery UI never claims the
 * backend is down when it is actually a UI defect.
 */
function classifyError(error: Error | null): ErrorClass {
  const name = error?.name ?? '';
  const msg = error?.message ?? '';
  if (/^(ReferenceError|TypeError|RangeError|SyntaxError|URIError|EvaluationError|RuntimeError)$/.test(name)) {
    return 'render';
  }
  if (/is not defined|Cannot read|Cannot destructure|Cannot redefine|is not a function|is not iterable|Invalid (HTML|Date|Number)|hydration/i.test(`${msg} ${name}`)) {
    return 'render';
  }
  if (/fetch|network|econn|ECONN|abort|timed out|timeout|50[0-9]|unavailable|failed to parse|unexpected token/i.test(msg)) {
    return 'service';
  }
  return 'render';
}
