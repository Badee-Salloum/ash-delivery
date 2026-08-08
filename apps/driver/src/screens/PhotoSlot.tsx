import { type ReactNode, useCallback, useRef, useState } from 'react'
import { compressImage, uploadEvidencePath } from '@ash/client'
import { useApp } from '../app-context.tsx'

/**
 * An evidence tile: pick an image, compress it, upload it, and show what happened.
 *
 * It lives in its own module because it is used from three places and, crucially, must never be
 * passed to a child AS A PROP. React compares component types by identity, so an inline
 * `PhotoSlot={(props) => <PhotoSlot …/>}` is a new type on every render: the whole subtree gets
 * unmounted and rebuilt, the tile's `'working' → 'done'` state is thrown away, and a photo that
 * uploaded perfectly snaps straight back to 📷. That is what made a working BMS upload look as
 * though nothing had happened at all.
 */
export interface PhotoSlotProps {
  shiftId: string
  pkg: 'start' | 'end'
  slot: string
  label: string
  onUploaded(slot: string): void
  /**
   * The ORIGINAL file, for on-device OCR. Best-effort — never blocks the upload.
   *
   * Deliberately not the compressed bytes: `compressImage` caps the long edge at 1280 px and drops
   * JPEG quality to 0.4, which puts a phone screenshot's body text at roughly 10–13 px of x-height
   * — below what Tesseract's LSTM can read, with ringing on exactly the thin, high-contrast glyphs
   * a BMS readout is made of. The upload still carries the compressed copy; OCR runs locally, so
   * it costs nothing to hand it the real pixels.
   */
  onImage?(file: File): void
  /**
   * `camera` opens the camera (an odometer is photographed). `gallery` does not — a BMS reading is
   * a SCREENSHOT the driver already took, and forcing the camera would make him photograph one
   * phone screen with another.
   */
  source?: 'camera' | 'gallery'
  /**
   * This slot was already uploaded before this mount, so the tile comes back TICKED.
   *
   * The driver can leave the closing package and return to it. Without this the tiles all reset to
   * 📷 while the submit button stayed enabled — the screen telling him, at the same time, that his
   * photos were missing and that he could submit. Read once, at mount: after that the tile's own
   * upload is the authority on its state.
   */
  uploaded?: boolean
}

export function PhotoSlot({
  shiftId,
  pkg,
  slot,
  label,
  onUploaded,
  onImage,
  source = 'camera',
  uploaded = false,
}: PhotoSlotProps): ReactNode {
  const { api, t } = useApp()
  const ref = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>(uploaded ? 'done' : 'idle')
  /** The file already picked, so a failed upload is one tap — not another trip to the gallery. */
  const [picked, setPicked] = useState<File | null>(null)

  const onPick = useCallback(
    async (file: File) => {
      setPicked(file)
      setState('working')
      // READ FIRST, UPLOAD SECOND. Tesseract runs entirely on-device, so reading is the one part
      // of this that never needed the network — and it used to be gated behind the upload. On 2G
      // at the end of a shift the upload failed, `onImage` was never reached, and the driver
      // hand-typed thirty orders the phone could have read while standing still.
      onImage?.(file)
      try {
        const { bytes, mimeType } = await compressImage(file)
        await api.putBytes(uploadEvidencePath(shiftId, pkg, slot), bytes, mimeType, {
          'x-client-taken-at': String(Date.now()),
        })
        setState('done')
        onUploaded(slot)
      } catch {
        // The upload is idempotent, so the fix is simply to tap again — with the same file.
        setState('error')
      }
    },
    [api, shiftId, pkg, slot, onUploaded, onImage],
  )

  return (
    <button
      // A failed upload retries the file already in hand; only an untouched tile opens the picker.
      onClick={() => (state === 'error' && picked ? void onPick(picked) : ref.current?.click())}
      className={`flex min-h-20 items-center justify-between rounded-2xl border-2 border-dashed px-4 ${
        state === 'done'
          ? 'border-emerald-400 bg-emerald-50'
          : state === 'error'
            ? 'border-red-400 bg-red-50'
            : 'border-slate-300 bg-white'
      }`}
    >
      <span className="font-medium">{label}</span>
      {/* An error used to keep the same grey dashed border and swap the 📷 for grey 14px text —
          in sunlight that reads as "not done yet" at best and as "done" at worst. */}
      <span className={`text-sm ${state === 'error' ? 'font-medium text-red-700' : 'text-slate-600'}`}>
        {state === 'working'
          ? t.common.loading
          : state === 'done'
            ? '✓'
            : state === 'error'
              ? t.shift.uploadFailed
              : '📷'}
      </span>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        {...(source === 'camera' ? { capture: 'environment' as const } : {})}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onPick(f)
        }}
      />
    </button>
  )
}
