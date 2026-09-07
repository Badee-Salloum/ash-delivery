import { Component, type ErrorInfo, type ReactNode } from 'react'
import { hardReset } from './boot.ts'

/**
 * The last thing between a thrown render and the «ASH» splash forever.
 *
 * The driver app had none. React unmounts the whole tree when a render throws, `#root` goes back to
 * empty — and `index.html`'s `#root:empty::after` paints the splash again. So every crash looked
 * exactly like a slow connection: a driver at the branch at 01:42 staring at a logo, reloading,
 * getting the logo, with nothing to read and nobody able to say what broke.
 *
 * The admin app learned this from React #310 on the approval screen. The driver's version differs in
 * one way that matters: a plain reload can hand him THE SAME broken bundle back, because a service
 * worker is serving it. So the way out here clears the worker and its caches first.
 *
 * It carries no `useApp()` — the provider may be the very thing that threw — so its text is literal
 * rather than catalogue keys. This is the one screen that cannot afford a dependency.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ash] render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-100 p-6" dir="rtl">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-surface-card p-5 shadow-sm">
          <h1 className="text-lg font-bold text-red-700">تعذّر فتح التطبيق</h1>
          <p className="mt-2 text-sm text-slate-600">
            حدث خطأ أثناء العرض. لم تتأثر أي بيانات ولم يُفقد أي شيء رفعته. اضغط الزر بالأسفل لإعادة
            تحميل نسخة نظيفة، وإذا تكرر الخطأ أرسل النص التالي إلى مدير الفرع.
          </p>
          <pre dir="ltr" className="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => void hardReset()}
            className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-slate-800 px-4 text-sm font-semibold text-white"
          >
            إعادة التحميل من جديد
          </button>
        </div>
      </div>
    )
  }
}
