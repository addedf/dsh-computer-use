/**
 * actions.js —— 动作工具实现：点击 / 双击 / 右键 / 输入 / 按键 / 滚动 / 拖拽。
 *
 * 每个动作都基于 screen_observe 的快照：
 *  - element 编号模式 → 透传 element_token（引擎校验快照是否过期）
 *  - x/y 坐标模式 → 使用快照窗口的 window-local 像素坐标
 */
import { cuaCall, normalizeMcp, withSession } from './cua.js'
import { getSnapshot, clearSnapshot } from './snapshot.js'
import { resolveToken, resolveWindow } from './snapshot.js'
import { humanClick, resolveClickTarget, windowLocalOf } from './human.js'

function integer(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}–${max} 范围内的整数。`)
  }
  return value
}

function point(x, y, snap, zoom = false) {
  const width = zoom ? snap?.zoom?.width : snap?.screenshotWidth
  const height = zoom ? snap?.zoom?.height : snap?.screenshotHeight
  return {
    x: integer(x, 'x', 0, width ? width - 1 : 100000),
    y: integer(y, 'y', 0, height ? height - 1 : 100000),
  }
}

function engineRefusal(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.ok === false || ['error', 'failed', 'refused', 'rejected'].includes(value.status)
      || (value.error && typeof value.error === 'object')) {
      return [value.error?.code || value.code || value.status || 'error', value.error?.message || value.reason || value.message || '操作被拒绝'].join(' ')
    }
    const effect = value.effect
    if (effect === 'refused' || effect === 'rejected' || effect === 'suspected_noop') {
      const code = value.code ? ` (${value.code})` : ''
      const reason = value.escalation?.reason || value.reason || value.message || ''
      return `${effect}${code}${reason ? ' ' + reason : ''}`
    }
    if (value.code === 'background_unavailable') {
      const reason = value.escalation?.reason || value.reason || value.message || ''
      return `background_unavailable${reason ? ' ' + reason : ''}`
    }
    if (typeof value.error === 'string') return value.error.slice(0, 200)
  }
  return null
}

/** Retry only driver-declared background delivery failures in the foreground. */
function requiresForegroundRetry(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value.code === 'background_unavailable'
      || value.escalation === 'foreground'
      || value.escalation?.recommended === 'foreground'))
}

async function callWithForegroundFallback(call, tool, payload, { approval, agent, toolName, signal, platform = process.platform } = {}) {
  const observed = getSnapshot()
  let value = normalizeMcp(await call(tool, payload))
  const supportsDeliveryMode = tool === 'type_text' || platform === 'win32'
  if (!supportsDeliveryMode || !requiresForegroundRetry(value)) return value

  const snap = getSnapshot()
  const app = snap?.appName ? `（目标应用：${snap.appName}）` : ''
  if (!approval || !agent) {
    return {
      effect: 'refused',
      code: 'foreground_approval_required',
      reason: `后台投递不可用；前台重试可能改变焦点${app}，当前没有可用的用户审批服务。`,
    }
  }

  let outcome = 'unavailable'
  try {
    outcome = await approval.request({
      agent,
      toolName,
      reason: `驱动未能确认后台投递可用或建议使用前台模式。前台重试可能把目标窗口置于前台并向其输入/发送按键${app}；是否仅为本次操作批准？`,
      signal,
    })
  } catch { /* 失败关闭：没有明确批准就不切到前台 */ }
  if (outcome !== 'allowed-once' || signal?.aborted) {
    return {
      effect: 'refused',
      code: outcome === 'unavailable' ? 'foreground_approval_required' : 'foreground_approval_denied',
      reason: `前台重试未获本次批准（${outcome}），已停止。`,
    }
  }

  if (observed) {
    if (getSnapshot() !== observed) throw new Error('前台重试审批期间快照已变化：请重新观察。')
    resolveWindow(observed.ttlMs)
  }

  return normalizeMcp(await call(tool, { ...payload, delivery_mode: 'foreground' }))
}

/**
 * 真人点击：解析目标（编号或坐标）→ 光标滑行 → 像素级点击。
 * @returns {Promise<{ok:boolean, result:string}>}
 */
async function humanAction(label, args, cfg, extra = {}) {
  let target
  const snap = getSnapshot()
  if (args.element != null && (args.x != null || args.y != null || args.from_zoom)) {
    throw new Error('element 与坐标 x/y、from_zoom 必须二选一。')
  }
  if (args.element !== undefined && args.element !== null) {
    integer(args.element, 'element', 0, Number.MAX_SAFE_INTEGER)
    target = resolveClickTarget(Number(args.element), cfg.ttlMs)
  } else if (args.x !== undefined && args.y !== undefined) {
    const { pid, windowId } = resolveWindow(cfg.ttlMs)
    if (args.from_zoom && !snap?.zoom) throw new Error('没有可用的 zoom 上下文：请先调用 screen_zoom。')
    const { x: sx, y: sy } = point(args.x, args.y, snap, args.from_zoom)
    const local = windowLocalOf(sx, sy, snap)
    target = {
      pid,
      windowId,
      x: local.x,
      y: local.y,
      sx,
      sy,
      from_zoom: Boolean(args.from_zoom),
    }
  } else {
    throw new Error('必须提供 element（观察编号）或 x/y 坐标。')
  }
  const value = normalizeMcp(await humanClick({ ...target, ...extra }))
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `${label} 被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `${label} 完成（${value?.effect === 'confirmed' ? '驱动已确认' : '已投递，需重新观察验证界面结果'}）：${detail}` }
}

