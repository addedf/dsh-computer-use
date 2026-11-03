/** Declarative, read-only conditions. No JavaScript, selectors that execute code,
 * implicit mutations, foreground fallback, or replay of action tools. */
import { cuaCall, normalizeMcp, withSession } from './cua.js'
import { getSnapshot, clearSnapshot } from './snapshot.js'
import { getSessionState } from './session.js'
import { observeBrowser } from './browser.js'

const STATES = ['satisfied', 'unsatisfied', 'unknown', 'timeout', 'cancelled', 'error']
const BROWSER_KINDS = new Set(['exists', 'text', 'value', 'url', 'title', 'checked', 'enabled'])
const SECURE = /password|passphrase|securetext|密码|密钥|口令/i

class ConditionError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
function invalid(message) { throw new ConditionError('INVALID_ARGUMENT', message) }
function cancelled(exec) {
  if (exec?.signal?.aborted) throw new ConditionError('CANCELLED', '条件检查已取消。')
}
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} 必须为对象。`)
  return value
}
function keys(value, allowed, label) {
  record(value, label)
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${label} 含不支持的字段。`)
}
function integer(value, fallback, name, min, max) {
  const result = value === undefined ? fallback : value
  if (!Number.isSafeInteger(result) || result < min || result > max) invalid(`${name} 必须为 ${min}–${max} 的整数。`)
  return result
}
function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.length || value.length > max) invalid(`${name} 需要 1–${max} 字符的字符串。`)
}
function bool(value, name) { if (typeof value !== 'boolean') invalid(`${name} 必须为布尔值。`) }
function predicates(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) invalid('expect 需要包含 1–8 个条件（AND）。')
}

export function validateDesktopConditions(expect) {
  predicates(expect)
  for (const predicate of expect) {
    keys(predicate, ['window', 'element'], '条件')
    if (Object.keys(predicate).length !== 1) invalid('每个桌面条件需要且只能包含 window 或 element。')
    if (predicate.window !== undefined) {
      const window = predicate.window
      keys(window, ['exists', 'bounds'], 'window')
      if (!Object.keys(window).length) invalid('window 条件不能为空。')
      if (window.exists !== undefined) bool(window.exists, 'window.exists')
      if (window.bounds !== undefined) {
        keys(window.bounds, ['x', 'y', 'width', 'height', 'tolerance_px'], 'window.bounds')
        for (const name of ['x', 'y', 'width', 'height']) {
          if (!Number.isFinite(window.bounds[name])) invalid('bounds 需要有限数值 x/y/width/height。')
        }
        if (window.bounds.width <= 0 || window.bounds.height <= 0) invalid('bounds 宽高必须为正数。')
        const tolerance = window.bounds.tolerance_px
        if (tolerance !== undefined && (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100)) invalid('tolerance_px 必须在 0–100 之间。')
      }
    } else {
      const element = predicate.element
      keys(element, ['selector', 'exists', 'value_equals', 'enabled', 'selected'], 'element')
      keys(element.selector, ['role', 'label_contains'], 'element.selector')
      if (!Object.keys(element.selector).length) invalid('元素条件需要 role 或 label_contains。')
      for (const name of ['role', 'label_contains']) {
        if (element.selector[name] !== undefined) text(element.selector[name], name)
      }
      if (Object.keys(element).length === 1) invalid('元素条件需要 exists/value_equals/enabled/selected 至少一项。')
      if (element.exists !== undefined && element.exists !== true) invalid('桌面 AX 不能证明元素不存在；exists 仅支持 true。')
      for (const name of ['enabled', 'selected']) if (element[name] !== undefined) bool(element[name], name)
      if (element.value_equals !== undefined) {
        if (typeof element.value_equals !== 'string' || element.value_equals.length > 2000) invalid('value_equals 必须是最多 2000 字符的字符串。')
        if (SECURE.test(`${element.selector.role || ''} ${element.selector.label_contains || ''}`)) invalid('不读取或断言密码/密钥字段的值。')
      }
    }
  }
  return expect
}

