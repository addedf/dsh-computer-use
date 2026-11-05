import test from 'node:test'
import assert from 'node:assert/strict'
import {
  observedDriverBinding,
  takeClickCapture,
  verifyObservedDriver,
} from '../lib/driver-capture.js'
import { humanClick } from '../lib/human.js'
import { screenObserve } from '../lib/observe.js'
import { computerStatus } from '../lib/control-status.js'
import { createToolScope, getSessionState } from '../lib/session.js'
import { getSnapshot, setSnapshot } from '../lib/snapshot.js'
import plugin, { Config } from '../index.js'

const capabilities = {
  transport: 'ok',
  readiness: 'degraded',
  identity: { key: 'fixture-driver-identity' },
  features: { captureClick: 'supported' },
  toolSchemas: { click: { inputSchema: { required: [] } } },
}

function snapshot(observation = { capture_id: 'fixture-image-1' }, report = capabilities) {
  return {
    at: Date.now(),
    pid: 42,
    windowId: 7,
    entries: new Map(),
    driverBinding: observedDriverBinding(observation, report),
  }
}

const scoped = (run) => createToolScope()({ agent: { session: {} } }, run)
const verified = async () => capabilities

test('capture support requires both the verified consumer and the actual observation ID', async () => {
  assert.equal(snapshot().driverBinding.captureMode, 'bound')
  assert.equal(snapshot({}).driverBinding.captureMode, 'legacy')
  assert.equal(
    snapshot(
      { capture_id: 'image' },
      {
        ...capabilities,
        features: { captureClick: 'unknown' },
      },
    ).driverBinding.captureMode,
    'legacy',
  )
  assert.equal(
    snapshot(
      {},
      {
        ...capabilities,
        features: { captureClick: 'unknown' },
        toolSchemas: { click: { inputSchema: { required: ['capture_id'] } } },
      },
    ).driverBinding.captureMode,
    'legacy',
  )
  assert.equal(observedDriverBinding({ capture_id: 'image' }, {}), null)
})

test('a bound click is dispatched once and never restores authorization after an unknown result', async () =>
  scoped(async () => {
    setSnapshot(snapshot())
    const calls = []
    const options = {
      check: verified,
      call: async (tool, args) => {
        calls.push({ tool, args })
        throw Object.assign(new Error('fixture connection lost'), { code: 'DRIVER_TIMEOUT' })
      },
    }
    await assert.rejects(humanClick({ pid: 42, windowId: 7, x: 20, y: 30 }, options), {
      code: 'DRIVER_TIMEOUT',
    })
    await assert.rejects(humanClick({ pid: 42, windowId: 7, x: 20, y: 30 }, options), {
      code: 'DRIVER_CAPTURE_CONSUMED',
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].args.capture_id, 'fixture-image-1')
    assert.equal(calls[0].args.from_zoom, undefined)
  }))

test('right clicks and repeated native clicks share one capture admission per command', async () =>
  scoped(async () => {
    const calls = []
    for (const extra of [{ button: 'right' }, { count: 2 }]) {
      setSnapshot(snapshot())
      await humanClick(
        { pid: 42, windowId: 7, x: 20, y: 30, ...extra },
        {
          check: verified,
          call: async (tool, args) => {
            calls.push({ tool, args })
            return { effect: 'unverifiable' }
          },
        },
      )
      assert.equal(getSnapshot().driverBinding.consumed, true)
    }
    assert.equal(calls[0].args.button, 'right')
    assert.equal(calls[1].args.count, 2)
    assert.ok(calls.every(({ args }) => args.capture_id === 'fixture-image-1'))
  }))

test('AX tokens and padded zoom clicks never mix capture_id into their payloads', async () =>
  scoped(async () => {
    setSnapshot(snapshot())
    const calls = [],
      checks = []
    const options = {
      check: async (_identity, settings) => {
        checks.push(settings)
        return capabilities
      },
      call: async (tool, args) => {
        calls.push({ tool, args })
        return { effect: 'confirmed' }
      },
    }
    await humanClick({ pid: 42, windowId: 7, token: 'fixture-ax-token' }, options)
    await humanClick({ pid: 42, windowId: 7, x: 10, y: 10, from_zoom: true }, options)
    assert.ok(calls.every(({ args }) => !Object.hasOwn(args, 'capture_id')))
    assert.equal(calls[0].args.element_token, 'fixture-ax-token')
    assert.equal(calls[1].args.from_zoom, true)
    assert.equal(getSnapshot().driverBinding.consumed, false)
    assert.equal(checks[1].feature, 'fromZoomClick')
  }))

test('a required or malformed capture is refused before any pixel dispatch', async () => {
  const required = {
    ...capabilities,
    toolSchemas: { click: { inputSchema: { required: ['capture_id'] } } },
  }
  await assert.rejects(takeClickCapture(snapshot({}, required), { check: verified }), {
    code: 'DRIVER_CAPTURE_REQUIRED',
  })
  for (const id of ['', 42, 'x'.repeat(513)]) {
    await assert.rejects(takeClickCapture(snapshot({ capture_id: id }), { check: verified }), {
      code: 'DRIVER_CAPTURE_INVALID',
    })
  }
})

