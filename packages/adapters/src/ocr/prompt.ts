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
    'a RECENT ORDERS list. Each card is one delivery: a signed fee beside "SYP", a time, and one or two addresses. A negative fee is a cash deduction and its minus sign must be preserved.',
  payments_log:
    'a PAYMENTS LOG («سجل المدفوعات»). Every row is SIGNED — "+" is money arriving, "−" money leaving — and the sign is part of the answer.',
  wallet:
    'a Yallago WALLET BALANCE screen. Read the ONE large white balance near the top of the orange wallet card; ' +
    'ignore the phone status bar, dates, buttons, payment-log rows and promotional numbers.\n\n' +
    'This screen uses Arabic-Indic digits. Inspect EACH glyph rather than guessing a plausible balance. ' +
    'In particular, do not confuse the leading ٢ (two) with ٣ (three): ٣ has two adjacent upper teeth/curves, ' +
    'while ٢ has one leading hook/stroke. A live incident mistook a leading ٢ for ٣. Compare the ' +
    'first glyph explicitly before answering, without assuming either one. The currency suffix «SYP» is not ' +
    'part of the number.',
  /*
   * «للعداد هو دائماً آخر رقم» — the owner's own rule about this dashboard, and the only reliable
   * one there is.
   *
   * A bike dash shows several numbers at once: a clock, a trip meter, a voltage, a speed, a gear
   * or «P». Nothing on the glass labels which is the odometer, so every reader has had to guess —
   * and both guessed badly. The on-device one takes the LARGEST number, which migration 0022
   * records getting wrong three times out of three (200 for 6948, 229 for 5426, one refusal). The
   * cloud, told only "the odometer reading", returned 8 off a dash whose odometer was 7034.
   *
   * Position is what actually identifies it on this hardware. That is not something a model can
   * work out from one photograph, and not something we could infer without being told.
   */
  odometer:
    'a photograph of a physical bike dashboard behind glass, often with glare.\n\n' +
    'There is NO money on it. Report ONE value, in `fields` under the key "odometer".\n\n' +
    'THE ODOMETER IS ALWAYS THE LAST NUMBER ON THE DISPLAY — the final one in reading order, ' +
    'lowest and last. This is a fact about this particular dashboard, not a guess to be revised: ' +
    'do NOT choose the largest number, the most central, or the one that looks most like a ' +
    'mileage. If the screen shows a clock, a gear letter such as «P», a speed, a voltage, a ' +
    'temperature and then a number, it is that LAST number and none of the others.\n\n' +
    'Give the digits only, dropping any «km» or «ODO» printed beside it, and keeping leading ' +
    'zeros out («02161 km» is 2161). If the last number is genuinely unreadable through glare, ' +
    'omit `odometer` entirely rather than offering the second-to-last.',
  /*
   * THE KEYS ARE PINNED, and this is not stylistic.
   *
   * Asked merely for "the labelled values", the model returned the app's OWN labels verbatim —
   * «Remain Battery» and «Cycle Count» on the English pack, «الطاقة المتبقية» and «الدورات» on the
   * Arabic one. Both are faithful transcriptions and both were useless: the driver app looks up
   * `percent` and `cycles`, found neither, and filled nothing. Two live reads cost money and ten
   * seconds of a driver's time to populate zero fields.
   *
   * `Remain Capacity` is the trap this also has to dodge — it reads «50.0Ah», which cleans to a
   * perfectly plausible «50» and would silently become a 50% charge on a pack that is full.
   */
  bms:
    'a BMS battery-management app screenshot, in English or in Arabic. There is NO money on it.\n\n' +
    'In `fields` you MUST use these exact keys, wherever the screen shows the value:\n' +
    '  percent  — the REMAINING CHARGE as a percentage. Printed «Remain Battery», «Battery Level», «SOC», or «الطاقة المتبقية». Give the number only, without the % sign.\n' +
    '  cycles   — the cycle count. Printed «Cycle Count», «Cycles», or «الدورات».\n' +
    '  voltage  — total pack voltage. Printed «Battery Voltage», «Total Voltage», or «إجمالي الجهد».\n\n' +
    'Do NOT put a capacity in Ah («Remain Capacity», «Battery Capacity», «السعة») under `percent` — ' +
    'a 50.0Ah capacity is not a 50% charge. If the percentage is not shown, omit `percent` entirely.\n\n' +
    'Anything else readable may be added under its own printed label.',
}

