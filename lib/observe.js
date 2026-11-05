/**
 * observe.js —— screen_observe 工具实现（含原生视觉 Mode C / 观察者 Mode D）。
 *
 * 流程：list_windows 取窗口 → 选目标 → get_window_state 取 AX 树
 * → 精简为"编号 + 角色 + 标签 + 中心坐标"行 → 缓存快照。
 *
 * 坐标语义（cua-driver 0.21+ 实测）：所有动作坐标 = "窗口本地截图像素"，
 * 与 get_window_state 返回的截图 PNG 同一空间（左上原点）。因此：
 *   - 元素编号模式 → element_token（AX 路径，无需坐标）
 *   - x/y 坐标模式 → 直接透传截图像素，不做 ×2 / 窗口偏移换算
 *
 * 三种观察模式：
 *   - ax（默认）：只取 AX 树，零视觉 token 成本。
 *   - vision：DeepSeek 视觉观察者（ctx.llm → deepseek-v4-flash-vision-exp，
 *     可配置 visionProvider/visionModel）结构化描述截图；模型不可用时回退 GLM。
 *   - native：截图经 attachments 持久化后以图片块("原生直读")返回 ——
 *     主对话模型（需支持 image 输入）直接看图，零外部 API。
 *   自动降级：AX 树为空（游戏/Canvas/Electron 不可解析）时，
 *   优先 native（route 支持 image）→ vision（有观察模型/GLM key）→ ax。
 */
import { withSession } from './cua.js'
import { cuaCall } from './cua.js'
import { setSnapshot, getSnapshot, clearSnapshot, isFresh } from './snapshot.js'
import { getSessionState } from './session.js'
import { observedDriverBinding, verifyObservedDriver } from './driver-capture.js'
import {
  deepseekVisionDescribe,
  glmVisionDescribe,
  glmVisionConfigured,
  routeImageCapable,
  modelImageCapable,
} from './vision.js'

/** AX role 中值得展示的精简角色名（太长会刷爆上下文）。 */
const ROLE_SHORT = {
  AXWindow: '窗口',
  AXButton: '按钮',
  AXTextField: '输入框',
  AXSecureTextField: '密码框',
  AXPasswordField: '密码框',
  AXTextArea: '文本框',
  AXCheckBox: '复选框',
  AXRadioButton: '单选',
  AXComboBox: '下拉框',
  AXMenuButton: '菜单按钮',
  AXMenuItem: '菜单项',
  AXLink: '链接',
  AXTab: '标签页',
  AXSlider: '滑块',
  AXScrollBar: '滚动条',
  AXTable: '表格',
  AXCell: '单元格',
  AXRow: '行',
  AXOutline: '大纲',
  AXList: '列表',
  AXStaticText: '文本',
  AXImage: '图片',
  AXPopUpButton: '弹出按钮',
  AXGroup: '分组',
  AXToolbar: '工具栏',
  AXSheet: '面板',
  AXDialog: '对话框',
}

function shortRole(role) {
  return ROLE_SHORT[role] || (role ? role.replace(/^AX/, '') : '元素')
}

function elementLabel(e) {
  // Some drivers expose a secure field's value; never copy that into model output.
  if (['AXSecureTextField', 'AXPasswordField'].includes(e.role)) return e.label || '密码输入'
  return e.label || e.value || ''
}

/** 清洗为安全字符串：保证可无损 JSON 序列化（去孤立代理项）+ 截断。 */
function safeStr(v, max = 120) {
  return Array.from(String(v ?? '').toWellFormed())
    .slice(0, max)
    .join('')
}

/** 是否值得给编号（可交互或有关键文本）。 */
function isActionable(e) {
  const r = e.role || ''
  if (
    [
      'AXButton',
      'AXTextField',
      'AXSecureTextField',
      'AXPasswordField',
      'AXTextArea',
      'AXCheckBox',
      'AXRadioButton',
      'AXComboBox',
      'AXMenuButton',
      'AXMenuItem',
      'AXLink',
      'AXTab',
      'AXSlider',
      'AXPopUpButton',
      'AXCell',
      'AXRow',
      'AXScrollBar',
    ].includes(r)
  )
    return true
  if (e.label || e.value) return true
  return false
}

