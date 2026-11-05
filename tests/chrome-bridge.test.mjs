import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { mkdtemp, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { chromium } from 'playwright-core'
import { createChromeBridge, createNativeDecoder, encodeNativeFrame, extensionIdFromKey, MAX_NATIVE_MESSAGE } from '../lib/chrome-bridge.js'
import { chromeBridgeInstallPlan, installChromeBridge } from '../tools/install-chrome-bridge.mjs'

const EXTENSION_ID = 'pbnchgmbihcaifkhfebngggflieijidb'
const NATIVE_INFO = { nativeGroup: true, background: true, focusPolicy: 'preserve-user-focus', releasePolicy: 'ungroup-preserve-tabs', transportConcurrency: 'parallel-rpc' }
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitForPath(path) {
  for (let i = 0; i < 200; i++) {
    if (await lstat(path).catch(() => null)) return
    await delay(5)
  }
  throw new Error('Test relay did not start')
}

async function fixture(t, handler, cfg = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chrome-bridge-'))
  const path = join(directory, 'bridge.sock')
  const bridge = createChromeBridge({}, { chromeBridgeSocketPath: path, extensionId: EXTENSION_ID, connectTimeoutMs: 1000, commandTimeoutMs: 1000, ...cfg })
  const requests = []
  let peer
  t.after(async () => { peer?.destroy(); await bridge.dispose(); await rm(directory, { recursive: true, force: true }) })
  const connectNative = async () => {
    if (!peer) {
      await waitForPath(path)
      peer = createConnection(path)
      peer.on('error', () => {})
      peer.on('data', createNativeDecoder((request) => {
        if (request.type === 'bridge-ready') return
        requests.push(request)
        Promise.resolve(handler?.(request, peer) ?? (request.method === 'cdp.send'
          ? { id: request.params.message.id, ...(request.params.message.sessionId ? { sessionId: request.params.message.sessionId } : {}), result: { owner: request.params.owner } }
          : NATIVE_INFO)).then((result) => peer.write(encodeNativeFrame({ id: request.id, result }))).catch((cause) => peer.write(encodeNativeFrame({ id: request.id, error: { message: cause.message, code: cause.code } })))
      }, (cause) => { throw cause }))
      await once(peer, 'connect')
      peer.write(encodeNativeFrame({ type: 'native-hello', protocol: 1, extensionId: EXTENSION_ID }))
    }
  }
  const begin = async (owner = 'one', options = {}) => {
    const pending = bridge.connect({ owner, title: 'Transport test', ...options })
    pending.catch(() => {})
    await connectNative()
    return pending
  }
  return { directory, path, bridge, requests, begin, connectNative, get peer() { return peer } }
}

async function openSocket(endpointURL) {
  const socket = new WebSocket(endpointURL)
  socket.on('error', () => {})
  await once(socket, 'open')
  return socket
}

async function eventually(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await delay(5)
  }
  assert.fail('Expected transport event did not arrive')
}

function cdpReply(message) {
  return { id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result: {} }
}

async function publishTarget(f, client, owner, sessionId, type = 'page', parentSessionId) {
  const received = once(client, 'message')
  f.peer.write(encodeNativeFrame({ event: 'cdp', owner, message: {
    method: 'Target.attachedToTarget', ...(parentSessionId ? { sessionId: parentSessionId } : {}),
    params: { sessionId, targetInfo: { targetId: `target-${sessionId}`, type } },
  } }))
  assert.equal(JSON.parse((await received)[0]).params.sessionId, sessionId)
}

