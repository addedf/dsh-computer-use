import test from 'node:test'
import assert from 'node:assert/strict'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { conditionTools, createConditionController, evaluateBrowserConditions } from '../lib/conditions.js'
import { createToolScope } from '../lib/session.js'
import { setSnapshot, getSnapshot } from '../lib/snapshot.js'

const desktopExpect = [{ element: { selector: { role: 'AXButton', label_contains: 'Ready' }, exists: true } }]
const browserExpect = [{ kind: 'text', value: 'Ready' }]
function response(status = 'satisfied', count = 1) {
  return { status, stable: status === 'satisfied', predicates: Array.from({ length: count }, (_v, index) => ({ index, status })) }
}
function fixture(options = {}) {
  let clock = 1000
  let snapshot = options.snapshot === null ? null : { at: clock, pid: 42, windowId: 7, appName: 'Calculator', snapshotId: 's1', entries: new Map(), ...options.snapshot }
  const state = { browser: options.browser === null ? null : { owned: true, pid: 99, appName: 'Google Chrome', ...options.browser } }
  const calls = []
  const observations = []
  let reads = 0
  let invalidations = 0
  const cfg = { ttlMs: 10000, ...options.cfg }
  const deps = {
    now: () => clock,
    snapshot: () => snapshot,
    invalidate: () => { snapshot = null; invalidations++ },
    sessionState: () => state,
    desktopCall: async (tool, args) => {
      calls.push({ tool, args })
      const values = options.responses || [response()]
      return options.desktopCall ? options.desktopCall(tool, args, calls.length) : values[Math.min(calls.length - 1, values.length - 1)]
    },
    browserRead: async (exec) => {
      reads++
      const read = options.browserRead ? await options.browserRead(reads, exec) : {
        ok: true, observation: { snapshotId: `p${reads}`, refs: [{ ref: `p${reads}:0`, role: 'button', name: 'Ready' }] },
        facts: { url: 'https://example.test/ready', title: 'Ready', titleComplete: true, text: 'Ready', complete: true, textComplete: true, refs: [{ role: 'button', name: 'Ready', enabled: true, checked: false, value: 'done' }] },
      }
      observations.push(read)
      return read
    },
    pause: async (ms, signal) => { clock += ms; if (options.onPause) options.onPause(ms, signal) },
  }
  if (options.realPause) delete deps.pause
  const controller = createConditionController({}, cfg, deps)
  return { controller, calls, observations, state, cfg, deps, reads: () => reads, invalidations: () => invalidations, snapshot: () => snapshot, advance: (ms) => { clock += ms } }
}

test('all four condition definitions compile through the real DSH defineTool schema compiler', () => {
  const definitions = conditionTools({}, {})
  assert.deepEqual(definitions.map((tool) => tool.name), ['computer_verify', 'computer_wait_for', 'browser_verify', 'browser_wait_for'])
  for (const definition of definitions) {
    const compiled = defineTool(definition)
    assert.equal(typeof compiled.execute, 'function')
    assert.equal(typeof compiled.output.render, 'function')
    const blocks = compiled.output.render({}, { result: 'test', data: { status: 'unknown', matched: false } })
    assert.match(blocks[0].text, /unknown/)
  }
})

test('desktop verify targets the exact observed window and invalidates old tokens', async () => {
  const f = fixture()
  const value = await f.controller.computerVerify({ expect: desktopExpect, snapshot_id: 's1' }, {})
  assert.equal(value.ok, true)
  assert.equal(value.status, 'satisfied')
  assert.equal(value.matched, true)
  assert.deepEqual(value.data.checks, [{ index: 0, status: 'satisfied' }])
  assert.equal(f.snapshot(), null)
  assert.equal(f.invalidations(), 1)
  assert.deepEqual({ ...f.calls[0].args, session: undefined }, { session: undefined, pid: 42, window_id: 7, expect: desktopExpect, timeout_ms: 0, stable_samples: 1, include_screenshot: false })
  assert.equal(f.calls[0].tool, 'verify_state')
  assert.match(value.result, /screen_observe/)
})

for (const [label, options, args] of [
  ['missing snapshot', { snapshot: null }, {}],
  ['stale snapshot', { snapshot: { at: -10000 } }, {}],
  ['wrong snapshot id', {}, { snapshot_id: 'wrong' }],
  ['wrong app scope', { cfg: { allowedApps: ['Other'] } }, {}],
]) {
  test(`desktop rejects ${label} before driver calls`, async () => {
    const f = fixture(options)
    const value = await f.controller.computerVerify({ expect: desktopExpect, ...args }, {})
    assert.equal(value.ok, false)
    assert.equal(value.status, 'error')
    assert.equal(f.calls.length, 0)
  })
}