/** computer_click —— 真人操作：光标滑行 + 像素点击 */
export async function click(args, cfg) {
  const extra = {}
  if (args.count != null) extra.count = integer(args.count, 'count', 1, 3)
  return humanAction('点击', args, cfg, extra)
}

/** computer_double_click */
export async function doubleClick(args, cfg) {
  return humanAction('双击', args, cfg, { count: 2 })
}

/** computer_right_click */
export async function rightClick(args, cfg) {
  return humanAction('右键点击', args, cfg, { button: 'right' })
}

/** computer_type —— 文本输入（可指定元素，否则输入到前台应用当前焦点） */
export async function typeText(args, cfg, { call = cuaCall, resolve = resolveWindow, approval, agent, signal, platform = process.platform } = {}) {
  if (!args.text) throw new Error('computer_type: 缺少 text 参数。')
  const payload = withSession({ text: String(args.text), delivery_mode: 'background' })
  if (args.element !== undefined && args.element !== null) {
    const { pid, token } = resolveToken(Number(args.element), cfg.ttlMs)
    payload.pid = pid
    payload.element_token = token
  } else {
    // 即使输入当前焦点，也必须绑定到新鲜观察快照的窗口，禁止盲发到 desktop scope。
    const { pid, windowId } = resolve(cfg.ttlMs)
    payload.pid = pid
    payload.window_id = windowId
  }
  const value = await callWithForegroundFallback(call, 'type_text', payload, {
    approval, agent, toolName: 'computer_type', signal, platform,
  })
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `输入被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `输入完成：${detail}` }
}

/** computer_key —— 按键 / 快捷键（如 return、cmd+c） */
export async function key(args, cfg, options = {}) {
  return dispatchKey(args, cfg, options)
}

/**
 * computer_key dispatch with optional dependencies for deterministic tests.
 * Bare keys stay on press_key for classic Win32; modifier combinations use
 * hotkey so UIA/XAML accelerators receive the event.
 */
export async function dispatchKey(args, cfg, { call = cuaCall, resolve = resolveWindow, approval, agent, signal, platform = process.platform } = {}) {
  if (!args.key) throw new Error('computer_key: 缺少 key 参数。')
  const parts = String(args.key).toLowerCase().split('+').map((s) => s.trim())
  const MODS = new Set(['cmd', 'command', 'ctrl', 'control', 'option', 'alt', 'shift', 'fn'])
  const modifiers = parts.filter((p) => MODS.has(p)).map((p) => {
    if (p === 'command') return 'cmd'
    if (p === 'control') return 'ctrl'
    if (p === 'option') return 'alt'
    return p
  })
  const keyNames = parts.filter((p) => !MODS.has(p))
  if (keyNames.length !== 1 || !keyNames[0] || new Set(modifiers).size !== modifiers.length) {
    throw new Error('computer_key: 组合键只能包含修饰键和一个按键（示例: cmd+shift+p）。')
  }
  const keyName = keyNames[0]
  if (!keyName) throw new Error('computer_key: 无法解析按键（示例: return / cmd+c / shift+tab）。')
  const isCombo = modifiers.length > 0
  // Both routes require a fresh snapshot and retain pid + window_id targeting.
  // 注：只传 pid 在多窗口应用（QQ 等）会歧义，必须带 window_id
  const { pid, windowId } = resolve(cfg.ttlMs)
  const target = { pid, window_id: windowId }
  const deliveryMode = platform === 'win32' ? { delivery_mode: 'background' } : {}
  const payload = withSession(isCombo
    ? { keys: [...modifiers, keyName], ...target, ...deliveryMode }
    : { key: keyName, ...target, ...deliveryMode })
  const tool = isCombo ? 'hotkey' : 'press_key'
  const value = await callWithForegroundFallback(call, tool, payload, {
    approval, agent, toolName: 'computer_key', signal, platform,
  })
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `按键被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `按键完成 (${String(args.key)})：${detail}` }
}

