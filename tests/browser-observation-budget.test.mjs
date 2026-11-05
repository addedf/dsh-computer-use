import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createPlaywrightController } from '../lib/browser-playwright.js'
import { createBrowserObservationBudget } from '../lib/browser-observation.js'
import { createToolScope, getSessionState } from '../lib/session.js'

function batch({
  rows = [],
  used = { output: 1, safety: 1 },
  safetyComplete = true,
  outputComplete = true,
  sensitive = false,
} = {}) {
  let disposed = 0
  const handles = rows.map(() => {
    const handle = { asElement: () => handle, dispose: async () => {} }
    return handle
  })
  return {
    evaluate: async () => ({
      cursorValid: true,
      rows,
      text: 'Public fixture text',
      used,
      outputComplete,
      safetyComplete,
      sensitive,
      stopReasons: safetyComplete ? [] : ['safety_nodes'],
    }),
    getProperty: async () => ({
      getProperties: async () => new Map(handles.map((handle, index) => [String(index), handle])),
      dispose: async () => {},
    }),
    dispose: async () => {
      disposed++
    },
    disposed: () => disposed,
  }
}

async function fixture(run, config = {}) {
  const page = new EventEmitter()
  const frames = []
  Object.assign(page, {
    url: () => 'https://fixture.test/',
    isClosed: () => false,
    frames: () => frames,
    title: async () => 'Budget fixture',
  })
  const state = {
    owned: true,
    backend: 'playwright',
    context: {},
    pages: new Map([['tab', page]]),
    tabId: 'tab',
    dialogs: new Map(),
    continuations: new Map(),
    observed: null,
    screenshot: null,
  }
  const exec = { agent: { session: {} }, signal: new AbortController().signal }
  await createToolScope()(exec, async () => {
    getSessionState().browser = state
    const controller = createPlaywrightController({}, config)
    await run({ controller, state, page, frames, exec })
  })
}

test(
  'one deadline bounds a stalled title RPC and publishes only an incomplete safe result',
  { timeout: 1000 },
  async () =>
    fixture(
      async ({ controller, page, exec, state }) => {
        page.title = () => new Promise(() => {})
        const observed = await controller.observe({}, exec)
        assert.equal(observed.ok, true)
        assert.equal(observed.data.complete, false)
        assert.equal(observed.data.safetyComplete, false)
        assert.equal(observed.data.inputBlocked, true)
        assert.equal(observed.data.observationBudget.stopReason, 'timeout')
        assert.equal(state.continuations.size, 0)
      },
      { browserObservationTimeoutMs: 20 },
    ),
)

test(
  'a scoped owner-frame RPC shares the deadline and cannot skip full-page safety',
  { timeout: 1000 },
  async () =>
    fixture(
      async ({ controller, state, frames, exec }) => {
        let scans = 0
        frames.push({
          evaluateHandle: async () => {
            scans++
            return batch()
          },
        })
        const handle = { ownerFrame: () => new Promise(() => {}), dispose: async () => {} }
        state.observed = { at: Date.now(), tabId: 'tab', refs: new Map([['scope', { handle }]]) }
        const observed = await controller.observe({ scope_ref: 'scope' }, exec)
        assert.equal(observed.ok, true)
        assert.equal(observed.data.inputBlocked, true)
        assert.equal(observed.data.safetyComplete, false)
        assert.equal(scans, 0)
      },
      { browserObservationTimeoutMs: 20 },
    ),
)

test('node allowances are deducted across frames rather than restarted per frame', async () =>
  fixture(
    async ({ controller, frames, exec }) => {
      const requests = []
      frames.push(
        ...[0, 1].map(() => ({
          evaluateHandle: async (_fn, request) => {
            requests.push(request)
            return batch({
              used: {
                output: Math.min(4, request.outputNodes),
                safety: Math.min(7, request.safetyNodes),
              },
              safetyComplete: request.safetyNodes >= 7,
            })
          },
        })),
      )
      const observed = await controller.observe({}, exec)
      assert.equal(requests[1].outputNodes, 6)
      assert.equal(requests[1].safetyNodes, 3)
      assert.deepEqual(observed.data.observationBudget.visitedNodes, { output: 8, safety: 10 })
      assert.equal(observed.data.inputBlocked, true)
      assert.equal(observed.data.complete, false)
    },
    { browserObservationMaxNodes: 10, browserObservationSafetyMaxNodes: 10 },
  ))