for (const expect of [
  [], Array.from({ length: 9 }, () => ({ window: { exists: true } })),
  [{ element: { selector: { role: 'AXButton' }, exists: false } }],
  [{ element: { selector: {}, exists: true } }],
  [{ element: { selector: { role: 'AXButton' } } }],
  [{ element: { selector: { role: 'AXSecureTextField' }, value_equals: 'synthetic-secret' } }],
  [{ window: { exists: true }, element: { selector: { role: 'AXButton' }, exists: true } }],
  [{ javascript: 'doSomething()' }],
  [{ window: { bounds: { x: 0, y: 0, width: 0, height: 20 } } }],
]) {
  test(`desktop predicate validation prevents unsafe or unsupported forwarding: ${JSON.stringify(expect).slice(0, 100)}`, async () => {
    const f = fixture()
    const value = await f.controller.computerVerify({ expect }, {})
    assert.equal(value.status, 'error')
    assert.equal(f.calls.length, 0)
    assert.equal(f.invalidations(), 0)
  })
}

for (const [description, evidence, expected] of [
  ['unsatisfied', response('unsatisfied'), 'unsatisfied'],
  ['unknown', response('unknown'), 'unknown'],
  ['malformed evidence', { status: 'satisfied', stable: true, predicates: [] }, 'unknown'],
  ['unstable success', { ...response(), stable: false }, 'unknown'],
  ['unknown predicate despite top success', { ...response(), predicates: [{ index: 0, status: 'unknown' }] }, 'unknown'],
]) {
  test(`desktop ${description} never passes`, async () => {
    const f = fixture({ responses: [evidence] })
    const value = await f.controller.computerVerify({ expect: desktopExpect }, {})
    assert.equal(value.ok, false)
    assert.equal(value.matched, false)
    assert.equal(value.status, expected)
  })
}

test('driver observed_json and private values never enter condition output', async () => {
  const raw = response('unsatisfied')
  raw.predicates[0].observed_json = '{"value":"synthetic-private-value"}'
  const f = fixture({ responses: [raw] })
  const value = await f.controller.computerVerify({ expect: desktopExpect }, {})
  assert.equal(JSON.stringify(value).includes('synthetic-private-value'), false)
})

test('desktop wait requires consecutive stable samples and performs only read calls', async () => {
  const f = fixture({ responses: [response(), response('unsatisfied'), response(), response()] })
  const value = await f.controller.computerWaitFor({ expect: desktopExpect, timeout_ms: 1000, interval_ms: 50, stable_samples: 2 }, {})
  assert.equal(value.ok, true)
  assert.equal(value.data.samples, 4)
  assert.equal(value.data.elapsedMs, 150)
  assert.ok(f.calls.every((call) => call.tool === 'verify_state' && call.args.timeout_ms === 0 && !('element' in call.args)))
  assert.equal(f.invalidations(), 1)
})

test('desktop waits stop at the deadline without extra reads', async () => {
  const f = fixture({ responses: [response('unknown')] })
  const value = await f.controller.computerWaitFor({ expect: desktopExpect, timeout_ms: 100, interval_ms: 50 }, {})
  assert.equal(value.status, 'timeout')
  assert.equal(value.ok, false)
  assert.equal(value.data.samples, 2)
  assert.equal(value.data.elapsedMs, 100)
})

test('desktop waits cannot outlive the original snapshot TTL', async () => {
  const f = fixture({ cfg: { ttlMs: 50 }, responses: [response('unsatisfied')], onPause: () => f.advance(1) })
  const value = await f.controller.computerWaitFor({ expect: desktopExpect, timeout_ms: 1000, interval_ms: 50 }, {})
  assert.equal(value.ok, false)
  assert.equal(value.data.code, 'STALE_SNAPSHOT')
  assert.equal(f.calls.length, 1)
})

test('cancellation before a condition never touches the driver or snapshot', async () => {
  const f = fixture()
  const signal = AbortSignal.abort()
  const value = await f.controller.computerVerify({ expect: desktopExpect }, { signal })
  assert.equal(value.status, 'cancelled')
  assert.equal(f.calls.length, 0)
  assert.equal(f.invalidations(), 0)
})

