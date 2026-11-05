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
  const socket = createConnection(socketPath)
  let ended = false
  const fail = () => {
    if (ended) return
    ended = true
    process.stderr.write('DSH Chrome native host: local connection ended. Open DSH browser control, then reconnect the extension.\n')
    process.exitCode = 1
    socket.destroy(); process.stdin.destroy()
  }
  socket.once('connect', () => {
    socket.setTimeout(0)
    socket.write(encodeNativeFrame({ type: 'native-hello', protocol: 1, extensionId, pid: process.pid }))
  })
  socket.setTimeout(3000, fail)
  socket.on('error', fail)
  socket.on('close', () => { if (!ended) { ended = true; process.stdin.destroy() } })
  socket.on('drain', () => process.stdin.resume())
  process.stdout.on('drain', () => socket.resume())
  process.stdout.on('error', () => { ended = true; socket.destroy(); process.stdin.destroy() })
  process.stdin.on('data', createNativeDecoder((message) => {
    if (!socket.write(encodeNativeFrame(message))) process.stdin.pause()
  }, fail))
  socket.on('data', createNativeDecoder((message) => {
    if (!process.stdout.write(encodeNativeFrame(message))) socket.pause()
  }, fail))
  process.stdin.on('end', () => { ended = true; socket.end() })
  process.stdin.on('error', fail)
}