export function validateBrowserConditions(expect) {
  predicates(expect)
  for (const predicate of expect) {
    keys(predicate, ['kind', 'role', 'name', 'value', 'match'], '网页条件')
    if (!BROWSER_KINDS.has(predicate.kind)) invalid('网页条件 kind 不受支持。')
    for (const name of ['role', 'name']) if (predicate[name] !== undefined) text(predicate[name], name)
    if (predicate.match !== undefined && !['equals', 'contains'].includes(predicate.match)) invalid('match 仅支持 equals 或 contains。')
    if (['url', 'title'].includes(predicate.kind) && (predicate.role !== undefined || predicate.name !== undefined)) invalid('URL/title 条件不接受元素选择器。')
    if (['exists', 'value', 'checked', 'enabled'].includes(predicate.kind) && predicate.role === undefined && predicate.name === undefined) invalid('元素条件需要精确 role 或 name，不能使用旧 ref。')
    if (predicate.kind === 'exists') {
      if (predicate.value !== undefined) bool(predicate.value, 'exists.value')
      if (predicate.match !== undefined) invalid('exists 不接受 match。')
    } else if (['checked', 'enabled'].includes(predicate.kind)) {
      bool(predicate.value, `${predicate.kind}.value`)
      if (predicate.match !== undefined) invalid('布尔状态不接受 match。')
    } else {
      if (predicate.kind === 'value' && typeof predicate.value === 'string') {
        if (predicate.value.length > 2000) invalid('value 最多 2000 字符。')
      } else if (predicate.kind !== 'value') text(predicate.value, 'value')
      else if (predicate.value !== null && !['number', 'boolean'].includes(typeof predicate.value)) invalid('value 条件需要字符串、数字、布尔值或 null。')
      if (typeof predicate.value === 'number' && !Number.isFinite(predicate.value)) invalid('value 必须为有限数字。')
      if (predicate.match === 'contains' && typeof predicate.value !== 'string') invalid('contains 需要字符串 value。')
    }
    if (predicate.kind === 'url') {
      if (/[?#]/.test(predicate.value)) invalid('URL 条件仅支持 origin+pathname，不支持 query 或 fragment。')
      try { const url = new URL(predicate.value); if (url.username || url.password) invalid('URL 条件不能包含凭据。') } catch (error) { if (error instanceof ConditionError) throw error }
    }
  }
  return expect
}

function compare(actual, predicate) {
  if (actual === undefined || actual === null) return 'unknown'
  const match = predicate.match || (predicate.kind === 'text' ? 'contains' : 'equals')
  const matched = match === 'contains' ? typeof actual === 'string' && actual.includes(predicate.value) : actual === predicate.value
  return matched ? 'satisfied' : 'unsatisfied'
}

/** Pure evaluator; absence and truncated/hidden data never imply success. */
export function evaluateBrowserConditions(expect, facts = {}) {
  const refs = Array.isArray(facts.refs) ? facts.refs : []
  return expect.map((predicate, index) => {
    let status = 'unknown'
    let reason
    if (['url', 'title'].includes(predicate.kind)) {
      status = compare(facts[predicate.kind], predicate)
      if (predicate.kind === 'title' && facts.titleComplete !== true && (predicate.match || 'equals') === 'equals') status = 'unknown'
    } else if (predicate.kind === 'text' && predicate.role === undefined && predicate.name === undefined) {
      status = compare(facts.text, predicate)
      if (facts.textComplete !== true && (status === 'unsatisfied' || predicate.match === 'equals')) status = 'unknown'
    } else {
      const matches = refs.filter((entry) => (predicate.role === undefined || entry.role === predicate.role)
        && (predicate.name === undefined || (!entry.nameTruncated && entry.name === predicate.name)))
      if (predicate.kind === 'exists') {
        const expected = predicate.value ?? true
        if (matches.length) status = expected ? 'satisfied' : 'unsatisfied'
        else if (facts.complete === true) status = expected ? 'unsatisfied' : 'satisfied'
      } else if (matches.length !== 1) {
        reason = matches.length ? 'ambiguous_target' : 'target_not_observed'
        if (!matches.length && facts.complete === true) status = 'unsatisfied'
      } else {
        const entry = matches[0]
        if (predicate.kind === 'value') {
          status = entry.valueTruncated || entry.states?.protected === true || SECURE.test(`${entry.role || ''} ${entry.name || ''}`)
            ? 'unknown' : compare(entry.value, predicate)
        } else if (predicate.kind === 'text') {
          const observedText = entry.text ?? entry.name
          status = compare(observedText, predicate)
          if (entry.nameTruncated && (status === 'unsatisfied' || predicate.match === 'equals')) status = 'unknown'
        } else {
          const actual = predicate.kind === 'enabled'
            ? (typeof entry.enabled === 'boolean' ? entry.enabled : typeof entry.states?.disabled === 'boolean' ? !entry.states.disabled : undefined)
            : (typeof entry.checked === 'boolean' ? entry.checked : entry.states?.checked)
          status = typeof actual === 'boolean' ? compare(actual, predicate) : 'unknown'
        }
      }
    }
    return { index, status, ...(reason ? { reason } : {}) }
  })
}

function aggregate(checks) {
  if (checks.every((check) => check.status === 'satisfied')) return 'satisfied'
  if (checks.some((check) => check.status === 'unsatisfied')) return 'unsatisfied'
  return 'unknown'
}
function driverChecks(value, count) {
  const predicates = value?.predicates
  if (!Array.isArray(predicates) || predicates.length !== count || new Set(predicates.map((item) => item?.index)).size !== count) {
    return Array.from({ length: count }, (_unused, index) => ({ index, status: 'unknown', reason: 'invalid_driver_evidence' }))
  }
  const checks = Array.from({ length: count }, (_unused, index) => {
    const item = predicates.find((entry) => entry?.index === index)
    return { index, status: ['satisfied', 'unsatisfied', 'unknown'].includes(item?.status) ? item.status : 'unknown' }
  })
  if (aggregate(checks) === 'satisfied' && (value.status !== 'satisfied' || value.stable !== true)) {
    return checks.map((item) => ({ ...item, status: 'unknown', reason: 'driver_not_stable' }))
  }
  return checks
}
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ConditionError('CANCELLED', '条件检查已取消。')); return }
    const cancel = () => { clearTimeout(timer); reject(new ConditionError('CANCELLED', '条件检查已取消。')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
function output(status, checks = [], { observation, elapsedMs = 0, samples = 0, invalidated = false, message, code } = {}) {
  const matched = status === 'satisfied'
  const messages = { satisfied: '条件已满足。', unsatisfied: '条件未满足。', unknown: '观察不足，条件结果未知。', timeout: '等待超时，条件未得到确认。', cancelled: '条件检查已取消。', error: '条件检查失败。' }
  const result = (message || messages[status])
    + (invalidated ? ' 桌面验证已清除旧快照；继续操作前请 screen_observe。' : '')
    + (observation ? ' 本次只读观察生成了新 ref；请使用返回的 observation，不复用旧 ref。' : '')
  const data = { status, matched, checks, elapsedMs: Math.max(0, Math.round(elapsedMs)), samples, ...(code ? { code } : {}), ...(observation ? { observation } : {}) }
  return { ok: matched, result, status, matched, data, ...(observation ? { observation } : {}) }
}

/** Caller owns the existing tool scope; never enter index.apply or create a new owner. */
export function createConditionController(ctx, cfg = {}, deps = {}) {
  const now = deps.now || Date.now
  const sleep = deps.pause || pause
  const desktopCall = deps.desktopCall || cuaCall
  const readBrowser = deps.browserRead || ((exec) => observeBrowser(ctx, {}, cfg, exec, deps.browserOptions))
  const snapshot = deps.snapshot || getSnapshot
  const invalidate = deps.invalidate || clearSnapshot
  const sessionState = deps.sessionState || getSessionState
  const ttlMs = Number.isFinite(cfg.ttlMs) && cfg.ttlMs > 0 ? cfg.ttlMs : 120000
  const allowedApps = Array.isArray(cfg.allowedApps) ? cfg.allowedApps : []

  const run = async (domain, waiting, args = {}, exec) => {
    let invalidated = false
    const started = now()
    try {
      cancelled(exec)
      keys(args, ['expect', ...(waiting ? ['timeout_ms', 'interval_ms', 'stable_samples'] : []), ...(domain === 'desktop' ? ['snapshot_id'] : [])], '参数')
      const expect = domain === 'desktop' ? validateDesktopConditions(args.expect) : validateBrowserConditions(args.expect)
      const timeout = waiting ? integer(args.timeout_ms, 5000, 'timeout_ms', 0, 10000) : 0
      const interval = waiting ? integer(args.interval_ms, 200, 'interval_ms', 50, 1000) : 0
      const stableSamples = waiting ? integer(args.stable_samples, timeout === 0 ? 1 : 2, 'stable_samples', 1, 5) : 1
      let deadline = started + timeout
      let anchor
      if (domain === 'desktop') {
        anchor = snapshot()
        if (!anchor || !Number.isSafeInteger(anchor.pid) || anchor.pid <= 0 || !Number.isSafeInteger(anchor.windowId) || anchor.windowId <= 0) throw new ConditionError('NO_SNAPSHOT', '请先 screen_observe 精确观察目标窗口。')
        if (!Number.isFinite(anchor.at) || now() - anchor.at > ttlMs) { invalidate(); throw new ConditionError('STALE_SNAPSHOT', '观察快照已过期，请重新 screen_observe。') }
        if (args.snapshot_id !== undefined && args.snapshot_id !== anchor.snapshotId) throw new ConditionError('STALE_SNAPSHOT', '快照编号不匹配，请重新 screen_observe。')
        if (allowedApps.length && !allowedApps.includes(anchor.appName)) throw new ConditionError('APP_NOT_ALLOWED', '目标应用不在 allowedApps 中。')
        // verify_state can acquire replacement driver snapshots. Retain only an
        // immutable target anchor, never old element indices/tokens afterwards.
        invalidate(); invalidated = true
        deadline = Math.min(deadline, anchor.at + ttlMs)
      } else {
        const browser = sessionState().browser
        const supported = browser?.backend === 'playwright'
          || ((browser?.backend === undefined || browser?.backend === 'cua') && Number.isSafeInteger(browser.pid) && browser.pid > 0)
        if (!browser?.owned || !supported) throw new ConditionError('NO_BROWSER', '请先 browser_open 建立本会话独立浏览器。')
        if (allowedApps.length && browser.appName && !allowedApps.includes(browser.appName)) throw new ConditionError('APP_NOT_ALLOWED', '浏览器应用不在 allowedApps 中。')
      }
      let last = { checks: [] }
      let samples = 0
      let consecutive = 0
      while (true) {
        cancelled(exec)
        if (domain === 'desktop' && now() > anchor.at + ttlMs) throw new ConditionError('STALE_SNAPSHOT', '等待期间快照已过期，请重新 screen_observe。')
        if (samples && now() >= deadline) return output('timeout', last.checks, { ...last, samples, elapsedMs: now() - started, invalidated })
        if (domain === 'desktop') {
          const value = normalizeMcp(await desktopCall('verify_state', withSession({ pid: anchor.pid, window_id: anchor.windowId, expect, timeout_ms: 0, stable_samples: 1, include_screenshot: false })))
          last = { checks: driverChecks(value, expect.length) }
        } else {
          const read = await readBrowser(exec)
          if (read?.ok !== true || !read.observation || !read.facts) throw new ConditionError('READ_FAILED', '网页条件读取失败，请 browser_observe 检查会话或权限。')
          last = { checks: evaluateBrowserConditions(expect, read.facts), observation: read.observation }
        }
        samples++
        cancelled(exec)
        if (domain === 'desktop' && now() > anchor.at + ttlMs) throw new ConditionError('STALE_SNAPSHOT', '读取期间快照已过期，请重新 screen_observe。')
        const status = aggregate(last.checks)
        consecutive = status === 'satisfied' ? consecutive + 1 : 0
        if (waiting && timeout > 0 && now() > deadline) return output('timeout', last.checks, { ...last, samples, elapsedMs: now() - started, invalidated })
        if (consecutive >= stableSamples || !waiting) return output(status, last.checks, { ...last, samples, elapsedMs: now() - started, invalidated })
        const remaining = deadline - now()
        if (remaining <= 0) return output('timeout', last.checks, { ...last, samples, elapsedMs: now() - started, invalidated })
        await sleep(Math.min(interval, remaining), exec?.signal)
      }
    } catch (error) {
      const known = error instanceof ConditionError
      const status = exec?.signal?.aborted || error?.code === 'CANCELLED' ? 'cancelled' : 'error'
      return output(status, [], { invalidated, elapsedMs: now() - started, code: known ? error.code : 'READ_FAILED', message: known ? error.message : '条件读取失败，请重新观察并检查驱动。' })
    }
  }
  return {
    computerVerify: (args, exec) => run('desktop', false, args, exec),
    computerWaitFor: (args, exec) => run('desktop', true, args, exec),
    browserVerify: (args, exec) => run('browser', false, args, exec),
    browserWaitFor: (args, exec) => run('browser', true, args, exec),
  }
}

const DESKTOP_EXPECT = { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
  window: { type: 'object', additionalProperties: false, properties: {
    exists: { type: 'boolean' },
    bounds: { type: 'object', additionalProperties: false, properties: {
      x: { type: 'number', required: true }, y: { type: 'number', required: true },
      width: { type: 'number', required: true }, height: { type: 'number', required: true }, tolerance_px: { type: 'number' },
    } },
  } },
  element: { type: 'object', additionalProperties: false, properties: {
    selector: { type: 'object', required: true, additionalProperties: false, properties: { role: { type: 'string' }, label_contains: { type: 'string' } } },
    exists: { type: 'boolean', description: '只支持 true；AX 不完整时无法证明不存在。' }, value_equals: { type: 'string' }, enabled: { type: 'boolean' }, selected: { type: 'boolean' },
  } },
} } }
const BROWSER_EXPECT = { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', required: true, enum: [...BROWSER_KINDS] },
  role: { type: 'string', description: '精确 role；不使用会过期的 ref。' }, name: { type: 'string', description: '精确可访问名称。' },
  value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }], description: '期望值；exists 默认 true；checked/enabled 需要布尔值。' },
  match: { type: 'string', enum: ['equals', 'contains'], description: 'text 默认 contains，其他默认 equals。' },
} } }
const TIMING = {
  timeout_ms: { type: 'integer', description: '总等待毫秒，0–10000，默认 5000；底层单次只读请求也受驱动超时限制。' },
  interval_ms: { type: 'integer', description: '轮询间隔 50–1000ms，默认 200。' },
  stable_samples: { type: 'integer', description: '连续满足次数 1–5，默认 2；timeout_ms=0 默认 1。' },
}
const OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: {
    ok: { type: 'boolean', required: true }, result: { type: 'string', required: true },
    status: { type: 'string', enum: STATES, required: true }, matched: { type: 'boolean', required: true },
    data: { type: 'object', additionalProperties: true, required: true }, observation: { type: 'object', additionalProperties: true },
  } },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify({ message: value.result, ...value.data }) }],
}