test('owned page commands share one private logical-focus acknowledgement without blocking other RPCs or owners', async (t) => {
  let finishPrimer
  const priming = new Promise((resolve) => { finishPrimer = resolve })
  const f = await fixture(t, (request) => {
    if (request.method !== 'cdp.send') return NATIVE_INFO
    const message = request.params.message
    return message.method === 'Emulation.setFocusEmulationEnabled' && request.params.owner === 'one' && message.sessionId === 'own-page'
      ? priming : cdpReply(message)
  })
  const one = await f.begin('one'), two = await f.begin('two')
  const a = await openSocket(one.endpointURL), b = await openSocket(two.endpointURL)
  t.after(() => { a.terminate(); b.terminate() })
  await publishTarget(f, a, 'one', 'own-page')
  await publishTarget(f, b, 'two', 'other-page')
  const replies = []; a.on('message', (bytes) => replies.push(JSON.parse(bytes)))
  const otherReplies = []; b.on('message', (bytes) => otherReplies.push(JSON.parse(bytes)))
  a.send(JSON.stringify({ id: 101, method: 'Page.enable', sessionId: 'own-page' }))
  a.send(JSON.stringify({ id: 102, method: 'Page.navigate', sessionId: 'own-page', params: { url: 'https://fixture.invalid/' } }))
  for (const [index, type] of ['mouseMoved', 'mousePressed', 'mouseReleased'].entries()) a.send(JSON.stringify({ id: 103 + index, method: 'Input.dispatchMouseEvent', sessionId: 'own-page', params: { type } }))
  a.send(JSON.stringify({ id: 201, method: 'Runtime.enable', sessionId: 'own-page' }))
  a.send(JSON.stringify({ id: 202, method: 'DOM.getDocument', sessionId: 'own-page' }))
  b.send(JSON.stringify({ id: 301, method: 'Input.dispatchKeyEvent', sessionId: 'other-page', params: { type: 'keyDown' } }))
  await eventually(() => replies.some((message) => message.id === 202) && otherReplies.some((message) => message.id === 301))
  const oneCommands = () => f.requests.filter((request) => request.method === 'cdp.send' && request.params.owner === 'one').map((request) => request.params.message)
  const primers = oneCommands().filter((message) => message.method === 'Emulation.setFocusEmulationEnabled')
  assert.equal(primers.length, 1)
  assert.ok(primers[0].id < 0)
  assert.deepEqual(primers[0].params, { enabled: true })
  assert.equal(primers[0].sessionId, 'own-page')
  assert.equal(oneCommands().some((message) => message.id >= 101 && message.id <= 105), false)
  finishPrimer(cdpReply(primers[0]))
  await eventually(() => replies.some((message) => message.id === 105))
  assert.deepEqual(oneCommands().filter((message) => message.method.startsWith('Input.')).map((message) => message.id), [103, 104, 105])
  a.send(JSON.stringify({ id: 106, method: 'Page.reload', sessionId: 'own-page' }))
  await eventually(() => replies.some((message) => message.id === 106))
  assert.equal(oneCommands().filter((message) => message.method === 'Emulation.setFocusEmulationEnabled').length, 1)
  await publishTarget(f, a, 'one', 'own-second-page')
  a.send(JSON.stringify({ id: 107, method: 'Page.enable', sessionId: 'own-second-page' }))
  await eventually(() => replies.some((message) => message.id === 107))
  assert.equal(oneCommands().filter((message) => message.method === 'Emulation.setFocusEmulationEnabled').length, 2)
  assert.equal(replies.some((message) => Number.isInteger(message.id) && message.id < 0), false)
  assert.equal(otherReplies.some((message) => Number.isInteger(message.id) && message.id < 0), false)
  await one.release(); await two.release()
})

test('logical focus never targets browser metadata, unregistered sessions or child targets', async (t) => {
  const f = await fixture(t)
  const lease = await f.begin('one'), client = await openSocket(lease.endpointURL)
  t.after(() => client.terminate())
  await publishTarget(f, client, 'one', 'own-page')
  await publishTarget(f, client, 'one', 'iframe-child', 'iframe', 'own-page')
  await publishTarget(f, client, 'one', 'nested-page', 'page', 'own-page')
  const replies = []; client.on('message', (bytes) => replies.push(JSON.parse(bytes)))
  const commands = [
    { method: 'Browser.getVersion' },
    { method: 'Target.setAutoAttach', params: { autoAttach: true } },
    { method: 'Page.enable' },
    { method: 'Page.enable', sessionId: 'dsh-root-one' },
    { method: 'Page.enable', sessionId: 'unknown-page' },
    { method: 'Page.enable', sessionId: 'iframe-child' },
    { method: 'Page.enable', sessionId: 'nested-page' },
    { method: 'Page.getLayoutMetrics', sessionId: 'own-page' },
    { method: 'Runtime.enable', sessionId: 'own-page' },
    { method: 'DOM.getDocument', sessionId: 'own-page' },
    { method: 'Target.setAutoAttach', sessionId: 'own-page', params: { autoAttach: true } },
  ]
  commands.forEach((message, index) => client.send(JSON.stringify({ id: 100 + index, ...message })))
  await eventually(() => replies.length === commands.length)
  assert.equal(f.requests.some((request) => request.params?.message?.method === 'Emulation.setFocusEmulationEnabled'), false)
  await lease.release()
})

