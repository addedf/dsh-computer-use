import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDriverCapabilitiesProbe, inspectDriverMetadata } from '../lib/driver-capabilities.js'
import { createRawCuaCall } from '../lib/cua.js'

async function fixture(t, { legacy = false, mismatch = false, slow = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-driver-handshake-'))
  const binary = join(root, 'driver $(literal).mjs')
  const log = join(root, 'metadata.jsonl')
  const source = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n')
if (${slow} && argv[0] === 'describe') await new Promise(resolve => setTimeout(resolve, 10000))
const types = {session:'string',pid:'integer',window_id:'integer',x:'number',y:'number',capture_id:'string',from_zoom:'boolean',x1:'number',y1:'number',x2:'number',y2:'number',from_x:'number',from_y:'number',to_x:'number',to_y:'number'}
const fields = {get_window_state:['session','pid','window_id'],click:['session','pid','window_id','x','y','from_zoom',...(${legacy} ? [] : ['capture_id'])],drag:['session','pid','window_id','from_x','from_y','to_x','to_y'],zoom:['session','pid','window_id','x1','y1','x2','y2']}
if (argv[0] === 'manifest') {
  console.log(JSON.stringify({schema_version:'1',binary_version:'0.38.0',subcommands:[{name:'describe'}]}))
} else if (argv[0] === 'describe' && fields[argv[1]]) {
  const tool = argv[1]
  const properties = Object.fromEntries(fields[tool].map(key => [key,{type:types[key]}]))
  if (tool === 'get_window_state') properties.tree_format = {type:'string',enum:['elements','markdown']}
  const schema = {type:'object',additionalProperties:false,properties,required:tool==='get_window_state'?['pid','window_id']:[]}
  console.log('name: ' + tool + '\\n\\ndescription:\\nControlled CLI fixture.\\n\\ninput_schema:\\n' + JSON.stringify(schema))
} else if (argv[0] === 'call' && argv[1] === 'health_report') {
  const hash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  console.log(JSON.stringify({schema_version:'1',driver_version:'0.38.0',platform:'darwin',overall:'degraded',checks:[{name:'bundle_identity',status:'fail'},{name:'screen_capture_capability',status:'skip'}],build:{exe_sha256:${mismatch}?'b'.repeat(64):hash}}))
} else {
  console.error('Unexpected command in read-only handshake fixture')
  process.exitCode = 2
}
`
  await writeFile(log, '')
  await writeFile(binary, source)
  await chmod(binary, 0o700)
  t.after(() => rm(root, { recursive: true, force: true }))
  const probe = createDriverCapabilitiesProbe({
    resolveBinary: () => binary,
    timeoutMs: slow ? 120 : 5000,
    callHealth: (path, { signal, timeoutMs }) =>
      createRawCuaCall({ resolveBinary: () => path, timeoutMs, maxOutputBytes: 128 * 1024 })(
        'health_report',
        {},
        { signal },
      ),
  })
  return {
    probe,
    binary,
    source,
    calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(JSON.parse),
  }
}

test('real finite CLI processes establish a matching identity and cache metadata without desktop calls', async (t) => {
  const h = await fixture(t)
  const report = await h.probe.get()
  assert.equal(report.identity.matched, true)
  assert.equal(report.transport, 'ok')
  assert.equal(report.readiness, 'degraded')
  assert.equal(report.features.captureClick, 'supported')
  assert.equal(report.features.captureDrag, 'unsupported')
  assert.equal(report.captureProducer.status, 'unverified')
  assert.equal(h.probe.peek(), report)
  assert.equal(await h.probe.get(), report)
  const calls = await h.calls()
  assert.equal(calls.length, 6)
  assert.deepEqual(
    calls.filter((argv) => argv[0] === 'call'),
    [['call', 'health_report', '{}']],
  )
  assert.ok(
    calls.every(
      (argv) => argv[0] === 'manifest' || argv[0] === 'describe' || argv[1] === 'health_report',
    ),
  )
  assert.equal(
    await h.probe.assertCompatibility(report.identity.key, { feature: 'captureClick' }),
    report,
  )
})

test('the same version can advertise an older contract without receiving new capture arguments', async (t) => {
  const h = await fixture(t, { legacy: true })
  const report = await h.probe.get()
  assert.equal(report.cliVersion, '0.38.0')
  assert.equal(report.features.structuredElements, 'supported')
  assert.equal(report.features.captureClick, 'unsupported')
  await assert.rejects(
    h.probe.assertCompatibility(report.identity.key, { feature: 'captureClick' }),
    { code: 'DRIVER_FEATURE_UNSUPPORTED' },
  )
  assert.equal(await h.probe.assertCompatibility(report.identity.key), report)
  assert.equal((await h.calls()).length, 6)
})

test('a running-image mismatch keeps advertised metadata unverified', async (t) => {
  const h = await fixture(t, { mismatch: true })
  const report = await h.probe.get()
  assert.equal(report.identity.matched, false)
  assert.equal(report.features.captureClick, 'unknown')
  await assert.rejects(
    h.probe.assertCompatibility(report.identity.key, { feature: 'captureClick' }),
    { code: 'DRIVER_FEATURE_UNKNOWN' },
  )
})

test('replacing the executable at the same configured path invalidates the old observation identity', async (t) => {
  const h = await fixture(t)
  const report = await h.probe.get()
  await writeFile(h.binary, `${h.source}\n// changed executable identity\n`)
  assert.equal(h.probe.peek(), null)
  await assert.rejects(h.probe.assertCompatibility(report.identity.key), {
    code: 'DRIVER_IDENTITY_CHANGED',
  })
  assert.equal((await h.calls()).length, 6)
  const fresh = await h.probe.get()
  assert.notEqual(fresh.identity.key, report.identity.key)
  assert.equal(fresh.identity.matched, true)
  assert.equal((await h.calls()).length, 12)
})

test('slow metadata processes are bounded and never trigger an action or installation', async (t) => {
  const h = await fixture(t, { slow: true })
  const report = await h.probe.get()
  assert.equal(report.transport, 'error')
  assert.equal(report.readiness, 'unknown')
  assert.deepEqual(report.diagnostics, ['DRIVER_CAPABILITIES_TIMEOUT'])
  assert.equal(h.probe.peek(), null)
  const calls = await h.calls()
  assert.ok(calls.every((argv) => ['manifest', 'describe', 'call'].includes(argv[0])))
  assert.ok(calls.filter((argv) => argv[0] === 'call').every((argv) => argv[1] === 'health_report'))
})

test('an executable rewritten while real metadata children run cannot publish a mixed handshake', async (t) => {
  const h = await fixture(t)
  let replaced = false
  const probe = createDriverCapabilitiesProbe({
    resolveBinary: () => h.binary,
    inspect: async (path, argv, options) => {
      const text = await inspectDriverMetadata(path, argv, options)
      if (!replaced) {
        replaced = true
        await writeFile(h.binary, `${h.source}\n// replaced during handshake\n`)
      }
      return text
    },
    callHealth: (path, { signal, timeoutMs }) =>
      createRawCuaCall({ resolveBinary: () => path, timeoutMs })('health_report', {}, { signal }),
  })
  const report = await probe.get()
  assert.equal(report.transport, 'error')
  assert.deepEqual(report.diagnostics, ['DRIVER_IDENTITY_CHANGED'])
  assert.equal(probe.peek(), null)
})
