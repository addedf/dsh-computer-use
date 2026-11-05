import test from 'node:test'
import assert from 'node:assert/strict'
import { captureDriverRelease, captureImmediateDriverEnd, computerStatus } from '../lib/control-status.js'
import { createCuaCall } from '../lib/cua.js'
import { createToolScope, getSessionState } from '../lib/session.js'

const record = (id = 'exact-owner') => ({ state: { driverSession: id, initialized: true } })

test('normal release captures actual disabled/hidden observations before the acknowledged end', async () => {
  const owner = record(), calls = []
  const evidence = await captureDriverRelease(owner, { call: async (tool, args) => {
    calls.push({ tool, args })
    if (tool === 'get_agent_cursor_state') return { enabled: false, visibility: { actual_visible: false } }
    if (tool === 'get_session') return { id: args.session, cursor_visible: false, lifecycle: 'active' }
    return { ok: true }
  } })
  assert.equal(evidence, owner.state.lastDriverRelease)
  assert.equal(evidence.kind, 'historical-release-evidence')
  assert.equal(evidence.mode, 'normal')
  assert.equal(evidence.disable.ok, true)
  assert.equal(evidence.beforeEnd.cursor.data.visibility.actual_visible, false)
  assert.equal(evidence.beforeEnd.lifecycle.data.cursor_visible, false)
  assert.equal(evidence.end.ok, true)
  assert.equal(calls[0].tool, 'set_agent_cursor_enabled')
  assert.equal(calls[0].args.enabled, false)
  assert.deepEqual(calls.slice(1, -1).map((entry) => entry.tool).sort(), ['get_agent_cursor_state', 'get_session'])
  assert.equal(calls.at(-1).tool, 'end_session')
  assert.ok(calls.every((entry) => entry.args.session === 'exact-owner'))
})

for (const failedTool of ['set_agent_cursor_enabled', 'get_agent_cursor_state', 'get_session', 'end_session']) {
  test(`release failure stays explicit and still ends the exact session: ${failedTool}`, async () => {
    const owner = record(), calls = []
    const evidence = await captureDriverRelease(owner, { call: async (tool) => {
      calls.push(tool)
      if (tool === failedTool) throw Object.assign(new Error('private failure detail'), { code: 'DRIVER_EXIT' })
      return { ok: true }
    } })
    assert.equal(calls.at(-1), 'end_session')
    const step = failedTool === 'set_agent_cursor_enabled' ? evidence.disable
      : failedTool === 'end_session' ? evidence.end
        : evidence.beforeEnd[failedTool === 'get_session' ? 'lifecycle' : 'cursor']
    assert.equal(step.ok, false)
    assert.equal(step.error.code, 'DRIVER_EXIT')
    if (failedTool === 'set_agent_cursor_enabled') assert.deepEqual(calls, ['set_agent_cursor_enabled', 'end_session'])
    assert.equal(JSON.stringify(evidence).includes('private failure detail'), false)
  })
}

test('missing, refused or malformed command replies are never acknowledged as successful cleanup', async () => {
  for (const response of [undefined, null, 'unknown response', { ok: false }, { error: 'failure' }]) {
    const calls = []
    const evidence = await captureDriverRelease(record(), { call: async (tool) => { calls.push(tool); return response } })
    assert.equal(evidence.disable.ok, false)
    assert.equal(evidence.end.ok, false)
    assert.deepEqual(calls, ['set_agent_cursor_enabled', 'end_session'])
  }
})

test('slow reads are bounded, finally end still runs and late results cannot rewrite evidence', async () => {
  const owner = record(), calls = []
  let lateCursor
  const evidence = await captureDriverRelease(owner, { observationTimeoutMs: 15, call: async (tool) => {
    calls.push(tool)
    if (tool === 'get_agent_cursor_state') return new Promise((resolve) => { lateCursor = resolve })
    return { ok: true }
  } })
  assert.equal(evidence.beforeEnd.cursor.error.code, 'CONTROL_STATUS_TIMEOUT')
  assert.equal(evidence.end.ok, true)
  assert.equal(calls.at(-1), 'end_session')
  const before = JSON.stringify(evidence)
  lateCursor({ enabled: true, visible: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(JSON.stringify(evidence), before)
})

test('Stop ends immediately during observation and its first ACK survives the duplicate end refusal', async () => {
  const owner = record(), calls = []
  let releaseRead, enteredRead
  const ready = new Promise((resolve) => { enteredRead = resolve })
  const call = async (tool) => {
    calls.push(tool)
    if (tool === 'get_agent_cursor_state') { enteredRead(); return new Promise((resolve) => { releaseRead = resolve }) }
    if (tool === 'end_session' && calls.filter((name) => name === tool).length > 1) throw Object.assign(new Error('already ended'), { code: 'DRIVER_EXIT' })
    return { ok: true }
  }
  const finalizing = captureDriverRelease(owner, { call })
  await ready
  owner.immediateEnd = captureImmediateDriverEnd(owner, { call })
  assert.equal(calls.at(-1), 'end_session')
  await owner.immediateEnd
  releaseRead({ visible: false })
  const evidence = await finalizing
  assert.equal(evidence.mode, 'interrupted')
  assert.equal(evidence.immediateEnd.ok, true)
  assert.equal(evidence.end.ok, false)
  assert.equal(evidence.beforeEnd.skipped, true)
  assert.equal(evidence.beforeEnd.reason, 'revoked-during-observation')
})

test('already-interrupted final cleanup never probes and release observations remain bounded', async () => {
  const owner = record(), calls = []
  owner.immediateEnd = Promise.resolve()
  const interrupted = await captureDriverRelease(owner, { call: async (tool) => { calls.push(tool); return { ok: true } } })
  assert.deepEqual(calls, ['set_agent_cursor_enabled', 'end_session'])
  assert.equal(interrupted.beforeEnd.reason, 'immediate-end-issued')
  const bounded = await captureDriverRelease(record('other'), { call: async (tool) => tool.startsWith('get_') ? { value: 'x'.repeat(17000) } : { ok: true } })
  assert.equal(bounded.beforeEnd.cursor.ok, false)
  assert.equal(bounded.beforeEnd.lifecycle.ok, false)
  assert.ok(JSON.stringify(bounded).length < 2000)
  assert.equal(bounded.end.ok, true)
})

test('history is owner-scoped, never masks failed live reads, and new owned starts clear stale evidence', async () => {
  const actor = { session: {} }
  await createToolScope()({ agent: actor }, async () => {
    const state = getSessionState(), own = state.driverSession
    state.lastDriverRelease = { sessionId: own, kind: 'historical-release-evidence', end: { ok: true } }
    const lastRelease = state.lastDriverRelease
    const value = await computerStatus({ scope: 'control' }, { state, call: async () => { throw Object.assign(new Error('ended'), { code: 'DRIVER_EXIT' }) } })
    assert.equal(value.ok, false)
    assert.equal(value.data.cursor.ok, false)
    assert.deepEqual(value.data.lastRelease, lastRelease)
    value.data.lastRelease.end.ok = false
    assert.equal(lastRelease.end.ok, true)
    const foreign = await computerStatus({ scope: 'control' }, { state: { driverSession: 'different', lastDriverRelease: lastRelease }, call: async () => ({ ok: true }) })
    assert.equal('lastRelease' in foreign.data, false)
    const call = createCuaCall(async () => ({ ok: true }))
    await call('health_report', { session: own })
    assert.equal(state.lastDriverRelease, lastRelease)
    assert.equal(state.driverTouched, undefined)
    await call('start_session', { session: own })
    assert.equal(state.lastDriverRelease, null)
  })
})