for (const failure of ['cdp-error', 'timeout']) test(`a logical-focus ${failure} revokes only its owner and discards waiting navigation and Input`, async (t) => {
  let finishPrimer
  const priming = new Promise((resolve) => { finishPrimer = resolve })
  const stopped = []
  const f = await fixture(t, (request) => request.method === 'cdp.send'
    ? request.params.owner === 'one' && request.params.message.method === 'Emulation.setFocusEmulationEnabled' ? priming : cdpReply(request.params.message) : NATIVE_INFO,
  { commandTimeoutMs: 100 })
  const one = await f.begin('one', { onStopped: (reason) => stopped.push(reason) }), two = await f.begin('two')
  const a = await openSocket(one.endpointURL), b = await openSocket(two.endpointURL)
  t.after(() => { a.terminate(); b.terminate() })
  await publishTarget(f, a, 'one', 'own-page')
  const closed = once(a, 'close')
  for (const [index, method] of ['Page.enable', 'Page.navigate', 'Input.dispatchMouseEvent'].entries()) a.send(JSON.stringify({ id: 101 + index, method, sessionId: 'own-page' }))
  await eventually(() => f.requests.some((request) => request.params?.message?.method === 'Emulation.setFocusEmulationEnabled'))
  const primer = f.requests.find((request) => request.params?.message?.method === 'Emulation.setFocusEmulationEnabled').params.message
  if (failure === 'cdp-error') finishPrimer({ id: primer.id, sessionId: primer.sessionId, error: { code: -32000, message: 'Focus refused' } })
  await closed
  await eventually(() => f.requests.some((request) => request.method === 'session.stop' && request.params.owner === 'one'))
  assert.deepEqual(stopped, ['page-focus-failed'])
  assert.equal(f.requests.some((request) => request.params?.owner === 'one' && request.params.message?.id > 0), false)
  const received = once(b, 'message')
  b.send(JSON.stringify({ id: 301, method: 'Runtime.enable' }))
  assert.equal(JSON.parse((await received)[0]).id, 301)
  await one.release(); await two.release()
})

for (const interruption of ['stop', 'detach', 'release']) test(`a ${interruption} during logical-focus preparation prevents original commands after its late acknowledgement`, async (t) => {
  let finishPrimer
  const priming = new Promise((resolve) => { finishPrimer = resolve })
  const f = await fixture(t, (request) => request.method === 'cdp.send'
    ? request.params.message.method === 'Emulation.setFocusEmulationEnabled' ? priming : cdpReply(request.params.message) : NATIVE_INFO)
  const one = await f.begin('one'), client = await openSocket(one.endpointURL)
  t.after(() => client.terminate())
  await publishTarget(f, client, 'one', 'own-page')
  const closed = once(client, 'close')
  client.send(JSON.stringify({ id: 101, method: 'Page.enable', sessionId: 'own-page' }))
  client.send(JSON.stringify({ id: 102, method: 'Input.dispatchMouseEvent', sessionId: 'own-page', params: { type: 'mousePressed' } }))
  await eventually(() => f.requests.some((request) => request.params?.message?.method === 'Emulation.setFocusEmulationEnabled'))
  const primer = f.requests.find((request) => request.params?.message?.method === 'Emulation.setFocusEmulationEnabled').params.message
  if (interruption === 'stop') {
    f.peer.write(encodeNativeFrame({ event: 'stopped', owner: 'one', reason: 'user-stopped' }))
    await closed
  } else if (interruption === 'detach') {
    const detached = once(client, 'message')
    f.peer.write(encodeNativeFrame({ event: 'cdp', owner: 'one', message: { method: 'Target.detachedFromTarget', params: { sessionId: 'own-page' } } }))
    await detached
  } else { await one.release(); await closed }
  finishPrimer(cdpReply(primer))
  if (interruption === 'detach') await closed
  await delay(25)
  assert.equal(f.requests.some((request) => request.params?.message?.id === 101 || request.params?.message?.id === 102), false)
  if (interruption === 'release') assert.ok(f.requests.some((request) => request.method === 'session.close'))
  await one.release()
})

