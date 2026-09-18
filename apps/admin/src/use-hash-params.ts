import { createContext, useContext } from 'react'
import { type RouteParams, type Section, formatHash } from './route.ts'

/**
 * Keeping a screen's filters in the URL without making every change a history step (P2).
 *
 * A manager narrowing a list clicks five checkboxes; five Back presses to leave the screen would
 * be absurd. So filter changes REPLACE the current entry (`history.replaceState`, which also fires
 * no `hashchange`), while navigation — the rail, a drill-down link, opening a shift — still pushes.
 *
 * The shell is told about every replacement, so closing a shift overlay restores the filtered
 * hash rather than the one the screen was opened with.
 */

export interface HashWriter {
  readonly location: { readonly hash: string }
  readonly history: { readonly state: unknown; replaceState(data: unknown, unused: string, url?: string | null): void }
}

/**
 * Write `section` + `params` into the current history entry. Returns whether the URL changed.
 * Never throws: a browser that refuses `replaceState` (a sandboxed frame) simply keeps its URL.
 */
export function replaceHashParams(section: Section, params: RouteParams, target: HashWriter): boolean {
  const next = `#${formatHash({ section, openShift: null, params })}`
  if (target.location.hash === next) return false
  try {
    target.history.replaceState(target.history.state, '', next)
    return true
  } catch {
    return false
  }
}

/** What the shell hands a filtered screen: «these are my filters now». */
export type ReplaceParams = (params: RouteParams) => void

export const HashParamsContext = createContext<ReplaceParams>(() => undefined)

/** The writer for the screen currently mounted by the shell. Outside the shell it does nothing. */
export function useHashParams(): ReplaceParams {
  return useContext(HashParamsContext)
}
