/**
 * macOS source-plugin smoke check against the real cua-driver.
 * Registers the actual plugin tools in a minimal stub host, opens Calculator
 * in the background, and verifies 7 × 8 = 56 through AX + coordinates + zoom.
 * This does not reload DSH or test its real approval/attachment/model services.
 * Run: node verify-desktop.mjs [optional-evidence-json-path]
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import plugin from './index.js'
import { cuaCall } from './lib/cua.js'
import { createToolScope, getDriverSession, getSessionState } from './lib/session.js'

if (process.platform !== 'darwin') throw new Error('verify-desktop currently exercises macOS Calculator only.')

const evidencePath = process.argv[2]
  ? resolve(process.argv[2])
  : join(await mkdtemp(join(tmpdir(), 'dsh-desktop-')), 'evidence.json')
const evidence = {
  startedAt: new Date().toISOString(),
  environment: 'actual plugin source + real cua-driver + stub DSH host services',
  limits: ['No DSH process reload', 'No real model/attachment/approval service integration', 'Calculator only; no browser or other desktop applications exercised'],
  steps: [],
}
const tools = new Map()
const attachments = []
const imagePaths = new Map()
const services = {
  attachments: {
    async saveImage({ data, mediaType, name }) {
      const ref = { attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`, mediaType, bytes: data.length, name }
      const path = join(dirname(evidencePath), `${ref.attachmentId.slice(7, 19)}-${name}`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data)
      imagePaths.set(ref.attachmentId, path)
      attachments.push({ name, mediaType, bytes: data.length, path })
      return ref
    },
  },
  llm: {
    async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    // eslint-disable-next-line require-yield -- A model call must fail before producing any chunks.
    async * stream() { throw new Error('This check never calls a model.') },
  },
}
const ctx = {
  get: (name) => services[name],
  approval: { async request() { throw new Error('Unexpected approval request: foreground delivery is not allowed in this check.') } },
  tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  logger: { info() {} },
}
const config = {
  ttlMs: 120000, maxElements: 500, allowedApps: [], cursorTheme: '',
  nativeImage: 'auto', visionProvider: 'stub', visionModel: 'stub-vision',
}
const agent = { options: { provider: 'stub', model: 'stub-vision' }, session: {} }
const exec = { agent, signal: new AbortController().signal }

async function run(name, args = {}, expectedOk = true) {
  const started = performance.now()
  const definition = tools.get(name)
  assert.ok(definition, `${name} must be registered`)
  const value = await definition.execute(args, exec)
  const step = { tool: name, args, ok: value.ok, durationMs: Math.round(performance.now() - started) }
  evidence.steps.push(step)
  assert.equal(value.ok, expectedOk, `${name}: ${value.result}`)
  if (name === 'computer_verify' || name === 'computer_wait_for') {
    step.status = value.status
    step.matched = value.matched
    step.samples = value.data?.samples
  }
  if (name === 'computer_click') {
    const jsonStart = value.result.indexOf('{')
    assert.ok(jsonStart >= 0, 'click must expose driver evidence')
    const driver = JSON.parse(value.result.slice(jsonStart))
    step.effect = driver.effect
    step.delivery = driver.delivery
    assert.equal(driver.delivery?.mode, 'background', `click changed delivery mode: ${value.result}`)
  }
  return value
}
function button(observation, pattern) {
  const candidates = observation.elements.filter((entry) => entry.role === '按钮' && pattern.test(entry.label))
  assert.equal(candidates.length, 1, `Expected one ${pattern} button; available: ${observation.elements.filter((entry) => entry.role === '按钮').map((entry) => entry.label).join(', ')}`)
  return candidates[0]
}

async function recognizeCalculatorImage(path) {
  // Calculator on recent macOS versions omits the display from its AX tree.
  // The system JXA bridge calls on-device Vision; no compiler, model, network,
  // Apple Events application control, or external OCR dependency is needed.
  const source = `function run(argv) {
    ObjC.import('Foundation'); ObjC.import('Vision');
    var request = $.VNRecognizeTextRequest.alloc.init;
    request.recognitionLevel = 0;
    var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
    if (!handler.performRequestsError($([request]), null)) throw new Error('Vision OCR failed');
    var results = request.results; var words = [];
    for (var i = 0; i < results.count; i++) {
      var candidates = results.objectAtIndex(i).topCandidates(1);
      if (candidates.count) words.push(ObjC.unwrap(candidates.objectAtIndex(0).string));
    }
    return JSON.stringify(words);
  }`
  const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source, path], { timeout: 30000, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout)
}

try {
  plugin.apply(ctx, config)
  const beforeApps = await run('app_list')
  evidence.activePidBefore = beforeApps.apps.find((app) => app.active)?.pid ?? null
  const launched = await run('app_launch', { bundle_id: 'com.apple.calculator', bring_to_front: false })
  const windowList = await cuaCall('list_windows', { on_screen_only: true })
  const calculatorWindows = (windowList.windows || []).filter((window) => launched.pid
    ? window.pid === launched.pid
    : /^(Calculator|计算器)$/i.test(window.app_name || ''))
  assert.equal(calculatorWindows.length, 1, 'Calculator must have one visible window for this check.')
  const target = calculatorWindows[0]
  evidence.target = { pid: target.pid, windowId: target.window_id, app: target.app_name }
  const observe = () => run('screen_observe', { window_id: target.window_id, mode: 'ax' })
  let observation = await observe()
  assert.equal(observation.mode, 'ax', 'Calculator must use AX without visual fallback.')
  assert.equal(Object.hasOwn(observation, 'image'), false, 'AX must not emit model image attachments.')
  evidence.axElementCount = observation.elementCount
  evidence.axEmittedImage = false

  const verified = await run('computer_verify', { expect: [
    { window: { exists: true } },
    { element: { selector: { role: 'AXButton', label_contains: '7' }, exists: true } },
  ] })
  assert.equal(verified.status, 'satisfied')
  observation = await observe()
  const waited = await run('computer_wait_for', {
    expect: [{ window: { exists: true } }], timeout_ms: 1000, interval_ms: 50, stable_samples: 2,
  })
  assert.equal(waited.data.samples, 2)
  observation = await observe()
  const missing = await run('computer_verify', { expect: [
    { element: { selector: { role: 'AXButton', label_contains: '__dsh_missing_condition_fixture__' }, exists: true } },
  ] }, false)
  assert.equal(missing.matched, false)
  assert.ok(['unknown', 'unsatisfied'].includes(missing.status), 'An unobserved target must never satisfy an assertion.')
  evidence.conditions = { positive: verified.status, stableWait: waited.status, waitSamples: waited.data.samples, missing: missing.status, missingPassed: missing.ok }
  observation = await observe()

  // Coordinate input after AX proves the driver retained a screenshot context.
  // Repeat clear once so a C button also becomes AC before entering a new value.
  for (let i = 0; i < 2; i++) {
    const clear = button(observation, /^(AC|C|全部清除|清除|清除所有|All Clear|Clear)$/i)
    await run('computer_click', { x: clear.x, y: clear.y })
    observation = await observe()
  }

  // A small symmetric crop around the known button center retains that center
  // despite the driver's 20% padding; from_zoom delegates all mapping to it.
  const seven = button(observation, /^7$/)
  const zoom = await run('screen_zoom', {
    x1: seven.x - 8, y1: seven.y - 8, x2: seven.x + 8, y2: seven.y + 8,
  })
  assert.ok(zoom.image?.width > 0 && zoom.image?.height > 0, 'zoom must return real image dimensions')
  await run('computer_click', { x: Math.floor(zoom.image.width / 2), y: Math.floor(zoom.image.height / 2), from_zoom: true })
  observation = await observe()
  const multiply = button(observation, /^(×|乘|乘法|乘以|multiply|multiplication)$/i)
  await run('computer_click', { element: multiply.index })
  observation = await observe()
  await run('computer_click', { element: button(observation, /^8$/).index })
  observation = await observe()
  await run('computer_click', { element: button(observation, /^(=|等于|equals|equal)$/i).index })
  observation = await observe()
  evidence.finalObservation = observation.result
  const axReadback = observation.elements.some((entry) => /(^|\D)56($|\D)/.test(entry.label)) || /值="56"/.test(observation.result)
  if (axReadback) {
    evidence.readback = { mode: 'AX', result: '56' }
  } else {
    const finalImage = await run('screen_observe', { window_id: target.window_id, mode: 'native' })
    const imagePath = imagePaths.get(finalImage.image?.attachmentId)
    assert.ok(imagePath, 'Native observation must save a real image attachment.')
    const render = tools.get('screen_observe').output.render({}, finalImage)
    assert.ok(render.some((block) => block.type === 'image'), 'Native render must emit the image attachment.')
    const recognized = await recognizeCalculatorImage(imagePath)
    evidence.readback = { mode: 'native screenshot + on-device Apple Vision OCR', recognized, imagePath }
    assert.ok(recognized.some((word) => word.replace(/\s/g, '') === '56'), 'Calculator screenshot must read back result 56.')
  }
  evidence.calculation = { expression: '7 × 8', expected: '56', verified: true }
  evidence.finalObservation = observation.result
  const afterApps = await run('app_list')
  evidence.activePidAfter = afterApps.apps.find((app) => app.active)?.pid ?? null
  evidence.activeAppUnchanged = evidence.activePidBefore === evidence.activePidAfter
  evidence.attachments = attachments
  evidence.ok = true
} catch (error) {
  evidence.ok = false
  evidence.error = error.message
  process.exitCode = 1
} finally {
  const cleanupScope = createToolScope()
  await cleanupScope(exec, async () => {
    if (!getSessionState().initialized) return
    const session = getDriverSession()
    try {
      await cuaCall('end_session', { session })
      evidence.sessionCleanup = { session, ended: true }
    } catch (error) {
      evidence.sessionCleanup = { session, ended: false, error: error.message }
      evidence.ok = false
      process.exitCode = 1
    }
  })
  evidence.finishedAt = new Date().toISOString()
  await mkdir(dirname(evidencePath), { recursive: true })
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ ok: evidence.ok, calculation: evidence.calculation, activeAppUnchanged: evidence.activeAppUnchanged, sessionCleanup: evidence.sessionCleanup, stepCount: evidence.steps.length, error: evidence.error, evidencePath }, null, 2))
}