test('Input commands retain arrival order across page sessions while other RPCs and owners run concurrently', async (t) => {
  let finishMove, finishDown
  const move = new Promise((resolve) => { finishMove = resolve })
  const down = new Promise((resolve) => { finishDown = resolve })
  const f = await fixture(t, (request) => {
    if (request.method !== 'cdp.send') return NATIVE_INFO
    const message = request.params.message
    if (request.params.owner === 'one' && message.id === 101) return move
    if (request.params.owner === 'one' && message.id === 102) return down
    return cdpReply(message)
  })
  const one = await f.begin('one'), two = await f.begin('two')
  const a = await openSocket(one.endpointURL), b = await openSocket(two.endpointURL)
  t.after(() => { a.terminate(); b.terminate() })
  const replies = []; a.on('message', (bytes) => replies.push(JSON.parse(bytes)))
  const otherReplies = []; b.on('message', (bytes) => otherReplies.push(JSON.parse(bytes)))
  const inputs = [
    { id: 101, method: 'Input.dispatchMouseEvent', sessionId: 'own-page', params: { type: 'mouseMoved' } },
    { id: 102, method: 'Input.dispatchMouseEvent', sessionId: 'own-page', params: { type: 'mousePressed' } },
    { id: 103, method: 'Input.dispatchMouseEvent', sessionId: 'own-page', params: { type: 'mouseReleased' } },
    { id: 104, method: 'Input.dispatchKeyEvent', sessionId: 'own-second-page', params: { type: 'keyDown' } },
  ]
  for (const message of inputs) a.send(JSON.stringify(message))
  a.send(JSON.stringify({ id: 201, method: 'Runtime.evaluate', sessionId: 'own-page', params: { expression: '1' } }))
  b.send(JSON.stringify({ id: 301, method: 'Input.dispatchKeyEvent', sessionId: 'other-page', params: { type: 'keyDown' } }))
  await eventually(() => replies.some((message) => message.id === 201) && otherReplies.some((message) => message.id === 301))
  const inputIds = () => f.requests.filter((request) => request.method === 'cdp.send' && request.params.owner === 'one' && request.params.message.method.startsWith('Input.')).map((request) => request.params.message.id)
  assert.deepEqual(inputIds(), [101])
  finishMove(cdpReply(inputs[0]))
  await eventually(() => inputIds().includes(102))
  assert.deepEqual(inputIds(), [101, 102])
  finishDown(cdpReply(inputs[1]))
  await eventually(() => replies.some((message) => message.id === 104))
  assert.deepEqual(inputIds(), [101, 102, 103, 104])
  await one.release(); await two.release()
})

test('a pending Runtime call cannot block Input or independent session cleanup', async (t) => {
  const f = await fixture(t, (request) => {
    if (request.method !== 'cdp.send') return NATIVE_INFO
    return request.params.message.method === 'Runtime.callFunctionOn' ? new Promise(() => {}) : cdpReply(request.params.message)
  })
  const lease = await f.begin('one'), client = await openSocket(lease.endpointURL)
  t.after(() => client.terminate())
  const replies = []; client.on('message', (bytes) => replies.push(JSON.parse(bytes)))
  client.send(JSON.stringify({ id: 101, method: 'Runtime.callFunctionOn', sessionId: 'own-page', params: { awaitPromise: true } }))
  client.send(JSON.stringify({ id: 102, method: 'Input.dispatchMouseEvent', sessionId: 'own-page', params: { type: 'mouseMoved' } }))
  await eventually(() => replies.some((message) => message.id === 102))
  assert.equal(replies.some((message) => message.id === 101), false)
  const closed = once(client, 'close')
  await lease.release(); await closed
  assert.ok(f.requests.some((request) => request.method === 'session.close'))
})

