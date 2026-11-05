import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolScope, getExecutionSignal, getSessionState } from '../lib/session.js'

test('nested executions use their own signal and restore the parent signal', async () => {
  const run = createToolScope(),
    agent = { session: {} }
  const parent = new AbortController(),
    child = new AbortController()
  await run({ agent, signal: parent.signal }, async () => {
    const state = getSessionState()
    assert.equal(getExecutionSignal(), parent.signal)
    await run({ agent, signal: child.signal }, async () => {
      await Promise.resolve()
      assert.equal(getExecutionSignal(), child.signal)
      assert.equal(getSessionState(), state)
      child.abort()
      assert.equal(getExecutionSignal().aborted, true)
    })
    assert.equal(getExecutionSignal(), parent.signal)
    assert.equal(getExecutionSignal().aborted, false)
    assert.equal('signal' in state, false)
    assert.equal('executionSignal' in state, false)
    await run({ agent }, () => assert.equal(getExecutionSignal(), undefined))
    assert.equal(getExecutionSignal(), parent.signal)
  })
  assert.equal(getExecutionSignal(), undefined)
})

test('queued cleanup drops the cancelled invocation signal without replacing its owner', async () => {
  const run = createToolScope(),
    agent = { session: {} },
    abort = new AbortController()
  let cleanup, state
  await run({ agent, signal: abort.signal }, () => {
    state = getSessionState()
    abort.abort()
    cleanup = run(
      { agent },
      async () => {
        await Promise.resolve()
        assert.equal(getExecutionSignal(), undefined)
        assert.equal(getSessionState(), state)
      },
      { enqueue: true },
    )
  })
  await cleanup
  await run({ agent, signal: new AbortController().signal }, () => {
    assert.equal(getExecutionSignal().aborted, false)
    assert.equal(getSessionState(), state)
  })
})

test('concurrent plugin scopes for the same owner cannot overwrite execution signals', async () => {
  const first = createToolScope(),
    second = createToolScope(),
    agent = { session: {} }
  const a = new AbortController(),
    b = new AbortController()
  let entered, release
  const ready = new Promise((resolve) => {
    entered = resolve
  })
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  let firstState
  const pending = first({ agent, signal: a.signal }, async () => {
    firstState = getSessionState()
    entered()
    await blocked
    assert.equal(getExecutionSignal(), a.signal)
    assert.equal(getExecutionSignal().aborted, false)
  })
  await ready
  await second({ agent, signal: b.signal }, async () => {
    assert.equal(getSessionState(), firstState)
    b.abort()
    await Promise.resolve()
    assert.equal(getExecutionSignal(), b.signal)
    assert.equal(getExecutionSignal().aborted, true)
  })
  release()
  await pending
})

test('queued owners each receive their own invocation signal', async () => {
  const run = createToolScope(),
    a = new AbortController(),
    b = new AbortController()
  const seen = []
  await Promise.all([
    run({ agent: {}, signal: a.signal }, async () => {
      await Promise.resolve()
      seen.push(getExecutionSignal())
    }),
    run({ agent: {}, signal: b.signal }, () => seen.push(getExecutionSignal())),
  ])
  assert.deepEqual(seen, [a.signal, b.signal])
})
