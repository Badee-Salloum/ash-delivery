import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { buildDeps } from '../src/deps.ts'

/**
 * `OCR_DRIVER` picks the reader, and the reader's cache signature is persisted to
 * `ocr_reads.cache_signature`. If two providers can produce the SAME signature, a swap — or the
 * revert — silently serves rows the other one produced, and nothing downstream can tell.
 */
async function readerFor(env: NodeJS.ProcessEnv) {
  const built = await buildDeps(loadConfig(env))
  try {
    return {
      available: built.deps.ocr.available,
      model: built.deps.ocr.model,
      signature: built.deps.ocr.cacheSignature('orders'),
    }
  } finally {
    await built.dispose()
  }
}

describe('OCR_DRIVER selects a reader that cannot be confused with another', () => {
  it('none is the kill switch: unavailable, and it never calls out', async () => {
    const r = await readerFor({} as NodeJS.ProcessEnv)
    expect(r.available).toBe(false)
  })

  it('openai reads with gpt-5.4 and signs as openai', async () => {
    const r = await readerFor({ OCR_DRIVER: 'openai', OPENAI_API_KEY: 'sk-x' } as NodeJS.ProcessEnv)
    expect(r.available).toBe(true)
    expect(r.model).toBe('gpt-5.4')
    expect(r.signature.startsWith('openai@api.openai.com:gpt-5.4:')).toBe(true)
  })

  it('openrouter reads with gemini-3.7-flash and signs as openrouter', async () => {
    const r = await readerFor({ OCR_DRIVER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-x' } as NodeJS.ProcessEnv)
    expect(r.available).toBe(true)
    expect(r.model).toBe('google/gemini-3.7-flash')
    expect(r.signature.startsWith('openrouter@openrouter.ai:google/gemini-3.7-flash:')).toBe(true)
  })

  it('the two providers can never collide on a cache signature', async () => {
    const openai = await readerFor({ OCR_DRIVER: 'openai', OPENAI_API_KEY: 'sk-x' } as NodeJS.ProcessEnv)
    const openrouter = await readerFor({ OCR_DRIVER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-x' } as NodeJS.ProcessEnv)
    expect(openai.signature).not.toBe(openrouter.signature)
  })
})
