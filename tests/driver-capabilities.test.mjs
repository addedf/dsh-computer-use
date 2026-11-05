import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDriverCapabilitiesProbe,
  inspectDriverMetadata,
  parseDriverDescription,
  summarizeDriverHealth,
} from '../lib/driver-capabilities.js'
import { createCuaCall } from '../lib/cua.js'

const HASH = 'a'.repeat(64)
const PROPERTY_TYPES = {
  session: 'string',
  pid: 'integer',
  window_id: 'integer',
  x: 'number',
  y: 'number',
  from_x: 'number',
  from_y: 'number',
  to_x: 'number',
  to_y: 'number',
  x1: 'number',
  y1: 'number',
  x2: 'number',
  y2: 'number',
  capture_id: 'string',
  from_zoom: 'boolean',
}

function schema(names, extra = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [],
    properties: Object.fromEntries(names.map((name) => [name, { type: PROPERTY_TYPES[name] }])),
    ...extra,
  }
}

const description = (tool, inputSchema) =>
  `name: ${tool}\n\ndescription:\nRead-only fixture metadata.\n\ninput_schema:\n${JSON.stringify(inputSchema)}\n`

function harness({ health, mismatch = false, timeoutMs = 3000, mutateSchemas } = {}) {
  const calls = []
  let clock = 1000
  let identity = {
    key: 'fixture-a',
    binaryPath: '/driver',
    realPath: '/driver-a',
    fingerprint: 'stat-a',
    sha256: HASH,
  }
  const report = health || {
    schema_version: '1',
    driver_version: '0.38.0',
    platform: 'darwin',
    overall: 'degraded',
    checks: [
      { name: 'bundle_identity', status: 'fail' },
      { name: 'screen_capture_capability', status: 'skip' },
    ],
    build: { exe_sha256: mismatch ? 'b'.repeat(64) : HASH },
  }
  const schemas = {
    get_window_state: schema(['session', 'pid', 'window_id'], {
      required: ['pid', 'window_id'],
      properties: {
        ...schema(['session', 'pid', 'window_id']).properties,
        tree_format: { type: 'string', enum: ['markdown', 'elements', 'both'] },
      },
    }),
    click: schema(['session', 'pid', 'window_id', 'x', 'y', 'capture_id', 'from_zoom']),
    drag: schema(['session', 'pid', 'window_id', 'from_x', 'from_y', 'to_x', 'to_y']),
    zoom: schema(['session', 'pid', 'window_id', 'x1', 'y1', 'x2', 'y2']),
  }
  mutateSchemas?.(schemas)
  const adapters = {
    resolveBinary: () => '/driver',
    identify: async () => ({ ...identity }),
    currentFingerprint: () => identity.fingerprint,
    callHealth: async (_binary, options) => {
      calls.push({ kind: 'health', options })
      return report
    },
    inspect: async (_binary, argv, options) => {
      calls.push({ kind: 'metadata', argv, options })
      return argv[0] === 'manifest'
        ? JSON.stringify({
            schema_version: '1',
            binary_version: '999.0.0',
            subcommands: [{ name: 'describe' }],
          })
        : description(argv[1], schemas[argv[1]])
    },
    now: () => clock,
    timeoutMs,
  }
  return {
    calls,
    schemas,
    report,
    adapters,
    probe: createDriverCapabilitiesProbe(adapters),
    setIdentity: (value) => {
      identity = value
    },
    setTime: (value) => {
      clock = value
    },
  }
}

test('only identity-matched schemas establish support; producer capture remains independently unverified', async () => {
  const h = harness(),
    report = await h.probe.get()
  assert.equal(report.transport, 'ok')
  assert.equal(report.readiness, 'degraded')
  assert.equal(report.identity.matched, true)
  assert.equal(report.features.structuredElements, 'supported')
  assert.equal(report.features.captureClick, 'supported')
  assert.equal(report.features.captureDrag, 'unsupported')
  assert.equal(report.features.fromZoomClick, 'supported')
  assert.equal(report.features.zoom, 'supported')
  assert.equal(report.captureProducer.status, 'unverified')
  assert.equal(report.cliVersion, '999.0.0')
  assert.deepEqual(report.toolSchemas.click.inputSchema.required, [])
  assert.deepEqual(report.toolSchemas.get_window_state.inputSchema.required, ['pid', 'window_id'])
  assert.equal(report.toolSchemas.click.inputSchema.additionalProperties, false)
  assert.equal(h.calls.length, 6)
  assert.ok(
    h.calls.every(
      (call) =>
        call.kind === 'health' || call.argv[0] === 'manifest' || call.argv[0] === 'describe',
    ),
  )
  assert.equal(
    await h.probe.assertCompatibility(report.identity.key, { feature: 'captureClick' }),
    report,
  )
  assert.throws(() => {
    report.features.captureDrag = 'supported'
  }, TypeError)
})

