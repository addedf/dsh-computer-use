import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolScope, getDriverSession } from '../lib/session.js'
import { getSnapshot, setSnapshot, clearSnapshot } from '../lib/snapshot.js'
import { resolveClickTarget } from '../lib/human.js'
import { runSteps } from '../lib/batch.js'
import { guard } from '../lib/guard.js'

const snapshot = (pid, at = Date.now()) => ({ pid, windowId: pid, appName: 'Test', at, ttlMs: 1000, entries: new Map([[1, { token: 't:1', role: 'AXButton', label: 'OK' }]]) })

test('element clicks and coordinate targets enforce the same TTL', () => {
  setSnapshot(snapshot(1, Date.now() - 100001))
  assert.throws(() => resolveClickTarget(1, 1000), /已过期/)
  assert.equal(getSnapshot(), null)
})

test('tools retain snapshots per agent session and use isolated driver labels', async () => {
  const run = createToolScope()
  const a = { agent: { session: {} } }, b = { agent: { session: {} } }
  const labelA = await run(a, () => { setSnapshot(snapshot(11)); return getDriverSession() })
  const labelB = await run(b, () => { assert.equal(getSnapshot(), null); setSnapshot(snapshot(22)); return getDriverSession() })
  assert.notEqual(labelA, labelB)
  await run(a, () => assert.equal(getSnapshot().pid, 11))
  await run(b, () => assert.equal(getSnapshot().pid, 22))
})

test('one plugin serializes tools, releases failed calls, and permits nested batch dispatch', async () => {
  const run = createToolScope()
  const order = []
  const a = run({ agent: {} }, async () => {
    order.push(1)
    await run({}, () => order.push(2))
    throw new Error('expected')
  })
  const b = run({ agent: {} }, () => order.push(3))
  await assert.rejects(a, /expected/)
  await b
  assert.deepEqual(order, [1, 2, 3])
})

test('nested calls cannot inherit another agent snapshot', async () => {
  const run = createToolScope()
  await run({ agent: {} }, async () => {
    setSnapshot(snapshot(11))
    await assert.rejects(run({ agent: {} }, () => getSnapshot()), /跨 Agent/)
    assert.equal(getSnapshot().pid, 11)
  })
})

test('batch stops at first refused step and never replays or dispatches later actions', async () => {
  const calls = []
  const tools = new Map(['a', 'b', 'c'].map((name) => [name, { execute: async () => {
    calls.push(name); return { ok: name !== 'b', result: name }
  } }]))
  const result = await runSteps({ steps: ['a', 'b', 'c'].map((tool) => ({ tool })) }, {}, tools)
  assert.equal(result.ok, false)
  assert.equal(result.failedStep, 2)
  assert.equal(result.completed, 1)
  assert.deepEqual(calls, ['a', 'b'])
})

test('batch only accepts registered tools and rejects recursion before any step runs', async () => {
  let calls = 0
  const tools = new Map([['a', { execute: async () => { calls++; return { ok: true } } }]])
  for (const tool of ['run_script', 'run_steps']) {
    await assert.rejects(runSteps({ steps: [{ tool: 'a' }, { tool }] }, {}, tools), /不支持/)
  }
  assert.equal(calls, 0)
})

test('cancelled batch does not dispatch actions', async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  const result = await runSteps({ steps: [{ tool: 'a' }] }, { signal: controller.signal }, new Map([['a', { execute: () => { calls++ } }]]))
  assert.equal(result.ok, false)
  assert.equal(calls, 0)
})

test('a newer observation clears an earlier batch image', async () => {
  const tools = new Map([
    ['screen_zoom', { execute: async () => ({ ok: true, result: 'zoom', image: { attachmentId: 'old' } }) }],
    ['screen_observe', { execute: async () => ({ ok: true, result: 'updated AX' }) }],
  ])
  const result = await runSteps({ steps: [{ tool: 'screen_zoom' }, { tool: 'screen_observe' }] }, {}, tools)
  assert.equal(result.image, undefined)
})

test('dangerous English labels need approval and stale snapshots cannot request it', async () => {
  const s = snapshot(1)
  s.entries.get(1).label = 'Delete item'
  setSnapshot(s)
  const blocked = await guard({}, {}, 'computer_click', { element: 1 }, {})
  assert.equal(blocked.ok, false)
  s.at -= 100001
  await assert.rejects(guard({}, { ttlMs: 1000 }, 'computer_click', { element: 1 }, {}), /已过期/)
  clearSnapshot()
})
