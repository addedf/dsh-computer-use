#!/usr/bin/env node
/** Chrome launches this process only for the manifest's allowed extension.
 * stdout is exclusively native-messaging frames; diagnostics never print paths.
 */
import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { createNativeDecoder, encodeNativeFrame } from '../lib/chrome-bridge.js'

const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const socketPath = option('--socket')
const extensionId = option('--extension-id')
const origin = args.find((value) => value.startsWith('chrome-extension://'))
if (!socketPath || !isAbsolute(socketPath) || !/^[a-p]{32}$/.test(extensionId || '') || origin !== `chrome-extension://${extensionId}/`) {
  process.stderr.write('DSH Chrome native host: invalid launch parameters.\n')
  process.exitCode = 1
} else {
  let socket, ready = false, ended = false, retryTimer, retryDelay = 1000
  const send = (message) => {
    if (ended) return false
    return process.stdout.write(encodeNativeFrame(message))
  }
  const finish = (failed = false) => {
    if (ended) return
    ended = true; clearTimeout(retryTimer)
    if (failed) { process.exitCode = 1; process.stderr.write('DSH Chrome native host: local transport failed.\n') }
    socket?.destroy(); process.stdin.destroy()
  }
  const disconnected = () => { ready = false; send({ type: 'bridge-disconnected', protocol: 1 }) }
  const connect = () => {
    if (ended) return
    const peer = createConnection(socketPath)
    socket = peer; ready = false
    const handshake = setTimeout(() => peer.destroy(), 3000)
    peer.once('connect', () => {
      peer.write(encodeNativeFrame({ type: 'native-hello', protocol: 1, extensionId, pid: process.pid }))
    })
    peer.on('data', createNativeDecoder((message) => {
      if (ended || socket !== peer) return
      if (!ready) {
        if (message.type !== 'bridge-ready' || message.protocol !== 1) { peer.destroy(); return }
        clearTimeout(handshake); ready = true; retryDelay = 1000
      }
      if (!send(message)) peer.pause()
    }, () => finish(true)))
    peer.on('error', () => {})
    peer.on('drain', () => { if (socket === peer) process.stdin.resume() })
    peer.on('close', () => {
      clearTimeout(handshake)
      if (ended || socket !== peer) return
      socket = undefined; process.stdin.resume(); disconnected()
      retryTimer = setTimeout(connect, retryDelay)
      retryDelay = Math.min(5000, retryDelay * 2)
    })
  }
  process.stdout.on('drain', () => socket?.resume())
  process.stdout.on('error', () => finish())
  // An unavailable DSH never queues or replays commands into a later process.
  process.stdin.on('data', createNativeDecoder((message) => {
    if (ended || !ready || !socket || socket.destroyed) return
    if (!socket.write(encodeNativeFrame(message))) process.stdin.pause()
  }, () => finish(true)))
  process.stdin.on('end', () => finish())
  process.stdin.on('error', () => finish(true))
  disconnected()
  connect()
}
