import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createPlaywrightController } from '../lib/browser-playwright.js'
import { createToolScope, getSessionState } from '../lib/session.js'

// Deterministic controller-level checks. No browser, network, driver, or files.
async function fixture(check) {
  let clock = 1000
  const page = new EventEmitter()
  page.isClosed = () => false
  page.url = () => 'https://example.test/'
  page.title = async () => 'Safety fixture'
  const exec = { agent: { session: {} }, signal: new AbortController().signal }
  const state = {
    owned: true, backend: 'playwright', context: {},
    pages: new Map([['tab', page]]), tabId: 'tab',
    dialogs: new Map(), continuations: new Map(), observed: null, screenshot: null,
  }
  const ctx = { approval: { request: async () => { clock += 101; return 'allowed-once' } } }
  await createToolScope()(exec, async () => {
    getSessionState().browser = state
    const controller = createPlaywrightController(ctx, { ttlMs: 100 }, { now: () => clock })
    await check({ controller, state, page, exec })
  })
}

test('a screenshot that expires during approval cannot authorize a coordinate click', async () => fixture(async ({ controller, state, page, exec }) => {
  let clicks = 0
  page.mouse = { click: async () => { clicks++ } }
  state.screenshot = { at: 1000, tabId: 'tab', width: 100, height: 100 }
  const result = await controller.click({ x: 10, y: 10 }, exec)
  assert.equal(result.ok, false)
  assert.equal(clicks, 0)
  assert.match(result.result, /截图.*失效/)
  assert.equal(page.listenerCount('dialog'), 0)
}))

test('a dialog that expires during approval is neither accepted nor dismissed', async () => fixture(async ({ controller, state, exec }) => {
  let accepts = 0, dismissals = 0
  state.dialogs.set('tab', {
    id: 'dialog-fixture', at: 1000,
    dialog: { type: () => 'confirm', message: () => 'Confirm operation',
      accept: async () => { accepts++ }, dismiss: async () => { dismissals++ } },
  })
  const result = await controller.dialog({ action: 'accept', dialog_id: 'dialog-fixture' }, exec)
  assert.equal(result.ok, false)
  assert.equal(accepts, 0)
  assert.equal(dismissals, 0)
  assert.match(result.result, /对话框.*过期/)
}))

test('a failed frame inspection blocks typing into otherwise readable fields', async () => fixture(async ({ controller, page, exec }) => {
  let fills = 0
  const input = {
    evaluate: async () => ({ role: 'textbox', name: 'Name', actions: ['pointer', 'type'], protected: false, enabled: true,
      value: '', rect: { x: 0, y: 0, width: 100, height: 20 }, inViewport: true }),
    fill: async () => { fills++ }, dispose: async () => {},
  }
  input.asElement = () => input
  const metadata = { cursorValid: true, rows: [await input.evaluate()], text: 'Name input', used: { output: 1, safety: 1 }, outputComplete: true, safetyComplete: true, sensitive: false, stopReasons: [] }
  const readable = { evaluateHandle: async () => ({
    evaluate: async () => metadata,
    getProperty: async () => ({ getProperties: async () => new Map([['0', input]]), dispose: async () => {} }),
    dispose: async () => {},
  }) }
  const inaccessible = { evaluateHandle: async () => { throw new Error('frame inspection unavailable') } }
  page.frames = () => [readable, inaccessible]

  const observed = await controller.observe({}, exec)
  assert.equal(observed.ok, true)
  assert.equal(observed.data.inputBlocked, true)
  assert.equal(observed.data.complete, false)
  assert.equal(observed.data.refs.length, 1)
  const typed = await controller.type({ ref: observed.data.refs[0].ref, text: 'ordinary text', replace: true }, exec)
  assert.equal(typed.ok, false)
  assert.equal(fills, 0)
}))