/** Definitions for index.js to register through its existing scoped wrapper. */
export function conditionTools(ctx, cfg, deps) {
  const controller = createConditionController(ctx, cfg, deps)
  return [
    { name: 'computer_verify', description: '只读断言当前精确窗口的 AX/窗口条件；1–8 项 AND，unknown 不通过。验证后旧元素快照失效，操作前重新 screen_observe。', parameters: { expect: DESKTOP_EXPECT, snapshot_id: { type: 'string' } }, execute: controller.computerVerify },
    { name: 'computer_wait_for', description: '只读等待窗口/AX条件，连续满足才成功；总预算最多10秒且受原快照TTL约束，可取消。仅稳定role/label选择器，不复用旧element编号；之后重新观察。', parameters: { expect: DESKTOP_EXPECT, snapshot_id: { type: 'string' }, ...TIMING }, execute: controller.computerWaitFor },
    { name: 'browser_verify', description: '只读刷新并断言本会话独立网页的exists/text/value/url/title/checked/enabled条件；unknown不通过。role/name精确匹配，URL仅origin+pathname。返回最新observation，旧ref失效。', parameters: { expect: BROWSER_EXPECT }, execute: controller.browserVerify },
    { name: 'browser_wait_for', description: '只读轮询本会话独立网页条件，最多10秒，可取消；每次重新观察生成新ref，使用返回最新observation。URL不含query/hash，缺失或隐藏状态不会当作已满足。', parameters: { expect: BROWSER_EXPECT, ...TIMING }, execute: controller.browserWaitFor },
  ].map((definition) => ({ ...definition, output: OUTPUT }))
}
