/** Known transient database failures; validation/permission/integrity errors stay distinct. */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (typeof code === 'string' && (/^08/.test(code) || ['55P03', '57014', '25P03', '53300', '57P01'].includes(code))) return true
  return typeof message === 'string' && (
    message === 'timeout exceeded when trying to connect' ||
    message === 'Connection terminated due to connection timeout'
  )
}