test('new or matching version numbers cannot override a runtime hash mismatch or absent schema field', async () => {
  const h = harness({ mismatch: true }),
    report = await h.probe.get()
  assert.equal(report.identity.matched, false)
  assert.equal(report.toolSchemas.click.status, 'unverified')
  assert.ok(Object.values(report.features).every((status) => status === 'unknown'))
  assert.ok(report.diagnostics.includes('DRIVER_RUNTIME_IDENTITY_MISMATCH'))
  assert.equal(await h.probe.assertCompatibility(report.identity.key), report)
  await assert.rejects(
    h.probe.assertCompatibility(report.identity.key, {
      feature: 'captureClick',
      allowUnknown: true,
    }),
    { code: 'DRIVER_FEATURE_UNKNOWN' },
  )
  assert.equal(
    await h.probe.assertCompatibility(report.identity.key, {
      feature: 'structuredElements',
      allowUnknown: true,
    }),
    report,
  )
  const legacy = harness({
    mutateSchemas: (schemas) => {
      delete schemas.click.properties.capture_id
    },
  })
  assert.equal((await legacy.probe.get()).features.captureClick, 'unsupported')
})

test('unsupported required output modes and absent metadata remain explicit rather than inferred', async () => {
  const h = harness({
    mutateSchemas: (schemas) => {
      schemas.get_window_state.properties.tree_format.enum = ['markdown']
      schemas.click.required = ['capture_id']
      delete schemas.drag
    },
  })
  const report = await h.probe.get()
  assert.equal(report.features.structuredElements, 'unsupported')
  assert.equal(report.features.captureDrag, 'unknown')
  assert.equal(report.toolSchemas.drag.status, 'unknown')
  assert.deepEqual(report.toolSchemas.click.inputSchema.required, ['capture_id'])
  await assert.rejects(
    h.probe.assertCompatibility(report.identity.key, {
      feature: 'structuredElements',
      allowUnknown: true,
    }),
    { code: 'DRIVER_FEATURE_UNSUPPORTED' },
  )
})

test('malformed enums cannot advertise structured element support', async () => {
  for (const values of ['no-elements', { includes: 'elements' }, ['elements', 1], [null], []]) {
    const h = harness({
      mutateSchemas: (schemas) => {
        schemas.get_window_state.properties.tree_format.enum = values
      },
    })
    const report = await h.probe.get()
    assert.equal(report.features.structuredElements, 'unknown')
    assert.equal(report.toolSchemas.get_window_state.status, 'unknown')
    assert.ok(report.diagnostics.includes('DRIVER_SCHEMA_UNKNOWN:get_window_state'))
  }
})

test('transport success does not turn failed or unknown health into ready', async () => {
  for (const [health, expected] of [
    [
      {
        schema_version: '1',
        driver_version: '0.38.0',
        platform: 'darwin',
        overall: 'failed',
        checks: [{ name: 'session_active', status: 'fail' }],
        build: { exe_sha256: HASH },
      },
      'failed',
    ],
    [{ schema_version: '2', overall: 'ok', checks: [], build: { exe_sha256: HASH } }, 'unknown'],
    [{ schema_version: '1', overall: 'ok', checks: [] }, 'unknown'],
    [null, 'unknown'],
  ]) {
    const h = harness()
    h.adapters.callHealth = async () => health
    const report = await createDriverCapabilitiesProbe(h.adapters).get()
    assert.equal(report.transport, 'ok')
    assert.equal(report.readiness, expected)
    if (expected === 'unknown') assert.equal(report.features.captureClick, 'unknown')
  }
  const h = harness()
  h.adapters.callHealth = async () => {
    throw Object.assign(new Error('private transport detail'), { code: 'DRIVER_EXIT' })
  }
  const report = await createDriverCapabilitiesProbe(h.adapters).get()
  assert.equal(report.transport, 'error')
  assert.equal(report.readiness, 'unknown')
  assert.equal(JSON.stringify(report).includes('private transport detail'), false)
})

test('cache expires and executable replacement invalidates a previously observed capability identity', async () => {
  const h = harness(),
    first = await h.probe.get()
  assert.equal(await h.probe.get(), first)
  assert.equal(h.probe.peek(), first)
  assert.equal(h.calls.length, 6)
  h.setTime(first.expiresAt)
  assert.equal(h.probe.peek(), null)
  await assert.rejects(h.probe.assertCompatibility(first.identity.key), {
    code: 'DRIVER_CAPABILITIES_EXPIRED',
  })
  const refreshed = await h.probe.get()
  assert.notEqual(refreshed, first)
  assert.equal(h.calls.length, 12)
  h.setIdentity({
    ...first.identity,
    fingerprint: 'stat-b',
    key: 'fixture-b',
    realPath: '/driver-b',
  })
  assert.equal(h.probe.peek(), null)
  await assert.rejects(h.probe.assertCompatibility(first.identity.key), {
    code: 'DRIVER_IDENTITY_CHANGED',
  })
  const replaced = await h.probe.get()
  assert.equal(replaced.identity.key, 'fixture-b')
  assert.equal(h.calls.length, 18)
})

