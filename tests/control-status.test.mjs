import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import plugin from '../index.js'
import { computerStatus } from '../lib/control-status.js'
import { createCuaCall } from '../lib/cua.js'
import { createToolScope, getSessionState } from '../lib/session.js'

test('default status retains the existing health report', async () => {
  const calls = [], report = { status: 'degraded', checks: [] }
  const value = await computerStatus({}, { call: async (tool, args) => { calls.push({ tool, args }); return report } })
  assert.deepEqual(JSON.parse(value.result), report)
  assert.equal(value.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tool, 'health_report')
})

test('control status queries exact owner cursor and lifecycle concurrently without mutating local state', async () => {
  const state = { driverSession: 'own-exact-session', initialized: false, driverTouched: false, controlStopped: true, snapshot: { untouched: true } }
  const before = structuredClone(state), calls = []
  let releaseCursor
  const cursorPending = new Promise((resolve) => { releaseCursor = resolve })
  const pending = computerStatus({ scope: 'control' }, { state, call: async (tool, args) => {
    calls.push({ tool, args })
    if (tool === 'get_agent_cursor_state') return cursorPending
    releaseCursor({ actual_driver_visibility: 'hidden' })
    return { actual_driver_lifecycle: 'ended' }
  } })
  const value = await pending
  assert.equal(value.ok, true)
  assert.deepEqual(calls, [
    { tool: 'get_agent_cursor_state', args: { session: 'own-exact-session' } },
    { tool: 'get_session', args: { session: 'own-exact-session' } },
  ])
  assert.deepEqual(value.data.cursor.data, { actual_driver_visibility: 'hidden' })
  assert.deepEqual(value.data.lifecycle.data, { actual_driver_lifecycle: 'ended' })
  assert.deepEqual(JSON.parse(value.result), value.data)
  assert.deepEqual(state, before)
})

test('control status rejects caller-selected sessions and invalid scopes before any driver read', async () => {
  let calls = 0
  for (const args of [{ scope: 'control', session: 'foreign' }, { scope: 'control', session_id: 'foreign' }, { scope: 'global' }]) {
    await assert.rejects(computerStatus(args, { call: async () => { calls++ } }), { code: 'CONTROL_STATUS_INVALID' })
  }
  const absent = await computerStatus({ scope: 'control' }, { state: {}, call: async () => { calls++ } })
  assert.equal(absent.ok, false)
  assert.equal(absent.data.error.code, 'NO_CONTROL_SESSION')
  assert.equal(calls, 0)
})

test('failed cursor read remains unknown even when lifecycle is readable and hides raw error diagnostics', async () => {
  const value = await computerStatus({ scope: 'control' }, { state: { driverSession: 'own' }, call: async (tool) => {
    if (tool === 'get_agent_cursor_state') throw Object.assign(new Error('private raw detail'), { code: 'DRIVER_TOOL_ERROR' })
    return { state: 'ended' }
  } })
  assert.equal(value.ok, false)
  assert.deepEqual(value.data.lifecycle, { ok: true, data: { state: 'ended' } })
  assert.equal(value.data.cursor.ok, false)
  assert.equal(value.data.cursor.error.code, 'DRIVER_TOOL_ERROR')
  assert.equal('visible' in value.data.cursor, false)
  assert.equal('data' in value.data.cursor, false)
  assert.equal(value.result.includes('private raw detail'), false)
})

for (const response of [null, 'unsupported', { ok: false, message: 'raw private failure' }, { error: 'raw private failure' }]) {
  test(`malformed or refused control reads cannot establish hidden cursor: ${JSON.stringify(response)}`, async () => {
    const value = await computerStatus({ scope: 'control' }, { state: { driverSession: 'own' }, call: async () => response })
    assert.equal(value.ok, false)
    assert.equal(value.data.cursor.ok, false)
    assert.equal(value.data.lifecycle.ok, false)
    assert.equal(value.result.includes('raw private failure'), false)
  })
}