test('release bypasses a pending Input and never forwards its queued events to a replacement owner', async (t) => {
  let finishMove
  const move = new Promise((resolve) => { finishMove = resolve })
  const f = await fixture(t, (request) => request.method === 'cdp.send'
    ? request.params.message.id === 101 ? move : cdpReply(request.params.message) : NATIVE_INFO)
  const lease = await f.begin('one'), client = await openSocket(lease.endpointURL)
  t.after(() => client.terminate())
  for (const [index, type] of ['mouseMoved', 'mousePressed', 'mouseReleased'].entries()) client.send(JSON.stringify({ id: 101 + index, method: 'Input.dispatchMouseEvent', sessionId: 'old-page', params: { type } }))
  await eventually(() => f.requests.some((request) => request.params?.message?.id === 101))
  const closed = once(client, 'close')
  await lease.release(); await closed
  assert.ok(f.requests.some((request) => request.method === 'session.close'))
  const replacement = await f.begin('one')
  finishMove(cdpReply({ id: 101, sessionId: 'old-page' }))
  await delay(25)
  assert.deepEqual(f.requests.filter((request) => request.params?.message?.method.startsWith('Input.')).map((request) => request.params.message.id), [101])
  await replacement.release()
})

for (const failure of ['native-error', 'cdp-error', 'timeout']) test(`an Input ${failure} revokes its client before queued events can be delivered`, async (t) => {
  let finishMove, rejectMove
  const move = new Promise((resolve, reject) => { finishMove = resolve; rejectMove = reject })
  const stopped = []
  const f = await fixture(t, (request) => request.method === 'cdp.send'
    ? request.params.owner === 'one' ? move : cdpReply(request.params.message) : NATIVE_INFO, { commandTimeoutMs: 100 })
  const lease = await f.begin('one', { onStopped: (reason) => stopped.push(reason) })
  const other = await f.begin('two')
  const client = await openSocket(lease.endpointURL), unaffected = await openSocket(other.endpointURL)
  t.after(() => { client.terminate(); unaffected.terminate() })
  const closed = once(client, 'close')
  for (const [index, type] of ['mouseMoved', 'mousePressed', 'mouseReleased'].entries()) client.send(JSON.stringify({ id: 101 + index, method: 'Input.dispatchMouseEvent', sessionId: 'own-page', params: { type } }))
  await eventually(() => f.requests.some((request) => request.params?.message?.id === 101))
  if (failure === 'native-error') rejectMove(Object.assign(new Error('Input refused'), { code: 'CHROME_SCOPE_REFUSED' }))
  if (failure === 'cdp-error') finishMove({ id: 101, sessionId: 'own-page', error: { code: -32000, message: 'Input refused' } })
  await Promise.race([closed, delay(1500).then(() => assert.fail('Input failure must close its client'))])
  await eventually(() => f.requests.some((request) => request.method === 'session.stop' && request.params.owner === 'one'))
  assert.deepEqual(stopped, ['input-command-failed'])
  assert.deepEqual(f.requests.filter((request) => request.method === 'cdp.send' && request.params.owner === 'one').map((request) => request.params.message.id), [101])
  const received = once(unaffected, 'message')
  unaffected.send(JSON.stringify({ id: 301, method: 'Input.dispatchMouseEvent', sessionId: 'other-page', params: { type: 'mouseMoved' } }))
  assert.equal(JSON.parse((await received)[0]).id, 301)
  await lease.release(); await other.release()
})

test('native frames handle chunk boundaries and reject oversized/invalid input', () => {
  const messages = [], errors = []
  const decode = createNativeDecoder((item) => messages.push(item), (cause) => errors.push(cause))
  const framed = Buffer.concat([encodeNativeFrame({ id: 1 }), encodeNativeFrame({ id: 2, result: 'ok' })])
  decode(framed.subarray(0, 2)); decode(framed.subarray(2, 9)); decode(framed.subarray(9))
  assert.deepEqual(messages, [{ id: 1 }, { id: 2, result: 'ok' }])
  assert.equal(errors.length, 0)
  const bad = Buffer.alloc(4); bad.writeUInt32LE(MAX_NATIVE_MESSAGE + 1)
  decode(bad); decode(encodeNativeFrame({ id: 3 }))
  assert.equal(errors[0].code, 'CHROME_MESSAGE_SIZE')
  assert.equal(messages.length, 2)
  assert.throws(() => encodeNativeFrame({ text: 'x'.repeat(MAX_NATIVE_MESSAGE) }), /大小限制/)
})

