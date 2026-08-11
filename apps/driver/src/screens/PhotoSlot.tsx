import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
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
   * `gallery` (the default) lets the driver pick what he already has; `camera` forces a live shot.
   *
   * Everything is `gallery` now, the odometer included, at the owner's instruction. It is also the
   * better workflow: he can take the odometer photo, screenshot the BMS app and page through the
   * Yallago dashboard in ONE pass, then upload the set — instead of the app yanking him into a
   * camera between each step while a manager waits.
   *
   * WHAT THIS COSTS: `capture` was the only thing guaranteeing an evidence photo was taken just now.
   * A gallery pick can be last week's. `x-client-taken-at` carries the file's real modification time
   * so the age is at least RECORDED and shown to the manager — see `onPick`.
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
  /**
   * `row` (the default) is the full-width bar with a readable label — right for evidence that is one
   * of a kind and whose NAME is the information: «العداد», «رصيد المحفظة».
   *
   * `tile` is a compact square for homogeneous, paged sets — «الطلبات الحديثة» pages 1…8, the
   * payments log, one per battery. They differ only by a number, so a number is all the label they
   * need, and stacking them as 80px bars is what made a real close package 12 tiles and ~1,000px of
   * identical grey before the driver reached a single field he came to fill in.
   */
  variant?: 'row' | 'tile'
  /** The tile's own caption — a page number, or a slot number. Ignored by `row`. */
  badge?: string
}

export function PhotoSlot({
  shiftId,
  pkg,
  slot,
  label,
  onUploaded,
  onImage,
  source = 'gallery',
  uploaded = false,
  variant = 'row',
  badge,
}: PhotoSlotProps): ReactNode {
  const { api, t } = useApp()
  const ref = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>(uploaded ? 'done' : 'idle')
  /** The file already picked, so a failed upload is one tap — not another trip to the gallery. */
  const [picked, setPicked] = useState<File | null>(null)

  /**
   * A thumbnail of the picture he actually chose.
   *
   * The commonest mistake in a close is uploading the SAME page twice: against identical grey bars
   * that is invisible until the manager finds it, and against two identical thumbnails it is
   * obvious immediately. It costs nothing on the network — the file is already in hand for the
   * retry path, so this renders the local blob rather than downloading anything. (It could not
   * download it anyway: `/api/media/:id` needs `branch_data.view`, which a driver does not have.)
   *
   * A RESUMED package has no local file and shows the tick alone. That is honest — the photo is on
   * the server, not in this browser — and it is why the tick, not the image, remains the state.
   */
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    if (picked === null || variant !== 'tile') return
    const url = URL.createObjectURL(picked)
    setPreview(url)
    // Revoked on replace AND on unmount: eight full-resolution screenshots held open would be a
    // real leak on the cheap Android this runs on.
    return () => {
      URL.revokeObjectURL(url)
      setPreview(null)
    }
  }, [picked, variant])

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
        // THE FILE'S OWN TIMESTAMP, not the clock.
        //
        // This header used to send `Date.now()`, i.e. the moment of upload — which is not a fact
        // about the photograph at all, and made every picture look freshly taken. Now that any slot
        // can be filled from the gallery, the age of the image IS the control that replaced
        // `capture`: `lastModified` is when the file was written, so a picture chosen from last
        // week arrives saying so and the manager sees it on the approval screen.
        //
        // `lastModified` is 0 on some pickers rather than absent; treat that as "unknown" and send
        // nothing, because a 1970 timestamp would read as a fifty-year-old photo.
        await api.putBytes(uploadEvidencePath(shiftId, pkg, slot), bytes, mimeType, {
          ...(file.lastModified > 0 ? { 'x-client-taken-at': String(file.lastModified) } : {}),
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

  const open = (): void => (state === 'error' && picked ? void onPick(picked) : ref.current?.click())
  const input = (
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
  )

  if (variant === 'tile') {
    return (
      <button
        type="button"
        onClick={open}
        // The full name lives here because the visible caption is a digit — the same reason the
        // delivery blocks carry one.
        aria-label={label}
        title={label}
        className={`relative flex aspect-square w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl border-2 ${
          state === 'done'
            ? 'border-emerald-400 bg-emerald-50'
            : state === 'error'
              ? 'border-red-400 bg-red-50'
              : 'border-dashed border-slate-300 bg-white'
        }`}
      >
        {/* The border carries the state, exactly as the delivery blocks do. */}
        <span className="absolute end-1 top-1 text-xs" aria-hidden>
          {state === 'done' ? '✓' : state === 'error' ? '✕' : ''}
        </span>
        {preview && state !== 'error' ? (
          <img src={preview} alt="" className="absolute inset-0 size-full object-cover opacity-60" />
        ) : null}
        {/* A page number when it has one. Otherwise the camera, and only while there is nothing
            there yet — once the tile is done its green border and ✓ already say so, and a 📷 beside
            a tick reads as an invitation to redo a photo that is perfectly fine. */}
        <span className="num relative text-xl font-bold text-slate-700">
          {badge ?? (state === 'done' ? '' : '📷')}
        </span>
        {state === 'working' ? (
          <span className="relative text-[10px] leading-none text-slate-600">{t.common.loading}</span>
        ) : null}
        {input}
      </button>
    )
  }

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
      <span className="min-w-0 flex-1 text-start font-medium">{label}</span>
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
