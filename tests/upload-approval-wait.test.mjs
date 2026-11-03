import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlaywrightController } from '../lib/browser-playwright.js'
import { createToolScope, getSessionState } from '../lib/session.js'

// Controller checks execute the production read-only element description on a
// small DOM carrier. Browser/host/UI integration is verified by verify:approval-ui.
async function fixture(check) {
  let clock = 1000, pageURL = 'https://example.test/upload?version=one#form'
  let frameURL = pageURL, detached = false, onRead, onApprove
  const counts = { approvals: 0, reads: 0, sends: 0, evaluations: 0 }
  const document = { getElementById: () => null }
  class Input {}
  const input = Object.assign(new Input(), {
    isConnected: true, ownerDocument: document, tagName: 'INPUT', type: 'file',
    label: 'Supporting file', role: null, disabled: false, ariaDisabled: false,
    hidden: false, value: '', tabIndex: 0,
    getBoundingClientRect() { return { x: 1, y: 1, width: 100, height: 20, right: 101, bottom: 21 } },
    getAttribute(name) { return ({ type: this.type, role: this.role, 'aria-label': this.label, 'aria-disabled': this.ariaDisabled ? 'true' : null })[name] ?? null },
    hasAttribute() { return false },
    matches(selector) { return selector === ':disabled' && this.disabled },
  })
  const frame = { url: () => frameURL, isDetached: () => detached }
  const page = { isClosed: () => false, url: () => pageURL }
  const handle = {
    ownerFrame: async () => frame,
    evaluate: async (fn, arg) => {
      counts.evaluations++
      const globals = { document, HTMLInputElement: Input, getComputedStyle: (element) => ({ visibility: element.hidden ? 'hidden' : 'visible', display: element.hidden ? 'none' : 'block' }), innerHeight: 800, innerWidth: 1200 }
      const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
      try {
        for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
        return fn(input, arg)
      } finally {
        for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
      }
    },
    setInputFiles: async (payloads) => { counts.sends++; assert.equal(payloads[0].buffer.toString(), 'test') },
    dispose: async () => {},
  }
  const entry = { ref: 'observed:0', name: input.label, role: 'fileinput', actions: ['pointer', 'upload'], enabled: true, handle, frame }
  const snapshot = { at: clock, tabId: 'tab', refs: new Map([[entry.ref, entry]]) }
  const state = { owned: true, backend: 'playwright', context: {}, pages: new Map([['tab', page]]), tabId: 'tab', dialogs: new Map(), continuations: new Map(), observed: snapshot }
  const abort = new AbortController()
  const exec = { agent: { session: {} }, signal: abort.signal }
  const readPaths = []
  const ctx = {
    approval: { request: async (request) => { counts.approvals++; return onApprove ? onApprove(request) : 'allowed-once' } },
    fs: {
      processPathFromHostPath: (path) => path,
      resolve: (path) => ({ displayPath: path }),
      lstat: async () => ({ type: 'file', size: 4 }),
      stat: async () => ({ type: 'file', size: 4 }),
      readBytes: async (target) => { counts.reads++; readPaths.push(target.displayPath); await onRead?.(); return Buffer.from('test') },
    },
  }
  const args = { ref: entry.ref, files: ['/explicit/selected.txt'] }
  await createToolScope()(exec, async () => {
    getSessionState().browser = state
    const controller = createPlaywrightController(ctx, { ttlMs: 100 }, { now: () => clock })
    await check({ controller, state, snapshot, entry, handle, input, frame, page, exec, args, abort, counts, readPaths,
      approve: (fn) => { onApprove = fn }, read: (fn) => { onRead = fn },
      advance: (ms) => { clock += ms }, pageURL: (url) => { pageURL = url }, frameURL: (url) => { frameURL = url }, detachFrame: () => { detached = true },
    })
  })
}

test('an upload approved after the snapshot TTL revalidates its original target without reviving refs', async () => fixture(async ({ controller, snapshot, state, exec, args, counts, approve, advance }) => {
  approve(() => { advance(1000); return 'allowed-once' })
  const value = await controller.upload(args, exec)
  assert.equal(value.ok, true)
  assert.deepEqual(counts, { approvals: 1, reads: 1, sends: 1, evaluations: 2 })
  assert.equal(snapshot.at, 1000)
  assert.equal(state.observed, null)
  const stale = await controller.upload(args, exec)
  assert.equal(stale.ok, false)
  assert.equal(counts.approvals, 1)
}))

