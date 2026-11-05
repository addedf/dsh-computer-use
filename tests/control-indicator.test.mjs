import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CONTROL_INDICATOR_BUNDLE_ID, createControlIndicator, ensureControlIndicatorBinary } from '../lib/control-indicator.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const actor = () => ({ agent: { session: {} }, signal: new AbortController().signal })

function harness(options = {}, config = {}) {
  const children = []
  const messages = []
  const errors = []
  let preparations = 0
  const indicator = createControlIndicator({}, { onError: (error) => errors.push(error.reason), ...config }, {
    platform: 'darwin',
    timeoutMs: 100,
    idleMs: 1000,
    ensureBinary: async () => { preparations++; return '/fixture/our-indicator' },
    spawn(executable, args, spawnOptions) {
      assert.equal(executable, '/fixture/our-indicator')
      assert.deepEqual(args, [])
      assert.equal(spawnOptions.shell, false)
      const child = new EventEmitter()
      child.exitCode = null
      child.stdout = new EventEmitter()
      child.stdin = new EventEmitter()
      child.stdin.writable = true
      child.stdin.destroyed = false
      child.stdin.write = (line) => {
        const message = JSON.parse(line)
        messages.push(message)
        if (message.op === 'update' && options.ack !== false) queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ event: 'visible', owner: message.owner, revision: message.revision })}\n`))
      }
      child.stdin.end = () => { child.stdin.writable = false; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)) }
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0) }
      children.push(child)
      if (options.ready !== false) queueMicrotask(() => child.stdout.emit('data', '{"event":"ready"}\n'))
      return child
    },
    ...options,
  })
  return { indicator, children, messages, errors, preparations: () => preparations }
}

test('indicator is lazy, waits for real display acknowledgement, and reuses one helper for two owners', async () => {
  const h = harness()
  assert.equal(h.children.length, 0)
  const one = actor(), two = actor()
  const values = await Promise.all([
    h.indicator.update(one, { phase: 'observing', window: { x: 10, y: 20, width: 600, height: 400 } }),
    h.indicator.update(two, { phase: 'acting' }),
  ])
  assert.deepEqual(values, [{ available: true, visible: true }, { available: true, visible: true }])
  assert.equal(h.children.length, 1)
  assert.equal(h.preparations(), 1)
  const shown = h.messages.filter((value) => value.op === 'update')
  assert.notEqual(shown[0].owner, shown[1].owner)
  assert.equal(shown[0].label, 'DSH 正在观察')
  assert.deepEqual(shown[0].window, { x: 10, y: 20, width: 600, height: 400 })
  h.indicator.hide(one)
  assert.equal(h.indicator.availability().visiblePanels, 1)
  await h.indicator.dispose()
  assert.equal(h.indicator.availability().visiblePanels, 0)
})

test('Stop latches the exact owner before async callback and never revives on update or hide', async () => {
  const one = actor(), two = actor()
  const calls = []
  const h = harness()
  await h.indicator.update(one, { phase: 'preparing', onStop: (event) => {
    assert.equal(h.indicator.isStopped(one), true)
    assert.equal(h.indicator.isStopped(two), false)
    assert.equal(event.exec, one)
    calls.push(event)
  } })
  await h.indicator.update(one, { phase: 'idle' })
  await h.indicator.update(two, { phase: 'waiting' })
  const id = h.messages.find((message) => message.label === 'DSH 准备操作').owner
  h.children[0].stdout.emit('data', `${JSON.stringify({ event: 'stop', owner: 'another-session' })}\n`)
  assert.equal(calls.length, 0)
  h.children[0].stdout.emit('data', `${JSON.stringify({ event: 'stop', owner: id })}\n`)
  h.children[0].stdout.emit('data', `${JSON.stringify({ event: 'stop', owner: id })}\n`)
  assert.equal(calls.length, 1)
  assert.equal(h.indicator.availability().visiblePanels, 1)
  h.indicator.hide(one)
  assert.deepEqual(await h.indicator.update(one, { phase: 'acting' }), { available: true, visible: false, reason: 'CONTROL_STOPPED' })
  assert.deepEqual(await h.indicator.update(two, { phase: 'acting' }), { available: true, visible: true })
  await h.indicator.dispose()
})

test('cancellation during preparation prevents stale panel resurrection', async () => {
  let finish
  const prepare = new Promise((resolve) => { finish = resolve })
  const h = harness({ ensureBinary: () => prepare })
  const controller = new AbortController()
  const exec = { agent: { session: {} }, signal: controller.signal }
  const showing = h.indicator.update(exec, { phase: 'acting' })
  controller.abort()
  finish('/fixture/our-indicator')
  const value = await showing
  assert.equal(value.visible, false)
  assert.equal(h.messages.filter((message) => message.op === 'update').length, 0)
  await h.indicator.dispose()
})

test('concurrent updates for the same owner retain the newest state', async () => {
  let finish
  const prepare = new Promise((resolve) => { finish = resolve })
  const h = harness({ ensureBinary: () => prepare })
  const exec = actor()
  const previous = h.indicator.update(exec, { phase: 'observing' })
  const latest = h.indicator.update(exec, { phase: 'acting' })
  finish('/fixture/our-indicator')
  assert.equal((await previous).reason, 'SUPERSEDED')
  assert.equal((await latest).visible, true)
  assert.deepEqual(h.messages.filter((message) => message.op === 'update').map((message) => message.status), ['acting'])
  await h.indicator.dispose()
})

test('missing compiler is a structured unavailable result and does not start another process', async () => {
  const h = harness({ ensureBinary: async () => { throw Object.assign(new Error('private diagnostic omitted'), { code: 'SWIFT_COMPILER_UNAVAILABLE' }) } })
  const result = await h.indicator.update(actor(), { phase: 'acting' })
  assert.deepEqual(result, { available: false, visible: false, reason: 'SWIFT_COMPILER_UNAVAILABLE' })
  assert.equal(h.children.length, 0)
  assert.deepEqual(h.errors, ['SWIFT_COMPILER_UNAVAILABLE'])
  assert.equal(h.indicator.availability().available, false)
  await h.indicator.dispose()
})

test('no positive visibility claim is made without a helper acknowledgement', async () => {
  const h = harness({ ack: false, timeoutMs: 10 })
  const value = await Promise.all([
    h.indicator.update(actor(), { phase: 'observing' }),
    new Promise((resolve) => setTimeout(resolve, 30)),
  ])
  assert.deepEqual(value[0], { available: false, visible: false, reason: 'INDICATOR_ACK_TIMEOUT' })
  assert.equal(h.indicator.availability().visiblePanels, 0)
  await h.indicator.dispose()
})

test('oversized helper output fails closed and clears displayed panels', async () => {
  const h = harness()
  const exec = actor()
  await h.indicator.update(exec, { phase: 'acting' })
  h.children[0].stdout.emit('data', 'x'.repeat(8193))
  assert.equal(h.indicator.availability().visiblePanels, 0)
  assert.deepEqual(h.errors, ['INDICATOR_PROTOCOL_ERROR'])
  assert.equal(h.indicator.isStopped(exec), true)
  await h.indicator.dispose()
})

test('unexpected helper exit cancels in-flight owners using the retained stop callback', async () => {
  const cancelled = []
  const one = actor(), two = actor()
  const h = harness()
  for (const exec of [one, two]) {
    await h.indicator.update(exec, { phase: 'acting', onStop: (event) => {
      assert.equal(h.indicator.isStopped(event.exec), true)
      cancelled.push(event)
    } })
    await h.indicator.update(exec, { phase: 'idle' })
  }
  h.children[0].exitCode = 1
  h.children[0].emit('exit', 1)
  assert.equal(cancelled.length, 2)
  assert.ok(cancelled.every((event) => event.reason === 'INDICATOR_PROCESS_EXITED'))
  assert.equal(h.indicator.isStopped(one), true)
  assert.equal(h.indicator.isStopped(two), true)
  assert.equal(h.indicator.availability().visiblePanels, 0)
  assert.equal((await h.indicator.update(one, { phase: 'acting' })).reason, 'CONTROL_STOPPED')
  assert.equal(h.children.length, 1)
  await h.indicator.dispose()
})

test('already aborted work, unsupported platform, disabled UI and invalid phase do not spawn', async () => {
  const h = harness()
  const cancelled = new AbortController(); cancelled.abort()
  assert.equal((await h.indicator.update({ agent: { session: {} }, signal: cancelled.signal }, { phase: 'acting' })).visible, false)
  assert.equal((await h.indicator.update(actor(), { phase: 'unknown' })).reason, 'INVALID_PHASE')
  assert.equal(h.children.length, 0)
  const other = harness({ platform: 'linux' })
  assert.equal((await other.indicator.update(actor(), { phase: 'acting' })).reason, 'UNSUPPORTED_PLATFORM')
  const disabled = harness({}, { desktopIndicator: false })
  assert.equal((await disabled.indicator.update(actor(), { phase: 'acting' })).reason, 'DISABLED')
  assert.equal(other.children.length + disabled.children.length, 0)
  await Promise.all([h.indicator.dispose(), other.indicator.dispose(), disabled.indicator.dispose()])
})

test('active turn cancellation hides its panel and helper disposal is idempotent', async () => {
  const h = harness()
  const controller = new AbortController()
  const exec = { agent: { session: {} }, signal: controller.signal }
  await h.indicator.update(exec, { phase: 'acting' })
  controller.abort()
  assert.equal(h.indicator.availability().visiblePanels, 0)
  assert.equal(h.messages.at(-1).op, 'hide')
  await Promise.all([h.indicator.dispose(), h.indicator.dispose()])
  assert.equal(h.messages.filter((message) => message.op === 'shutdown').length, 1)
  assert.equal((await h.indicator.update(exec, { phase: 'acting' })).reason, 'DISPOSED')
})

test('disposing while compiler preparation is pending never spawns a helper', async () => {
  let finish
  const h = harness({ ensureBinary: () => new Promise((resolve) => { finish = resolve }) })
  const showing = h.indicator.update(actor(), { phase: 'acting' })
  const disposal = h.indicator.dispose()
  finish('/fixture/our-indicator')
  await disposal
  assert.equal((await showing).visible, false)
  assert.equal(h.children.length, 0)
  await tick()
})

test('compiled helper is packaged as a private discoverable application and reused without recompilation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-indicator-bundle-'))
  try {
    const source = join(root, 'source.swift')
    await writeFile(source, '// Test fixture; no actual UI or compiler is run.\n')
    let compilations = 0
    const options = {
      sourcePath: source,
      cacheRoot: join(root, 'cache'),
      compilerPaths: [process.execPath],
      sdkPaths: [root],
      compile: async (_compiler, args, settings) => {
        compilations++
        assert.equal(settings.shell, false)
        assert.ok(args.includes('-sdk'))
        const output = args[args.indexOf('-o') + 1]
        assert.ok(output.endsWith('.app/Contents/MacOS/DSHControlIndicator'))
        await writeFile(output, 'Synthetic executable bytes; never launched.\n')
      },
    }
    const binary = await ensureControlIndicatorBinary(options)
    assert.ok(binary.endsWith('.app/Contents/MacOS/DSHControlIndicator'))
    const metadata = await readFile(join(dirname(dirname(binary)), 'Info.plist'), 'utf8')
    assert.ok(metadata.includes(`<string>${CONTROL_INDICATOR_BUNDLE_ID}</string>`))
    assert.ok(metadata.includes('<key>CFBundleDisplayName</key><string>DSH Control</string>'))
    assert.ok(metadata.includes('<key>LSUIElement</key><true/>'))
    assert.equal((await lstat(binary)).mode & 0o777, 0o700)
    assert.equal(await ensureControlIndicatorBinary(options), binary)
    assert.equal(compilations, 1)
    await writeFile(join(dirname(dirname(binary)), 'Info.plist'), metadata.replace('DSH Control', 'Unexpected identity'))
    await assert.rejects(ensureControlIndicatorBinary(options), (error) => error.code === 'UNSAFE_INDICATOR_CACHE')
    assert.equal(compilations, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
