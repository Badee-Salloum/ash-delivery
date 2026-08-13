/**
 * What we ask a vision model for, and the shape we insist it answers in.
 *
 * Both are ported from `scripts/vision-bench.mjs`, which measured them over 48 real screens against
 * a hand-built 311-row answer key. Two things in here look like decoration and are not:
 *
 * 1. **`printed` and `value` are separate fields.** Transcription and arithmetic are different
 *    skills, and a model that reads «−١٬١٥٥٫٦٥» correctly can still hand back `-115565`. Keeping
 *    them apart lets us re-derive the number ourselves and notice the disagreement.
 * 2. **`value` is a STRING.** Declared as a number, constrained decoding cannot emit the trailing
 *    zero in «-165.50» — every `.50` and `.00` in the corpus would come back short by construction.
 *
 * The verification fields (`hasDecimal`, `hasThousands`, `digitCount`) are asked BEFORE the amount
 * on purpose: generation follows declaration order, so the model commits to "this has a fractional
 * part" before it writes the number. Asked afterwards it back-fills the evidence from its own
 * answer and the check becomes circular.
 *
 * Measured caveat, worth knowing before trusting it: when the decimal is dropped during READING
 * rather than during conversion, both fields agree and the cross-check stays silent. It catches a
 * conversion error, not a perception one. That is why the on-device reader stays as a second
 * opinion — it fails differently.
 */

import type { OcrField } from '@ash/contracts'

/** What each screen is, in the model's own terms. A reader told what it is looking at reads better. */
const FIELD_HINT: Record<OcrField, string> = {
  orders:
    'a RECENT ORDERS list. Each card is one delivery: an unsigned fee beside "SYP", a time, and one or two addresses.',
  payments_log:
    'a PAYMENTS LOG («سجل المدفوعات»). Every row is SIGNED — "+" is money arriving, "−" money leaving — and the sign is part of the answer.',
  wallet: 'a WALLET BALANCE screen. The balance is the figure to read; ignore any promotional numbers.',
  odometer:
    'a photograph of a physical bike dashboard behind glass, often with glare. There is NO money on it. Put the odometer reading in `fields` as label "odometer".',
  bms: 'a BMS battery-management app screenshot. There is NO money on it. Put the labelled values — percent, cycle count, volts — in `fields`.',
}

export function readPrompt(field: OcrField): string {
  return `You are transcribing a screenshot from a Damascus delivery company's driver app. Every number you read becomes money in a ledger that must balance to exactly zero, so a plausible guess is worse than an honest refusal.

This image is ${FIELD_HINT[field]}

For every money row, answer the verification fields FIRST and honestly, then the amount:

  hasDecimal    — does this amount have a FRACTIONAL PART? (a "٫" or "." followed by one or two digits at the end)
  hasThousands  — is a THOUSANDS mark printed? ("٬", "،" or ",")
  digitCount    — how many digit glyphs, excluding the sign and any separators?
  printed       — the amount EXACTLY as it appears. Same digits (Arabic-Indic ٠١٢٣٤٥٦٧٨٩ stay Arabic-Indic), same marks, same sign. Convert NOTHING here.
  value         — only here do you convert. Western digits, "." as the decimal point, sign kept, as a STRING.

٫ and ٬ are DIFFERENT characters and the difference is a factor of one hundred. ٫ is the decimal mark and is followed by one or two digits at the end. ٬ and ، are thousands marks and always leave groups of exactly three digits.

  «−١٬١٥٥٫٦٥»  →  printed "−١٬١٥٥٫٦٥", value "-1155.65", digitCount 6, hasDecimal true, hasThousands true
  NOT "-115565". This single error is the reason this prompt is written the way it is.

Other rules, each of which corresponds to a real screen:

- A CANCELLED order ("Cancelled" / "تم إلغاؤه") has NO amount: \`value\` null, \`cancelled\` true, \`digitCount\` 0. Never copy a number from a neighbouring row.
- A card SLICED by the top or bottom edge may show its addresses but not its fee: \`value\` null, and say so in \`notes\`.
- A screen may carry MORE THAN ONE date header ("Friday, August 7" … then lower down "Thursday, August 6"). Each row takes the nearest header ABOVE it. Month names may be Arabic (أغسطس, آب), Maghrebi (غشت) or English. The year is 2026.
- Times: Arabic "م" is PM, "ص" is AM. Report 24-hour HH:MM. Some screens already print 24-hour times.
- Addresses contain digits — "المدخل ١", "entrance ٨٦", GPS pairs, plus-codes like "G63V 78J". Those are NOT fees. Only the amount printed beside "SYP" is a fee.
- If a character is genuinely unreadable, put "?" in \`printed\` and null in \`value\`. An honest refusal is a correct answer.

Rows go in \`rows\`, in the order they appear top to bottom. Labelled non-money values go in \`fields\`. A screen with no money rows has \`rows: []\`.`
}

/**
 * OpenAI's strict dialect, written out rather than translated at runtime.
 *
 * `strict: true` refuses a schema unless EVERY property appears in `required` and every object sets
 * `additionalProperties: false`, and it has no `nullable` — an optional value is a type union.
 */
export const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'fields', 'notes'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['hasDecimal', 'hasThousands', 'digitCount', 'printed', 'value', 'cancelled'],
        properties: {
          hasDecimal: {
            type: 'boolean',
            description: 'true iff this amount has a FRACTIONAL PART — ٫ (U+066B) or "." followed by one or two digits at the end',
          },
          hasThousands: {
            type: 'boolean',
            description: 'true iff a THOUSANDS mark is printed: ٬ (U+066C), ، (U+060C) or ","',
          },
          digitCount: {
            type: 'integer',
            description: 'how many DIGIT glyphs the amount has, ignoring sign and separators',
          },
          printed: {
            type: 'string',
            description: 'the amount EXACTLY as printed: same digits, same marks, same sign. Never converted.',
          },
          value: {
            type: ['string', 'null'],
            description: 'STRING, never a number. Western digits, "." decimal, sign kept. "-165.50" keeps its trailing zero. null if the row has no amount.',
          },
          cancelled: { type: 'boolean' },
        },
      },
    },
    fields: {
      type: 'array',
      description: 'odometer / BMS screens only — labelled values that are not money',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value'],
        properties: { label: { type: 'string' }, value: { type: ['string', 'null'] } },
      },
    },
    notes: { type: ['string', 'null'] },
  },
} as const
