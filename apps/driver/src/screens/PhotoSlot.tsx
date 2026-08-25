import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  type ApiError,
  type CloseDraftAttachment,
  type CloseDraftAttachmentHistoryItem,
  type CloseDraftView,
  type CloudOcrField,
  type CloudOcrResponse,
  type EvidenceUploadResponse,
  type OcrImageFocus,
  closeDraftThumbnailPath,
  clientUuid,
  compressForOcr,
  compressImage,
  evidenceUploadHeaders,
  photoAgeFromClockSkew,
  readInCloud,
  uploadEvidencePath,
} from '@ash/client'
import { useApp } from '../app-context.tsx'
import {
  deletePendingEvidence,
  getPendingEvidence,
  pendingEvidenceBlob,
  putPendingEvidence,
} from '../pending-evidence-storage.ts'
import {
  executePhotoAttempt,
  isCurrentPhotoAttempt,
  nextPhotoAttempt,
  planAcceptedUpload,
  type PhotoAttempt,
} from '../photo-attempt.ts'

export type CloudReadEvent =
  | { status: 'reading' }
  | { status: 'read'; response: CloudOcrResponse }
  | {
      status: 'failed'
      /** `cancelled` is browser-owned: the driver left a slow read and continued manually. */
      reason:
        | 'unavailable' | 'timeout' | 'no_fields' | 'refused' | 'wrong_screen' | 'cancelled'
        | 'read_budget_exhausted'
      retryable: boolean
    }

interface PreparedEvidence {
  file: File
  bytes: Uint8Array
  mimeType: string
  generationId: string
}

export interface PhotoSlotProps {
  shiftId: string
  pkg: 'start' | 'end'
  slot: string
  label: string
  onUploaded(slot: string, result?: EvidenceUploadResponse, file?: File): void | Promise<void>
  /**
   * The server accepted an upload for an attempt that is no longer on screen.
   *
   * Deliberately NOT `onUploaded`. That callback means "this generation is now the slot", and
   * consumers act on it: `BatteryPanel` resets the pack, clears the cloud read and repoints
   * `onMediaIdChanged`. Running that for a SUPERSEDED generation would let an older photo clobber
   * the newer one's state — a worse bug than the one being fixed.
   *
   * So this says only the narrow true thing: the slot is filled on the server. Consumers that gate
   * on "is there a photo" implement it; consumers that track generations ignore it or record the
   * slot alone.
   */
  onSupersededAttach?(slot: string, result: EvidenceUploadResponse): void
  onUploadResult?(slot: string, result: EvidenceUploadResponse): void
  /** Runs only after the server accepted this exact attachment generation. */
  onImage?(file: File, result?: EvidenceUploadResponse): void | Promise<void>
  ocrField?: CloudOcrField
  onCloudRead?(event: CloudReadEvent, file?: File): void
  onDelete?(slot: string): void
  source?: 'camera' | 'gallery'
  uploaded?: boolean
  variant?: 'row' | 'tile'
  badge?: string
  /** Server-restored attachment, including its separately persisted read status. */
  attachment?: CloseDraftAttachment | null
  /** Revision/token make an end-package replacement conditional instead of last-write-wins. */
  closeDraftRevision?: number | null
  onCloseDraft?(draft: CloseDraftView): void
  /** Linked OCR can be retried after reload without retaining the original File. */
  onRetryRead?(): void | Promise<void>
  /** Recent-orders/payment/BMS evidence is stored at recognition quality for linked OCR. */
  recognitionQuality?: boolean
  recognitionFocus?: OcrImageFocus
}

function terminalRead(attachment: CloseDraftAttachment | null | undefined): boolean {
  return attachment?.read?.status === 'complete' || attachment?.read?.status === 'failed'
}

