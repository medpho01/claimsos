import React from 'react';

/**
 * Top-level ErrorBoundary.
 *
 * Frontend review M16: the app has no error boundary at any level. A
 * single render error in PublicHospitalProfile.tsx (1026 lines), one
 * of the AttributesManager/PanelsManager mega-components, or any
 * deferred Suspense chunk will crash the entire route and leave the
 * user looking at a blank page.
 *
 * Wrap the root in this boundary. It catches React render errors,
 * logs them (will be picked up by a future Sentry/Bugsnag wire-up),
 * and renders a tidy fallback with a "Reload" CTA. For dev, the
 * error message is shown so the cause is obvious.
 *
 * NOTE: this catches RENDER errors only. Event-handler errors and
 * async errors still need toast/try-catch handling at the call site.
 */
interface State {
  hasError: boolean;
  error?: Error;
  componentStack?: string;
  copied?: boolean;
}

interface Props {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] Render error:', error, info);
    // Surface the component stack in the fallback so the field/support team
    // can capture the cause WITHOUT a DevTools session or a call.
    this.setState({ componentStack: info?.componentStack ?? undefined });
    // Hook for future Sentry/Bugsnag wiring.
  }

  /** Everything support needs in one copy: message, stack, where, when. */
  private details(): string {
    const e = this.state.error;
    return [
      `Error: ${e?.name ?? 'Error'}: ${e?.message ?? 'unknown'}`,
      `URL: ${typeof window !== 'undefined' ? window.location.href : '—'}`,
      `Time: ${new Date().toISOString()}`,
      `UA: ${typeof navigator !== 'undefined' ? navigator.userAgent : '—'}`,
      '',
      'Stack:',
      e?.stack ?? '(no stack)',
      '',
      'Component stack:',
      this.state.componentStack ?? '(no component stack)',
    ].join('\n');
  }

  handleCopy = () => {
    try {
      navigator.clipboard?.writeText(this.details());
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      /* clipboard unavailable — the user can still select the text manually */
    }
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-6">
          <div className="max-w-lg w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 shadow-sm">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-2">
              Something went wrong
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
              The page hit an unexpected error. Reloading usually fixes it. If
              the problem persists, please share the details below with support.
            </p>

            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={this.handleReload}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white"
              >
                Reload page
              </button>
              <button
                onClick={this.handleCopy}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-md text-sm font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {this.state.copied ? 'Copied ✓' : 'Copy error details'}
              </button>
            </div>

            {/* Always available (incl. production) so the field team can
                capture the real cause without DevTools. Collapsed by default
                so normal users aren't shown a wall of text. */}
            {this.state.error && (
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 dark:text-slate-400 select-none">
                  Technical details
                </summary>
                <pre className="mt-2 bg-slate-100 dark:bg-slate-800 text-danger-700 dark:text-danger-300 p-2 rounded overflow-auto max-h-60 whitespace-pre-wrap">
                  {this.details()}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
