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

const consentError = {
  code: 'px_capture_unavailable',
  reason: 'direct_capture_consent_required: private-window-marker; do-not-copy-bypass-advice',
  suggestion: 'private-suggestion-marker',
}

function assertConsentDiagnostic(value) {
  assert.equal(value.ok, false)
  assert.deepEqual(Object.keys(value).sort(), ['ok', 'result'])
  assert.match(value.result, /px_capture_unavailable\/direct_capture_consent_required/)
  assert.match(value.result, /不能静默授权/)
  assert.match(value.result, /cua-driver permissions grant/)
  assert.match(value.result, /不要立即重试/)
  assert.match(value.result, /mode="ax"/)
  assert.equal(value.result.includes('private-window-marker'), false)
  assert.equal(value.result.includes('private-suggestion-marker'), false)
  assert.equal(value.result.includes('do-not-copy-bypass-advice'), false)
  assert.equal(value.result.includes('Coordinate fixture'), false)
}

for (const mode of ['native', 'vision']) {
  test(`${mode} empty capture explains direct consent without saving or invoking a model`, async () => {
    const h = harness({
      observer: true,
      state: { ...driverState, screenshot_png_b64: '', screenshot_error: consentError },
    })
    const value = await screenObserve(h.ctx, { mode }, cfg, {}, h.deps)
    assertConsentDiagnostic(value)
    assert.equal(h.saved(), 0)
    assert.equal(h.described(), 0)
    assert.equal(getSnapshot(), null)
    assert.deepEqual(h.calls, ['list_windows', 'get_window_state'])
  })

  test(`${mode} compact zoom uses the same consent diagnostic without falling through to another model`, async () => {
    const h = harness({
      observer: true,
      zoom: { width: 500, height: 300, screenshot_png_b64: '', screenshot_error: consentError },
    })
    const value = await screenObserve(
      h.ctx,
      { mode },
      { ...cfg, nativeImage: 'compact' },
      {},
      h.deps,
    )
    assertConsentDiagnostic(value)
    assert.equal(h.saved(), 0)
    assert.equal(h.described(), 0)
    assert.equal(getSnapshot(), null)
    assert.deepEqual(h.calls, ['list_windows', 'get_window_state', 'zoom'])
  })
}

test('usable degraded AX keeps tokens but publishes no pixel frame and does not recapture', async () => {
  const h = harness({
    observer: true,
    state: {
      ...driverState,
      screenshot_png_b64: '',
      screenshot_error: consentError,
      screenshot_frame_valid: true,
      capture_id: 'must-not-bind-an-unavailable-image',
      degraded_reason: 'ax_window_unresolved',
      elements: [
        {
          ...driverState.elements[0],
          screenshot_frame: { x: 10, y: 20, w: 50, h: 40 },
        },
      ],
    },
  })
  const value = await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  assert.equal(value.ok, true)
  assert.equal(value.mode, 'ax')
  assert.match(value.result, /截图\/像素坐标不可用/)
  assert.match(value.result, /direct_capture_consent_required/)
  assert.equal(value.result.includes('@('), false)
  assert.equal(value.result.includes('private-window-marker'), false)
  assert.equal(value.result.includes('private-suggestion-marker'), false)
  assert.equal(value.image, undefined)
  assert.deepEqual([value.elements[0].x, value.elements[0].y], [null, null])
  const snapshot = getSnapshot()
  assert.equal(snapshot.entries.get(1).token, 'button-1')
  assert.deepEqual([snapshot.entries.get(1).x, snapshot.entries.get(1).y], [null, null])
  assert.equal(snapshot.screenshotWidth, null)
  assert.equal(snapshot.screenshotHeight, null)
  assert.equal(snapshot.zoom, null)
  assert.equal(h.saved(), 0)
  assert.equal(h.described(), 0)
  assert.deepEqual(h.calls, ['list_windows', 'get_window_state'])
})

test('an empty degraded AX tree with an explicit capture failure is not captured a second time', async () => {
  const h = harness({
    observer: true,
    state: { ...driverState, screenshot_png_b64: '', screenshot_error: consentError, elements: [] },
  })
  const value = await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  assertConsentDiagnostic(value)
  assert.deepEqual(h.calls, ['list_windows', 'get_window_state'])
  assert.equal(h.saved(), 0)
  assert.equal(h.described(), 0)
  assert.equal(getSnapshot(), null)
})

test('explicit empty zoom preserves AX tokens while clearing its old pixel mapping', async () => {
  const h = harness({
    zoom: { width: 500, height: 300, screenshot_png_b64: '', screenshot_error: consentError },
  })
  await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  const old = getSnapshot()
  setSnapshot({ ...old, zoom: { width: 500, height: 300 } })
  const value = await screenZoom(h.ctx, {}, cfg, {}, h.deps)
  assertConsentDiagnostic(value)
  assert.equal(getSnapshot().zoom, null)
  assert.equal(getSnapshot().entries, old.entries)
  assert.equal(getSnapshot().at, old.at)
  assert.equal(h.saved(), 0)
  assert.equal(h.described(), 0)
})

test('other and malformed screenshot errors never echo reason, suggestion or arbitrary codes', async () => {
  for (const detail of [
    { ...consentError, code: 'px_frame_mismatch' },
    { ...consentError, reason: 'not-a-known-consent-code: private-window-marker' },
    { ...consentError, code: 'private-window-marker'.repeat(20) },
    'private-window-marker',
  ]) {
    const h = harness({
      state: { ...driverState, screenshot_png_b64: '', screenshot_error: detail },
    })
    const value = await screenObserve(h.ctx, { mode: 'native' }, cfg, {}, h.deps)
    assert.equal(value.ok, false)
    assert.match(value.result, /截图当前不可用/)
    assert.equal(value.result.includes('cua-driver permissions grant'), false)
    assert.equal(value.result.includes('private-window-marker'), false)
    assert.equal(value.result.includes('private-suggestion-marker'), false)
    assert.equal(value.result.includes('do-not-copy-bypass-advice'), false)
    assert.equal(value.result.includes('Coordinate fixture'), false)
    assert.equal(h.saved(), 0)
    assert.equal(h.described(), 0)
  }
})

test('drivers omitting screenshot_error retain their existing empty-image diagnostics', async () => {
  const empty = { ...driverState, screenshot_png_b64: '' }
  for (const mode of ['native', 'vision']) {
    const h = harness({ state: empty, observer: true })
    const value = await screenObserve(h.ctx, { mode }, cfg, {}, h.deps)
    assert.equal(value.ok, false)
    assert.match(value.result, /引擎返回空截图/)
    assert.equal(value.result.includes('permissions grant'), false)
    assert.equal(h.saved(), 0)
    assert.equal(h.described(), 0)
  }
  const h = harness({ zoom: { screenshot_png_b64: '' } })
  await screenObserve(h.ctx, {}, cfg, {}, h.deps)
  const value = await screenZoom(h.ctx, {}, cfg, {}, h.deps)
  assert.deepEqual(value, { ok: false, result: 'zoom 返回空图片。' })
})