/** screenshot_frame is window-local pixels; frame is screen points on macOS. */
function centerOf(e, state = {}) {
  if (state.screenshot_frame_valid === false) return null
  let f = e.screenshot_frame
  if (!f && e.frame) {
    const bounds = state.window_bounds
    if (
      bounds &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      state.screenshot_width > 0 &&
      state.screenshot_height > 0
    ) {
      const scaleX = state.screenshot_width / bounds.width
      const scaleY = state.screenshot_height / bounds.height
      f = {
        x: (e.frame.x - bounds.x) * scaleX,
        y: (e.frame.y - bounds.y) * scaleY,
        w: e.frame.w * scaleX,
        h: e.frame.h * scaleY,
      }
    } else {
      // Legacy drivers exposed frame directly in the screenshot coordinate space.
      f = e.frame
    }
  }
  if (!f) return null
  const x = f.x + f.w / 2
  const y = f.y + f.h / 2
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (
    (state.screenshot_width > 0 && (x < 0 || x >= state.screenshot_width)) ||
    (state.screenshot_height > 0 && (y < 0 || y >= state.screenshot_height))
  )
    return null
  return { x: Math.round(x), y: Math.round(y) }
}

/** 渲染一行编号元素。 */
function renderLine(e, state) {
  const role = shortRole(e.role)
  const label = safeStr(elementLabel(e))
  const parts = [`[${e.element_index}] ${role}`]
  if (label) parts.push(`"${label}"`)
  if (e.label && e.value != null && !['AXSecureTextField', 'AXPasswordField'].includes(e.role)) {
    const value = safeStr(e.value)
    if (value && value !== label) parts.push(`值="${value}"`)
  }
  const c = centerOf(e, state)
  if (c) parts.push(`@(${c.x},${c.y})`)
  return parts.join(' ')
}

/** 构造视觉提问（坐标系 = 截图像素 = 动作坐标）。 */
function visionQuestion(w, h) {
  return `这是一张电脑应用窗口的截图，宽 ${w}px，高 ${h}px（坐标原点左上角，坐标为窗口本地截图像素）。
请用中文描述界面内容，并列出所有可交互元素（按钮、输入框、菜单、链接、图标等），每项格式：
V序号 类型 "文字" @(x,y)
坐标 x,y 为该元素中心在截图中的像素位置。只输出列表，最多 30 项，不要多余解释。`
}

/** base64 → Buffer。 */
function buf(b64) {
  return Buffer.from(String(b64 || ''), 'base64')
}

const SCREENSHOT_ERROR_CODES = new Set([
  'px_capture_unavailable',
  'px_frame_mismatch',
  'px_window_not_found',
])

class ScreenshotCaptureError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code.toUpperCase()
  }
}

/** Driver reasons can contain app names and bypass advice; never copy them. */
function emptyScreenshotError(state, fallbackMessage) {
  const detail = state?.screenshot_error
  if (detail == null) return new Error(fallbackMessage)
  const code = SCREENSHOT_ERROR_CODES.has(detail?.code) ? detail.code : 'screenshot_unavailable'
  const consentRequired =
    code === 'px_capture_unavailable' &&
    typeof detail?.reason === 'string' &&
    detail.reason.startsWith('direct_capture_consent_required:')
  const message = consentRequired
    ? `[${code}/direct_capture_consent_required] macOS 直接截图许可尚未完成。为避免系统授权弹窗抢占焦点，驱动已跳过截图；插件不能静默授权。请用户在方便时运行 cua-driver permissions grant 并亲自确认授权；完成前不要立即重试 native/vision 截图。切回 mode="ax" 不受该截图许可影响。`
    : `[${code}] 截图当前不可用，已停止图片处理；可使用 mode="ax" 读取可用的界面树，待截图权限或状态恢复后再观察。`
  return new ScreenshotCaptureError(code, message)
}

function screenshotFailureOutput(error, prefix = '') {
  return {
    ok: false,
    result: `${prefix}${error.message}`,
  }
}

const defaultDependencies = {
  cuaCall,
  routeImageCapable,
  modelImageCapable,
  deepseekVisionDescribe,
  glmVisionDescribe,
  glmVisionConfigured,
  verifyObservedDriver,
}

