/** Private transport between one DSH plugin and its explicitly connected Chrome
 * companion. The public browser API never receives this transport's WS URL.
 */
import { createServer as createHTTPServer } from 'node:http'
import { createServer as createIPCServer, createConnection } from 'node:net'
import { chmod, lstat, mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

export const MAX_NATIVE_MESSAGE = 1024 * 1024
export const NATIVE_HOST_NAME = 'com.dsh.computer_use'

function error(code, message) { return Object.assign(new Error(message), { code }) }
function aborted(signal) { if (signal?.aborted) throw error('ABORTED', 'Chrome 操作已取消。') }
function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function safeMessage(value) { return String(value || 'Chrome 扩展操作失败。').replace(/(?:https?|wss?|chrome-extension):\/\/[^\s"'<>]+/gi, '[address omitted]').slice(0, 500) }

export function encodeNativeFrame(value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (!bytes.length || bytes.length > MAX_NATIVE_MESSAGE) throw error('CHROME_MESSAGE_SIZE', 'Chrome 桥接消息超过大小限制。')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(bytes.length)
  return Buffer.concat([header, bytes])
}

/** Chrome native messaging framing, also used on the private Unix connection. */
export function createNativeDecoder(onMessage, onError) {
  let buffer = Buffer.alloc(0), failed = false
  return (chunk) => {
    if (failed) return
    try {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0)
        if (!length || length > MAX_NATIVE_MESSAGE) throw error('CHROME_MESSAGE_SIZE', 'Chrome 桥接消息长度无效。')
        if (buffer.length < length + 4) break
        const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'))
        buffer = buffer.subarray(length + 4)
        if (!object(message)) throw error('CHROME_MESSAGE_INVALID', 'Chrome 桥接消息必须是对象。')
        onMessage(message)
      }
      if (buffer.length > MAX_NATIVE_MESSAGE + 4) throw error('CHROME_MESSAGE_SIZE', 'Chrome 桥接消息过大。')
    } catch (cause) {
      failed = true
      buffer = Buffer.alloc(0)
      onError?.(cause.code ? cause : error('CHROME_MESSAGE_INVALID', 'Chrome 桥接消息格式无效。'))
    }
  }
}

export function extensionIdFromKey(key) {
  if (typeof key !== 'string' || !key) throw error('CHROME_EXTENSION_KEY', 'Chrome 扩展缺少公开标识。')
  return createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))
}

export function defaultChromeSocketPath(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'computer-use', 'chrome-bridge.sock')
}

async function prepareSocketPath(path) {
  if (process.platform === 'win32') throw error('CHROME_PLATFORM_UNSUPPORTED', '当前 Chrome Native Messaging 安装流程支持 macOS 与 Linux。')
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const parent = await lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && parent.uid !== process.getuid())) {
    throw error('CHROME_SOCKET_DIRECTORY', 'Chrome 桥接目录必须由当前用户独占（权限 0700），且不能是符号链接。')
  }
  let existing
  try { existing = await lstat(path) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
  if (!existing) return
  if (!existing.isSocket() || (typeof process.getuid === 'function' && existing.uid !== process.getuid())) {
    throw error('CHROME_SOCKET_OCCUPIED', 'Chrome 桥接路径已被其它文件占用。')
  }
  const live = await new Promise((done) => {
    const socket = createConnection(path)
    let settled = false
    const finish = (value) => { if (settled) return; settled = true; socket.destroy(); done(value) }
    socket.once('connect', () => finish(true))
    socket.once('error', (cause) => finish(!['ENOENT', 'ECONNREFUSED'].includes(cause.code)))
    socket.setTimeout(250, () => finish(true))
  })
  if (live) throw error('CHROME_BRIDGE_IN_USE', '另一个 Chrome 桥接实例正在使用此路径；请先停止该实例。')
  const current = await lstat(path).catch(() => null)
  if (current && current.ino === existing.ino && current.dev === existing.dev) await unlink(path)
  else if (current) throw error('CHROME_SOCKET_CHANGED', 'Chrome 桥接路径在检查期间变化。')
}

