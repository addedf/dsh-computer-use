// Explicit isolated-Chrome regression; never uses a user profile or browser.
// node --test tests/chrome-bridge-popup.integration.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright-core'
import { WebSocket } from 'ws'
import { createChromeBridge, createNativeDecoder, encodeNativeFrame } from '../lib/chrome-bridge.js'
import { createPlaywrightController } from '../lib/browser-playwright.js'
import { createConditionController } from '../lib/conditions.js'
import { createToolScope, getSessionState } from '../lib/session.js'

test('explicit link navigation owns both background pages and releases their groups after one verified preview', { timeout: 25000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-popup-'))
  let child, peer, browser, lease, bridge, control
  const requests = [], emitted = []
  const reads = [], previews = []
  const server = createServer((req, response) => {
    reads.push(req.url)
    if (req.method === 'POST' && req.url === '/preview') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const value = JSON.parse(body)
        if (value.name === 'Background test' && value.reference === 'SAMPLE42') previews.push(value)
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ message: `Preview ready: ${value.name} / ${value.reference}` }))
      })
      return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end(req.url === '/brief' ? '<title>Brief</title><p>Reference code: SAMPLE42</p>' : `<!doctype html><title>Form</title>
      <a href="/brief" target="_blank" onclick="window.linkClicks++">Read reference</a>
      <p><label>Name <input id="name"></label></p><p><label>Reference <input id="reference"></label></p>
      <button id="preview" type="button">Preview</button><p id="result" aria-live="polite">No preview</p>
      <script>window.linkClicks=0;window.previewClicks=[];
      document.querySelector('#preview').addEventListener('click',async(event)=>{
        window.previewClicks.push({trusted:event.isTrusted});
        const response=await fetch('/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.querySelector('#name').value,reference:document.querySelector('#reference').value})});
        document.querySelector('#result').textContent=(await response.json()).message;
      });</script>`)
  })
  t.after(async () => {
    await lease?.release().catch(() => {})
    await browser?.close().catch(() => {})
    peer?.destroy()
    await bridge?.dispose()
    if (control?.socket.readyState === WebSocket.OPEN) await control.send('Browser.close').catch(() => {})
    control?.socket.close()
    if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed }
    await new Promise((done) => server.close(done))
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Isolated DSH bridge regression', version: '0.0.1',
    permissions: ['debugger', 'tabs', 'tabGroups'],
    background: { service_worker: 'fixture.js', type: 'module' },
  }))
  await writeFile(join(directory, 'broker.js'), await readFile(new URL('../chrome-extension/broker.js', import.meta.url)))
  await writeFile(join(directory, 'fixture.js'), `import {createChromeBroker} from './broker.js';globalThis.rawEvents=[];chrome.debugger.onEvent.addListener((source,method,params)=>{if(method.startsWith('Target.'))rawEvents.push({source,method,params})});chrome.tabs.onCreated.addListener(tab=>rawEvents.push({method:'tabs.onCreated',tab}));globalThis.broker=createChromeBroker(chrome,{emit:(message)=>globalThis.forwardEvent(JSON.stringify(message))});`)
  const profile = join(directory, 'profile')
  const executable = process.env.DSH_TEST_CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
  child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-extension-debugging', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let launchError
  let launchDiagnostics = ''
  child.stderr.on('data', (chunk) => { launchDiagnostics = (launchDiagnostics + chunk).slice(-2000) })
  child.on('error', (cause) => { launchError = cause })
  let activePort
  for (let i = 0; i < 1000 && !activePort && child.exitCode === null && !child.signalCode && !launchError; i++) {
    activePort = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => null)
    if (!activePort) await new Promise((done) => setTimeout(done, 10))
  }
  assert.ok(activePort, launchError?.message || `isolated Chrome must expose its own temporary debugging port (exit ${child.exitCode}, ${child.signalCode}): ${launchDiagnostics}`)
  const [port, path] = activePort.trim().split('\n')
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  const pending = new Map(), listeners = new Set()
  let sequence = 0
  socket.on('message', (bytes) => {
    const message = JSON.parse(bytes)
    if (message.id) {
      const task = pending.get(message.id); pending.delete(message.id)
      message.error ? task?.reject(new Error(message.error.message)) : task?.resolve(message.result)
    } else for (const listener of listeners) listener(message)
  })
  socket.on('close', () => { for (const task of pending.values()) task.reject(new Error('isolated CDP closed')); pending.clear() })
  await once(socket, 'open')
  control = { socket, send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  }) }
  const { id: extensionId } = await control.send('Extensions.loadUnpacked', { path: directory })
  let worker
  for (let i = 0; i < 100 && !worker; i++) {
    worker = (await control.send('Target.getTargets')).targetInfos.find((info) => info.type === 'service_worker' && info.url === `chrome-extension://${extensionId}/fixture.js`)
    if (!worker) await new Promise((done) => setTimeout(done, 10))
  }
  assert.ok(worker, 'isolated companion service worker must start')
  const { sessionId } = await control.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
  await control.send('Runtime.enable', {}, sessionId)
  await control.send('Runtime.addBinding', { name: 'forwardEvent' }, sessionId)
  listeners.add((event) => {
    if (event.sessionId !== sessionId || event.method !== 'Runtime.bindingCalled' || event.params.name !== 'forwardEvent') return
    const message = JSON.parse(event.params.payload)
    emitted.push(message)
    if (peer && !peer.destroyed) peer.write(encodeNativeFrame(message))
  })
  const evaluate = async (expression) => {
    const response = await control.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text)
    return response.result.value
  }
  for (let i = 0; i < 100 && !await evaluate('Boolean(globalThis.broker)'); i++) await new Promise((done) => setTimeout(done, 10))
  assert.equal(await evaluate('Boolean(globalThis.broker)'), true)
  bridge = createChromeBridge({}, { socketPath: join(directory, 'bridge.sock'), extensionId, commandTimeoutMs: 3000 })
  await bridge.start()
  peer = createConnection(bridge.socketPath)
  peer.on('error', () => {})
  peer.on('data', createNativeDecoder((request) => {
    requests.push(request)
    void evaluate(`broker.handleCommand(${JSON.stringify(request)})`).then((response) => {
      if (request.method === 'session.open' && response.result) response.result.transportConcurrency = 'parallel-rpc'
      if (!peer.destroyed) peer.write(encodeNativeFrame(response))
    }).catch(() => {})
  }, () => peer.destroy()))
  await once(peer, 'connect')
  peer.write(encodeNativeFrame({ type: 'native-hello', protocol: 1, extensionId }))
  const initialActive = await evaluate('chrome.tabs.query({active:true}).then(tabs=>tabs.map(tab=>tab.id))')
  assert.equal(initialActive.length, 1)
  const relay = { start: () => bridge.start(), connect: async (options) => { lease = await bridge.connect(options); return lease } }
  const ctx = {}, cfg = { browserBackend: 'chrome-extension' }, options = { chromeBridge: relay, playwright: { chromium } }
  const exec = { agent: { session: {} }, signal: new AbortController().signal }
  const checked = (value) => { assert.equal(value.ok, true, value.result); return value.data }
  const ref = (observation, name) => { const entry = observation.refs.find((item) => item.name === name); assert.ok(entry, name); return entry.ref }
  const activeUnchanged = async () => assert.deepEqual(await evaluate('chrome.tabs.query({active:true}).then(tabs=>tabs.map(tab=>tab.id))'), initialActive)
  await createToolScope()(exec, async () => {
    const controller = createPlaywrightController(ctx, cfg, options)
    const conditions = createConditionController(ctx, cfg, { browserOptions: options })
    const opened = checked(await controller.open({ url: base }, exec))
    const state = getSessionState().browser
    browser = state.browser
    const form = state.pages.get(opened.tabId)
    const sourceRef = ref(opened, 'Read reference')
    await activeUnchanged()

    // Raw CmdClick may associate a background popup with the selected user tab.
    // Refuse that gesture before input, then use explicit owned href navigation.
    const beforeRefusal = requests.length
    const refused = await controller.click({ ref: sourceRef }, exec)
    assert.equal(refused.ok, false)
    assert.match(refused.result, /BROWSER_BACKGROUND_LINK_REQUIRES_OPEN/)
    assert.equal(requests.slice(beforeRefusal).some((request) => request.params?.message?.method.startsWith('Input.')), false)
    assert.equal((await evaluate('broker.snapshot()')).sessions[0].tabCount, 1)
    assert.equal((await evaluate('chrome.tabs.query({})')).length, 2)
    assert.equal(await form.evaluate(() => window.linkClicks), 0)

    const linked = checked(await controller.tabs({ action: 'open_link', ref: sourceRef }, exec))
    assert.equal(linked.navigationOnly, true)
    assert.equal(linked.clickScriptsExecuted, false)
    assert.equal(linked.sourceTabId, opened.tabId)
    assert.notEqual(linked.openedTabId, opened.tabId)
    assert.equal(linked.openedUrl, `${base}/brief`)
    assert.match(linked.outline, /Reference code: SAMPLE42/)
    const listed = checked(await controller.tabs({ action: 'list' }, exec))
    assert.equal(listed.tabs.length, 2)
    assert.deepEqual(listed.tabs.map((tab) => tab.url).sort(), [`${base}/`, `${base}/brief`].sort())
    const liveSnapshot = await evaluate('broker.snapshot()')
    assert.equal(liveSnapshot.sessions[0].tabCount, 2)
    const groupId = liveSnapshot.sessions[0].groupId
    const ownedTabs = await evaluate(`chrome.tabs.query({groupId:${groupId}}).then(tabs=>tabs.map(({id,active,url})=>({id,active,url})))`)
    assert.equal(ownedTabs.length, 2)
    assert.ok(ownedTabs.every((tab) => !tab.active))
    assert.equal(await form.evaluate(() => window.linkClicks), 0)
    assert.equal(reads.filter((url) => url === '/brief').length, 1)
    await activeUnchanged()

    let observation = checked(await controller.tabs({ action: 'select', tab_id: opened.tabId }, exec))
    checked(await controller.type({ ref: ref(observation, 'Name'), text: 'Background test', replace: true }, exec))
    observation = checked(await controller.observe({}, exec))
    checked(await controller.type({ ref: ref(observation, 'Reference'), text: 'SAMPLE42', replace: true }, exec))
    observation = checked(await controller.observe({}, exec))
    checked(await controller.click({ ref: ref(observation, 'Preview') }, exec))
    const verified = await conditions.browserWaitFor({ expect: [{ kind: 'text', value: 'Preview ready: Background test / SAMPLE42' }], timeout_ms: 3000, interval_ms: 100, stable_samples: 1 }, exec)
    assert.equal(verified.status, 'satisfied', verified.result)
    assert.equal(verified.matched, true)
    assert.deepEqual(previews, [{ name: 'Background test', reference: 'SAMPLE42' }])
    assert.deepEqual(await form.evaluate(() => window.previewClicks), [{ trusted: true }])
    assert.equal(await form.evaluate(() => window.linkClicks), 0)
    await activeUnchanged()

    const released = checked(await controller.close({}, exec))
    assert.equal(released.groupCleanup.complete, true)
    assert.equal(released.groupCleanup.ungroupedTabs, 2)
    assert.equal(getSessionState().browser, null)
    const retained = await evaluate('chrome.tabs.query({}).then(tabs=>tabs.map(({id,active,url,groupId})=>({id,active,url,groupId})))')
    assert.equal(retained.length, 3)
    for (const owned of ownedTabs) {
      const remaining = retained.find((tab) => tab.id === owned.id)
      assert.ok(remaining, 'owned result page must remain open')
      assert.equal(remaining.groupId, -1)
      assert.equal(remaining.active, false)
    }
    assert.deepEqual(await evaluate('chrome.tabGroups.query({})'), [])
    assert.deepEqual((await evaluate('broker.snapshot()')).sessions, [])
    assert.equal(requests.filter((request) => request.method === 'session.close').length, 1)
    assert.equal(requests.some((request) => request.params?.message?.method === 'Browser.close'), false)
    await activeUnchanged()
    t.diagnostic('Real MV3 debugger + native framing + restricted CDP + controller: 2 owned pages, 1 trusted preview, 2 retained ungrouped pages, selected user tab unchanged.')
  })
})