/** Explain the mapping when an attachment has fewer pixels than the action space. */
function imageCoordinateNote(sourceWidth, sourceHeight, imageWidth, imageHeight, fromZoom = false) {
  if (
    ![sourceWidth, sourceHeight, imageWidth, imageHeight].every((n) => Number.isInteger(n) && n > 0)
  ) {
    throw new Error('截图尺寸无效，无法建立可靠的点击坐标映射。')
  }
  return fromZoom
    ? `图片尺寸=${imageWidth}×${imageHeight}；这是驱动 zoom 图，含边缘留白/缩放。根据本图点击请传 x/y 并设置 from_zoom=true，由驱动转换为整窗坐标；不可直接把本图坐标当整窗坐标。元素编号仍可直接用于 element。`
    : `图片尺寸=${imageWidth}×${imageHeight}；整窗截图坐标可直接用于 x/y。`
}

/** The attachment must preserve the driver's pixel frame. A zoom image may
 * include padding, so a second resize cannot be repaired by a guessed ratio. */
function attachmentDimensions(captureWidth, captureHeight, ref = {}) {
  const width = ref.width ?? captureWidth
  const height = ref.height ?? captureHeight
  if (
    ![captureWidth, captureHeight, width, height].every((n) => Number.isInteger(n) && n > 0) ||
    width !== captureWidth ||
    height !== captureHeight
  ) {
    throw Object.assign(
      new Error(
        `截图坐标映射已拒绝：驱动图片为 ${captureWidth}×${captureHeight}，附件为 ${width}×${height}；尺寸无效或附件被缩放，请保留驱动图片原始尺寸后重新观察。`,
      ),
      { code: 'IMAGE_COORDINATE_MISMATCH' },
    )
  }
  return { width, height }
}

async function commitScreenshot(ctx, target, state, cfg, deps) {
  const attachments = ctx?.get?.('attachments')
  if (!attachments) throw new Error('当前环境未挂载 attachments 服务，无法持久化截图。')
  const pngBuf = buf(state.screenshot_png_b64)
  if (pngBuf.byteLength === 0) throw emptyScreenshotError(state, '引擎返回空截图，请重新观察。')
  const maxBytes = attachments.imageLimits?.maxImageBytes ?? 5 * 1024 * 1024
  const compact =
    cfg.nativeImage === 'compact' || (cfg.nativeImage !== 'full' && pngBuf.byteLength > maxBytes)
  let data = pngBuf
  let mediaType = state.screenshot_mime_type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  let width = state.screenshot_width
  let height = state.screenshot_height
  attachmentDimensions(width, height)
  let name = `screen-${target.pid}.${mediaType === 'image/jpeg' ? 'jpg' : 'png'}`
  if (compact) {
    await deps.verifyObservedDriver(
      {
        driverBinding: observedDriverBinding(state, getSessionState().driverCapabilities),
      },
      { feature: 'zoom' },
    )
    const zv = await deps.cuaCall(
      'zoom',
      withSession({
        pid: target.pid,
        window_id: target.window_id,
        x1: 0,
        y1: 0,
        x2: width,
        y2: height,
      }),
    )
    data = buf(zv?.screenshot_png_b64)
    if (data.byteLength === 0) throw emptyScreenshotError(zv, 'zoom 降级截图失败：引擎返回空图片。')
    mediaType = zv?.mime_type || 'image/jpeg'
    width = zv?.width
    height = zv?.height
    name = `screen-${target.pid}-compact.jpg`
  }
  // Reject unknown driver geometry before persisting an image, then verify the
  // attachment service did not replace the driver's coordinate frame.
  attachmentDimensions(width, height)
  const ref = await attachments.saveImage({ data, mediaType, name })
  const displayed = attachmentDimensions(width, height, ref)
  width = displayed.width
  height = displayed.height
  const coordinateNote = imageCoordinateNote(
    state.screenshot_width,
    state.screenshot_height,
    width,
    height,
    compact,
  )
  const zoom = compact
    ? { pid: target.pid, windowId: target.window_id, width, height, at: Date.now() }
    : null
  return { ref, width, height, compact, coordinateNote, zoom }
}

