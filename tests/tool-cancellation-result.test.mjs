import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../index.js'
import { createToolScope, getSessionState } from '../lib/session.js'

test('the registered wrapper rejects a late adapter success after cancellation', async () => {
  const tools = new Map()
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => {}
      },
    },
    on: () => () => {},
    logger: { info() {}, warn() {} },
  }
  plugin.apply(ctx, { browserBackend: 'playwright', desktopIndicator: false })
  const controller = new AbortController()
  const exec = { agent: { session: {} }, signal: controller.signal }
  let finish, entered
  const waiting = new Promise((resolve) => {
    entered = resolve
  })
  const disposing = new Promise((resolve) => {
    finish = resolve
  })
  const running = createToolScope()(exec, async () => {
    const state = getSessionState()
    state.snapshot = { at: Date.now(), entries: new Map() }
    state.browser = {
      backend: 'playwright',
      owned: true,
      context: {},
      pages: new Map(),
      dispose: () => {
        entered()
        return disposing
      },
    }
    const value = await tools.get('browser_close').execute({}, exec)
    assert.equal(state.snapshot, null)
    return value
  })
  await waiting
  controller.abort()
  finish()
  const value = await running
  assert.equal(value.ok, false)
  assert.equal(value.errorCode, 'CANCELLED')
  assert.match(value.result, /可能已执行/)
})