test('an upload ref already expired before approval is refused without prompting or reading', async () => fixture(async ({ controller, exec, args, counts, advance }) => {
  advance(101)
  assert.equal((await controller.upload(args, exec)).ok, false)
  assert.equal(counts.approvals, 0)
  assert.equal(counts.reads, 0)
  assert.equal(counts.sends, 0)
}))

for (const [label, mutate] of [
  ['detached element', ({ input }) => { input.isConnected = false }],
  ['different document', ({ input }) => { input.ownerDocument = {} }],
  ['changed accessible name', ({ input }) => { input.label = 'Other file' }],
  ['changed role', ({ input }) => { input.role = 'button' }],
  ['changed input type', ({ input }) => { input.type = 'text' }],
  ['disabled target', ({ input }) => { input.disabled = true }],
  ['hidden target', ({ input }) => { input.hidden = true }],
  ['changed top-level URL query', ({ pageURL }) => { pageURL('https://example.test/upload?version=two#form') }],
  ['changed frame URL', ({ frameURL }) => { frameURL('https://frame.test/changed') }],
  ['detached frame', ({ detachFrame }) => { detachFrame() }],
  ['changed owner frame', ({ handle }) => { handle.ownerFrame = async () => ({}) }],
  ['changed tab', ({ state, page }) => { state.pages.set('other', page); state.tabId = 'other' }],
  ['replaced page', ({ state, page }) => { state.pages.set('tab', { ...page }) }],
  ['replaced snapshot', ({ state, snapshot }) => { state.observed = { ...snapshot } }],
  ['replaced ref entry', ({ snapshot, entry }) => { snapshot.refs.set(entry.ref, { ...entry }) }],
]) test(`approval cannot authorize an upload to a ${label}`, async () => fixture(async (f) => {
  f.approve(() => { mutate(f); return 'allowed-once' })
  const value = await f.controller.upload(f.args, f.exec)
  assert.equal(value.ok, false)
  assert.equal(JSON.parse(value.result).code, 'UPLOAD_TARGET_CHANGED')
  assert.match(value.result, /审批已允许/)
  assert.match(value.result, /文件未交给页面/)
  assert.equal(f.counts.reads, 0)
  assert.equal(f.counts.sends, 0)
}))

test('rejection and cancellation while awaiting approval never read file bytes', async () => {
  for (const outcome of ['rejected', 'cancelled']) await fixture(async ({ controller, exec, args, abort, counts, approve }) => {
    approve(() => { if (outcome === 'cancelled') abort.abort(); return outcome === 'cancelled' ? 'allowed-once' : outcome })
    assert.equal((await controller.upload(args, exec)).ok, false)
    assert.equal(counts.reads, 0)
    assert.equal(counts.sends, 0)
  })
})

test('the approved file list is immutable for the lifetime of the request', async () => fixture(async ({ controller, exec, args, counts, approve, readPaths }) => {
  approve((request) => {
    assert.ok(request.reason.includes('/explicit/selected.txt'))
    args.files[0] = '/unapproved/other.txt'
    return 'allowed-once'
  })
  assert.equal((await controller.upload(args, exec)).ok, true)
  assert.deepEqual(readPaths, ['/explicit/selected.txt'])
  assert.equal(counts.approvals, 1)
}))

test('a frame recipient is disclosed without its private URL query or fragment', async () => fixture(async ({ controller, exec, args, frameURL, approve }) => {
  frameURL('https://frame.test/file-picker?private=hidden#token')
  approve((request) => {
    const details = JSON.parse(request.reason.slice(request.reason.indexOf('{')))
    assert.equal(details.frame, 'https://frame.test/file-picker')
    assert.equal(details.page, 'https://example.test/upload')
    assert.ok(!request.reason.includes('private=hidden'))
    assert.ok(!request.reason.includes('#token'))
    return 'allowed-once'
  })
  assert.equal((await controller.upload(args, exec)).ok, true)
}))

test('a target changed while the approved file was read never receives the payload', async () => fixture(async ({ controller, exec, args, input, counts, read }) => {
  read(() => { input.label = 'Other file' })
  const value = await controller.upload(args, exec)
  assert.equal(value.ok, false)
  assert.equal(JSON.parse(value.result).code, 'UPLOAD_TARGET_CHANGED')
  assert.match(value.result, /审批已允许/)
  assert.match(value.result, /文件未交给页面/)
  assert.doesNotMatch(value.result, /未读取|没有读取/)
  assert.equal(counts.reads, 1)
  assert.equal(counts.sends, 0)
}))
