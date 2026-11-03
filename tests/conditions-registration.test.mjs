import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../index.js'

function registered() {
  const definitions = new Map()
  const ctx = {
    tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } },
    approval: { request: async () => { throw new Error('Read-only conditions must not request action approval.') } },
    logger: { info() {} },
    get() {},
  }
  plugin.apply(ctx, { ttlMs: 1000, cursorTheme: '' })
  return definitions
}

test('actual Cordis plugin registration exposes all declarative condition tools', () => {
  const definitions = registered()
  for (const name of ['computer_verify', 'computer_wait_for', 'browser_verify', 'browser_wait_for']) {
    const tool = definitions.get(name)
    assert.ok(tool, name)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('registered condition tools preserve structured cancellation before any driver initialization', async () => {
  const definitions = registered()
  const exec = { agent: { session: {} }, signal: AbortSignal.abort() }
  for (const name of ['computer_verify', 'computer_wait_for', 'browser_verify', 'browser_wait_for']) {
    const expect = name.startsWith('browser_') ? [{ kind: 'text', value: 'Ready' }] : [{ window: { exists: true } }]
    const value = await definitions.get(name).execute({ expect }, exec)
    assert.equal(value.ok, false)
    assert.equal(value.status, 'cancelled')
    assert.equal(value.matched, false)
    assert.equal(value.data.status, 'cancelled')
  }
})

test('registered native condition failure without observation is structured and read-only', async () => {
  const value = await registered().get('computer_verify').execute({ expect: [{ window: { exists: true } }] }, { agent: { session: {} } })
  assert.equal(value.ok, false)
  assert.equal(value.status, 'error')
  assert.equal(value.matched, false)
  assert.equal(value.data.code, 'NO_SNAPSHOT')
})
