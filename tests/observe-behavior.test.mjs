import test from 'node:test'
import assert from 'node:assert/strict'
import { screenObserve, screenZoom } from '../lib/observe.js'
import { getSnapshot, setSnapshot, clearSnapshot } from '../lib/snapshot.js'
import { CUA_SESSION } from '../lib/cua.js'
import { guard } from '../lib/guard.js'

const window = { pid: 42, window_id: 99, app_name: '测试 App', title: '测试窗口', z_index: 1 }
const element = (token = 'token-1') => ({ element_index: 1, element_token: token, role: 'AXButton', label: '确认 😀', frame: { x: 10, y: 20, w: 100, h: 40 } })
const state = (overrides = {}) => ({ snapshot_id: 'snapshot-1', elements: [element()], screenshot_width: 1000, screenshot_height: 800, ...overrides })
const cfg = { ttlMs: 30000, maxElements: 500 }
function harness({ windows = [window], states = [state()], native = false, observer = false, imageWidth = 1000, imageHeight = 800, vision, zoom } = {}) {
  const calls = []
  const saved = []
  let cursor = 0
  const ctx = { get(name) {
    if (name === 'attachments') return { async saveImage(args) { saved.push(args); return { attachmentId: 'image-1', mediaType: args.mediaType, bytes: args.data.length, width: imageWidth, height: imageHeight } } }
    if (name === 'llm' && observer) return {}
  } }
  const deps = {
    async cuaCall(tool, args) {
      calls.push({ tool, args })
      if (tool === 'list_windows') return { windows }
      if (tool === 'get_window_state') return states[Math.min(cursor++, states.length - 1)]
      if (tool === 'zoom') return zoom || { screenshot_png_b64: Buffer.from('jpeg').toString('base64'), width: imageWidth, height: imageHeight }
      throw new Error(`Unexpected tool ${tool}`)
    },
    routeImageCapable: async () => native,
    modelImageCapable: async () => observer,
    glmVisionConfigured: () => false,
    deepseekVisionDescribe: vision || (async () => 'V1 按钮 @(100,100)'),
  }
  return { ctx, deps, calls, saved }
}
const png = Buffer.from('png').toString('base64')

test('AX observation requests structured elements with the driver session and preserves emoji', async () => {
  const h = harness()
  const before = Date.now()
  const value = await screenObserve(h.ctx, { window_id: 99 }, cfg, {}, h.deps)
  assert.equal(value.ok, true)
  assert.equal(value.mode, 'ax')
  assert.match(value.result, /确认 😀/)
  assert.equal(value.snapshotId, 'snapshot-1')
  assert.ok(value.expiresAt >= before + cfg.ttlMs)
  assert.deepEqual(h.calls[1], { tool: 'get_window_state', args: { session: CUA_SESSION, pid: 42, window_id: 99, include_screenshot: true, max_elements: 500, tree_format: 'elements' } })
  assert.equal(getSnapshot().entries.get(1).token, 'token-1')
  assert.equal(h.saved.length, 0)
})

test('screenshot retry uses refreshed elements and tokens, preserving the query', async () => {
  const h = harness({ native: true, states: [state({ elements: [] }), state({ snapshot_id: 'snapshot-2', elements: [element('token-2')], screenshot_png_b64: png })] })
  const value = await screenObserve(h.ctx, { query: '确认' }, cfg, {}, h.deps)
  assert.equal(value.ok, true)
  assert.equal(value.snapshotId, 'snapshot-2')
  assert.equal(getSnapshot().entries.get(1).token, 'token-2')
  assert.equal(h.calls[2].args.query, '确认')
  assert.equal(h.calls[2].args.tree_format, 'elements')
  // The second capture recovered a usable AX tree, so no image attachment is necessary.
  assert.equal(value.mode, 'ax')
})

test('usable AX observation avoids all visual model and GLM credential lookups', async () => {
  const h = harness()
  h.deps.routeImageCapable = h.deps.modelImageCapable = h.deps.glmVisionConfigured = () => { throw new Error('visual lookup must be lazy') }
  assert.equal((await screenObserve(h.ctx, {}, cfg, {}, h.deps)).ok, true)
})

test('output truncation cannot hide dangerous words from the action guard', async () => {
  const h = harness({ states: [state({ elements: [{ ...element(), label: '普通说明'.repeat(80) + ' Delete account' }] })] })
  const value = await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  assert.equal(value.ok, true)
  assert.ok(value.elements[0].label.length <= 100)
  const result = await guard({}, cfg, 'computer_click', { element: 1 }, {})
  assert.equal(result.ok, false)
})