test('loopback routes isolate owners, preserve CDP event order, and reject foreign Origins', async (t) => {
  const f = await fixture(t, (request, peer) => {
    if (request.method !== 'cdp.send') return NATIVE_INFO
    peer.write(encodeNativeFrame({ event: 'cdp', owner: request.params.owner, message: { method: 'Runtime.ready', params: { owner: request.params.owner } } }))
    return { id: request.params.message.id, result: { owner: request.params.owner } }
  })
  const one = await f.begin('one'), two = await f.begin('two')
  assert.notEqual(one.endpointURL, two.endpointURL)
  const a = await openSocket(one.endpointURL), b = await openSocket(two.endpointURL)
  t.after(() => { a.terminate(); b.terminate() })
  const received = []
  a.on('message', (bytes) => received.push(JSON.parse(bytes)))
  const bMessages = []; b.on('message', (bytes) => bMessages.push(JSON.parse(bytes)))
  a.send(JSON.stringify({ id: 5, method: 'Browser.getVersion' }))
  for (let i = 0; i < 100 && received.length < 2; i++) await delay(5)
  assert.equal(received[0].method, 'Runtime.ready')
  assert.equal(received[1].id, 5)
  assert.equal(received[1].result.owner, 'one')
  assert.deepEqual(bMessages, [])
  const bad = new WebSocket(two.endpointURL, { origin: 'https://foreign.invalid' })
  bad.on('error', () => {})
  const status = await new Promise((done) => bad.on('unexpected-response', (_request, response) => { done(response.statusCode); response.resume(); bad.terminate() }))
  assert.equal(status, 403)
  await one.release()
  assert.deepEqual(f.requests.find((request) => request.method === 'session.close').params, { owner: 'one', keepTabs: true })
  b.send(JSON.stringify({ id: 6, method: 'Browser.getVersion' }))
  for (let i = 0; i < 100 && !bMessages.some((message) => message.id === 6); i++) await delay(5)
  assert.ok(bMessages.some((message) => message.id === 6 && message.result.owner === 'two'))
  assert.ok(!f.requests.some((request) => request.params?.message?.method === 'Browser.close'))
  await two.release()
})

test('extension stop revokes an endpoint and notifies the owner once', async (t) => {
  const f = await fixture(t)
  const stopped = []
  const lease = await f.begin('one', { onStopped: (reason) => stopped.push(reason) })
  const client = await openSocket(lease.endpointURL)
  const closed = once(client, 'close')
  f.peer.write(encodeNativeFrame({ event: 'stopped', owner: 'one', reason: 'user-stopped' }))
  await closed
  f.peer.write(encodeNativeFrame({ event: 'stopped', owner: 'one', reason: 'again' }))
  await delay(5)
  assert.deepEqual(stopped, ['user-stopped'])
  const bad = new WebSocket(lease.endpointURL); bad.on('error', () => {})
  const status = await new Promise((done) => bad.on('unexpected-response', (_req, response) => { done(response.statusCode); response.resume(); bad.terminate() }))
  assert.equal(status, 403)
  await lease.release()
})

test('an old foreground companion is released before a CDP route or target is exposed', async (t) => {
  const f = await fixture(t, () => ({ nativeGroup: true }))
  await assert.rejects(f.begin('old-companion'), { code: 'CHROME_EXTENSION_UPDATE_REQUIRED' })
  assert.deepEqual(f.requests.map((request) => request.method), ['session.open', 'session.close'])
  assert.deepEqual(f.requests[1].params, { owner: 'old-companion', keepTabs: true })
  assert.ok(!f.requests.some((request) => request.method === 'cdp.send'))
})

test('a background companion with the old group-retention policy cannot create a task target', async (t) => {
  const f = await fixture(t, () => ({ nativeGroup: true, background: true, focusPolicy: 'preserve-user-focus' }))
  await assert.rejects(f.begin('old-group-policy'), { code: 'CHROME_EXTENSION_UPDATE_REQUIRED' })
  assert.deepEqual(f.requests.map((request) => request.method), ['session.open', 'session.close'])
  assert.equal(f.requests[1].params.keepTabs, true)
})

test('an extension without independent cleanup cannot create a task target', async (t) => {
  const f = await fixture(t, () => ({ background: true, focusPolicy: 'preserve-user-focus', releasePolicy: 'ungroup-preserve-tabs' }))
  await assert.rejects(f.begin('serial-transport'), { code: 'CHROME_EXTENSION_UPDATE_REQUIRED' })
  assert.deepEqual(f.requests.map((request) => request.method), ['session.open', 'session.close'])
})

