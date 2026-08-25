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

  it('does not let an older attachment terminal result delete a pending replacement', async () => {
    await act(async () => root.render(
      <PhotoSlot
        shiftId="shift-1"
        pkg="end"
        slot="dashboard"
        label="dashboard"
        attachment={attachment('attachment-old')}
        onUploaded={vi.fn()}
      />,
    ))
    await flushEffects()

    expect(storage.deletePendingEvidence).not.toHaveBeenCalled()
    expect(container.textContent).toContain('uploadStateFailed')
    expect(container.textContent).toContain('retryUpload')
  })

  it('settles an accepted same-token terminal generation without a second reload', async () => {
    await act(async () => root.render(
      <PhotoSlot
        shiftId="shift-1"
        pkg="end"
        slot="dashboard"
        label="dashboard"
        attachment={attachment('attachment-new')}
        onUploaded={vi.fn()}
      />,
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