/** No Chrome process or profile is launched, closed, or inspected here. */
export function createChromeBridge(_ctx = {}, cfg = {}) {
  const socketPath = resolve(cfg.chromeBridgeSocketPath || cfg.chromeSocketPath || cfg.socketPath || defaultChromeSocketPath())
  const connectTimeoutMs = Math.min(120000, Math.max(100, cfg.chromeConnectTimeoutMs || cfg.connectTimeoutMs || 15000))
  const commandTimeoutMs = Math.min(120000, Math.max(100, cfg.chromeCommandTimeoutMs || cfg.commandTimeoutMs || 30000))
  const records = new Map(), routes = new Map(), pending = new Map(), nativeWaiters = new Set()
  let ipc, http, wss, peer, peerReady = false, socketIdentity, starting, disposed = false, serial = 0, internalCDPSerial = 0, expectedExtensionId

  const request = (method, params, { signal, timeoutMs = commandTimeoutMs } = {}) => {
    aborted(signal)
    if (!peerReady || !peer || peer.destroyed) return Promise.reject(error('CHROME_EXTENSION_DISCONNECTED', 'Chrome 扩展未连接；请检查本机 DSH、连接组件与扩展的自动连接授权。'))
    if (pending.size >= 512) return Promise.reject(error('CHROME_BRIDGE_BUSY', 'Chrome 桥接并行请求过多。'))
    const id = ++serial
    return new Promise((resolveRequest, rejectRequest) => {
      const finish = (cause, result) => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id); clearTimeout(entry.timer); signal?.removeEventListener('abort', entry.onAbort)
        if (cause) rejectRequest(cause); else resolveRequest(result)
      }
      const timer = setTimeout(() => finish(error('CHROME_COMMAND_TIMEOUT', 'Chrome 扩展响应超时。')), timeoutMs)
      const onAbort = () => finish(error('ABORTED', 'Chrome 操作已取消。'))
      pending.set(id, { finish, timer, onAbort })
      signal?.addEventListener('abort', onAbort, { once: true })
      try { peer.write(encodeNativeFrame({ id, method, params })) } catch { finish(error('CHROME_EXTENSION_DISCONNECTED', 'Chrome 扩展连接已中断。')) }
      if (signal?.aborted) onAbort()
    })
  }

  const stopRecord = (record, reason) => {
    if (record.stopped || record.released) return
    record.stopped = true
    routes.delete(record.path)
    try { record.onStopped?.(reason) } catch {}
    for (const socket of record.clients) socket.close(1000, 'Control stopped')
  }
  const disconnectPeer = (nativePeer) => {
    if (peer !== nativePeer) return
    peerReady = false; peer = undefined
    for (const item of [...pending.values()]) item.finish(error('CHROME_EXTENSION_DISCONNECTED', 'Chrome 扩展连接已中断。'))
    for (const record of records.values()) stopRecord(record, 'extension-disconnected')
  }

  const start = () => starting ||= (async () => {
    if (disposed) throw error('CHROME_BRIDGE_DISPOSED', 'Chrome 桥接已关闭。')
    expectedExtensionId = cfg.chromeExtensionId || cfg.extensionId
      || extensionIdFromKey(JSON.parse(await readFile(new URL('../chrome-extension/manifest.json', import.meta.url), 'utf8')).key)
    if (!/^[a-p]{32}$/.test(expectedExtensionId)) throw error('CHROME_EXTENSION_KEY', 'Chrome 扩展标识无效。')
    await prepareSocketPath(socketPath)
    if (disposed) throw error('CHROME_BRIDGE_DISPOSED', 'Chrome 桥接已关闭。')
    ipc = createIPCServer((socket) => {
      if (peer && !peer.destroyed) { socket.destroy(); return }
      peer = socket; peerReady = false
      const handshake = setTimeout(() => socket.destroy(), 3000)
      socket.on('data', createNativeDecoder((message) => {
        if (!peerReady) {
          if (message.type !== 'native-hello' || message.protocol !== 1 || message.extensionId !== expectedExtensionId) { socket.destroy(); return }
          peerReady = true; clearTimeout(handshake)
          socket.write(encodeNativeFrame({ type: 'bridge-ready', protocol: 1 }))
          for (const ready of [...nativeWaiters]) ready()
          return
        }
        if (message.id !== undefined) {
          const item = pending.get(message.id)
          if (item) item.finish(message.error ? error(String(message.error.code || 'CHROME_EXTENSION_ERROR'), safeMessage(message.error.message)) : null, message.result)
          return
        }
        const record = records.get(message.owner)
        if (!record || record.released) return
        if (message.event === 'stopped') { stopRecord(record, String(message.reason || 'user-stopped')); return }
        if (message.event === 'cdp' && !record.stopped && object(message.message) && typeof message.message.method === 'string') {
          const event = message.message
          // Only the broker's registered top-level pages can receive logical
          // focus. Metadata, browser sessions and child targets cannot opt in.
          if (event.method === 'Target.attachedToTarget' && !event.sessionId && event.params?.targetInfo?.type === 'page'
              && typeof event.params.sessionId === 'string') record.pageSessions.set(event.params.sessionId, {})
          if (event.method === 'Target.detachedFromTarget' && !event.sessionId && typeof event.params?.sessionId === 'string') record.pageSessions.delete(event.params.sessionId)
          const encoded = JSON.stringify(message.message)
          for (const client of record.clients) if (client.readyState === WebSocket.OPEN) client.send(encoded)
        }
      }, () => socket.destroy()))
      socket.on('error', () => {})
      socket.on('close', () => { clearTimeout(handshake); disconnectPeer(socket) })
    })
    await new Promise((yes, no) => { ipc.once('error', no); ipc.listen(socketPath, () => { ipc.off('error', no); yes() }) })
    if (disposed) throw error('CHROME_BRIDGE_DISPOSED', 'Chrome 桥接已关闭。')
    await chmod(socketPath, 0o600); socketIdentity = await lstat(socketPath)
    if (disposed) throw error('CHROME_BRIDGE_DISPOSED', 'Chrome 桥接已关闭。')
    http = createHTTPServer((_req, response) => { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end() })
    wss = new WebSocketServer({ noServer: true, maxPayload: MAX_NATIVE_MESSAGE, perMessageDeflate: false })
    http.on('upgrade', (req, socket, head) => {
      const record = routes.get(req.url)
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${http.address().port}` || !record || record.stopped || record.released || record.clients.size) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        record.clients.add(client)
        // One client is allowed per owner. Input calls can arrive concurrently
        // (Playwright batches mouse move/down/up), but Chrome must apply them in
        // arrival order across that owner's page sessions. Other RPCs and native
        // cleanup deliberately bypass this queue.
        let inputTail = Promise.resolve()
        const focusPrimers = new Map()
        const assertClient = () => {
          if (disposed || record.stopped || record.released || records.get(record.owner) !== record
              || !record.clients.has(client) || client.readyState !== WebSocket.OPEN) throw error('CHROME_CONTROL_STOPPED', 'Chrome 控制已停止。')
        }
        const revokeClient = (reason) => {
          if (!record.stopped && !record.released && records.get(record.owner) === record && record.clients.has(client)) {
            stopRecord(record, reason)
            void request('session.stop', { owner: record.owner }).catch(() => {})
          }
        }
        const forwardNative = async (message) => {
          assertClient()
          const response = await request('cdp.send', { owner: record.owner, message })
          if (!object(response) || response.id !== message.id) throw error('CHROME_CDP_INVALID', 'Chrome 扩展响应无法配对。')
          return response
        }
        const primePage = async (message) => {
          if (!['Page.enable', 'Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry'].includes(message.method) && !message.method.startsWith('Input.')) return
          const entry = record.pageSessions.get(message.sessionId)
          if (!entry) return
          const assertPage = () => {
            assertClient()
            if (record.pageSessions.get(message.sessionId) !== entry) throw error('CHROME_PAGE_SESSION_REVOKED', 'Chrome 页面会话已撤销。')
          }
          try {
            let primer = focusPrimers.get(message.sessionId)
            if (primer?.entry !== entry) {
              const promise = (async () => {
                assertPage()
                const response = await forwardNative({ id: --internalCDPSerial, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true }, sessionId: message.sessionId })
                if (response.error) throw error('CHROME_PAGE_FOCUS_FAILED', 'Chrome 后台页面准备失败；本次控制已停止。')
                assertPage()
              })()
              primer = { entry, promise }
              focusPrimers.set(message.sessionId, primer)
            }
            await primer.promise
            assertPage()
          } catch (cause) {
            revokeClient('page-focus-failed')
            throw cause
          }
        }
        client.on('error', () => {})
        client.on('close', () => {
          record.clients.delete(client)
          if (!record.released && !record.stopped) {
            stopRecord(record, 'client-disconnected')
            void request('session.stop', { owner: record.owner }).catch(() => {})
          }
        })
        client.on('message', async (bytes, binary) => {
          let message
          try {
            message = JSON.parse(bytes.toString('utf8'))
            if (binary || !object(message) || !Number.isInteger(message.id) || typeof message.method !== 'string'
                || !/^[A-Za-z]+\.[A-Za-z][A-Za-z0-9]*$/.test(message.method)
                || (message.params !== undefined && !object(message.params))
                || (message.sessionId !== undefined && typeof message.sessionId !== 'string')) throw error('CHROME_CDP_INVALID', 'CDP message invalid')
            const forward = async () => {
              // A queued input must never outlive this exact lease and client,
              // including when the same owner has already opened a replacement.
              assertClient()
              await primePage(message)
              return forwardNative(message)
            }
            let response
            if (message.method.startsWith('Input.')) {
              const running = inputTail.then(async () => {
                try {
                  const value = await forward()
                  if (value.error) throw error('CHROME_INPUT_FAILED', 'Chrome 输入失败；本次控制已停止。')
                  return value
                } catch (cause) {
                  // After a rejected or timed-out input, the pointer/key state
                  // is uncertain. Revoke once so queued events cannot execute
                  // after failure or be replayed into a later task.
                  revokeClient('input-command-failed')
                  throw cause
                }
              })
              inputTail = running.catch(() => {})
              response = await running
            } else response = await forward()
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(response))
          } catch (cause) {
            if (Number.isInteger(message?.id) && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: cause.code || 'CHROME_BRIDGE_ERROR' } }))
            else client.close(1008, 'Invalid CDP request')
          }
        })
      })
    })
    await new Promise((yes, no) => { http.once('error', no); http.listen(0, '127.0.0.1', () => { http.off('error', no); yes() }) })
  })().catch(async (cause) => { await dispose(); throw cause })

  const waitNative = (signal) => {
    aborted(signal)
    if (disposed) throw error('CHROME_BRIDGE_DISPOSED', 'Chrome 桥接已关闭。')
    if (peerReady) return Promise.resolve()
    return new Promise((yes, no) => {
      const finish = (cause) => { clearTimeout(timer); nativeWaiters.delete(ready); signal?.removeEventListener('abort', cancel); cause ? no(cause) : yes() }
      const ready = (cause) => finish(cause)
      const cancel = () => finish(error('ABORTED', 'Chrome 连接已取消。'))
      const timer = setTimeout(() => finish(error('CHROME_EXTENSION_REQUIRED', '请检查 DSH Chrome 扩展、本机连接组件与自动连接授权；DSH 启动后会自动重连。')), connectTimeoutMs)
      nativeWaiters.add(ready); signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
  }

  async function connect({ owner, title = 'DSH', signal, onStopped } = {}) {
    if (typeof owner !== 'string' || !owner || owner.length > 200) throw error('CHROME_OWNER_INVALID', 'Chrome 会话标识无效。')
    if (records.has(owner)) throw error('CHROME_SESSION_EXISTS', '此会话已有 Chrome 连接。')
    await start(); await waitNative(signal); aborted(signal)
    if (records.has(owner)) throw error('CHROME_SESSION_EXISTS', '此会话已有 Chrome 连接。')
    const record = { owner, onStopped, path: `/devtools/browser/${randomBytes(24).toString('hex')}`, clients: new Set(), pageSessions: new Map(), stopped: false, released: false }
    records.set(owner, record)
    let info
    try {
      info = await request('session.open', { owner, title: String(title).slice(0, 80) }, { signal })
      // An already-loaded old companion can still activate tabs even when the
      // host no longer asks for focus. Refuse it before exposing a CDP route or
      // creating any target; updating the host must never retain that behavior.
      if (!object(info) || info.background !== true || info.focusPolicy !== 'preserve-user-focus' || info.releasePolicy !== 'ungroup-preserve-tabs' || info.transportConcurrency !== 'parallel-rpc') {
        throw error('CHROME_EXTENSION_UPDATE_REQUIRED', 'Chrome 扩展尚未更新为支持后台操作和独立清理的版本，请重新加载 DSH Chrome Control 并连接。')
      }
    }
    catch (cause) {
      records.delete(owner)
      if (peerReady) await request('session.close', { owner, keepTabs: true }).catch(() => {})
      throw cause
    }
    if (signal?.aborted) {
      records.delete(owner)
      if (peerReady) await request('session.close', { owner, keepTabs: true }).catch(() => {})
      aborted(signal)
    }
    if (record.stopped) { records.delete(owner); throw error('CHROME_CONTROL_STOPPED', 'Chrome 控制已停止，请在扩展中明确恢复。') }
    routes.set(record.path, record)
    const release = ({ keepTabs = true } = {}) => {
      if (record.releaseTask) return record.releaseTask
      record.released = true; routes.delete(record.path); records.delete(owner)
      // Reject this owner's pending Playwright calls immediately; an extension
      // cleanup acknowledgement must not keep a cancelled tool queue alive.
      for (const client of record.clients) client.close(1000, 'Session released')
      record.releaseTask = (async () => {
        try {
          return peerReady
            ? await request('session.close', { owner, keepTabs: keepTabs !== false })
            : { closed: true, keptTabs: true, warning: '控制连接已释放，但扩展已断开，无法确认分组清理结果。' }
        } finally { for (const client of record.clients) client.close(1000, 'Session released') }
      })()
      return record.releaseTask
    }
    return { endpointURL: `ws://127.0.0.1:${http.address().port}${record.path}`, release, info: { existingUserProfile: true, isolated: false, nativeGroup: true, ...(object(info) ? info : {}) } }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    for (const waiting of [...nativeWaiters]) waiting(error('CHROME_BRIDGE_DISPOSED', 'Chrome 桥接已关闭。'))
    for (const record of records.values()) stopRecord(record, 'plugin-disposed')
    records.clear(); routes.clear()
    if (peer) peer.destroy()
    for (const item of [...pending.values()]) item.finish(error('CHROME_BRIDGE_DISPOSED', 'Chrome 桥接已关闭。'))
    for (const client of wss?.clients || []) client.terminate()
    // libuv unlinks a bound Unix path during close without checking its inode.
    // Preserve an unexpectedly replaced path, rather than deleting that file.
    const beforeClose = await lstat(socketPath).catch(() => null)
    let displaced
    if (ipc && socketIdentity && beforeClose && (beforeClose.ino !== socketIdentity.ino || beforeClose.dev !== socketIdentity.dev)) {
      displaced = join(dirname(socketPath), `.chrome-bridge-preserved-${randomBytes(12).toString('hex')}`)
      await rename(socketPath, displaced)
    }
    await Promise.all([
      http ? new Promise((done) => http.close(done)) : undefined,
      ipc ? new Promise((done) => ipc.close(done)) : undefined,
      wss ? new Promise((done) => wss.close(done)) : undefined,
    ])
    if (displaced) {
      // Never overwrite a second replacement which appeared during shutdown.
      if (!await lstat(socketPath).catch(() => null)) await rename(displaced, socketPath)
      else _ctx.logger?.warn?.('Chrome bridge cleanup preserved a replaced socket-path file in the private bridge directory.')
    }
    const current = await lstat(socketPath).catch(() => null)
    if (socketIdentity && current?.ino === socketIdentity.ino && current.dev === socketIdentity.dev) await unlink(socketPath)
  }

  return { start, connect, dispose, get socketPath() { return socketPath } }
}