/** Observer errors remain errors; a failed visual route must not report a successful observation. */
async function describeVision(ctx, cfg, state, target, exec, question, deps) {
  if (!buf(state.screenshot_png_b64).byteLength)
    throw emptyScreenshotError(state, '引擎返回空截图，无法进行视觉理解。')
  const errors = []
  if (ctx?.get?.('llm') && ctx?.get?.('attachments')) {
    try {
      const { ref, width, height, compact, coordinateNote, zoom } = await commitScreenshot(
        ctx,
        target,
        state,
        cfg,
        deps,
      )
      const q =
        (question || visionQuestion(width, height)) +
        `\n${coordinateNote}\n视觉目标用 V1、V2 标记，不能当作 element 编号；坐标输出为图片内 x/y${compact ? '，操作需 from_zoom=true' : ''}。`
      const text = await deps.deepseekVisionDescribe(ctx, cfg, { imageRef: ref, question: q })
      return {
        text: `（观察者 ${cfg.visionProvider || 'deepseek-official'}/${cfg.visionModel || 'deepseek-v4-flash-vision-exp'}${compact ? ' · 紧凑图' : ''}）\n${coordinateNote}\n${text}`,
        zoom,
      }
    } catch (err) {
      if (err.code === 'IMAGE_COORDINATE_MISMATCH' || err instanceof ScreenshotCaptureError)
        throw err
      errors.push(err.message)
    }
  }
  if (deps.glmVisionConfigured()) {
    try {
      const text = await deps.glmVisionDescribe({
        imageBase64: state.screenshot_png_b64,
        mimeType: state.screenshot_mime_type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
        question:
          (question || visionQuestion(state.screenshot_width, state.screenshot_height)) +
          '\n视觉目标用 V1、V2 标记，操作时用整窗 x/y，不能当作 element 编号。',
      })
      return { text, zoom: null }
    } catch (err) {
      errors.push(err.message)
    }
  }
  throw new Error(`视觉观察不可用：${errors.join('；') || '未配置可用的视觉观察模型或 GLM key。'}`)
}

function selectWindow(windows, args) {
  const candidateText = (items) =>
    items
      .map((w) => `${w.app_name || ''} · ${w.title || ''} · pid=${w.pid} window_id=${w.window_id}`)
      .join('\n')
  const explicit =
    args.window_id !== undefined ||
    args.pid !== undefined ||
    (args.window !== undefined && args.window !== null && args.window !== '')
  let matches = windows
  if (args.window_id !== undefined)
    matches = matches.filter((w) => Number(w.window_id) === Number(args.window_id))
  if (args.pid !== undefined) matches = matches.filter((w) => Number(w.pid) === Number(args.pid))
  if (args.window !== undefined && args.window !== null && args.window !== '') {
    const want = String(args.window).toLowerCase()
    const byPid = matches.filter((w) => String(w.pid) === want)
    const exact = matches.filter((w) =>
      [w.title, w.app_name].some((v) => String(v || '').toLowerCase() === want),
    )
    matches = byPid.length
      ? byPid
      : exact.length
        ? exact
        : matches.filter((w) =>
            [w.title, w.app_name].some((v) =>
              String(v || '')
                .toLowerCase()
                .includes(want),
            ),
          )
  }
  if (!matches.length)
    throw new Error(
      `未找到指定窗口，已拒绝继续操作。\n当前可见窗口：\n${candidateText(windows) || '无'}`,
    )
  if (explicit && matches.length > 1)
    throw new Error(`目标匹配多个窗口，请传 window_id 精确选择：\n${candidateText(matches)}`)
  return explicit ? matches[0] : [...matches].sort((a, b) => (b.z_index || 0) - (a.z_index || 0))[0]
}

/** Observe one exact window. Optional dependencies support deterministic driver-contract tests. */
export async function screenObserve(ctx, args, cfg, exec, overrides = {}) {
  const deps = { ...defaultDependencies, ...overrides }
  clearSnapshot()
  try {
    return await observeWindow(ctx, args, cfg, exec, deps)
  } catch (err) {
    clearSnapshot()
    return screenshotFailureOutput(err, '观察失败：')
  }
}

