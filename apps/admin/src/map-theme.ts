/**
 * Leaflet paints SVG paths itself, outside Tailwind utility generation. Read the same semantic
 * tokens the rest of the app uses at draw time so a map never becomes a light-mode island.
 */
export interface LeafletPaint {
  color: string
  fillColor: string
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function leafletFreshnessPaints(): Record<'fresh' | 'recent' | 'stale', LeafletPaint> {
  return {
    fresh: { color: token('--ash-map-fresh-stroke'), fillColor: token('--ash-map-fresh-fill') },
    recent: { color: token('--ash-map-recent-stroke'), fillColor: token('--ash-map-recent-fill') },
    stale: { color: token('--ash-map-stale-stroke'), fillColor: token('--ash-map-stale-fill') },
  }
}

export function leafletBranchPaint(): LeafletPaint {
  return {
    color: token('--ash-map-branch-stroke'),
    fillColor: token('--ash-map-branch-fill'),
  }
}

/** The recorded-path colours: the full trail, a selected order's segment, and the two endpoints. */
export function leafletPathPaints(): { path: string; segment: string; start: string; end: string } {
  return {
    path: token('--ash-map-path-stroke'),
    segment: token('--ash-map-segment-stroke'),
    start: token('--ash-map-start-fill'),
    end: token('--ash-map-end-fill'),
  }
}