test('exact read-only lifecycle queries remain available after Stop without touching or reviving the driver', async () => {
  const actor = { session: {} }, calls = []
  await createToolScope()({ agent: actor }, async () => {
    const state = getSessionState()
    state.controlStopped = true
    state.controlReleasing = true
    state.driverTouched = false
    const before = { ...state }
    const call = createCuaCall(async (tool, args) => {
      calls.push({ tool, args })
      throw new Error('session has ended; call start_session')
    })
    for (const tool of ['get_session', 'get_agent_cursor_state']) {
      await assert.rejects(call(tool, { session: state.driverSession }), /session has ended/)
    }
    assert.deepEqual(state, before)
    assert.deepEqual(calls.map((entry) => entry.tool), ['get_session', 'get_agent_cursor_state'])
  })
})

test('lifecycle observation never falls back to a global default session', async () => {
  let calls = 0
  const call = createCuaCall(async () => { calls++ })
  for (const tool of ['get_session', 'get_agent_cursor_state']) {
    await assert.rejects(call(tool), { code: 'CONTROL_SESSION_REQUIRED' })
  }
  assert.equal(calls, 0)
})

async function fixture(t, { endedReadsFail = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-control-status-'))
  const log = join(root, 'calls.jsonl'), driver = join(root, 'driver.mjs')
  await writeFile(log, '')
  await writeFile(driver, `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';\nconst [, , verb, tool, json] = process.argv;\nconst args=JSON.parse(json), log=${JSON.stringify(log)};\nappendFileSync(log,JSON.stringify({tool,args})+'\\n');\nconst calls=readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse);\nconst lifecycle=calls.filter(c=>c.args.session===args.session&&['start_session','end_session'].includes(c.tool)).at(-1)?.tool;\nconst ended=lifecycle==='end_session';\nconst cursorEnabled=calls.filter(c=>c.args.session===args.session&&c.tool==='set_agent_cursor_enabled').at(-1)?.args.enabled===true;\nif(${endedReadsFail}&&ended&&['get_session','get_agent_cursor_state'].includes(tool)){console.error('session has ended');process.exit(1)}\nlet value={ok:true};\nif(tool==='get_session')value={id:args.session,state:ended?'ended':lifecycle?'active':'absent',cursor_visible:!ended&&cursorEnabled};\nif(tool==='get_agent_cursor_state')value={session:args.session,visible:!ended&&cursorEnabled,enabled:!ended&&cursorEnabled};\nif(tool==='launch_app')value={pid:42};\nif(tool==='health_report')value={status:'fixture'};\nconsole.log(JSON.stringify(value));\n`)
  await chmod(driver, 0o700)
  const previous = process.env.CUA_DRIVER_BIN
  process.env.CUA_DRIVER_BIN = driver
  let fiber
  t.after(async () => {
    await fiber?.dispose()
    if (previous === undefined) delete process.env.CUA_DRIVER_BIN
    else process.env.CUA_DRIVER_BIN = previous
    await rm(root, { recursive: true, force: true })
  })
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const runtime = new ToolRuntime(ctx)
  ctx.provide('approval', {})
  fiber = ctx.plugin(plugin, { browserBackend: 'playwright', cursorTheme: '' })
  await new Promise((resolve) => setImmediate(resolve))
  return {
    ctx,
    run: (agent, name, args = {}) => runtime.execute({ name, arguments: args, agent, signal: new AbortController().signal, callId: `status:${name}` }),
    calls: async () => String(await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
  }
}

test('real ToolRuntime accepts control scope, isolates owner sessions and performs no initialization for observations', async (t) => {
  const h = await fixture(t), one = { session: {} }, two = { session: {} }
  const first = await h.run(one, 'computer_status', { scope: 'control' })
  const second = await h.run(two, 'computer_status', { scope: 'control' })
  assert.equal(first.isError, false)
  assert.equal(first.value.ok, true)
  assert.notEqual(first.value.data.sessionId, second.value.data.sessionId)
  const calls = await h.calls()
  assert.equal(calls.length, 4)
  assert.ok(calls.every((entry) => ['get_session', 'get_agent_cursor_state'].includes(entry.tool)))
  assert.ok(calls.slice(0, 2).every((entry) => entry.args.session === first.value.data.sessionId))
  assert.ok(calls.slice(2).every((entry) => entry.args.session === second.value.data.sessionId))
  await h.ctx.parallel('session/event', one.session, { type: 'turn/end' })
  assert.equal((await h.calls()).length, 4)
  const invalid = await h.run(one, 'computer_status', { scope: 'all-sessions' })
  assert.equal(invalid.isError, true)
  assert.equal((await h.calls()).length, 4)
})

test('post-turn control probe reads the ended exact session without restarting, clearing Stop or changing the snapshot', async (t) => {
  const h = await fixture(t), actor = { session: {} }
  await h.run(actor, 'app_launch', { name: 'Fixture' })
  await h.ctx.parallel('session/event', actor.session, { type: 'turn/end' })
  let state
  await createToolScope()({ agent: actor }, async () => {
    state = getSessionState()
    state.controlStopped = true
    state.snapshot = { untouched: true }
  })
  const before = { ...state }
  const first = await h.run(actor, 'computer_status', { scope: 'control' })
  assert.equal(first.isError, false)
  assert.equal(first.value.data.lifecycle.data.state, 'ended')
  assert.equal(first.value.data.cursor.data.visible, false)
  assert.equal(first.value.data.cursor.data.enabled, false)
  assert.equal(first.value.data.sessionId, state.driverSession)
  assert.equal(state.snapshot, before.snapshot)
  assert.equal(state.controlStopped, true)
  assert.equal(state.initialized, false)
  assert.equal(state.driverTouched, false)
  await h.ctx.parallel('session/event', actor.session, { type: 'turn/end' })
  const calls = await h.calls()
  assert.equal(calls.filter((entry) => entry.tool === 'start_session').length, 1)
  assert.equal(calls.filter((entry) => entry.tool === 'end_session').length, 1)
  assert.equal(calls.filter((entry) => entry.tool === 'set_agent_cursor_enabled' && entry.args.enabled).length, 1)
  assert.deepEqual(calls.slice(-2).map((entry) => entry.tool).sort(), ['get_agent_cursor_state', 'get_session'])
})

test('real post-turn driver refusal preserves historical cleanup without health-only revival or cross-owner evidence', async (t) => {
  const h = await fixture(t, { endedReadsFail: true }), actor = { session: {} }, other = { session: {} }
  await h.run(actor, 'app_launch', { name: 'Fixture' })
  await h.ctx.parallel('session/event', actor.session, { type: 'turn/end' })
  const status = await h.run(actor, 'computer_status', { scope: 'control' })
  assert.equal(status.value.ok, false)
  assert.equal(status.value.data.cursor.error.code, 'DRIVER_EXIT')
  assert.equal(status.value.data.lifecycle.error.code, 'DRIVER_EXIT')
  const historical = status.value.data.lastRelease
  assert.equal(historical.kind, 'historical-release-evidence')
  assert.equal(historical.sessionId, status.value.data.sessionId)
  assert.equal(historical.disable.ok, true)
  assert.equal(historical.beforeEnd.cursor.data.enabled, false)
  assert.equal(historical.beforeEnd.lifecycle.data.cursor_visible, false)
  assert.equal(historical.end.ok, true)
  await h.ctx.parallel('session/event', actor.session, { type: 'turn/end' })
  const health = await h.run(actor, 'computer_status')
  assert.equal(health.value.ok, true)
  await h.ctx.parallel('session/event', actor.session, { type: 'turn/end' })
  let state
  await createToolScope()({ agent: actor }, async () => { state = getSessionState() })
  assert.deepEqual(state.lastDriverRelease, historical)
  assert.equal(state.driverTouched, false)
  const foreign = await h.run(other, 'computer_status', { scope: 'control' })
  assert.equal('lastRelease' in foreign.value.data, false)
  let calls = await h.calls()
  assert.equal(calls.filter((entry) => entry.tool === 'start_session').length, 1)
  assert.equal(calls.filter((entry) => entry.tool === 'end_session').length, 1)
  await h.run(actor, 'app_launch', { name: 'Fixture' })
  assert.equal(state.lastDriverRelease, null)
  calls = await h.calls()
  assert.equal(calls.filter((entry) => entry.tool === 'start_session').length, 2)
})