test('pre-cancelled probes do no metadata work; cancellation cannot populate the shared cache', async () => {
  const h = harness(),
    abort = new AbortController()
  abort.abort()
  await assert.rejects(h.probe.get({ signal: abort.signal }), { code: 'CANCELLED' })
  assert.deepEqual(h.calls, [])
  const runningAbort = new AbortController()
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  h.adapters.inspect = async (_binary, _argv, { signal }) => {
    started()
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    throw new Error('aborted fixture')
  }
  const probe = createDriverCapabilitiesProbe(h.adapters)
  const pending = probe.get({ signal: runningAbort.signal })
  await ready
  runningAbort.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  await Promise.resolve()
  assert.equal(probe.peek(), null)
})

test('total deadline returns unknown and cannot cache a hanging read-only metadata adapter', async () => {
  const h = harness({ timeoutMs: 10 })
  h.adapters.inspect = async () => new Promise(() => {})
  const probe = createDriverCapabilitiesProbe(h.adapters)
  const report = await probe.get()
  assert.equal(report.transport, 'error')
  assert.equal(report.readiness, 'unknown')
  assert.deepEqual(report.diagnostics, ['DRIVER_CAPABILITIES_TIMEOUT'])
  assert.equal(probe.peek(), null)
})

test('a replacement during metadata collection cannot bind new schemas to an earlier executable', async () => {
  const h = harness()
  const inspect = h.adapters.inspect
  h.adapters.inspect = async (...args) => {
    const value = await inspect(...args)
    h.setIdentity({
      key: 'fixture-b',
      binaryPath: '/driver',
      realPath: '/driver-b',
      fingerprint: 'stat-b',
      sha256: HASH,
    })
    return value
  }
  const probe = createDriverCapabilitiesProbe(h.adapters)
  const report = await probe.get()
  assert.equal(report.transport, 'error')
  assert.deepEqual(report.diagnostics, ['DRIVER_IDENTITY_CHANGED'])
  assert.equal(probe.peek(), null)
})

test('an identity adapter that ignores cancellation cannot publish its late probe result', async () => {
  const h = harness(),
    abort = new AbortController()
  const identify = h.adapters.identify
  let entered,
    release,
    count = 0
  const ready = new Promise((resolve) => {
    entered = resolve
  })
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  h.adapters.identify = async (...args) => {
    if (++count === 2) {
      entered()
      await blocked
    }
    return identify(...args)
  }
  const probe = createDriverCapabilitiesProbe(h.adapters)
  const pending = probe.get({ signal: abort.signal })
  await ready
  abort.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(probe.peek(), null)
})

test('description parsing requires the exact named tool and structured schema boundary', () => {
  const valid = description('click', schema(['capture_id']))
  assert.equal(parseDriverDescription(valid, 'click').properties.capture_id.type, 'string')
  for (const invalid of [
    valid.replace('name: click', 'name: drag'),
    valid.replace('input_schema:', 'schema:'),
    'supports capture_id',
    description('click', { type: 'object' }),
    description(
      'click',
      schema(['capture_id'], {
        properties: { capture_id: { type: 'string', enum: [42] } },
      }),
    ),
    `${valid}trailing prose`,
  ]) {
    assert.throws(() => parseDriverDescription(invalid, 'click'))
  }
})

test('metadata command admission cannot be used as a general CLI action runner', async () => {
  for (const argv of [
    ['call', 'click', '{}'],
    ['describe', 'type_text'],
    ['manifest', '--extra'],
    ['permissions', 'grant'],
  ]) {
    await assert.rejects(inspectDriverMetadata('/never-spawn', argv), {
      code: 'DRIVER_METADATA_COMMAND_INVALID',
    })
  }
})

test('driver health tolerates additional checks while retaining skipped checks as unverified', () => {
  const health = summarizeDriverHealth({
    schema_version: '1',
    driver_version: '0.38.0',
    platform: 'darwin',
    overall: 'ok',
    checks: [
      { name: 'future_check', status: 'pass' },
      { name: 'screen_capture_capability', status: 'skip' },
    ],
  })
  assert.equal(health.readiness, 'ready')
  assert.deepEqual(health.checks, [
    { name: 'future_check', status: 'pass' },
    { name: 'screen_capture_capability', status: 'skip' },
  ])
})

test('an ended session cannot cause a capture-bound action to be restarted or replayed', async () => {
  const calls = []
  const call = createCuaCall(async (tool, args) => {
    calls.push({ tool, args })
    throw new Error('session has ended; call start_session')
  })
  await assert.rejects(
    call('click', { session: 'owner', capture_id: 'single-use-capture', x: 10, y: 10 }),
    { code: 'DRIVER_CAPTURE_STALE' },
  )
  assert.deepEqual(
    calls.map((item) => item.tool),
    ['click'],
  )
})