test('driver screenshot_frame takes priority over screen-point frame on Retina displays', async () => {
  const h = harness({ states: [state({
    screenshot_width: 460, screenshot_height: 816,
    window_bounds: { x: 306, y: 492, width: 230, height: 408 },
    elements: [{ ...element(), frame: { x: 316, y: 679, w: 48, h: 48 }, screenshot_frame: { x: 20, y: 374, w: 96, h: 96 } }],
  })] })
  const value = await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  assert.deepEqual([value.elements[0].x, value.elements[0].y], [68, 422])
  assert.deepEqual([getSnapshot().entries.get(1).x, getSnapshot().entries.get(1).y], [68, 422])
})

test('legacy screen-point frames map through window bounds and exclude outside-window coordinates', async () => {
  const h = harness({ states: [state({
    screenshot_width: 460, screenshot_height: 816,
    window_bounds: { x: 306, y: 492, width: 230, height: 408 },
    elements: [{ ...element(), frame: { x: 316, y: 679, w: 48, h: 48 } }, { ...element(), element_index: 2, frame: { x: 10, y: 10, w: 20, h: 20 } }],
  })] })
  const value = await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  assert.deepEqual([value.elements[0].x, value.elements[0].y], [68, 422])
  assert.deepEqual([value.elements[1].x, value.elements[1].y], [null, null])
})

test('secure fields remain targetable without exposing their value', async () => {
  const h = harness({ states: [state({ elements: [{ ...element(), role: 'AXSecureTextField', label: '', value: 'synthetic-secret-value' }] })] })
  const value = await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  assert.equal(value.ok, true)
  assert.match(value.result, /密码框/)
  assert.equal(JSON.stringify(value).includes('synthetic-secret-value'), false)
  assert.equal(getSnapshot().entries.get(1).role, 'AXSecureTextField')
  assert.equal(getSnapshot().entries.get(1).label, '密码输入')
})

test('ambiguous app and pid targets are refused and clear the previous snapshot', async () => {
  const h = harness({ windows: [window, { ...window, window_id: 100, title: '第二窗口' }] })
  setSnapshot({ at: Date.now(), entries: new Map() })
  const value = await screenObserve(h.ctx, { pid: 42 }, cfg, {}, h.deps)
  assert.equal(value.ok, false)
  assert.match(value.result, /多个窗口/)
  assert.match(value.result, /window_id=100/)
  assert.equal(getSnapshot(), null)
  assert.equal(h.calls.length, 1)
})

test('an exact title can select one of multiple app windows', async () => {
  const h = harness({ windows: [window, { ...window, window_id: 100, title: '第二窗口' }] })
  const value = await screenObserve(h.ctx, { window: '第二窗口' }, cfg, {}, h.deps)
  assert.equal(value.ok, true)
  assert.equal(value.window.windowId, 100)
})

test('failed window lookup clears the previous observation', async () => {
  const h = harness()
  setSnapshot({ at: Date.now(), entries: new Map() })
  const value = await screenObserve(h.ctx, { window_id: 777 }, cfg, {}, h.deps)
  assert.equal(value.ok, false)
  assert.equal(getSnapshot(), null)
})

test('AX fallback uses a configured host observer without a GLM key', async () => {
  const h = harness({ observer: true, states: [state({ elements: [] }), state({ elements: [], screenshot_png_b64: png })] })
  const value = await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  assert.equal(value.ok, true)
  assert.equal(value.mode, 'vision')
  assert.match(value.result, /V1 按钮/)
  assert.equal(h.saved.length, 1)
})

test('failed native attachment falls through to host vision instead of silently returning empty AX', async () => {
  const h = harness({ native: true, observer: true, states: [state({ elements: [], screenshot_png_b64: png })] })
  const original = h.ctx.get('attachments')
  let attempts = 0
  const ctx = { get(name) {
    if (name === 'attachments') return { async saveImage(args) { if (++attempts === 1) throw new Error('temporary attachment failure'); return original.saveImage(args) } }
    return h.ctx.get(name)
  } }
  const value = await screenObserve(ctx, {}, cfg, {}, h.deps)
  assert.equal(value.ok, true)
  assert.equal(value.mode, 'vision')
  assert.equal(attempts, 2)
})

