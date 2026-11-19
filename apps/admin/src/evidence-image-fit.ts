/** Fit the whole photo before applying deliberate zoom; never stretch its aspect ratio. */
export function evidenceImageSize(width: number, height: number, availableWidth: number, availableHeight: number, zoom = 1): { width: number; height: number } | null {
  if (![width, height, availableWidth, availableHeight, zoom].every(n => Number.isFinite(n) && n > 0)) return null
  const fit = Math.min(availableWidth / width, availableHeight / height, 1)
  return { width: width * fit * zoom, height: height * fit * zoom }
}