test('release closes only its owner client before a delayed cleanup acknowledgement', async (t) => {
  let acknowledge
  const f = await fixture(t, (request) => request.method === 'session.close'
    ? new Promise((resolve) => { acknowledge = resolve }) : NATIVE_INFO)
  const lease = await f.begin('cancelled-owner')
  const client = await openSocket(lease.endpointURL)
  const closed = once(client, 'close')
  const releasing = lease.release()
  let released = false; releasing.then(() => { released = true })
  await closed
  for (let i = 0; i < 100 && !acknowledge; i++) await delay(5)
  assert.equal(typeof acknowledge, 'function')
  assert.equal(released, false)
  acknowledge({ closed: true, groupCleanup: { complete: true } })
  assert.equal((await releasing).groupCleanup.complete, true)
})

test('release forwards incomplete group cleanup once while revoking its control route', async (t) => {
  const outcome = { closed: true, keptTabs: true, groupCleanup: { ungroupedTabs: 0, failedTabs: 1, complete: false }, warning: '控制已释放，但部分任务页面未能退出分组。' }
  const f = await fixture(t, (request) => request.method === 'session.close' ? delay(5).then(() => outcome) : NATIVE_INFO)
  const lease = await f.begin('cleanup-warning')
  const first = lease.release(), second = lease.release()
  assert.equal(first, second)
  assert.deepEqual(await first, outcome)
  assert.deepEqual(await second, outcome)
  assert.equal(f.requests.filter((request) => request.method === 'session.close').length, 1)
  const revoked = new WebSocket(lease.endpointURL); revoked.on('error', () => {})
  const status = await new Promise((done) => revoked.on('unexpected-response', (_request, response) => { done(response.statusCode); response.resume(); revoked.terminate() }))
  assert.equal(status, 403)
})

test('another relay cannot steal a live socket and cleanup removes only its own socket', async (t) => {
  const f = await fixture(t)
  const lease = await f.begin()
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600)
  const second = createChromeBridge({}, { socketPath: f.path, extensionId: EXTENSION_ID, connectTimeoutMs: 100 })
  await assert.rejects(second.connect({ owner: 'intruder' }), { code: 'CHROME_BRIDGE_IN_USE' })
  assert.ok((await lstat(f.path)).isSocket())
  await lease.release(); await f.bridge.dispose()
  await assert.rejects(lstat(f.path), { code: 'ENOENT' })
})

test('cancellation while awaiting extension leaves no pending connection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chrome-cancel-'))
  const bridge = createChromeBridge({}, { socketPath: join(directory, 'bridge.sock'), extensionId: EXTENSION_ID, connectTimeoutMs: 1000 })
  t.after(async () => { await bridge.dispose(); await rm(directory, { recursive: true, force: true }) })
  const abort = new AbortController()
  const pending = bridge.connect({ owner: 'one', signal: abort.signal })
  await waitForPath(bridge.socketPath); abort.abort()
  await assert.rejects(pending, { code: 'ABORTED' })
})

test('start prepares IPC before a model task so the extension can connect first', async (t) => {
  const f = await fixture(t)
  await f.bridge.start(); await f.bridge.start()
  await f.connectNative()
  const lease = await f.bridge.connect({ owner: 'already-connected' })
  assert.equal(f.requests[0].method, 'session.open')
  assert.equal(f.requests[0].params.owner, 'already-connected')
  await lease.release()
})

test('cleanup preserves another file which replaced the bound socket path', async (t) => {
  const f = await fixture(t)
  await f.bridge.start()
  await rename(f.path, f.path + '.old')
  await writeFile(f.path, 'user replacement', { mode: 0o600 })
  const before = await lstat(f.path)
  await f.bridge.dispose()
  assert.equal(await readFile(f.path, 'utf8'), 'user replacement')
  assert.equal((await lstat(f.path)).ino, before.ino)
})