test('cancellation during a read cannot return a successful match', async () => {
  const control = new AbortController()
  const f = fixture({ desktopCall: async () => { control.abort(); return response() } })
  const value = await f.controller.computerVerify({ expect: desktopExpect }, { signal: control.signal })
  assert.equal(value.status, 'cancelled')
  assert.equal(value.ok, false)
  assert.equal(f.snapshot(), null)
})

test('real pause aborts promptly without polling again or leaving a timer', async () => {
  const control = new AbortController()
  const f = fixture({ realPause: true, responses: [response('unsatisfied')] })
  const pending = f.controller.computerWaitFor({ expect: desktopExpect, timeout_ms: 1000, interval_ms: 1000 }, { signal: control.signal })
  setTimeout(() => control.abort(), 0)
  const value = await pending
  assert.equal(value.status, 'cancelled')
  assert.equal(f.calls.length, 1)
})

for (const options of [{ browser: null }, { cfg: { allowedApps: ['Other'] } }]) {
  test(`browser requires its own allowed session: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options)
    const value = await f.controller.browserVerify({ expect: browserExpect }, {})
    assert.equal(value.status, 'error')
    assert.equal(f.reads(), 0)
  })
}

test('browser verify returns the exact latest safe observation and structured data', async () => {
  const f = fixture()
  const value = await f.controller.browserVerify({ expect: browserExpect }, {})
  assert.equal(value.ok, true)
  assert.equal(value.observation.snapshotId, 'p1')
  assert.equal(value.data.observation, value.observation)
  assert.match(value.result, /旧 ref/)
})

test('owned Playwright browser conditions do not require or fabricate an OS pid', async () => {
  const f = fixture({ browser: { backend: 'playwright', pid: undefined } })
  const value = await f.controller.browserVerify({ expect: browserExpect }, {})
  assert.equal(value.ok, true)
  assert.equal(f.state.browser.pid, undefined)
  assert.equal(f.reads(), 1)
})

test('browser wait returns only the final refs after multiple refreshed reads', async () => {
  const f = fixture({ browserRead: async (read) => ({
    ok: true, observation: { snapshotId: `p${read}`, refs: [{ ref: `p${read}:1` }] },
    facts: { text: read === 1 ? 'Loading' : 'Ready', textComplete: true, complete: true, refs: [] },
  }) })
  const value = await f.controller.browserWaitFor({ expect: browserExpect, timeout_ms: 1000, interval_ms: 50 }, {})
  assert.equal(value.ok, true)
  assert.equal(f.reads(), 3)
  assert.equal(value.observation.snapshotId, 'p3')
  assert.equal(JSON.stringify(value).includes('p1:1'), false)
})

test('absence is satisfied only when browser completeness is proven', () => {
  const expect = [{ kind: 'exists', role: 'button', name: 'Missing', value: false }]
  assert.equal(evaluateBrowserConditions(expect, { refs: [], complete: false })[0].status, 'unknown')
  assert.equal(evaluateBrowserConditions(expect, { refs: [], complete: true })[0].status, 'satisfied')
  assert.equal(evaluateBrowserConditions(expect, { refs: [{ role: 'button', name: 'Missing' }], complete: false })[0].status, 'unsatisfied')
})

test('missing, truncated, protected, and ambiguous browser field states remain unknown', () => {
  const scenarios = [
    [{ kind: 'value', role: 'textbox', value: 'partial' }, [{ role: 'textbox', value: 'partial', valueTruncated: true }]],
    [{ kind: 'value', role: 'textbox', value: 'hidden' }, [{ role: 'textbox', value: 'hidden', states: { protected: true } }]],
    [{ kind: 'checked', role: 'checkbox', value: false }, [{ role: 'checkbox' }]],
    [{ kind: 'enabled', role: 'button', value: true }, [{ role: 'button' }]],
    [{ kind: 'value', role: 'textbox', value: 'same' }, [{ role: 'textbox', value: 'same' }, { role: 'textbox', value: 'same' }]],
  ]
  for (const [predicate, refs] of scenarios) assert.equal(evaluateBrowserConditions([predicate], { refs, complete: true })[0].status, 'unknown')
})

test('known false booleans are compared without inventing missing enabled or checked states', () => {
  assert.equal(evaluateBrowserConditions([{ kind: 'checked', role: 'checkbox', value: false }], { refs: [{ role: 'checkbox', checked: false }] })[0].status, 'satisfied')
  assert.equal(evaluateBrowserConditions([{ kind: 'enabled', role: 'button', value: false }], { refs: [{ role: 'button', states: { disabled: true } }] })[0].status, 'satisfied')
})

test('text missing from incomplete observation is unknown while observed text can pass', () => {
  assert.equal(evaluateBrowserConditions(browserExpect, { text: 'Loading', textComplete: false })[0].status, 'unknown')
  assert.equal(evaluateBrowserConditions(browserExpect, { text: 'Ready', textComplete: false })[0].status, 'satisfied')
  assert.equal(evaluateBrowserConditions([{ kind: 'text', value: 'Ready', match: 'equals' }], { text: 'Ready', textComplete: false })[0].status, 'unknown')
  assert.equal(evaluateBrowserConditions([{ kind: 'title', value: 'Prefix' }], { title: 'Prefix', titleComplete: false })[0].status, 'unknown')
  assert.equal(evaluateBrowserConditions([{ kind: 'title', value: 'Prefix' }], { title: 'Prefix' })[0].status, 'unknown')
})

test('empty ordinary browser fields can be asserted without coercing missing values', async () => {
  const f = fixture({ browserRead: async () => ({ ok: true, observation: {}, facts: { refs: [{ role: 'textbox', name: 'Name', value: '' }], complete: true } }) })
  const value = await f.controller.browserVerify({ expect: [{ kind: 'value', role: 'textbox', name: 'Name', value: '' }] }, {})
  assert.equal(value.ok, true)
  assert.equal(evaluateBrowserConditions([{ kind: 'value', role: 'textbox', value: '' }], { refs: [{ role: 'textbox' }], complete: true })[0].status, 'unknown')
})

for (const predicate of [
  { kind: 'url', value: 'https://example.test/path?token=private' },
  { kind: 'url', value: 'https://example.test/path#fragment' },
  { kind: 'url', value: 'https://user:private@example.test/path' },
  { kind: 'exists', ref: 'p-old:0', value: true },
  { kind: 'enabled', role: 'button', value: 'true' },
]) {
  test(`browser rejects unsupported predicate before reading: ${predicate.kind}`, async () => {
    const f = fixture()
    const value = await f.controller.browserVerify({ expect: [predicate] }, {})
    assert.equal(value.status, 'error')
    assert.equal(f.reads(), 0)
    assert.equal(JSON.stringify(value).includes('token=private'), false)
    assert.equal(JSON.stringify(value).includes('user:private'), false)
  })
}

test('browser supports URL/title, scalar values and checked/enabled assertions together', async () => {
  const f = fixture()
  const value = await f.controller.browserVerify({ expect: [
    { kind: 'url', value: '/ready', match: 'contains' }, { kind: 'title', value: 'Ready' },
    { kind: 'value', role: 'button', name: 'Ready', value: 'done' },
    { kind: 'enabled', role: 'button', value: true }, { kind: 'checked', role: 'button', value: false },
  ] }, {})
  assert.equal(value.ok, true)
  assert.equal(value.data.checks.length, 5)
})

test('cancelled browser reads never pass', async () => {
  const signal = new AbortController()
  const f = fixture({ browserRead: async () => { signal.abort(); return { ok: true, observation: {}, facts: { text: 'Ready', complete: true } } } })
  const value = await f.controller.browserVerify({ expect: browserExpect }, { signal: signal.signal })
  assert.equal(value.status, 'cancelled')
})

test('read failures hide raw diagnostics and do not return false success', async () => {
  const f = fixture({ desktopCall: async () => { throw new Error('https://user:secret@private.test/path?token=private') } })
  const value = await f.controller.computerVerify({ expect: desktopExpect }, {})
  assert.equal(value.status, 'error')
  assert.equal(JSON.stringify(value).includes('secret'), false)
  assert.equal(f.snapshot(), null)
})

test('native conditions do not inherit another agent scope or its snapshot', async () => {
  const scope = createToolScope()
  const a = { agent: { session: {} } }, b = { agent: { session: {} } }
  const calls = []
  const controller = createConditionController({}, {}, { desktopCall: async (tool, args) => { calls.push({ tool, args }); return response() } })
  await scope(a, () => setSnapshot({ pid: 42, windowId: 7, appName: 'Calculator', snapshotId: 'one', at: Date.now() }))
  const other = await scope(b, () => controller.computerVerify({ expect: desktopExpect }, b))
  assert.equal(other.ok, false)
  const own = await scope(a, () => controller.computerVerify({ expect: desktopExpect }, a))
  assert.equal(own.ok, true)
  assert.equal(calls.length, 1)
  await scope(a, () => assert.equal(getSnapshot(), null))
})