function attachmentLabel(slot: string, labels: { dashboardShot: string; paymentsLog: string }): string {
  const match = /^(dashboard|payments_log)(?:_([0-9]+))?$/.exec(slot)
  if (!match) return slot
  const page = match[2] ?? '1'
  const name = match[1] === 'dashboard' ? labels.dashboardShot : labels.paymentsLog
  return `${name} ${page}`
}

export function PhotoSlot({
  shiftId,
  pkg,
  slot,
  label,
  onUploaded,
  onSupersededAttach,
  onUploadResult,
  onImage,
  ocrField,
  onCloudRead,
  onDelete,
  source = 'gallery',
  uploaded = false,
  variant = 'row',
  badge,
  attachment = null,
  closeDraftRevision = null,
  onCloseDraft,
  onRetryRead,
  recognitionQuality = false,
  recognitionFocus,
}: PhotoSlotProps): ReactNode {
  const { api, t } = useApp()
  const ref = useRef<HTMLInputElement>(null)
  const attached = uploaded || attachment !== null
  const [state, setState] = useState<'idle' | 'preparing' | 'uploading' | 'done' | 'error'>(
    attached ? 'done' : 'idle',
  )
  const [picked, setPicked] = useState<File | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [uploadResult, setUploadResult] = useState<EvidenceUploadResponse | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [pendingGenerationId, setPendingGenerationId] = useState<string | null>(null)
  const acknowledgedFiles = useRef<WeakSet<File>>(new WeakSet())
  const attemptSequence = useRef(0)
  const currentAttempt = useRef<PhotoAttempt<PreparedEvidence> | null>(null)
  const acceptedResult = useRef<EvidenceUploadResponse | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyItems, setHistoryItems] = useState<CloseDraftAttachmentHistoryItem[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [restoreReason, setRestoreReason] = useState('')
  const [restoringHistoryId, setRestoringHistoryId] = useState<string | null>(null)

  useEffect(() => {
    if (attached && state === 'idle') setState('done')
  }, [attached, state])

  /** Recover only bytes that never reached a persisted terminal read. */
  useEffect(() => {
    if (pkg !== 'end' || picked !== null) return
    let cancelled = false
    void getPendingEvidence(shiftId, pkg, slot).then((record) => {
      if (cancelled || !record) return
      const file = new File([pendingEvidenceBlob(record)], record.fileName, {
        type: record.mimeType,
        lastModified: record.lastModified,
      })
      const prepared: PreparedEvidence = {
        file,
        bytes: new Uint8Array(record.bytes.slice(0)),
        mimeType: record.mimeType,
        generationId: record.generationId,
      }
      const attempt = nextPhotoAttempt(attemptSequence.current, prepared)
      attemptSequence.current = attempt.id
      currentAttempt.current = attempt
      setPicked(file)
      setPendingGenerationId(record.generationId)
      // A retained generation means its upload never reached a persisted terminal outcome. This is
      // still an upload failure even when the slot has an older accepted attachment: hiding the
      // retry behind that old green thumbnail strands an offline replacement after reload.
      setState('error')
    })
    return () => {
      cancelled = true
    }
  }, [shiftId, pkg, slot, picked, attached])

  /** A persisted read outcome owns the bytes now; conditional deletion protects a newer retake. */
  useEffect(() => {
    if (pkg !== 'end' || pendingGenerationId === null || !terminalRead(attachment)) return
    void deletePendingEvidence(shiftId, pkg, slot, pendingGenerationId)
    setPendingGenerationId(null)
  }, [shiftId, pkg, slot, attachment, pendingGenerationId])

  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    setPreview(null)
    if (
      picked === null ||
      variant !== 'tile' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) return
    let url: string
    try {
      url = URL.createObjectURL(picked)
    } catch {
      // A preview is cosmetic. Private/old WebViews may refuse object URLs; upload still proceeds.
      return
    }
    setPreview(url)
    return () => {
      try {
        URL.revokeObjectURL(url)
      } catch {
        // Cleanup must not crash the evidence tile in a partial WebView implementation.
      }
    }
  }, [picked, variant])

  const runLegacyCloudRead = useCallback(
    async (attempt: PhotoAttempt<PreparedEvidence>) => {
      if (!ocrField || !onCloudRead) return
      const { file } = attempt.file
      onCloudRead({ status: 'reading' }, file)
      const response = await readInCloud(api, shiftId, ocrField, file)
      if (!isCurrentPhotoAttempt(currentAttempt.current, attempt)) return
      onCloudRead(
        response === null
          ? { status: 'failed', reason: 'unavailable', retryable: true }
          : response.ok
            ? { status: 'read', response }
            : {
                status: 'failed',
                reason: response.reason ?? 'unavailable',
                retryable: response.retryable,
              },
        file,
      )
    },
    [api, shiftId, ocrField, onCloudRead],
  )

  const upload = useCallback(
    async (attempt: PhotoAttempt<PreparedEvidence>): Promise<boolean> => {
      const prepared = attempt.file
      try {
        setState('uploading')
        setUploadError(null)
        let expectedAttachmentToken = attachment?.attachmentToken ?? null
        const put = (replaceConfirmed: boolean): Promise<EvidenceUploadResponse> =>
          api.putBytes<EvidenceUploadResponse>(
            uploadEvidencePath(shiftId, pkg, slot),
            prepared.bytes,
            prepared.mimeType,
            evidenceUploadHeaders(
              prepared.file.lastModified > 0 ? prepared.file.lastModified : null,
              acknowledgedFiles.current.has(prepared.file),
              {
                ...(pkg === 'end' && closeDraftRevision !== null
                  ? { expectedRevision: closeDraftRevision }
                  : {}),
                expectedAttachmentToken,
                replaceConfirmed,
              },
            ),
          )
        let result: EvidenceUploadResponse | null = null
        let replaceConfirmed = false
        // A replacement can independently be stale/reused. Keep both acknowledgements and allow
        // at most two preflight confirmations; no reader starts until one PUT actually succeeds.
        for (let preflights = 0; preflights < 3 && result === null; preflights += 1) {
          try {
            result = await put(replaceConfirmed)
          } catch (candidateError) {
            const preflight = candidateError as ApiError
            const confirmable =
              preflight.error === 'stale_evidence_confirmation_required' ||
              preflight.error === 'evidence_replacement_confirmation_required'
            if (!confirmable) throw candidateError
            if (!window.confirm(t.shift.reusedEvidenceConfirm)) {
              // Preflight rejected without mutating the attachment. Discard only this local attempt.
              currentAttempt.current = null
              setPicked(null)
              setUploadResult(null)
              setState(attached ? 'done' : 'idle')
              await deletePendingEvidence(shiftId, pkg, slot, prepared.generationId)
              setPendingGenerationId(null)
              return false
            }
            if (preflight.error === 'evidence_replacement_confirmation_required') {
              const detail = preflight.detail as {
                currentAttachment?: { attachmentToken?: string } | null
              } | undefined
              expectedAttachmentToken =
                detail?.currentAttachment?.attachmentToken ?? expectedAttachmentToken
              replaceConfirmed = true
            } else acknowledgedFiles.current.add(prepared.file)
          }
        }
        if (result === null) throw new Error('evidence_preflight_did_not_settle')
        const plan = planAcceptedUpload(currentAttempt.current, attempt)
        if (!plan.ownsUi) {
          /*
           * SUPERSEDED, BUT THE SERVER TOOK IT.
           *
           * This runs when the driver picks a second photo while the first is still in flight. The
           * first PUT then lands on a slot that is no longer the one on screen — and the old code
           * returned here, before `onUploaded`, so the parent never learned the slot was filled.
           * The server holds the photo; the gate goes on saying «ناقص: صورة العداد»; and the driver
           * has no way out but to discard the shift. That is the same shape as the outage of
           * 2026-08-15: evidence stored server-side that nothing on the client can see.
           *
           * So tell the parent the slot IS attached. Deliberately NOT done here: `setState` and
           * `onCloseDraft`, which belong to the newer attempt — rewinding a close-draft revision to
           * a superseded generation would trade this bug for a worse one.
           */
          if (plan.notifyAttached) onSupersededAttach?.(slot, result)
          return false
        }

        const accepted = result
        acceptedResult.current = accepted
        setUploadResult(accepted)
        onUploadResult?.(slot, accepted)
        if (accepted.draft) onCloseDraft?.(accepted.draft)
        await onUploaded(slot, accepted, prepared.file)
        if (!isCurrentPhotoAttempt(currentAttempt.current, attempt)) return false
        setState('done')
        if (pkg === 'end' && !onImage && !ocrField) {
          await deletePendingEvidence(shiftId, pkg, slot, prepared.generationId)
          setPendingGenerationId(null)
        }
        return true
      } catch (error) {
        if (!isCurrentPhotoAttempt(currentAttempt.current, attempt)) return false
        const apiError = error as ApiError
        const terminalCandidateRejection =
          apiError.error === 'wrong_screen' || apiError.error === 'evidence_already_attached'
        if (apiError.error === 'wrong_screen') {
          // A staged kind check rejected the candidate before replacing the current attachment.
          setUploadError(t.shift.wrongScreen)
        } else if (apiError.error === 'evidence_already_attached') {
          const detail = apiError.detail as { sourcePackage?: string; sourceSlot?: string } | undefined
          const location = detail?.sourceSlot
            ? `: ${attachmentLabel(detail.sourceSlot, {
                dashboardShot: t.shift.dashboardShot,
                paymentsLog: t.shift.paymentsLog,
              })}`
            : ''
          setUploadError(`${t.shift.evidenceAlreadyUsed}${location}`)
        } else if (apiError.error === 'close_draft_revision_conflict') {
          const detail = apiError.detail as { current?: CloseDraftView; draft?: CloseDraftView } | undefined
          const current = detail?.current ?? detail?.draft
          if (current) onCloseDraft?.(current)
          setUploadError(t.shift.draftChangedRetry)
        } else if (apiError.error === 'upload_too_large') {
          setUploadError(t.shift.uploadTooLarge)
        } else if (apiError.error === 'not_an_image') {
          setUploadError(t.shift.notAnImage)
        } else {
          /*
           * Name the cause, even when we have no words for it.
           *
           * This branch used to collapse 413, 415, 504, 500, a privilege refusal and an offline
           * phone into the same nine words. That is how a fleet-wide outage looked like one
           * driver's bad photo for three days. A raw code is not pretty, but «فشل الرفع
           * (insufficient_privilege)» is something a manager can read down the phone, and
           * «(http_504)» tells him to wait rather than re-shoot.
           */
          const code = typeof apiError.error === 'string' && apiError.error !== 'unknown' ? apiError.error : null
          setUploadError(code === null ? t.shift.uploadFailed : `${t.shift.uploadFailed} (${code})`)
        }
        if (terminalCandidateRejection) {
          // Retrying identical bytes cannot succeed. Remove only the rejected local generation;
          // the accepted server attachment, thumbnail, rows and read state stay untouched.
          try {
            await deletePendingEvidence(shiftId, pkg, slot, prepared.generationId)
          } finally {
            currentAttempt.current = null
            setPicked(null)
            setUploadResult(null)
            setPendingGenerationId(null)
          }
        }
        setState('error')
        return false
      }
    },
    [
      api,
      t,
      shiftId,
      pkg,
      slot,
      closeDraftRevision,
      attachment?.attachmentToken,
      attached,
      onUploadResult,
      onSupersededAttach,
      onCloseDraft,
      onUploaded,
      onImage,
      ocrField,
    ],
  )

  const execute = useCallback(
    (attempt: PhotoAttempt<PreparedEvidence>, phase: 'selection' | 'upload_retry'): Promise<void> =>
      executePhotoAttempt(attempt, phase, {
        upload,
        startReaders: async ({ file: prepared }) => {
          await onImage?.(prepared.file, acceptedResult.current ?? undefined)
          if (ocrField && onCloudRead) await runLegacyCloudRead(attempt)
        },
      }),
    [upload, onImage, ocrField, onCloudRead, runLegacyCloudRead],
  )

  const onPick = useCallback(
    async (file: File) => {
      const pickedAge = photoAgeFromClockSkew(file.lastModified > 0 ? Date.now() - file.lastModified : null)
      if (pickedAge.kind === 'stale' && !acknowledgedFiles.current.has(file)) {
        const ageLabel =
          pickedAge.minutes < 60 ? `${pickedAge.minutes}m` : `${Math.round(pickedAge.minutes / 60)}h`
        if (!window.confirm(t.shift.staleEvidenceConfirm.replace('{n}', ageLabel))) {
          if (ref.current) ref.current.value = ''
          return
        }
        acknowledgedFiles.current.add(file)
      }

      // Selection itself supersedes the old generation. If this file cannot be decoded, retaining
      // the old attempt would paint "retry upload" and send the PREVIOUS photo when the driver taps.
      currentAttempt.current = null
      acceptedResult.current = null
      setPicked(file)
      setUploadResult(null)
      setUploadError(null)
      setState('preparing')
      let attempt: PhotoAttempt<PreparedEvidence>
      try {
        const focus = recognitionFocus ?? (recognitionQuality ? 'full' : null)
        const compressed = focus ? await compressForOcr(file, focus) : await compressImage(file)
        if (!compressed) throw new Error('image_too_large_after_compression')
        const generationId = clientUuid()
        const prepared: PreparedEvidence = {
          file,
          bytes: compressed.bytes,
          mimeType: compressed.mimeType,
          generationId,
        }
        if (pkg === 'end') {
          await putPendingEvidence({
            shiftId,
            package: pkg,
            slot,
            generationId,
            fileName: file.name || `${slot}.jpg`,
            mimeType: compressed.mimeType,
            lastModified: file.lastModified,
            bytes: compressed.bytes,
          })
          setPendingGenerationId(generationId)
        }
        attempt = nextPhotoAttempt(attemptSequence.current, prepared)
        attemptSequence.current = attempt.id
        currentAttempt.current = attempt
      } catch (error) {
        const reason = error instanceof Error && /^[a-z0-9_]+$/i.test(error.message)
          ? ` (${error.message})`
          : ''
        setUploadError(`${t.shift.photoPreparationFailed}${reason}`)
        setState('error')
        return
      }

      try {
        await execute(attempt, 'selection')
      } catch {
        /*
         * `upload()` owns and reports every PUT failure. A rejection escaping `execute` therefore
         * happened only after the server accepted the evidence, while a local/cloud reader was
         * starting. Never repaint accepted evidence as a preparation/upload failure or offer a
         * duplicate PUT; the separate read state and its retry control own that failure.
         */
        if (isCurrentPhotoAttempt(currentAttempt.current, attempt)) {
          setUploadError(null)
          setState('done')
        }
      }
    },
    [t, recognitionQuality, recognitionFocus, pkg, shiftId, slot, execute],
  )

  const retryUpload = useCallback((): void => {
    const attempt = currentAttempt.current
    if (!attempt || state === 'preparing' || state === 'uploading') return
    setState('uploading')
    void execute(attempt, 'upload_retry')
  }, [execute, state])

  /*
   * Re-read the bytes the SERVER already holds, never the bytes in this browser.
   *
   * There used to be a fallback here that called `runLegacyCloudRead` directly when `onRetryRead`
   * was absent. It was unreachable — `canRetryRead` requires `onRetryRead`, so the button could
   * never invoke it — but it described something the system must not do: publish a machine reading
   * for bytes that were never stored. `odoOcr` ships as `odometerKmOcr`, the SRS D-3 baseline a
   * manager reviews against the driver's typed number, so a reading whose evidence does not exist
   * is an audit trail that cannot be checked. Removed rather than left as a trap.
   */
  const retryRead = useCallback((): void => {
    void onRetryRead?.()
  }, [onRetryRead])

  const remove = useCallback(async (): Promise<void> => {
    if (!onDelete) return
    setConfirming(false)
    setState('uploading')
    try {
      const deleted =
        pkg === 'end' && attachment !== null && closeDraftRevision !== null
          ? await api.deleteCloseDraftAttachment(shiftId, slot, {
              expectedRevision: closeDraftRevision,
              expectedAttachmentToken: attachment.attachmentToken,
            })
          : (await api.del(uploadEvidencePath(shiftId, pkg, slot)), null)
      if (deleted) onCloseDraft?.(deleted.draft)
      const generationId = currentAttempt.current?.file.generationId
      currentAttempt.current = null
      setPicked(null)
      setUploadResult(null)
      setUploadError(null)
      setState('idle')
      onDelete(slot)
      await deletePendingEvidence(shiftId, pkg, slot, generationId)
      setPendingGenerationId(null)
    } catch (error) {
      const apiError = error as ApiError
      const detail = apiError.detail as { current?: CloseDraftView } | undefined
      if (detail?.current) onCloseDraft?.(detail.current)
      setState('done')
    }
  }, [
    api,
    shiftId,
    pkg,
    slot,
    attachment,
    closeDraftRevision,
    onCloseDraft,
    onDelete,
  ])

  const openPicker = (): void => {
    if (state === 'preparing' || state === 'uploading') return
    ref.current?.click()
  }

  const toggleHistory = useCallback(async (): Promise<void> => {
    if (pkg !== 'end') return
    if (historyOpen) {
      setHistoryOpen(false)
      return
    }
    setHistoryOpen(true)
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const response = await api.closeDraftAttachmentHistory(shiftId)
      setHistoryItems(response.history.filter((item) => item.slot === slot && !item.isCurrent))
    } catch {
      setHistoryError(t.shift.attachmentHistoryFailed)
    } finally {
      setHistoryLoading(false)
    }
  }, [api, shiftId, pkg, slot, historyOpen, t])

  const restoreHistory = useCallback(
    async (item: CloseDraftAttachmentHistoryItem): Promise<void> => {
      const reason = restoreReason.trim()
      if (closeDraftRevision === null || reason.length === 0) return
      setRestoringHistoryId(item.historyId)
      setHistoryError(null)
      try {
        const response = await api.restoreCloseDraftAttachment(shiftId, item.historyId, {
          expectedRevision: closeDraftRevision,
          expectedAttachmentToken: attachment?.attachmentToken ?? null,
          reason,
        })
        const generationId = currentAttempt.current?.file.generationId
        currentAttempt.current = null
        setPicked(null)
        setPendingGenerationId(null)
        setUploadResult(null)
        setUploadError(null)
        setRestoreReason('')
        setHistoryOpen(false)
        setState('done')
        await deletePendingEvidence(shiftId, pkg, slot, generationId)
        onCloseDraft?.(response.draft)
      } catch (error) {
        const apiError = error as ApiError
        const detail = apiError.detail as { current?: CloseDraftView } | undefined
        if (detail?.current) onCloseDraft?.(detail.current)
        setHistoryError(t.shift.attachmentRestoreFailed)
      } finally {
        setRestoringHistoryId(null)
      }
    },
    [
      api,
      shiftId,
      pkg,
      slot,
      restoreReason,
      closeDraftRevision,
      attachment?.attachmentToken,
      onCloseDraft,
      t,
    ],
  )

  const input = (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      {...(source === 'camera' ? { capture: 'environment' as const } : {})}
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0]
        if (file) void onPick(file)
        event.target.value = ''
      }}
    />
  )

  const age = uploadResult === null ? null : photoAgeFromClockSkew(uploadResult.clockSkewMs)
  const ageWarning =
    age?.kind === 'stale'
      ? t.shift.photoOld.replace(
          '{n}',
          age.minutes < 60 ? `${age.minutes}m` : `${Math.round(age.minutes / 60)}h`,
        )
      : null
  const read = attachment?.read ?? null
  const readLabel =
    read === null || read.status === 'idle'
      ? t.shift.readStateIdle
      : read.status === 'running'
        ? t.shift.readStateRunning
        : read.status === 'complete'
          ? t.shift.readStateComplete
          : read.failure === 'wrong_screen'
            ? t.shift.wrongScreen
            : t.shift.readStateFailed
  const readTone =
    read?.status === 'complete'
      ? 'text-emerald-700'
      : read?.status === 'failed'
        ? read.failure === 'wrong_screen'
          ? 'text-red-700'
          : 'text-amber-800'
        : 'text-slate-500'
  const canRetryRead = Boolean(
    onRetryRead &&
      attached &&
      !(state === 'error' && currentAttempt.current) &&
      read?.status !== 'running' &&
      read?.status !== 'complete',
  )
  const restoredThumbnail = attachment ? closeDraftThumbnailPath(shiftId, attachment.mediaId) : null

  const controls = (
    <div className="mt-1 flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-1 text-[10px] leading-tight">
        <span className={state === 'error' ? 'text-red-700' : attached ? 'text-emerald-700' : 'text-slate-500'}>
          {state === 'preparing' || state === 'uploading'
            ? t.common.loading
            : state === 'error'
              ? t.shift.uploadStateFailed
              : attached
                ? t.shift.uploadStateComplete
                : t.shift.uploadStateIdle}
        </span>
        {attachment ? <span className={readTone}>· {readLabel}</span> : null}
      </div>
      {state === 'error' && currentAttempt.current ? (
        <button
          type="button"
          onClick={retryUpload}
          className="min-h-9 rounded-lg bg-red-50 px-1 text-[11px] font-medium text-red-700"
        >
          {t.shift.retryUpload}
        </button>
      ) : null}
      {state === 'error' && !currentAttempt.current ? (
        <button
          type="button"
          onClick={openPicker}
          className="min-h-9 rounded-lg bg-red-50 px-1 text-[11px] font-medium text-red-700"
        >
          {t.shift.chooseAnotherImage}
        </button>
      ) : null}
      {canRetryRead ? (
        <button
          type="button"
          onClick={retryRead}
          className="min-h-9 rounded-lg bg-amber-50 px-1 text-[11px] font-medium text-amber-900"
        >
          {t.shift.retryRead}
        </button>
      ) : null}
      {uploadError ? <p className="break-words text-center text-[10px] text-red-700">{uploadError}</p> : null}
      {pkg === 'end' && closeDraftRevision !== null ? (
        <div className="min-w-0 border-t border-slate-100 pt-1">
          <button
            type="button"
            onClick={() => void toggleHistory()}
            className="min-h-8 w-full rounded-lg px-1 text-[10px] font-medium text-slate-500"
            aria-expanded={historyOpen}
          >
            {historyOpen ? t.shift.hideAttachmentHistory : t.shift.attachmentHistory}
          </button>
          {historyOpen ? (
            <div className="mt-1 min-w-0 space-y-2 rounded-xl bg-slate-50 p-2 text-start">
              {historyLoading ? <p className="text-[10px] text-slate-500">{t.common.loading}</p> : null}
              {!historyLoading && historyItems.length === 0 && !historyError ? (
                <p className="text-[10px] text-slate-500">{t.shift.noAttachmentHistory}</p>
              ) : null}
              {historyItems.length > 0 ? (
                <label className="block text-[10px] text-slate-600">
                  <span>{t.shift.attachmentRestoreReason}</span>
                  <input
                    value={restoreReason}
                    onChange={(event) => setRestoreReason(event.target.value)}
                    maxLength={240}
                    className="mt-1 min-h-9 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2 text-xs"
                  />
                </label>
              ) : null}
              {historyItems.map((item) => {
                const attachedAt = item.attachedAt ?? (item.attachedAtMs ? new Date(item.attachedAtMs).toISOString() : '')
                return (
                  <div
                    key={item.historyId}
                    className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-2 rounded-lg bg-white p-1.5"
                  >
                    <img
                      src={closeDraftThumbnailPath(shiftId, item.mediaId)}
                      alt=""
                      className="size-10 rounded-md object-cover"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-[10px] text-slate-500" dir="ltr">
                        {attachedAt || item.mediaId}
                      </p>
                      <button
                        type="button"
                        disabled={restoreReason.trim().length === 0 || restoringHistoryId !== null}
                        onClick={() => void restoreHistory(item)}
                        className="mt-1 min-h-8 w-full rounded-lg bg-slate-900 px-2 text-[10px] font-medium text-white disabled:opacity-40"
                      >
                        {restoringHistoryId === item.historyId ? t.common.loading : t.shift.restoreAttachment}
                      </button>
                    </div>
                  </div>
                )
              })}
              {historyError ? <p className="break-words text-[10px] text-red-700">{historyError}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )

  if (variant === 'tile') {
    return (
      <div className="flex min-w-0 flex-col">
        <button
          type="button"
          onClick={openPicker}
          aria-label={label}
          title={label}
          className={`relative flex aspect-square w-full min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl border-2 ${
            state === 'error'
              ? 'border-red-400 bg-red-50'
              : attached
                ? 'border-emerald-400 bg-emerald-50'
                : 'border-dashed border-slate-300 bg-white'
          }`}
        >
          <span className="absolute end-1 top-1 z-10 text-xs" aria-hidden>
            {state === 'error' ? '✕' : attached ? '✓' : ''}
          </span>
          {restoredThumbnail ? (
            <img src={restoredThumbnail} alt="" className="absolute inset-0 size-full object-cover opacity-60" />
          ) : preview ? (
            <img src={preview} alt="" className="absolute inset-0 size-full object-cover opacity-60" />
          ) : null}
          <span className="num relative text-xl font-bold text-slate-700">
            {badge ?? (attached ? '' : '📷')}
          </span>
          {state === 'preparing' || state === 'uploading' ? (
            <span className="relative text-[10px] leading-none text-slate-700">{t.common.loading}</span>
          ) : null}
          {input}
        </button>
        {controls}
        {onDelete && attached ? (
          <button
            type="button"
            onClick={() => (confirming ? void remove() : setConfirming(true))}
            onBlur={() => setConfirming(false)}
            className={`mt-1 min-h-8 w-full rounded-lg px-1 text-[10px] font-medium ${
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
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        onClick={openPicker}
        className={`flex min-h-20 min-w-0 items-center justify-between rounded-2xl border-2 border-dashed px-4 ${
          state === 'error'
            ? 'border-red-400 bg-red-50'
            : attached
              ? 'border-emerald-400 bg-emerald-50'
              : 'border-slate-300 bg-white'
        }`}
      >
        <span className="min-w-0 truncate text-sm font-medium">{label}</span>
        <span className="shrink-0 text-xl" aria-hidden>
          {state === 'preparing' || state === 'uploading'
            ? '…'
            : state === 'error'
              ? '✕'
              : attached
                ? '✓'
                : '📷'}
        </span>
        {input}
      </button>
      {controls}
      {ageWarning ? <p className="text-xs text-amber-700">{ageWarning}</p> : null}
    </div>
  )
}