/** computer_scroll */
export async function scroll(args, cfg, { call = cuaCall, resolve = resolveWindow } = {}) {
  const dir = args.direction || 'down'
  if (!['up', 'down', 'left', 'right'].includes(dir)) {
    throw new Error('computer_scroll: direction 必须是 up/down/left/right。')
  }
  const payload = withSession({ direction: dir })
  if (args.amount != null) payload.amount = integer(args.amount, 'amount', 1, 50)
  if (args.element !== undefined && args.element !== null) {
    const { pid, token } = resolveToken(Number(args.element), cfg.ttlMs)
    payload.pid = pid
    payload.element_token = token
  } else {
    const { pid, windowId } = resolve(cfg.ttlMs)
    payload.pid = pid
    payload.window_id = windowId
  }
  const value = normalizeMcp(await call('scroll', payload))
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `滚动被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `滚动完成 (${dir})：${detail}` }
}

/** computer_drag —— 拖拽（坐标 = 窗口本地截图像素，与观察输出同空间） */
export async function drag(args, cfg, { call = cuaCall, resolve = resolveWindow } = {}) {
  const { pid, windowId } = resolve(cfg.ttlMs)
  if ([args.from_x, args.from_y, args.to_x, args.to_y].some((v) => v === undefined)) {
    throw new Error('computer_drag: 需要 from_x/from_y/to_x/to_y。')
  }
  const from = point(args.from_x, args.from_y, getSnapshot())
  const to = point(args.to_x, args.to_y, getSnapshot())
  const payload = withSession({
    pid,
    window_id: windowId,
    from_x: from.x,
    from_y: from.y,
    to_x: to.x,
    to_y: to.y,
  })
  if (args.duration_ms != null) payload.duration_ms = integer(args.duration_ms, 'duration_ms', 0, 10000)
  const value = normalizeMcp(await call('drag', payload))
  const refusal = engineRefusal(value)
  if (refusal) return { ok: false, result: `拖拽被引擎拒绝：${refusal}` }
  const detail = typeof value === 'string' ? value : JSON.stringify(value)
  return { ok: true, result: `拖拽完成：${detail}` }
}

/** computer_wait —— 本地等待（不调引擎） */
export async function wait(args, { signal } = {}) {
  const ms = integer(args.ms ?? 1000, 'ms', 0, 60000)
  if (signal?.aborted) throw new Error('操作已取消。')
  await new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error('操作已取消。')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
  return { ok: true, result: `已等待 ${ms}ms。` }
}

/** app_list —— 列出应用 */
export async function listApps() {
  const value = await cuaCall('list_apps')
  const apps = (value.apps || []).filter((a) => a.running)
  const lines = apps.map((a) => {
    const win = a.windows && a.windows.length > 0 ? ` (${a.windows.length} 窗口)` : ''
    return `- ${a.name}${win} [pid=${a.pid}]${a.active ? ' ★活动' : ''}`
  })
  const result = `正在运行的应用（${apps.length} 个）：\n${lines.join('\n')}`
  return { ok: true, result, apps: apps.map((a) => ({ name: a.name, pid: a.pid, active: a.active })) }
}

/** app_launch —— 启动应用（后台），可选前置 */
export async function launchApp(args) {
  if (!args.name && !args.bundle_id) {
    throw new Error('app_launch: 需要 name（应用名）或 bundle_id。')
  }
  const payload = {}
  if (args.bundle_id) payload.bundle_id = String(args.bundle_id)
  else payload.name = String(args.name)
  if (args.creates_new_instance) payload.creates_new_instance = true
  const launched = await cuaCall('launch_app', withSession(payload))
  clearSnapshot()

  // 若请求前置，找 pid 并 bring_to_front
  let pid = launched?.pid ?? null
  let frontNote = ''
  if (args.bring_to_front && pid) {
    await cuaCall('bring_to_front', { pid })
    frontNote = ' 已前置'
  }

  const detail = typeof launched === 'string' ? launched : JSON.stringify(launched)
  return {
    ok: true,
    result: `应用已启动${frontNote}：${detail}`,
    pid,
  }
}
