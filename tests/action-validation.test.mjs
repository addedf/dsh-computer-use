import test from 'node:test'
import assert from 'node:assert/strict'
import { click, drag, dispatchKey, wait } from '../lib/actions.js'
import { setSnapshot } from '../lib/snapshot.js'

test('malformed shortcuts are rejected rather than silently dropping keys', async () => {
  for (const key of ['cmd+a+b', 'cmd+', 'ctrl+ctrl+a']) {
    await assert.rejects(dispatchKey({ key }, {}), /组合键/)
  }
})

test('invalid and out-of-window clicks fail before any driver call', async () => {
  setSnapshot({ at: Date.now(), pid: 1, windowId: 2, screenshotWidth: 10, screenshotHeight: 20 })
  for (const args of [{ x: NaN, y: 1 }, { x: -1, y: 1 }, { x: 10, y: 1 }, { x: 1, y: 20 }, { x: 1, y: 1, count: 0 }, { element: 1, x: 1, y: 1 }]) {
    await assert.rejects(click(args, { ttlMs: 10000 }))
  }
})

test('invalid drag coordinates do not reach the driver', async () => {
  let called = false
  await assert.rejects(drag({ from_x: 1, from_y: 1, to_x: Infinity, to_y: 1 }, { ttlMs: 10000 }, {
    resolve: () => ({ pid: 1, windowId: 2 }), call: async () => { called = true },
  }), /范围内的整数/)
  assert.equal(called, false)
})

test('cancelled wait ends promptly and zero wait stays zero', async () => {
  const controller = new AbortController()
  const pending = wait({ ms: 60000 }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /取消/)
  assert.match((await wait({ ms: 0 })).result, /0ms/)
})
