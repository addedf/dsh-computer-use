// Explicit integration: production extension + native host in a temporary Chrome
// profile. Never reads or changes the user's browser or NativeMessagingHosts.
// node --test tests/chrome-connection.integration.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { WebSocket } from 'ws'
import { createChromeBridge, extensionIdFromKey } from '../lib/chrome-bridge.js'

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`

test('installed extension connects silently, survives DSH restart, keeps Stop locked and persists revocation', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chrome-connection-'))
  const profile = join(directory, 'profile')
  const socketPath = join(directory, 'bridge.sock')
  const extensionPath = fileURLToPath(new URL('../chrome-extension/', import.meta.url))
  const nativeSource = fileURLToPath(new URL('../tools/chrome-native-host.mjs', import.meta.url))
  const extensionId = extensionIdFromKey(JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8')).key)
  let child, browser, bridge, lease, control, client
  t.after(async () => {
    client?.terminate()
    await lease?.release().catch(() => {})
    await bridge?.dispose()
    await browser?.close().catch(() => {})
    control?.close()
    if (child && child.exitCode === null && !child.signalCode) {
      const closed = once(child, 'close'); child.kill('SIGTERM'); await closed
    }
    await rm(directory, { recursive: true, force: true })
  })
  const nativeDirectory = join(profile, 'NativeMessagingHosts')
  await mkdir(nativeDirectory, { recursive: true, mode: 0o700 })
  const launcher = join(directory, 'native-host')
  await writeFile(launcher, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(process.execPath)} ${quote(nativeSource)} --socket ${quote(socketPath)} --extension-id ${quote(extensionId)} "$@"\n`, { mode: 0o700 })
  await writeFile(join(nativeDirectory, 'com.dsh.computer_use.json'), JSON.stringify({
    name: 'com.dsh.computer_use', description: 'Isolated DSH connection test', path: launcher,
    type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`],
  }), { mode: 0o600 })
  const executable = process.env.DSH_TEST_CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
  child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-extension-debugging', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let launchError, diagnostics = ''
  child.on('error', (cause) => { launchError = cause })
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-1000) })
  let activePort
  for (let i = 0; i < 500 && !activePort && child.exitCode === null && !child.signalCode && !launchError; i++) {
    activePort = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => null)
    if (!activePort) await wait(10)
  }
  assert.ok(activePort, launchError?.message || `Isolated Chrome failed: ${diagnostics}`)
  const [port, path] = activePort.trim().split('\n')
  control = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await once(control, 'open')
  let sequence = 0
  const pending = new Map()
  control.on('message', (bytes) => {
    const message = JSON.parse(bytes)
    const task = pending.get(message.id)
    if (!task) return
    pending.delete(message.id)
    message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result)
  })
  control.on('close', () => { for (const task of pending.values()) task.reject(new Error('Isolated Chrome closed')); pending.clear() })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); control.send(JSON.stringify({ id, method, params }))
  })
  assert.equal((await send('Extensions.loadUnpacked', { path: extensionPath })).id, extensionId)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  let popup = await browser.contexts()[0].newPage()
  await popup.setViewportSize({ width: 380, height: 650 })
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  const state = () => popup.evaluate(() => globalThis.chrome.runtime.sendMessage({ action: 'status' }))
  const until = async (check, description) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await wait(50) }
    assert.fail(description)
  }
  await until(async () => (await state()).autoConnect === true, 'New install must enable automatic connection without a popup click')
  assert.equal((await state()).connected, false, 'A native port alone cannot report DSH connected')
  bridge = createChromeBridge({}, { socketPath, extensionId, connectTimeoutMs: 10000, commandTimeoutMs: 3000 })
  await bridge.start()
  await until(async () => (await state()).connected, 'DSH appearing later must connect automatically')
  lease = await bridge.connect({ owner: 'popup-connection-test', title: '后台任务演示' })
  client = new WebSocket(lease.endpointURL)
  await once(client, 'open')
  const created = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned tab creation timed out')), 3000)
    const listener = (bytes) => {
      const message = JSON.parse(bytes)
      if (message.id !== 1) return
      clearTimeout(timer); client.off('message', listener); resolve(message)
    }
    client.on('message', listener)
  })
  client.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }))
  const createdResult = await created
  assert.ok(createdResult.result?.targetId, JSON.stringify(createdResult))
  await until(async () => (await state()).sessions.some((session) => session.owner === 'popup-connection-test' && session.tabCount === 1), 'The owned task must be registered')
  const screenshotDirectory = process.env.DSH_CHROME_SCREENSHOTS
  if (screenshotDirectory) {
    await mkdir(screenshotDirectory, { recursive: true })
    await popup.locator('body').screenshot({ path: join(screenshotDirectory, 'chrome-active.png') })
  }
  // Task controls belong to DSH. Exercise the existing stop latch through the
  // trusted runtime channel while the popup only exposes connection authority.
  await popup.evaluate(() => globalThis.chrome.runtime.sendMessage({ action: 'stop', owner: 'popup-connection-test' }))
  await until(async () => (await state()).blockedOwners.includes('popup-connection-test'), 'Stop must persist the owner lock')
  await lease.release(); lease = undefined; client.terminate(); client = undefined
  const old = bridge; bridge = undefined
  await old.dispose()
  await until(async () => !(await state()).connected, 'DSH shutdown must clear the real connection state')
  bridge = createChromeBridge({}, { socketPath, extensionId, connectTimeoutMs: 10000, commandTimeoutMs: 3000 })
  await bridge.start()
  await until(async () => (await state()).connected, 'DSH restart must reconnect without user action')
  await assert.rejects(bridge.connect({ owner: 'popup-connection-test' }), { code: 'CHROME_CONTROL_STOPPED' })
  await popup.locator('#connect').click()
  await until(async () => (await state()).autoConnect === false, 'Revocation must persist')
  assert.equal((await state()).connected, false)
  await send('Extensions.loadUnpacked', { path: extensionPath })
  popup = await browser.contexts()[0].newPage()
  await popup.setViewportSize({ width: 380, height: 650 })
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  assert.equal((await state()).autoConnect, false, 'Extension reload must respect revoked authorization')
  assert.equal((await state()).connected, false)
  assert.ok((await state()).blockedOwners.includes('popup-connection-test'))
  await popup.locator('#connect').click()
  await until(async () => (await state()).connected, 'Explicit authorization must reconnect')
  await send('Extensions.loadUnpacked', { path: extensionPath })
  popup = await browser.contexts()[0].newPage()
  await popup.setViewportSize({ width: 380, height: 650 })
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await until(async () => (await state()).connected, 'Authorized extension reload must reconnect without another click')
  await popup.waitForTimeout(1600)
  const dimensions = await popup.locator('body').evaluate((element) => ({ width: element.scrollWidth, height: element.scrollHeight }))
  assert.ok(dimensions.width <= 380, 'Popup must fit its compact viewport without horizontal overflow')
  if (screenshotDirectory) await popup.locator('body').screenshot({ path: join(screenshotDirectory, 'chrome-ready.png') })
  t.diagnostic('Production MV3 worker, popup, native stdio host and private bridge verified in an isolated Chrome profile; user browser and DSH were untouched.')
})