test('real Playwright CDP handshake connects through the native relay without browser shutdown', async (t) => {
  const f = await fixture(t, (request) => {
    if (request.method !== 'cdp.send') return NATIVE_INFO
    const message = request.params.message
    const result = message.method === 'Browser.getVersion'
      ? { protocolVersion: '1.3', product: 'Chrome/156.0.0.0', revision: 'test', userAgent: 'Chrome/156.0.0.0', jsVersion: '15.6' }
      : {}
    return { id: message.id, result }
  })
  const lease = await f.begin()
  const browser = await chromium.connectOverCDP(lease.endpointURL, { noDefaults: true, timeout: 2000 })
  assert.equal(browser.version(), '156.0.0.0')
  assert.equal(browser.contexts().length, 1)
  const disconnected = once(browser, 'disconnected')
  await lease.release(); await disconnected
  assert.ok(f.requests.some((request) => request.params?.message?.method === 'Target.setAutoAttach'))
  assert.ok(!f.requests.some((request) => request.params?.message?.method === 'Browser.close'))
})

test('installer plan is read-only, restricts native origin, and installs only into a test home', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-chrome-install-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const plan = await chromeBridgeInstallPlan({ home, platform: 'darwin' })
  assert.equal(plan.extensionId, EXTENSION_ID)
  assert.ok(plan.launcher.startsWith(home))
  assert.ok(plan.nativeManifest.startsWith(home))
  await assert.rejects(lstat(plan.launcher), { code: 'ENOENT' })
  const nativeManifest = JSON.parse(plan.files[1].content)
  assert.deepEqual(nativeManifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`])
  const first = await installChromeBridge(plan)
  assert.deepEqual(first.backups, [])
  assert.equal((await lstat(plan.launcher)).mode & 0o777, 0o700)
  const second = await installChromeBridge(plan)
  assert.equal(second.backups.length, 2)
  assert.equal(await readFile(plan.nativeManifest, 'utf8'), plan.files[1].content)
})

test('native host rejects a launch from a different extension without emitting stdout', async () => {
  const child = spawn(process.execPath, ['tools/chrome-native-host.mjs', '--socket', '/tmp/unreachable-dsh.sock', '--extension-id', EXTENSION_ID, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], { cwd: new URL('../', import.meta.url) })
  let stdout = '', stderr = ''
  child.stdout.on('data', (bytes) => { stdout += bytes }); child.stderr.on('data', (bytes) => { stderr += bytes })
  const [code] = await once(child, 'exit')
  assert.equal(code, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /invalid launch parameters/)
  assert.equal(extensionIdFromKey(JSON.parse(await readFile(new URL('../chrome-extension/manifest.json', import.meta.url), 'utf8')).key), EXTENSION_ID)
})

test('native host carries real stdio frames to the relay and closes cleanly', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chrome-native-'))
  const bridge = createChromeBridge({}, { socketPath: join(directory, 'bridge.sock'), extensionId: EXTENSION_ID, connectTimeoutMs: 1000, commandTimeoutMs: 1000 })
  let child
  t.after(async () => { child?.kill(); await bridge.dispose(); await rm(directory, { recursive: true, force: true }) })
  const pending = bridge.connect({ owner: 'native-stdio' }); pending.catch(() => {})
  await waitForPath(bridge.socketPath)
  child = spawn(process.execPath, ['tools/chrome-native-host.mjs', '--socket', bridge.socketPath, '--extension-id', EXTENSION_ID, `chrome-extension://${EXTENSION_ID}/`], { cwd: new URL('../', import.meta.url) })
  const calls = [], decodeErrors = []
  child.stdout.on('data', createNativeDecoder((request) => {
    if (request.type) return
    calls.push(request)
    const result = request.method === 'cdp.send'
      ? { id: request.params.message.id, result: { transported: true } }
      : NATIVE_INFO
    const response = encodeNativeFrame({ id: request.id, result })
    // Exercise the decoder across a header boundary through actual stdio.
    child.stdin.write(response.subarray(0, 2)); child.stdin.write(response.subarray(2))
  }, (cause) => decodeErrors.push(cause)))
  let stderr = ''; child.stderr.on('data', (bytes) => { stderr += bytes })
  const lease = await pending
  const client = await openSocket(lease.endpointURL)
  const message = once(client, 'message')
  client.send(JSON.stringify({ id: 17, method: 'Runtime.enable' }))
  assert.deepEqual(JSON.parse((await message)[0]), { id: 17, result: { transported: true } })
  await lease.release()
  const ended = once(child, 'exit'); child.stdin.end()
  const [code] = await ended
  assert.equal(code, 0)
  assert.equal(stderr, '')
  assert.deepEqual(decodeErrors, [])
  assert.deepEqual(calls.map((item) => item.method), ['session.open', 'cdp.send', 'session.close'])
})