test('legacy captures keep their existing payload while checking the observed driver identity', async () =>
  scoped(async () => {
    setSnapshot(snapshot({}))
    let checked, payload
    await humanClick(
      { pid: 42, windowId: 7, x: 20, y: 30 },
      {
        check: async (key) => {
          checked = key
        },
        call: async (_tool, args) => {
          payload = args
          return { effect: 'unverifiable' }
        },
      },
    )
    assert.equal(checked, capabilities.identity.key)
    assert.equal(payload.capture_id, undefined)
  }))

test('driver replacement clears the old snapshot and refuses dispatch', async () =>
  scoped(async () => {
    const snap = snapshot()
    setSnapshot(snap)
    const check = async () => {
      throw Object.assign(new Error('Driver changed'), { code: 'DRIVER_IDENTITY_CHANGED' })
    }
    let dispatched = 0
    await assert.rejects(
      humanClick(
        { pid: 42, windowId: 7, x: 20, y: 30 },
        {
          check,
          call: () => {
            dispatched++
          },
        },
      ),
      { code: 'DRIVER_IDENTITY_CHANGED' },
    )
    assert.equal(getSnapshot(), null)
    assert.equal(dispatched, 0)
    await assert.rejects(verifyObservedDriver(snap, { check }), { code: 'DRIVER_IDENTITY_CHANGED' })
  }))

test('bound capture checks do not allow an unknown consumer feature', async () => {
  let options
  await takeClickCapture(snapshot(), {
    check: async (_key, received) => {
      options = received
    },
  })
  assert.equal(options.feature, 'captureClick')
  assert.equal(options.allowUnknown, false)
})

test('observation stores the binding privately without exposing capture IDs to the model', async () =>
  scoped(async () => {
    getSessionState().driverCapabilities = capabilities
    const state = {
      snapshot_id: 'snapshot-1',
      capture_id: 'private-fixture-capture',
      screenshot_width: 100,
      screenshot_height: 100,
      elements: [
        { element_index: 1, element_token: 'token-1', role: 'AXButton', label: 'Continue' },
      ],
    }
    const value = await screenObserve(
      {},
      {},
      { ttlMs: 1000 },
      {},
      {
        cuaCall: async (tool) =>
          tool === 'list_windows'
            ? { windows: [{ pid: 42, window_id: 7, title: 'Fixture' }] }
            : state,
      },
    )
    assert.equal(value.ok, true)
    assert.equal(getSnapshot().driverBinding.captureId, 'private-fixture-capture')
    assert.equal(JSON.stringify(value).includes('private-fixture-capture'), false)
  }))

test('compact screenshots check the current observation identity before invoking zoom', async () =>
  scoped(async () => {
    getSessionState().driverCapabilities = capabilities
    let zoomCalls = 0
    const value = await screenObserve(
      { get: (service) => (service === 'attachments' ? {} : undefined) },
      { mode: 'native' },
      { ttlMs: 1000, nativeImage: 'compact' },
      {},
      {
        cuaCall: async (tool) => {
          if (tool === 'list_windows')
            return { windows: [{ pid: 42, window_id: 7, title: 'Fixture' }] }
          if (tool === 'zoom') {
            zoomCalls++
            return {}
          }
          return {
            screenshot_width: 100,
            screenshot_height: 100,
            screenshot_png_b64: Buffer.from('fixture').toString('base64'),
            elements: [],
          }
        },
        routeImageCapable: async () => true,
        modelImageCapable: async () => false,
        glmVisionConfigured: () => false,
        verifyObservedDriver: async (current, options) => {
          assert.equal(current.driverBinding.identityKey, capabilities.identity.key)
          assert.equal(options.feature, 'zoom')
          throw Object.assign(new Error('zoom unsupported'), { code: 'DRIVER_FEATURE_UNSUPPORTED' })
        },
      },
    )
    assert.equal(value.ok, false)
    assert.match(value.result, /zoom unsupported/)
    assert.equal(zoomCalls, 0)
    assert.equal(getSnapshot(), null)
  }))

test('capability diagnostics preserve readiness separately without creating a control session', async () => {
  const signal = new AbortController().signal
  const value = await computerStatus(
    { scope: 'capabilities' },
    {
      signal,
      call: () => assert.fail('capability diagnostics must not start or recover a control session'),
      capabilities: async (options) => {
        assert.equal(options.signal, signal)
        return capabilities
      },
    },
  )
  assert.equal(value.ok, true)
  assert.equal(value.data.scope, 'capabilities')
  assert.equal(value.data.readiness, 'degraded')
})

test('the registered configuration exposes bounded collection settings and rejects invalid budgets', () => {
  const defaults = Config({})
  assert.equal(defaults.browserObservationMaxNodes, 10000)
  assert.equal(defaults.browserObservationSafetyMaxNodes, 10000)
  assert.equal(defaults.browserObservationTimeoutMs, 5000)
  const ctx = { tools: { register() {} }, logger: { info() {} } }
  for (const settings of [
    { browserObservationMaxNodes: 99 },
    { browserObservationSafetyMaxNodes: Infinity },
    { browserObservationTimeoutMs: 30001 },
  ]) {
    assert.throws(() => plugin.apply(ctx, settings), /browserObservation/)
  }
})
