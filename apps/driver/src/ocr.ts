/**
 * On-device OCR for the start-package dashboard photo (SRS §D, assisted variant).
 *
 * Tesseract.js runs entirely in the browser — no photo leaves the phone, no cloud, works under the
 * Damascus network once the assets are cached. The whole library (worker + wasm core + traineddata,
 * a few MB) is loaded ONLY here, via a lazy `import()`, so it never touches the ~70 KB entry bundle;
 * the assets are self-hosted under `/tesseract/` (staged by scripts/copy-tesseract.mjs).
 *
 * It is ASSISTED, not automatic: `readDashboard` returns a best-effort battery + odometer to
 * PRE-FILL the fields, and the driver corrects any misread before submitting. Every path is wrapped
 * so that ANY failure — assets missing, worker error, a slow phone — resolves to `null`, and the
 * screen simply falls back to manual entry. OCR can only ever help, never block.
 */
export interface OcrReading {
  battery: number | null
  odometer: number | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workerPromise: Promise<any> | null = null

async function getWorker(): Promise<unknown> {
  workerPromise ??= (async () => {
    const { createWorker, OEM, PSM } = await import('tesseract.js')
    const worker = await createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/',
      langPath: '/tesseract/',
    })
    await worker.setParameters({
      // The dashboard shows only digits, a per-cent sign and a decimal point — restricting the
      // character set makes a cheap Android both faster and more accurate.
      tessedit_char_whitelist: '0123456789%.',
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    })
    return worker
  })()
  return workerPromise
}

/** Recognise battery % + odometer from a dashboard image. Returns null on ANY failure. */
export async function readDashboard(image: Blob | Uint8Array, timeoutMs = 20_000): Promise<OcrReading | null> {
  try {
    const worker = (await getWorker()) as { recognize(b: Blob): Promise<{ data: { text: string } }> }
    const blob = image instanceof Uint8Array ? new Blob([image as BlobPart], { type: 'image/jpeg' }) : image
    const result = await Promise.race([
      worker.recognize(blob),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ocr timeout')), timeoutMs)),
    ])
    return parseReading(result.data.text)
  } catch {
    return null
  }
}

/**
 * Pull the two numbers out of the recognised text.
 * - battery: the number just before a `%`, clamped to 0–100.
 * - odometer: the longest run of digits — on an e-bike dash the odometer is the largest figure
 *   (speed/trip/clock are all shorter), so this is a good-enough first guess for the driver to fix.
 */
export function parseReading(text: string): OcrReading {
  const batteryMatch = text.match(/(\d{1,3})\s*%/)
  const battery = batteryMatch ? Math.min(100, Number(batteryMatch[1])) : null

  const batteryDigits = batteryMatch?.[1]
  let odometer: number | null = null
  let longest = ''
  for (const run of text.match(/\d+/g) ?? []) {
    if (run === batteryDigits) continue // don't mistake the battery reading for the odometer
    if (run.length > longest.length) longest = run
  }
  if (longest) odometer = Number(longest)

  return { battery, odometer }
}
