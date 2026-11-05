import test from 'node:test'
import assert from 'node:assert/strict'
import { screenObserve, screenZoom } from '../lib/observe.js'
import { getSnapshot, setSnapshot } from '../lib/snapshot.js'

const cfg = { ttlMs: 30000, nativeImage: 'full' }
const encoded = Buffer.from('synthetic-image').toString('base64')
const driverState = {
  snapshot_id: 'pixels-1',
  screenshot_width: 1000,
  screenshot_height: 800,
  screenshot_png_b64: encoded,
  elements: [{ element_index: 1, element_token: 'button-1', role: 'AXButton', label: 'Continue' }],
}

function harness({
  dimensions = { width: 1000, height: 800 },
  state = driverState,
  zoom = { width: 500, height: 300 },
  observer = false,
} = {}) {
  const calls = []
  let saved = 0
  let described = 0
  const ctx = {
    get(name) {
      if (name === 'llm' && observer) return {}
      if (name === 'attachments')
        return {
          async saveImage(args) {
            saved++
            return {
              attachmentId: 'coordinate-image',
              bytes: args.data.length,
              mediaType: args.mediaType,
              ...dimensions,
            }
          },
        }
    },
  }
  const deps = {
    cuaCall: async (tool) => {
      calls.push(tool)
      if (tool === 'list_windows')
        return { windows: [{ pid: 42, window_id: 99, title: 'Coordinate fixture' }] }
      if (tool === 'get_window_state') return state
      if (tool === 'zoom') return { screenshot_png_b64: encoded, ...zoom }
      throw new Error(`unexpected tool ${tool}`)
    },
    routeImageCapable: async () => true,
    modelImageCapable: async () => observer,
    glmVisionConfigured: () => observer,
    deepseekVisionDescribe: async () => {
      described++
      return 'V1 @(20,20)'
    },
    glmVisionDescribe: async () => {
      described++
      return 'V1 @(20,20)'
    },
  }
  return { ctx, deps, calls, saved: () => saved, described: () => described }
}

test('a resized full attachment cannot authorize screenshot coordinates', async () => {
  const h = harness({ dimensions: { width: 500, height: 400 } })
  setSnapshot({ at: Date.now(), zoom: { width: 500, height: 300 } })
  const value = await screenObserve(h.ctx, { mode: 'native' }, cfg, {}, h.deps)
  assert.equal(value.ok, false)
  assert.match(value.result, /驱动图片为 1000×800，附件为 500×400/)
  assert.equal(value.image, undefined)
  assert.equal(getSnapshot(), null)
  assert.equal(h.saved(), 1)
})

test('an AX visual fallback stops on a resized attachment before another vision route', async () => {
  const h = harness({
    dimensions: { width: 500, height: 400 },
    state: { ...driverState, elements: [] },
    observer: true,
  })
  const value = await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  assert.equal(value.ok, false)
  assert.match(value.result, /坐标映射已拒绝/)
  assert.equal(getSnapshot(), null)
  assert.equal(h.described(), 0)
  assert.equal(h.saved(), 1)
})

test('a resized observer attachment does not send misleading coordinates to either model', async () => {
  const h = harness({ dimensions: { width: 500, height: 400 }, observer: true })
  const value = await screenObserve(h.ctx, { mode: 'vision' }, cfg, {}, h.deps)
  assert.equal(value.ok, false)
  assert.equal(h.described(), 0)
  assert.equal(getSnapshot(), null)
})

test('a second resize of the padded driver zoom image cannot establish from_zoom coordinates', async () => {
  const h = harness({ dimensions: { width: 250, height: 150 } })
  const value = await screenObserve(
    h.ctx,
    { mode: 'native' },
    { ...cfg, nativeImage: 'compact' },
    {},
    h.deps,
  )
  assert.equal(value.ok, false)
  assert.match(value.result, /驱动图片为 500×300，附件为 250×150/)
  assert.equal(getSnapshot(), null)
})

test('unchanged compact attachments preserve the exact driver zoom frame', async () => {
  const h = harness({ dimensions: { width: 500, height: 300 } })
  const value = await screenObserve(
    h.ctx,
    { mode: 'native' },
    { ...cfg, nativeImage: 'compact' },
    {},
    h.deps,
  )
  assert.equal(value.ok, true)
  assert.deepEqual([value.image.width, value.image.height], [500, 300])
  assert.deepEqual([getSnapshot().zoom.width, getSnapshot().zoom.height], [500, 300])
  assert.equal(getSnapshot().screenshotWidth, 1000)
  assert.match(value.result, /from_zoom=true/)
})

test('attachments with no dimension metadata retain the validated driver geometry', async () => {
  const h = harness({ dimensions: {} })
  const value = await screenObserve(h.ctx, { mode: 'native' }, cfg, {}, h.deps)
  assert.equal(value.ok, true)
  assert.deepEqual([value.image.width, value.image.height], [1000, 800])
  assert.match(value.result, /整窗截图坐标可直接用于 x\/y/)
})

test('invalid driver dimensions fail before persisting the image', async () => {
  const h = harness({ state: { ...driverState, screenshot_width: 0 } })
  const value = await screenObserve(h.ctx, { mode: 'native' }, cfg, {}, h.deps)
  assert.equal(value.ok, false)
  assert.equal(h.saved(), 0)
  assert.equal(getSnapshot(), null)
})

test('resized explicit zoom clears its prior zoom mapping while preserving the element snapshot', async () => {
  const h = harness({ dimensions: { width: 250, height: 150 } })
  await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  const old = getSnapshot()
  setSnapshot({ ...old, zoom: { width: 500, height: 300 } })
  const value = await screenZoom(h.ctx, {}, cfg, {}, h.deps)
  assert.equal(value.ok, false)
  assert.match(value.result, /坐标映射已拒绝/)
  assert.equal(getSnapshot().zoom, null)
  assert.equal(getSnapshot().entries, old.entries)
  assert.equal(getSnapshot().at, old.at)
})

test('invalid explicit zoom dimensions cannot restore the old zoom mapping', async () => {
  const h = harness({ zoom: { width: undefined, height: 300 } })
  await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  const old = getSnapshot()
  setSnapshot({ ...old, zoom: { width: 500, height: 300 } })
  const value = await screenZoom(h.ctx, {}, cfg, {}, h.deps)
  assert.equal(value.ok, false)
  assert.equal(h.saved(), 0)
  assert.equal(getSnapshot().zoom, null)
  assert.equal(getSnapshot().entries, old.entries)
})
