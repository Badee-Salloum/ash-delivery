import type { ReactNode } from 'react'

/**
 * The console's icon vocabulary — a reviewed list, drawn in the repo.
 *
 * NOT an icon library. `apps/admin` has three runtime dependencies and its vite config says charts
 * must be lazy-loaded per route; pulling a package in to draw sixteen glyphs would be the wrong
 * trade for a console served to one branch. Twenty paths cost less than the dependency.
 *
 * Keeping them in one allowlisted map is the point: the set stays small, nothing drifts in, and if
 * this ever should become a library it changes here and at no call site.
 *
 * Every icon is decorative. Each sits beside a real text label — the nav item, the button — so it
 * is `aria-hidden` and is never the accessible name of anything. An icon-only control would need
 * its own `aria-label`, which is the call site's job, not this component's.
 */

const PATHS: Record<string, ReactNode> = {
  // ── navigation ────────────────────────────────────────────────────────────
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </>
  ),
  queue: (
    <>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>
  ),
  live: (
    <>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </>
  ),
  completed: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-6" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <path d="M9 15l2 2 4-4" />
    </>
  ),
  map: (
    <>
      <path d="M9 3L3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" />
      <path d="M9 3v15M15 6v15" />
    </>
  ),
  bike: (
    <>
      <circle cx="6" cy="17" r="3" />
      <circle cx="18" cy="17" r="3" />
      <path d="M6 17L10 7h4l3 10M9 7h6" />
    </>
  ),
  hash: (
    <>
      <path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" />
    </>
  ),
  treasury: (
    <>
      <path d="M3 21h18M4 21V10l8-6 8 6v11" />
      <path d="M9 21v-6h6v6" />
    </>
  ),
  expenses: (
    <>
      <path d="M4 3h16v18l-3-2-2 2-3-2-3 2-2-2-3 2z" />
      <path d="M8 8h8M8 12h8M8 16h4" />
    </>
  ),
  checkin: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  accounts: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 21v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1" />
      <path d="M17 11h4M19 9v4" />
    </>
  ),
  audit: (
    <>
      <path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v6h6M9 13h6M9 17h4" />
    </>
  ),
  removals: (
    <>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  permissions: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),

  // ── chrome ────────────────────────────────────────────────────────────────
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  logout: (
    <>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="M10 17l-5-5 5-5M5 12h12" />
    </>
  ),
  language: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18-2.5-2.7-2.5-15.3 0-18z" />
    </>
  ),
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      {PATHS[name]}
    </svg>
  )
}