test('empty native screenshot fails explicitly without saving an attachment or snapshot', async () => {
  const h = harness({ native: true, states: [state({ screenshot_png_b64: '' })] })
  const value = await screenObserve(h.ctx, { mode: 'native' }, cfg, {}, h.deps)
  assert.equal(value.ok, false)
  assert.match(value.result, /空截图/)
  assert.equal(getSnapshot(), null)
  assert.equal(h.saved.length, 0)
})

test('failed vision is not reported as a successful observation', async () => {
  const h = harness({ observer: true, states: [state({ screenshot_png_b64: png })], vision: async () => { throw new Error('model unavailable') } })
  const value = await screenObserve(h.ctx, { mode: 'vision' }, cfg, {}, h.deps)
  assert.equal(value.ok, false)
  assert.match(value.result, /model unavailable/)
  assert.equal(getSnapshot(), null)
})

test('compact native screenshot exposes the scale between displayed and action coordinates', async () => {
  const h = harness({ native: true, states: [state({ screenshot_png_b64: png })], imageWidth: 500, imageHeight: 400 })
  const value = await screenObserve(h.ctx, { mode: 'native' }, { ...cfg, nativeImage: 'compact' }, {}, h.deps)
  assert.equal(value.ok, true)
  assert.match(value.result, /from_zoom=true/)
  assert.equal(getSnapshot().zoom.width, 500)
  assert.equal(value.image.width, 500)
  assert.equal(getSnapshot().screenshotWidth, 1000)
})

test('compact vision prompt retains zoom coordinates and avoids element ids', async () => {
  let question
  const h = harness({ observer: true, states: [state({ screenshot_png_b64: png })], imageWidth: 500, imageHeight: 400,
    vision: async (_ctx, _cfg, args) => { question = args.question; return 'V1 按钮 @(200,200)' } })
  const value = await screenObserve(h.ctx, { mode: 'vision' }, { ...cfg, nativeImage: 'compact' }, {}, h.deps)
  assert.equal(value.ok, true)
  assert.match(question, /宽 500px，高 400px/)
  assert.match(question, /from_zoom=true/)
  assert.equal(getSnapshot().zoom.width, 500)
  assert.match(question, /不能当作 element 编号/)
})

test('zoom reuses the observed window and never invalidates its element snapshot', async () => {
  const h = harness({ native: true, states: [state({ screenshot_png_b64: png })], imageWidth: 250, imageHeight: 200 })
  await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  const snapshot = getSnapshot()
  const value = await screenZoom(h.ctx, { x1: 100, y1: 200, x2: 600, y2: 600 }, cfg, {}, h.deps)
  assert.equal(value.ok, true)
  assert.equal(getSnapshot().at, snapshot.at)
  assert.equal(getSnapshot().entries, snapshot.entries)
  assert.equal(getSnapshot().zoom.width, 250)
  assert.equal(h.calls.filter((call) => call.tool === 'get_window_state').length, 1)
  assert.deepEqual(h.calls.at(-1), { tool: 'zoom', args: { session: CUA_SESSION, pid: 42, window_id: 99, x1: 100, y1: 200, x2: 600, y2: 600 } })
  assert.match(value.result, /from_zoom=true/)
})

test('zoom rejects wrong-window and invalid region requests without driver actions', async () => {
  const h = harness({ native: true })
  await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  assert.equal((await screenZoom(h.ctx, { window_id: 100 }, cfg, {}, h.deps)).ok, false)
  assert.equal((await screenZoom(h.ctx, { x1: 500, x2: 100 }, cfg, {}, h.deps)).ok, false)
  assert.equal((await screenZoom(h.ctx, { x1: NaN }, cfg, {}, h.deps)).ok, false)
  assert.equal(h.calls.some((call) => call.tool === 'zoom'), false)
  clearSnapshot()
})

test('failed zoom capture clears the old zoom mapping while preserving element tokens', async () => {
  const h = harness({ native: true })
  await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  await screenZoom(h.ctx, {}, cfg, {}, h.deps)
  const old = getSnapshot()
  assert.ok(old.zoom)
  const value = await screenZoom(h.ctx, {}, cfg, {}, { ...h.deps, cuaCall: async () => ({ screenshot_png_b64: '' }) })
  assert.equal(value.ok, false)
  assert.equal(getSnapshot().zoom, null)
  assert.equal(getSnapshot().entries, old.entries)
  assert.equal(getSnapshot().at, old.at)
})