async function observeWindow(ctx, args, cfg, exec, deps) {
  const wantMode = args.mode || 'ax'
  if (!['ax', 'native', 'vision'].includes(wantMode))
    throw new Error('mode 必须为 ax、native 或 vision。')
  const maxElements = Math.max(
    1,
    Math.min(5000, Math.floor(Number(args.maxElements ?? cfg.maxElements) || 500)),
  )
  const winList = await deps.cuaCall('list_windows', { on_screen_only: true })
  const windows = (winList.windows || []).filter((w) => w.window_id && (w.title || w.app_name))
  if (!windows.length) throw new Error('当前没有可见窗口。')
  const target = selectWindow(windows, args)
  let nativeCapable = false
  let visionCapable = false
  const resolveCapabilities = async () => {
    nativeCapable = await deps.routeImageCapable(ctx, exec)
    const observerCapable =
      Boolean(ctx?.get?.('attachments')) &&
      (await deps.modelImageCapable(
        ctx,
        cfg.visionProvider || 'deepseek-official',
        cfg.visionModel || 'deepseek-v4-flash-vision-exp',
      ))
    visionCapable = observerCapable || deps.glmVisionConfigured()
  }
  if (wantMode !== 'ax') await resolveCapabilities()
  if (wantMode === 'native' && !nativeCapable)
    throw new Error(
      '原生视觉模式（mode="native"）需要当前对话模型支持图片输入。请切换视觉模型，或使用 mode="vision" / mode="ax"。',
    )
  if (wantMode === 'vision' && !visionCapable)
    throw new Error(
      '未配置可用的视觉观察模型或 GLM key，请配置 visionProvider / visionModel，或使用 mode="ax"。',
    )
  const gwArgs = {
    pid: target.pid,
    window_id: target.window_id,
    // Driver 0.38 coordinate actions and zoom require a screenshot owned by
    // this session. AX keeps it inside the driver; no attachment reaches the model.
    include_screenshot: true,
    max_elements: maxElements,
    // cua-driver >= 0.37 默认返回 tree_markdown, 插件需要结构化 elements
    tree_format: 'elements',
  }
  if (args.query) gwArgs.query = String(args.query)
  let state = await deps.cuaCall('get_window_state', withSession(gwArgs))
  let observedAt = Date.now()
  let rawElements = Array.isArray(state.elements) ? state.elements : []
  const initialScreenshotError =
    state.screenshot_error != null && !buf(state.screenshot_png_b64).byteLength
  const initiallyDegraded =
    Boolean(state.degraded_reason) || rawElements.filter(isActionable).length === 0
  if (wantMode === 'ax' && initiallyDegraded && !initialScreenshotError) await resolveCapabilities()
  if (
    wantMode === 'ax' &&
    initiallyDegraded &&
    (nativeCapable || visionCapable) &&
    !state.screenshot_png_b64 &&
    !initialScreenshotError
  ) {
    // Refresh tokens and image together; never retain entries from the superseded snapshot.
    state = await deps.cuaCall(
      'get_window_state',
      withSession({ ...gwArgs, include_screenshot: true, tree_format: 'elements' }),
    )
    observedAt = Date.now()
    rawElements = Array.isArray(state.elements) ? state.elements : []
  }
  const elements = rawElements.filter(isActionable)
  const captureError =
    state.screenshot_error != null && !buf(state.screenshot_png_b64).byteLength
      ? emptyScreenshotError(state, '引擎返回空截图，请重新观察。')
      : null
  if (captureError) {
    if (wantMode !== 'ax' || !elements.length) throw captureError
    // Keep usable AX tokens while refusing to publish any screenshot frame.
    state = {
      ...state,
      screenshot_frame_valid: false,
      screenshot_width: null,
      screenshot_height: null,
      capture_id: undefined,
    }
  }
  const degraded = Boolean(state.degraded_reason) || elements.length === 0
  let effectiveMode = 'ax'
  let visionText = ''
  let image
  let coordinateNote = captureError ? `截图提示：${captureError.message}` : ''
  let zoom = null
  const failures = []
  if (wantMode === 'native' || (wantMode === 'ax' && degraded && nativeCapable && !captureError)) {
    try {
      const saved = await commitScreenshot(ctx, target, state, cfg, deps)
      image = {
        attachmentId: saved.ref.attachmentId,
        mediaType: saved.ref.mediaType,
        bytes: saved.ref.bytes,
        width: saved.width,
        height: saved.height,
        ...(saved.ref.name === undefined ? {} : { name: saved.ref.name }),
      }
      effectiveMode = 'native'
      coordinateNote = saved.coordinateNote
      zoom = saved.zoom
    } catch (err) {
      if (err.code === 'IMAGE_COORDINATE_MISMATCH' || err instanceof ScreenshotCaptureError)
        throw err
      failures.push(err.message)
      if (wantMode === 'native') throw err
    }
  }
  if (
    wantMode === 'vision' ||
    (wantMode === 'ax' && degraded && !image && visionCapable && !captureError)
  ) {
    try {
      const described = await describeVision(ctx, cfg, state, target, exec, args.question, deps)
      visionText = described.text
      zoom = described.zoom
      effectiveMode = 'vision'
    } catch (err) {
      if (err.code === 'IMAGE_COORDINATE_MISMATCH' || err instanceof ScreenshotCaptureError)
        throw err
      failures.push(err.message)
      if (wantMode === 'vision') throw err
    }
  }
  if (!elements.length && effectiveMode === 'ax') {
    throw new Error(
      `AX 树无可用元素，无法建立可操作快照。${failures.length ? failures.join('；') : '请使用支持图片的主模型（mode="native"）或配置视觉观察者（mode="vision"）。'}`,
    )
  }
  const ttlMs = Number(cfg.ttlMs) > 0 ? Number(cfg.ttlMs) : 120000
  const snapshotId = state.snapshot_id == null ? null : String(state.snapshot_id)
  const expiresAt = observedAt + ttlMs
  if (Date.now() > expiresAt)
    throw new Error('视觉处理期间观察快照已过期，请重新调用 screen_observe。')
  const entries = new Map()
  for (const e of elements) {
    const c = centerOf(e, state)
    entries.set(e.element_index, {
      token: e.element_token,
      role: safeStr(e.role, 40),
      label: safeStr(elementLabel(e), Number.MAX_SAFE_INTEGER),
      x: c ? c.x : null,
      y: c ? c.y : null,
    })
  }
  setSnapshot({
    at: observedAt,
    ttlMs,
    pid: target.pid,
    windowId: target.window_id,
    appName: target.app_name || '',
    snapshotId,
    entries,
    windowFrame: state.window_bounds || target.frame || target.bounds || null,
    elementCount: state.element_count,
    totalElementCount: state.total_element_count,
    mode: effectiveMode,
    zoom,
    driverBinding: observedDriverBinding(state, getSessionState().driverCapabilities),
    screenshotWidth: state.screenshot_width || null,
    screenshotHeight: state.screenshot_height || null,
  })
  const lines = elements.map((e) => renderLine(e, state))
  const modeNote = `模式=${effectiveMode}${degraded && wantMode === 'ax' && effectiveMode !== 'ax' ? '（AX 不完整自动降级）' : ''}`
  const header = [
    `窗口: ${safeStr(target.app_name)} · ${safeStr(target.title)}`,
    `pid=${target.pid} window_id=${target.window_id} ${modeNote} ${captureError ? '仅 AX 元素可用；截图/像素坐标不可用' : '坐标=窗口本地截图像素'}`,
    `可见元素 ${lines.length} 个（树共 ${state.element_count ?? rawElements.length}/${state.total_element_count ?? rawElements.length}，快照 ${snapshotId ?? '未提供'}；有效期 ${Math.round(ttlMs / 1000)} 秒）`,
    ...(coordinateNote ? [coordinateNote] : []),
  ].join('\n')
  return buildObserveOutput({
    ok: true,
    result: `${header}\n${lines.join('\n') || '(AX 树无可用元素，请根据图片或视觉描述使用 x/y 点击)'}${visionText ? `\n── 视觉理解 ──\n${visionText}` : ''}\n\n提示: 仅界面树中的 [编号] 可用于 element；视觉目标按上方坐标说明使用 x/y。界面变化后重新观察。`,
    window: {
      pid: target.pid,
      windowId: target.window_id,
      app: safeStr(target.app_name, 60),
      title: safeStr(target.title, 80),
    },
    elementCount: elements.length,
    mode: effectiveMode,
    snapshotId,
    expiresAt,
    elements: elements.map((e) => {
      const c = centerOf(e, state)
      return {
        index: e.element_index,
        role: safeStr(shortRole(e.role), 40),
        label: safeStr(elementLabel(e), 100),
        x: c ? c.x : null,
        y: c ? c.y : null,
      }
    }),
    screenshotFile: state.screenshot_out_file || null,
    image,
  })
}