test(
  'late timed-out collection is disposed without replacing the published observation',
  { timeout: 1000 },
  async () =>
    fixture(
      async ({ controller, frames, state, exec }) => {
        let deliver
        const late = batch()
        frames.push({
          evaluateHandle: () =>
            new Promise((resolve) => {
              deliver = resolve
            }),
        })
        const observed = await controller.observe({}, exec)
        const snapshot = state.observed
        assert.equal(observed.data.inputBlocked, true)
        assert.equal(observed.data.continuation, null)
        deliver(late)
        await new Promise((resolve) => setTimeout(resolve, 0))
        assert.equal(late.disposed(), 1)
        assert.equal(state.observed, snapshot)
      },
      { browserObservationTimeoutMs: 20 },
    ),
)

test(
  'cancellation retires a pending scan and its late completion cannot pollute the next observation',
  { timeout: 1000 },
  async () =>
    fixture(async ({ controller, frames, state, exec }) => {
      let deliver, markStarted
      const started = new Promise((resolve) => {
        markStarted = resolve
      })
      const late = batch()
      const frame = {
        evaluateHandle: () =>
          new Promise((resolve) => {
            deliver = resolve
            markStarted()
          }),
      }
      frames.push(frame)
      const abort = new AbortController()
      exec.signal = abort.signal
      const pending = controller.observe({}, exec)
      await started
      abort.abort()
      const canceled = await pending
      assert.equal(canceled.ok, false)
      assert.match(canceled.result, /ABORTED/)
      assert.equal(state.observed, null)
      frame.evaluateHandle = async () => batch()
      exec.signal = new AbortController().signal
      assert.equal((await controller.observe({}, exec)).ok, true)
      const snapshot = state.observed
      deliver(late)
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(late.disposed(), 1)
      assert.equal(state.observed, snapshot)
    }),
)

test(
  'a stalled retired-handle disposal shares the observation deadline',
  { timeout: 1000 },
  async () =>
    fixture(
      async ({ controller, frames, state, exec }) => {
        const oldHandle = { dispose: () => new Promise(() => {}) }
        state.observed = {
          at: Date.now(),
          tabId: 'tab',
          refs: new Map([['old', { handle: oldHandle }]]),
        }
        frames.push({ evaluateHandle: async () => batch() })
        const observed = await controller.observe({}, exec)
        assert.equal(observed.ok, true)
        assert.equal(state.retired.size, 0)
      },
      { browserObservationTimeoutMs: 20 },
    ),
)

test('superseded work cannot use a deadline as permission to start another RPC', async () => {
  let current = true,
    calls = 0
  const budget = createBrowserObservationBudget({}, undefined, () => current)
  current = false
  await assert.rejects(
    budget.call(() => {
      calls++
    }),
    { code: 'BROWSER_OBSERVATION_SUPERSEDED' },
  )
  assert.equal(calls, 0)
})

test('incomplete safety inspection prevents native select delivery before option enumeration', async () =>
  fixture(async ({ controller, state, exec }) => {
    let reads = 0,
      writes = 0
    const handle = {
      evaluate: async () => {
        reads++
        return { label: 'Ready', value: 'ready' }
      },
      selectOption: async () => {
        writes++
      },
      dispose: async () => {},
    }
    const entry = { ref: 'select', name: 'Stage', enabled: true, actions: ['select'], handle }
    state.observed = {
      at: Date.now(),
      tabId: 'tab',
      inputBlocked: true,
      refs: new Map([[entry.ref, entry]]),
    }
    const selected = await controller.select({ ref: entry.ref, value: 'ready' }, exec)
    assert.equal(selected.ok, false)
    assert.equal(reads, 0)
    assert.equal(writes, 0)
  }))

test('an expired continuation is destroyed instead of retaining a live traversal cursor', async () =>
  fixture(
    async ({ controller, state, page, exec }) => {
      let disposed = 0
      const cursor = {
        dispose: async () => {
          disposed++
        },
      }
      state.observed = {
        at: Date.now() - 1000,
        tabId: 'tab',
        snapshotId: 'expired',
        refs: new Map(),
      }
      state.continuations.set('expired', {
        tabId: 'tab',
        url: page.url(),
        snapshotId: 'expired',
        frames: [{ cursor }],
      })
      const observed = await controller.observe({ continuation: 'expired' }, exec)
      assert.equal(observed.ok, false)
      assert.equal(state.continuations.size, 0)
      assert.equal(disposed, 1)
    },
    { ttlMs: 10 },
  ))
