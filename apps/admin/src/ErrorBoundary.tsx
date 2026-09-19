import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * The last thing between a thrown render and a white screen.
 *
 * React unmounts the entire tree when a render throws, and an app with nothing to catch that shows
 * the user a blank page — no message, no reload, no clue. That is what happened to the approval
 * screen: one `useState` declared below an early return threw #310 the moment a shift's data
 * arrived, and a branch manager standing at the counter with a driver waiting saw white.
 *
 * A blank page is the worst possible failure here precisely because it is silent. It looks like a
 * slow network, so the manager reloads, gets white again, and has no way to tell anyone what broke.
 * This turns that into a page that says something is wrong, offers the way out, and — critically —
 * prints the actual error, so the next report arrives with a cause attached instead of "it's white".
 *
 * Deliberately NOT a place to retry or "recover": a screen that moves money and has just thrown is
 * a screen whose state cannot be trusted. The only offer is a full reload.
 *
 * It carries no `useApp()` — the provider may be the very thing that threw — so its text is bilingual
 * literals rather than catalogue keys. This is the one screen that cannot afford a dependency.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keeps the component stack in the console for whoever opens devtools next.
    // eslint-disable-next-line no-console
    console.error('[ash] render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-100 p-6" dir="rtl">
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-surface-card p-5 shadow-sm">
          <h1 className="text-lg font-bold text-red-700">حدث خطأ في العرض</h1>
          <p className="mt-2 text-sm text-slate-600">
            تعذّر عرض هذه الشاشة. لم يُحفظ أي تغيير ولم تتأثر أي بيانات. أعد تحميل الصفحة، وإذا تكرر
            الخطأ أرسل النص التالي إلى الدعم.
          </p>
          <p className="mt-1 text-sm text-slate-500" dir="ltr">
            Something went wrong rendering this screen. Nothing was saved and no data was changed.
          </p>
          <pre
            dir="ltr"
            className="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-700"
          >
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-brand px-4 text-sm font-semibold text-on-brand"
          >
            إعادة التحميل · Reload
          </button>
        </div>
      </div>
    )
  }
}