export function readPrompt(field: OcrField): string {
  const timeRule = field === 'orders'
    ? '- On every ORDERS card, `time` is the time EXACTLY AS PRINTED, including the original Arabic-Indic or Western digits and the printed `ص` / `م` / AM / PM marker. Convert NOTHING and do not infer 24-hour time. If any time glyph is unreadable, return null.'
    : '- Times: Arabic "م" is PM, "ص" is AM. Report 24-hour HH:MM. Some screens already print 24-hour times.'
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
${timeRule}
- On the ORDERS list each card shows two address lines, A (pickup) then B (dropoff). Copy each into \`pointA\` / \`pointB\` exactly as printed. On every other screen both are null.
- Addresses contain digits — "المدخل ١", "entrance ٨٦", GPS pairs, plus-codes like "G63V 78J". Those are NOT fees. Only the amount printed beside "SYP" is a fee.
- If a character is genuinely unreadable, put "?" in \`printed\` and null in \`value\`. An honest refusal is a correct answer.

Rows go in \`rows\`, in the order they appear top to bottom. Labelled non-money values go in \`fields\`. A screen with no money rows has \`rows: []\`.`
}

/**
 * The financially authoritative orders pass.
 *
 * Route transcription is deliberately excluded. A long address, coordinate pair or Plus Code can
 * make the full orders completion spend most of its budget on text that does not affect the fee.
 * This pass stays small enough to return the fee/date/time rows even when the independent route
 * pass times out. The shared row shape is retained so the result can flow through `parsedResult`.
 */
export function ordersMoneyReadPrompt(): string {
  return `ORDERS MONEY/TIME/DATE FAST PASS

Read a RECENT ORDERS screenshot from a Damascus delivery app. Return one row per visible order card,
top to bottom. This pass is financially authoritative: read only the fee printed beside "SYP", the
card time, and the nearest date header ABOVE the card.

Do NOT transcribe, copy, translate, or reason about pickup/dropoff addresses, business names,
coordinates, phone numbers, entrance numbers, or Plus Codes. They are irrelevant here. Set
\`pointA\` and \`pointB\` to null on EVERY row.

For each fee:
- \`hasDecimal\`: true only for a final fractional separator ("٫" or ".") plus one or two digits.
- \`hasThousands\`: true only when a thousands separator ("٬", "،", or ",") is printed.
- \`digitCount\`: count digit glyphs only, excluding signs and separators.
- \`printed\`: copy the fee exactly as printed, preserving Arabic-Indic digits and separators.
- \`value\`: convert only the fee to Western digits with "." as decimal, as a STRING.

A fee can be negative. Preserve a printed minus sign exactly in \`printed\` and at the beginning of
\`value\`; a negative Recent Orders fee is a cash deduction, not a cancelled card.

Before returning a row, compare value digit by digit with printed. They must describe the same
amount; if visible glyphs do not support the conversion, preserve printed and set value to null.

Only a number beside "SYP" is a fee. Never use a number from an address, coordinate, phone status
bar, date header, or time. A cancelled card has \`value\` null, \`cancelled\` true and
\`digitCount\` 0. Include an edge-sliced card when its fee is visible; if the card is visible but
its fee is genuinely unreadable, use "?" for \`printed\` and null for \`value\`.

A screenshot can contain multiple date headers. Each row takes the closest header ABOVE it. The
year is 2026. Month names can be Arabic, Maghrebi, or English. In \`time\`, copy the complete time
EXACTLY AS PRINTED, preserving Arabic-Indic or Western digits, the separator, and the printed
\`ص\` / \`م\` / AM / PM marker. Do not convert it to 24-hour time and do not guess a missing marker.
Return all visible rows, including rows below a second date header.`
}

/**
 * An independent, deliberately tiny inspection of card clocks and their date headers.
 *
 * It contains no money and no routes so it cannot copy the financial pass's reasoning. The server
 * converts the two raw transcriptions itself and requires two observations to agree before a clock
 * is allowed to classify an order inside or outside a shift window.
 */
export function ordersTimeReadPrompt(): string {
  return `ORDERS PRINTED-TIME VERIFIER

Inspect the RECENT ORDERS screenshot independently. Return one row for EVERY visible order card,
top to bottom, including cancelled and edge-sliced cards. Read only:

- \`time\`: copy the card time EXACTLY AS PRINTED. Preserve Arabic-Indic or Western digits, the
  printed separator, and the printed \`ص\` / \`م\` / AM / PM marker. Convert NOTHING. In particular,
  never turn 12:xx into 00:xx and never change a visible 12 into 11. Return null when any time glyph
  or its marker is unreadable.
- \`dateIso\`: YYYY-MM-DD from the nearest date header ABOVE that card. The year is 2026. A screen
  can contain more than one date header; do not carry the lower header upward or the upper header
  past a newer one.
- \`cancelled\`: true only when that card visibly says Cancelled / تم إلغاؤه.

Ignore all fees, SYP values, addresses, coordinates, status-bar clocks and phone numbers. They are
not time evidence.`
}

/**
 * A cheap, independent gate that runs beside the financial and time readers.
 *
 * Recent Orders and the Payments Log both contain stacked cards, times and money. Asking a reader
 * that has already been told “this is orders” to notice the difference is circular, so this pass
 * gets neither that assumption nor any transcription work. It classifies only stable screen
 * landmarks and fails closed when the title/structure is cropped away.
 */
