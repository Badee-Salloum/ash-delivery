// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloseDraftAttachment } from '@ash/client'

const storage = vi.hoisted(() => ({
  record: null as {
    version: 2
    key: string
    shiftId: string
    package: 'end'
    slot: string
    generationId: string
    acceptedAttachmentToken: string | null
    fileName: string
    mimeType: string
    lastModified: number
    createdAt: number
    savedAt: number
    bytes: ArrayBuffer
  } | null,
  deletePendingEvidence: vi.fn(async () => {
    storage.record = null
  }),
}))

vi.mock('../src/pending-evidence-storage.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pending-evidence-storage.ts')>()
  return {
    ...actual,
    getPendingEvidence: vi.fn(async () => storage.record),
    deletePendingEvidence: storage.deletePendingEvidence,
  }
})

const words = new Proxy<Record<string, string>>({}, {
  get: (_target, property) => String(property),
})

vi.mock('../src/app-context.tsx', () => ({
  useApp: () => ({ api: {}, t: { common: words, shift: words } }),
}))

import { PhotoSlot } from '../src/screens/PhotoSlot.tsx'
import { FeedbackProvider } from '../src/feedback.tsx'

function attachment(attachmentToken: string): CloseDraftAttachment {
  return {
    package: 'end',
    slot: 'dashboard',
    mediaId: `media-${attachmentToken}`,
    attachmentToken,
    read: {
      readId: `read-${attachmentToken}`,
      field: 'orders',
      status: 'complete',
      failure: null,
      attempts: 1,
    },
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}

describe('PhotoSlot retained-evidence terminal cleanup', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    storage.deletePendingEvidence.mockClear()
    storage.record = {
      version: 2,
      key: 'shift-1:end:dashboard',
      shiftId: 'shift-1',
      package: 'end',
      slot: 'dashboard',
      generationId: 'local-new',
      acceptedAttachmentToken: 'attachment-new',
      fileName: 'dashboard.jpg',
      mimeType: 'image/jpeg',
      lastModified: 1,
      createdAt: 1,
      savedAt: 1,
      bytes: new Uint8Array([1, 2, 3]).buffer,
    }
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('explains partial payment-log reads and clears the warning after a complete retry', async () => {
    storage.record = null
    const partial: CloseDraftAttachment = { ...attachment('log'), slot: 'payments_log', read: {
      readId: 'partial-log', field: 'payments_log', status: 'failed', failure: 'no_fields', attempts: 1, rowCount: 2,
    } }
    const render = (current: CloseDraftAttachment) => root.render(
      <FeedbackProvider>
        <PhotoSlot shiftId="shift-1" pkg="end" slot="payments_log" label="payments log"
          attachment={current} onUploaded={vi.fn()} onRetryRead={vi.fn()} />
      </FeedbackProvider>,
    )
    await act(async () => render(partial))
    await flushEffects()
    expect(container.textContent).toContain('readStatePartialPayments')
    expect(container.textContent).not.toContain('readStateComplete')
    await act(async () => render({ ...partial, read: { ...partial.read!, readId: 'complete-log', status: 'complete', failure: null, attempts: 2 } }))
    await flushEffects()
    expect(container.textContent).toContain('readStateComplete')
    expect(container.textContent).not.toContain('readStatePartialPayments')
  })

  it('does not let an older attachment terminal result delete a pending replacement', async () => {
    await act(async () => root.render(
      <FeedbackProvider>
        <PhotoSlot
          shiftId="shift-1"
          pkg="end"
          slot="dashboard"
          label="dashboard"
          attachment={attachment('attachment-old')}
          onUploaded={vi.fn()}
        />
      </FeedbackProvider>,
    ))
    await flushEffects()

    expect(storage.deletePendingEvidence).not.toHaveBeenCalled()
    expect(container.textContent).toContain('uploadStateFailed')
    expect(container.textContent).toContain('retryUpload')
  })

  it('settles an accepted same-token terminal generation without a second reload', async () => {
    await act(async () => root.render(
      <FeedbackProvider>
        <PhotoSlot
          shiftId="shift-1"
          pkg="end"
          slot="dashboard"
          label="dashboard"
          attachment={attachment('attachment-new')}
          onUploaded={vi.fn()}
        />
      </FeedbackProvider>,
    ))
    await flushEffects()

    expect(storage.deletePendingEvidence).toHaveBeenCalledWith(
      'shift-1',
      'end',
      'dashboard',
      'local-new',
    )
    expect(container.textContent).toContain('uploadStateComplete')
    expect(container.textContent).not.toContain('retryUpload')
  })
})
