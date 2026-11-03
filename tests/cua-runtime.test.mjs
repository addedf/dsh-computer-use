import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRawCuaCall, createCuaCall, normalizeMcp, resolveBin } from '../lib/cua.js'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kills = []
  child.kill = (signal) => { child.kills.push(signal); queueMicrotask(() => child.emit('close', null)); return true }
  return child
}

function spawnResult(value, record = []) {
  return (binary, argv, options) => {
    const child = fakeChild()
    record.push({ binary, argv, options, child })
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify(value))
      child.emit('close', 0)
    })
    return child
  }
}

test('installation after plugin load is discovered on the very next call', async () => {
  const calls = []
  let installed = false
  const raw = createRawCuaCall({
    resolveBinary: () => resolveBin({ platform: 'darwin', env: { PATH: '' }, home: '/home/test', exists: (path) => installed && path === '/home/test/.cua-driver/packages/current/cua-driver' }),
    spawnFn: (binary, argv, options) => {
      if (installed) return spawnResult({ apps: [] }, calls)(binary, argv, options)
      const child = fakeChild()
      calls.push({ binary })
      queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })))
      return child
    },
  })
  await assert.rejects(raw('list_apps'), (error) => error.code === 'DRIVER_NOT_FOUND' && /无需重启/.test(error.message))
  installed = true
  assert.deepEqual(await raw('list_apps'), { apps: [] })
  assert.equal(calls[0].binary, 'cua-driver')
  assert.equal(calls[1].binary, '/home/test/.cua-driver/packages/current/cua-driver')
})

test('invokes fixed non-shell argv and preserves literal action text', async () => {
  const calls = []
  const raw = createRawCuaCall({ spawnFn: spawnResult({ status: 'delivered' }, calls), resolveBinary: () => '/driver' })
  const args = { text: 'literal $(whoami) `pwd` 中文' }
  await raw('type_text', args)
  assert.deepEqual(calls[0].argv, ['call', 'type_text', JSON.stringify(args)])
  assert.equal(calls[0].options.shell, false)
})

test('MCP isError is a failure even when the CLI exits successfully', async () => {
  const raw = createRawCuaCall({ spawnFn: spawnResult({ isError: true, content: [{ type: 'text', text: 'permission denied' }] }) })
  await assert.rejects(raw('click'), (error) => error.code === 'DRIVER_TOOL_ERROR' && /permission denied/.test(error.message))
  assert.throws(() => normalizeMcp({ isError: true, content: [{ type: 'text', text: 'denied' }] }), { code: 'DRIVER_TOOL_ERROR' })
})

test('timeouts stop the child without replaying an action whose outcome is unknown', async () => {
  const children = []
  const call = createCuaCall(createRawCuaCall({
    timeoutMs: 10,
    spawnFn: () => { const child = fakeChild(); children.push(child); return child },
  }))
  await assert.rejects(call('click'), (error) => error.code === 'DRIVER_TIMEOUT' && /可能已执行/.test(error.message))
  assert.equal(children.length, 1)
  assert.deepEqual(children[0].kills, ['SIGTERM'])
})

test('bounded output stops an oversized response and does not retry', async () => {
  const children = []
  const raw = createRawCuaCall({
    maxOutputBytes: 8,
    spawnFn: () => {
      const child = fakeChild()
      children.push(child)
      queueMicrotask(() => child.stdout.write('more than eight bytes'))
      return child
    },
  })
  await assert.rejects(raw('click'), { code: 'OUTPUT_LIMIT' })
  assert.equal(children.length, 1)
  assert.deepEqual(children[0].kills, ['SIGTERM'])
})

test('invalid JSON reports unknown outcome without echoing driver output', async () => {
  const raw = createRawCuaCall({ spawnFn: () => {
    const child = fakeChild()
    queueMicrotask(() => { child.stdout.write('potentially private output'); child.emit('close', 0) })
    return child
  } })
  await assert.rejects(raw('click'), (error) => error.code === 'INVALID_JSON' && !error.message.includes('potentially private'))
})

test('a process exit failure reports a stable code and bounded diagnostic', async () => {
  const raw = createRawCuaCall({ spawnFn: () => {
    const child = fakeChild()
    queueMicrotask(() => { child.stderr.write('x'.repeat(2000)); child.emit('close', 2) })
    return child
  } })
  await assert.rejects(raw('list_apps'), (error) => error.code === 'DRIVER_EXIT' && error.message.length < 1000)
})