export function ordersScreenKindPrompt(): string {
  return `ORDERS SCREEN-KIND SAFETY CHECK

Classify this Damascus delivery-app screenshot using only visible screen structure and labels. Do
not transcribe amounts, times, addresses, or rows.

- "orders": the Recent Orders / «الطلبات الحديثة» screen. Delivery cards normally have orange A
  and blue B route markers, pickup/dropoff lines, and may show a fee beside SYP or Cancelled / تم
  إلغاؤه. A visible Recent Orders title is decisive.
- "payments_log": the Payments Log / «سجل المدفوعات» screen. It is a ledger of signed incoming and
  outgoing movements, not pickup/dropoff delivery cards. A visible Payments Log title is decisive.
- "unknown": neither identity is proved, the decisive title/landmarks are cropped, or the image is
  another screen.

Never infer "orders" merely because SYP, dates, times, or stacked white cards are visible.`
}

/**
 * Three genuinely different inspections of the one field where a single glyph changes BR1.
 *
 * They are sent as independent model calls and a two-out-of-three agreement is required. Repeating
 * one prompt three times is not independent evidence: reasoning models are deliberately stable and
 * tend to repeat the same visual shortcut. These variants make each pass approach the orange card
 * differently while keeping the exact same strict response schema.
 */
export function walletReadPrompts(): readonly [string, string, string] {
  const base = readPrompt('wallet')
  return [
    `${base}\n\nWALLET CHECK A — Read the complete large white balance as a whole, then re-check every glyph once before returning it.`,
    `${base}\n\nWALLET CHECK B — Work glyph by glyph. Start with the LEFTMOST digit of the balance and explicitly decide whether it is ٢ or ٣ by its visible strokes; then transcribe the remaining digits and separators. Do not infer the answer from a previous balance or from ledger arithmetic.`,
    `${base}\n\nWALLET CHECK C — Treat ٢↔٣ as an adversarial ambiguity. Test both hypotheses against the actual first white glyph on the orange card, reject the one whose strokes do not match, and only then assemble the amount. Do not copy any number elsewhere on the screen.`,
  ]
}

/** A compact strict schema for the orders pass that intentionally cannot emit route text. */
export const ORDERS_MONEY_READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['hasDecimal', 'hasThousands', 'digitCount', 'printed', 'value', 'time', 'dateIso', 'pointA', 'pointB', 'cancelled'],
        properties: {
          hasDecimal: { type: 'boolean' },
          hasThousands: { type: 'boolean' },
          digitCount: { type: 'integer' },
          printed: { type: 'string' },
          value: { type: ['string', 'null'] },
          time: { type: ['string', 'null'], description: 'Card time exactly as printed, including ص / م / AM / PM; never converted' },
          dateIso: { type: ['string', 'null'], description: 'YYYY-MM-DD from the nearest header above the row' },
          pointA: { type: 'null', description: 'Always null in the fast orders pass' },
          pointB: { type: 'null', description: 'Always null in the fast orders pass' },
          cancelled: { type: 'boolean' },
        },
      },
    },
  },
} as const

/** A compact strict schema for the independent printed-time pass. */
export const ORDERS_TIME_READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['time', 'dateIso', 'cancelled'],
        properties: {
          time: {
            type: ['string', 'null'],
            description: 'Card time exactly as printed, including original digits and ص / م / AM / PM',
          },
          dateIso: {
            type: ['string', 'null'],
            description: 'YYYY-MM-DD from the nearest date header above the row',
          },
          cancelled: { type: 'boolean' },
        },
      },
    },
  },
} as const

/** Strict response for the independent Orders-vs-Payments-Log safety gate. */
export const ORDERS_SCREEN_KIND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['screenKind'],
  properties: {
    screenKind: {
      type: 'string',
      enum: ['orders', 'payments_log', 'unknown'],
    },
  },
} as const

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
        required: ['hasDecimal', 'hasThousands', 'digitCount', 'printed', 'value', 'time', 'dateIso', 'pointA', 'pointB', 'cancelled'],
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
          time: {
            type: ['string', 'null'],
            description: 'Orders: exact printed time with marker, never converted. Other screens: 24-hour HH:MM.',
          },
          pointA: {
            type: ['string', 'null'],
            description: 'Orders list only: the PICKUP line, marked A. Copy it as printed. null on any other screen.',
          },
          pointB: {
            type: ['string', 'null'],
            description: 'Orders list only: the DROPOFF line, marked B — a place name, or a coordinate pair in brackets. null on any other screen.',
          },
          dateIso: {
            type: ['string', 'null'],
            description: 'YYYY-MM-DD from the nearest date header ABOVE this row — not from today. The year is 2026.',
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