/** Assemble the schema-facing output without serializing an absent image as null. */
export function buildObserveOutput({ image, ...value }) {
  return image ? { ...value, image } : value
}

/**
 * screen_zoom —— 区域截图工具：裁剪窗口某区域（截图像素）为 ≤500px JPEG 直读。
 * 用于"放大某块区域细看"：图片 token 远小于整窗截图。
 * @param {object} ctx
 * @param {object} args - { window?, x1, y1, x2, y2, question? }
 */
export async function screenZoom(ctx, args, cfg, exec, overrides = {}) {
  const deps = { ...defaultDependencies, ...overrides }
  if (!(await deps.routeImageCapable(ctx, exec))) {
    return { ok: false, result: 'screen_zoom 需要当前对话模型支持图片输入（原生直读）。' }
  }
  const snap = getSnapshot()
  if (!snap || !isFresh(cfg.ttlMs ?? snap.ttlMs ?? 120000))
    return { ok: false, result: '请先调用 screen_observe 获取新鲜快照，再放大当前窗口。' }
  if (
    (args.pid !== undefined && Number(args.pid) !== Number(snap.pid)) ||
    (args.window_id !== undefined && Number(args.window_id) !== Number(snap.windowId))
  ) {
    return { ok: false, result: '放大目标与当前观察窗口不同，请先对目标窗口调用 screen_observe。' }
  }
  const w = snap.screenshotWidth
  const h = snap.screenshotHeight
  if (!(w > 0 && h > 0))
    return {
      ok: false,
      result: '当前快照没有截图尺寸，请先用 screen_observe(mode="native") 观察。',
    }
  const coords = [args.x1 ?? 0, args.y1 ?? 0, args.x2 ?? w, args.y2 ?? h].map(Number)
  if (!coords.every(Number.isFinite)) return { ok: false, result: '区域坐标必须为有限数字。' }
  const [x1, y1, x2, y2] = [
    Math.max(0, coords[0]),
    Math.max(0, coords[1]),
    Math.min(w, coords[2]),
    Math.min(h, coords[3]),
  ]
  if (x1 >= x2 || y1 >= y2) return { ok: false, result: '放大区域必须有正宽高并位于窗口内。' }
  const attachments = ctx?.get?.('attachments')
  if (!attachments) return { ok: false, result: '当前环境未挂载 attachments 服务。' }
  await verifyObservedDriver(snap, { feature: 'zoom' })
  // zoom does not call get_window_state: existing element tokens remain bound to the observed snapshot.
  // Once the driver may replace its zoom context, an older image must stop
  // authorizing from_zoom clicks even if this capture or attachment later fails.
  setSnapshot({ ...snap, zoom: null })
  const zv = await deps.cuaCall(
    'zoom',
    withSession({ pid: snap.pid, window_id: snap.windowId, x1, y1, x2, y2 }),
  )
  const jpeg = buf(zv?.screenshot_png_b64)
  if (!jpeg.byteLength)
    return screenshotFailureOutput(emptyScreenshotError(zv, 'zoom 返回空图片。'))
  const mediaType = zv?.mime_type || 'image/jpeg'
  let ref
  let displayed
  try {
    attachmentDimensions(zv?.width, zv?.height)
    ref = await attachments.saveImage({
      data: jpeg,
      mediaType,
      name: `screen-zoom-${snap.windowId}.jpg`,
    })
    displayed = attachmentDimensions(zv?.width, zv?.height, ref)
  } catch (err) {
    if (err.code !== 'IMAGE_COORDINATE_MISMATCH') throw err
    return { ok: false, result: err.message }
  }
  const image = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: displayed.width,
    height: displayed.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
  const coordinateNote = imageCoordinateNote(w, h, image.width, image.height, true)
  setSnapshot({
    ...snap,
    zoom: {
      pid: snap.pid,
      windowId: snap.windowId,
      width: image.width,
      height: image.height,
      at: Date.now(),
    },
  })
  return {
    ok: true,
    result: `区域截图完成。${coordinateNote} 本次放大不延长快照有效期；界面变化后请重新观察。`,
    image,
  }
}
