import { describe, expect, it } from 'vitest'
import { includedByOperationWindow } from '../src/operation-window.ts'

describe('automatic operation-window inclusion', () => {
  it.each([
    ['in_window', true],
    ['open_minute_boundary', true],
    ['close_minute_boundary', true],
    ['pre_open', false],
    ['post_close', false],
    ['unknown', false],
  ] as const)('%s -> %s', (status, included) => {
    expect(includedByOperationWindow(status)).toBe(included)
  })
})
