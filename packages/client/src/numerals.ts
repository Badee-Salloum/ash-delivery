/** Turn the decimal digits used by Arabic and Persian keyboards into ASCII digits. */
export function normalizeDecimalDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0)
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660)
  })
}

/** Parse a whole, non-negative reading without accepting partial or unsafe numbers. */
export function parseNonNegativeInteger(value: string): number | null {
  const normalized = normalizeDecimalDigits(value).trim()
  if (!/^\d+$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Read an odometer value from the cloud reader's labelled fields.
 *
 * The provider sometimes includes a label/unit in the value (for example `ODO ٠٢٦١١ km`), so
 * this intentionally extracts decimal digits after normalising both Arabic digit blocks.
 */
export function odometerFromCloudFields(fields: Readonly<Record<string, string | null>>): number | null {
  for (const [label, value] of Object.entries(fields)) {
    if (value === null || !['odometer', 'odo', 'km', 'mileage'].includes(label.trim().toLowerCase())) continue
    const digits = normalizeDecimalDigits(value).replace(/[^0-9]/g, '')
    if (digits === '') continue
    const parsed = Number(digits)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return null
}
