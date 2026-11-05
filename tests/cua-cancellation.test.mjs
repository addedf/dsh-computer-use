import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { createCuaCall, createRawCuaCall } from '../lib/cua.js'
import { createToolScope, getSessionState } from '../lib/session.js'

function childProcess() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kills = []
  child.kill = (signal) => {
    child.kills.push(signal)
    queueMicrotask(() => child.emit('close', null))
    return true
  }
  return child
}

test('pre-aborted raw calls do not resolve a binary or spawn a child', async () => {
  const abort = new AbortController()
  abort.abort()
  const raw = createRawCuaCall({
    resolveBinary: () => assert.fail('binary resolution must not run'),
    spawnFn: () => assert.fail('cancelled call must not spawn'),
  })
  await assert.rejects(raw('click', {}, { signal: abort.signal }), { code: 'CANCELLED' })
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
})

test('in-flight cancellation terminates one child, ignores late output and never recovers or replays', async () => {
  const abort = new AbortController(),
    calls = [],
    children = []
  const raw = createRawCuaCall({
    spawnFn: (_binary, argv) => {
      calls.push(argv[1])
      const child = childProcess()
      children.push(child)
      return child
    },
  })
  const call = createCuaCall(raw)
  const pending = call('click', { session: 'own' }, { signal: abort.signal })
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1)
  abort.abort()
  children[0].stdout.write(JSON.stringify({ ok: true }))
  children[0].emit('close', 0)
  children[0].emit('error', new Error('late session has ended'))
  await assert.rejects(
    pending,
    (error) => error.code === 'CANCELLED' && /可能已执行/.test(error.message),
  )
  assert.deepEqual(calls, ['click'])
  assert.deepEqual(children[0].kills, ['SIGTERM'])
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
})

test('a successful raw call removes its listener so later cancellation does not kill it', async () => {
  const abort = new AbortController(),
    child = childProcess()
  const raw = createRawCuaCall({
    spawnFn: () => {
      queueMicrotask(() => {
        child.stdout.write('{"ok":true}')
        child.emit('close', 0)
      })
      return child
    },
  })
  assert.deepEqual(await raw('click', {}, { signal: abort.signal }), { ok: true })
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  abort.abort()
  assert.deepEqual(child.kills, [])
})

test('cancellation in a spawner is observed after registration and stops the new child', async () => {
  const abort = new AbortController(),
    child = childProcess()
  const raw = createRawCuaCall({
    spawnFn: () => {
      abort.abort()
      return child
    },
  })
  await assert.rejects(raw('click', {}, { signal: abort.signal }), { code: 'CANCELLED' })
  assert.deepEqual(child.kills, ['SIGTERM'])
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
})

test('owner-scoped signals reach raw calls and prevent a late adapter success', async () => {
  const run = createToolScope(),
    agent = { session: {} },
    abort = new AbortController()
  const calls = []
  const call = createCuaCall(async (tool, _args, options) => {
    calls.push(tool)
    assert.equal(options.signal, abort.signal)
    abort.abort()
    return { ok: true }
  })
  await run({ agent, signal: abort.signal }, async () => {
    await assert.rejects(
      call('click'),
      (error) => error.code === 'CANCELLED' && /可能已执行/.test(error.message),
    )
    await assert.rejects(call('type_text'), { code: 'CANCELLED' })
  })
  assert.deepEqual(calls, ['click'])
})

test('cancellation before or during session recovery cannot restart or replay an action', async () => {
  for (const duringRecovery of [false, true]) {
    const abort = new AbortController(),
      calls = []
    const call = createCuaCall(async (tool, _args, options) => {
      calls.push(tool)
      assert.equal(options.signal, abort.signal)
      if (tool === 'click') {
        if (!duringRecovery) abort.abort()
        throw new Error('session has ended; start_session')
      }
      abort.abort()
      return { ok: true }
    })
    await assert.rejects(call('click', { session: 'own' }, { signal: abort.signal }), {
      code: 'CANCELLED',
    })
    assert.deepEqual(calls, duringRecovery ? ['click', 'start_session'] : ['click'])
  }
})

test('exact cleanup remains available after abort while other reads and actions are cancelled', async () => {
  const run = createToolScope(),
    abort = new AbortController(),
    calls = []
  const call = createCuaCall(async (tool, args, options) => {
    calls.push({ tool, args })
    assert.equal(options.signal, undefined)
    return { ok: true }
  })
  await run({ agent: {}, signal: abort.signal }, async () => {
    const state = getSessionState()
    state.controlStopped = true
    state.controlReleasing = true
    abort.abort()
    const session = state.driverSession
    await call('set_agent_cursor_enabled', { session, enabled: false })
    await call('end_session', { session })
    await assert.rejects(call('set_agent_cursor_enabled', { session, enabled: true }), {
      code: 'CANCELLED',
    })
    await assert.rejects(call('health_report'), { code: 'CANCELLED' })
  })
  assert.deepEqual(
    calls.map((item) => item.tool),
    ['set_agent_cursor_enabled', 'end_session'],
  )
})
