import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  type CloudOcrField,
  type CloudOcrResponse,
  type EvidenceUploadResponse,
  acknowledgeStaleEvidencePath,
  compressImage,
  evidenceUploadHeaders,
  photoAgeFromClockSkew,
  readInCloud,
  uploadEvidencePath,
} from '@ash/client'
import { useApp } from '../app-context.tsx'
import {
  executePhotoAttempt,
  isCurrentPhotoAttempt,
  nextPhotoAttempt,
  type PhotoAttempt,
} from '../photo-attempt.ts'

/** What the cloud read is doing. One `reading`, then exactly one terminal event. */
export type CloudReadEvent =
  | { status: 'reading' }
  | { status: 'read'; response: CloudOcrResponse }
  | { status: 'failed'; reason: 'unavailable' | 'timeout' | 'no_fields' | 'refused' }

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
  onUploaded(slot: string, result?: EvidenceUploadResponse, file?: File): void | Promise<void>
  /** Optional hook for dedupe/age telemetry without coupling it to the slot-complete callback. */
  onUploadResult?(slot: string, result: EvidenceUploadResponse): void
  /**
   * The ORIGINAL file, for on-device OCR. Best-effort — never blocks the upload.
   *
   * Deliberately not the compressed bytes: `compressImage` caps the long edge at 1280 px and drops
   * JPEG quality to 0.4, which puts a phone screenshot's body text at roughly 10–13 px of x-height
   * — below what Tesseract's LSTM can read, with ringing on exactly the thin, high-contrast glyphs
   * a BMS readout is made of. The upload still carries the compressed copy; OCR runs locally, so
   * it costs nothing to hand it the real pixels.
   *
   * A consumer that declares the cloud authoritative must treat this as a training/sample reader
   * only. It must not publish a provisional field value: the wallet flow enforces that rule through
   * `ai-ocr-authority`, while explicit typing remains the human override.
   */
  onImage?(file: File): void
  /**
   * Which screen the CLOUD reader should be asked about, if any. Omitted = no cloud read at all.
   *
   * The cloud model is authoritative where it answers: it reads 290 of 311 rows across the real
   * corpus against the on-device reader's 136. But the two are kept side by side deliberately —
   * they fail differently, the local one REFUSES rather than guessing, and it is the one being
   * trained on what the driver confirms.
   */
  ocrField?: CloudOcrField
  /** Progress and result of the cloud read. Called with `reading` first, then exactly one outcome. */
  onCloudRead?(event: CloudReadEvent, file?: File): void
  /**
   * Offer «حذف الصورة» on this tile. Called after the server has released the slot.
   *
   * Omitted where removal makes no sense — a required one-of-a-kind photo is corrected by
   * re-shooting it, not by leaving the slot empty.
   */
  onDelete?(slot: string): void
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
  onUploadResult,
  onImage,
  ocrField,
  onCloudRead,
  onDelete,
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
  /** Two taps to delete: a photo is evidence, and the second tap is cheaper than a stray first. */
  const [confirming, setConfirming] = useState(false)
  const [uploadResult, setUploadResult] = useState<EvidenceUploadResponse | null>(null)
  /** Remember acknowledgement across an idempotent retry of the same File object. */
  const acknowledgedFiles = useRef<WeakSet<File>>(new WeakSet())
  /**
   * One gallery selection is one OCR generation, even if its evidence upload needs another tap.
   * Reusing this attempt for upload-only retry prevents duplicate local/cloud readers for one File.
   */
  const attemptSequence = useRef(0)
  const currentAttempt = useRef<PhotoAttempt<File> | null>(null)

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

  /**
   * The cloud read, isolated so nothing it does can reach the upload path.
   *
   * Every failure keeps the on-device training sample. This component never promotes its guess;
   * cloud-authoritative consumers such as wallet keep the field blank. A timeout is worth retrying
   * while `no_fields`/`refused` asks the driver to check the pixels or enter the value explicitly.
   * Only transport/local preparation failures collapse to `unavailable`, because no server answer
   * exists to preserve in those cases.
   */
  const runCloudRead = useCallback(
    async (attempt: PhotoAttempt<File>) => {
      if (!ocrField || !onCloudRead) return
      const { file } = attempt
      onCloudRead({ status: 'reading' }, file)
      const res = await readInCloud(api, shiftId, ocrField, file)
      if (!isCurrentPhotoAttempt(currentAttempt.current, attempt)) return
      onCloudRead(
        res === null
          ? { status: 'failed', reason: 'unavailable' }
          : res.ok
            ? { status: 'read', response: res }
            : { status: 'failed', reason: res.reason ?? 'unavailable' },
        file,
      )
    },
    [api, shiftId, ocrField, onCloudRead],
  )

  /** Upload one generation without deciding whether its readers should run. */
  const upload = useCallback(
    async (attempt: PhotoAttempt<File>): Promise<void> => {
      const { file } = attempt
      try {
        const { bytes, mimeType } = await compressImage(file)
        // The file's own timestamp, not the upload clock. A zero timestamp means unknown.
        const result = await api.putBytes<EvidenceUploadResponse>(
          uploadEvidencePath(shiftId, pkg, slot),
          bytes,
          mimeType,
          evidenceUploadHeaders(
            file.lastModified > 0 ? file.lastModified : null,
            acknowledgedFiles.current.has(file),
          ),
        )
        if (!isCurrentPhotoAttempt(currentAttempt.current, attempt)) return
        let accepted = result
        if (result.reusedFromShiftId && !result.staleAcknowledged && !acknowledgedFiles.current.has(file)) {
          if (!window.confirm(t.shift.reusedEvidenceConfirm)) {
            setUploadResult(result)
            setState('error')
            return
          }
          await api.post(acknowledgeStaleEvidencePath(shiftId, pkg, slot), {
            mediaId: result.mediaId,
            attachmentToken: result.attachmentToken,
          })
          if (!isCurrentPhotoAttempt(currentAttempt.current, attempt)) return
          acknowledgedFiles.current.add(file)
          accepted = { ...result, staleAcknowledged: true }
        }
        setUploadResult(accepted)
        onUploadResult?.(slot, accepted)
        // BMS may persist an evidence-linked read here. Keep the attempt current through that write.
        await onUploaded(slot, accepted, file)
        if (!isCurrentPhotoAttempt(currentAttempt.current, attempt)) return
        setState('done')
      } catch {
        // The upload is idempotent. Retry these bytes, but never relaunch the readers for them.
        if (isCurrentPhotoAttempt(currentAttempt.current, attempt)) setState('error')
      }
    },
    [api, t, shiftId, pkg, slot, onUploaded, onUploadResult],
  )

  const execute = useCallback(
    (attempt: PhotoAttempt<File>, phase: 'selection' | 'upload_retry'): Promise<void> =>
      executePhotoAttempt(attempt, phase, {
        startReaders: ({ file }) => {
          onImage?.(file)
          if (ocrField && onCloudRead) void runCloudRead(attempt)
        },
        upload,
      }),
    [onImage, ocrField, onCloudRead, runCloudRead, upload],
  )

  const onPick = useCallback(
    async (file: File) => {
      const pickedAge = photoAgeFromClockSkew(file.lastModified > 0 ? Date.now() - file.lastModified : null)
      if (pickedAge.kind === 'stale' && !acknowledgedFiles.current.has(file)) {
        const ageLabel =
          pickedAge.minutes < 60 ? `${pickedAge.minutes}m` : `${Math.round(pickedAge.minutes / 60)}h`
        if (!window.confirm(t.shift.staleEvidenceConfirm.replace('{n}', ageLabel))) {
          // A declined replacement must not erase the slot that is already attached. Nothing has
          // reached the server yet, so leave every visible/local completion state untouched.
          if (ref.current) ref.current.value = ''
          return
        }
        acknowledgedFiles.current.add(file)
      }
      setPicked(file)
      setUploadResult(null)
      setState('working')
      const attempt = nextPhotoAttempt(attemptSequence.current, file)
      attemptSequence.current = attempt.id
      currentAttempt.current = attempt
      // START THE TRAINING READER FIRST, UPLOAD SECOND. Tesseract runs entirely on-device, so it
      // never needed the network — and it used to be gated behind the upload. On 2G
      // at the end of a shift the upload failed, `onImage` was never reached, and the driver
      // hand-typed thirty orders the phone could have read while standing still.
      /*
       * THEN the cloud read, started here and NOT awaited.
       *
       * Order matters and this is third on purpose. The evidence upload below is the one that
       * BR5 gates on — a shift cannot open or close without it — so it must never queue behind a
       * vision model that can take twenty-five seconds. For a cloud-authoritative field, only the
       * cloud callback may publish a machine value; the local callback retains its sample and an
       * AI failure leaves the keyboard/retry path rather than exposing a provisional guess.
       *
       * `ocrField` being undefined means this slot has no cloud reader wired up, which is the
       * state every slot is in until its screen opts in.
       */
      await execute(attempt, 'selection')
    },
    [t, execute],
  )

  /**
   * Take the photo back out of the slot.
   *
   * The tile returns to empty only if the SERVER agreed. Clearing it optimistically would show a
   * driver an empty tile the BR5 gate still counts as filled, and he would submit believing he had
   * removed a page that is still attached.
   */
  const remove = useCallback(async (): Promise<void> => {
    if (!onDelete) return
    setConfirming(false)
    setState('working')
    try {
      await api.del(uploadEvidencePath(shiftId, pkg, slot))
      currentAttempt.current = null
      setPicked(null)
      setUploadResult(null)
      setState('idle')
      onDelete(slot)
    } catch {
      // Still attached. Say so by staying done, rather than by showing an empty tile.
      setState('done')
    }
  }, [api, shiftId, pkg, slot, onDelete])

  const open = (): void => {
    // One file owns the local/cloud/upload race until it reaches a terminal state. Opening the
    // picker while that work is running could let an older upload complete over a newer choice.
    if (state === 'working') return
    if (state === 'error' && picked) {
      const attempt = currentAttempt.current
      if (attempt === null) return
      setUploadResult(null)
      setState('working')
      void execute(attempt, 'upload_retry')
    } else ref.current?.click()
  }
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
  const age = uploadResult === null ? null : photoAgeFromClockSkew(uploadResult.clockSkewMs)
  const ageWarning =
    age?.kind === 'stale' ? t.shift.photoOld.replace('{n}', age.minutes < 60 ? `${age.minutes}m` : `${Math.round(age.minutes / 60)}h`) : null

  if (variant === 'tile') {
    return (
      <div className="flex flex-col">
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
      {/*
       * «حذف الصورة» — OUTSIDE the tile button, because a delete nested inside the tap target that
       * opens the gallery is a delete the thumb finds by accident. It appears only once there is
       * something to remove, and only where the caller offers it: a required one-of-a-kind slot
       * (the wallet, the odometer) is corrected by re-shooting, whereas a surplus dashboard page
       * is a thing the driver genuinely needs to take away.
       *
       * Two taps. A photo is evidence, and the second tap is cheaper than an accidental first.
       */}
      {onDelete && state === 'done' ? (
        <button
          type="button"
          onClick={() => (confirming ? void remove() : setConfirming(true))}
          onBlur={() => setConfirming(false)}
          className={`mt-1 w-full rounded-lg py-1 text-[11px] font-medium ${
            confirming ? 'bg-red-600 text-white' : 'text-slate-500'
          }`}
        >
          {confirming ? t.shift.removePhotoConfirm : t.shift.removePhoto}
        </button>
      ) : null}
      {ageWarning ? <p className="mt-1 text-center text-[10px] text-amber-700">{ageWarning}</p> : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
    <button
      type="button"
      // A failed upload retries the file already in hand; only an untouched tile opens the picker.
      onClick={open}
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
    {ageWarning ? <p className="text-center text-xs text-amber-700">{ageWarning}</p> : null}
    </div>
  )
}
