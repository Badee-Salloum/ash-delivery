export type EndReviewWarningKey = 'moneyMismatch' | 'batteryIncomplete'

/**
 * Facts that do not prevent the driver handing the shift to the manager.
 *
 * They remain explicit warnings: the manager must settle a money difference and must supply any
 * deferred battery reading before ordinary approval. Keeping this pure prevents the submit button
 * and the warning card from drifting into different rules.
 */
export function endReviewWarningKeys(input: {
  difference: 'balanced' | 'surplus' | 'shortage' | null
  batteriesReady: boolean
}): EndReviewWarningKey[] {
  const warnings: EndReviewWarningKey[] = []
  if (input.difference !== null && input.difference !== 'balanced') warnings.push('moneyMismatch')
  if (!input.batteriesReady) warnings.push('batteryIncomplete')
  return warnings
}
