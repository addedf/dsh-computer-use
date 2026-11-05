/**
 * dsh-computer-use —— Computer Use 插件：给 harness-desktop 增加"虚拟鼠标真人操作"。
 *
 * 工具集（Hermes 风格，模型友好）：
 *   screen_observe          看屏幕：AX 编号树 + 坐标 / 原生直读 / 视觉观察者
 *   screen_zoom             区域截图直读（≤500px JPEG，细节放大看）
 *   computer_click          点击（element 编号 或 x/y 坐标）
 *   computer_double_click   双击
 *   computer_right_click    右键
 *   computer_type           文本输入
 *   computer_key            按键 / 快捷键
 *   computer_scroll         滚动
 *   computer_drag           拖拽
 *   computer_wait           等待 / 轮询间隔
 *   app_list                列出应用
 *   app_launch              启动应用
 *
 * 视觉能力（原生接入）：
 *   - mode="native"：截图经 attachments 持久化后以图片块返回，主对话模型
 *     （如 deepseek-v4-flash-vision-exp）直接看图 —— 零外部 API、零额外 key。
 *   - mode="vision"：DeepSeek 视觉观察者（ctx.llm）结构化描述截图（免 ZHIPU key），
 *     不可用时回退 GLM 免费模型。
 *   - ax：零成本 AX 树；AX 树为空时自动降级 native → vision → ax。
 *
 * 安全设计（P1 已内建，P3 深化）：
 *   - 观察快照 TTL：过期后拒绝动作，必须重新观察（element_token 引擎侧双重校验）
 *   - 动作一律要求先 screen_observe（无快照直接拒绝，杜绝盲操作）
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { screenObserve, screenZoom } from './lib/observe.js'
import {
  click,
  doubleClick,
  rightClick,
  typeText,
  key,
  scroll,
  drag,
  wait,
  listApps,
  launchApp,
} from './lib/actions.js'
import { guard } from './lib/guard.js'
import {
  cuaCall,
  withSession,
  getDriverCapabilities,
  assertDriverCompatibility,
} from './lib/cua.js'
import { createToolScope, getSessionState } from './lib/session.js'
import { getSnapshot, resolveWindow } from './lib/snapshot.js'
import { runSteps } from './lib/batch.js'
import { browserTools } from './lib/browser.js'
import { conditionTools } from './lib/conditions.js'
import { registerSkills } from './lib/skills.js'
import { registerCleanup } from './lib/lifecycle.js'
import { createControlIndicator } from './lib/control-indicator.js'
import {
  computerStatus,
  captureImmediateDriverEnd,
  captureDriverRelease,
} from './lib/control-status.js'

export const name = 'dsh-computer-use'

export const inject = ['tools', 'approval']

/** 插件配置。 */
export const Config = z.object({
  /** 观察快照的有效期（毫秒）。 */
  ttlMs: z.number().default(120000),
  /** screen_observe 最多返回多少编号元素。 */
  maxElements: z.number().default(500),
  /** 区域限制：允许操作的应用名白名单（空 = 不限制）。 */
  allowedApps: z.array(z.string()).default([]),
  /** 虚拟光标主题 id（空 = 不设置，用引擎默认）。 */
  cursorTheme: z.string().default('com.dsh.computeruse.rainbow'),
  /** 原生直读截图策略：auto（PNG 超限额时自动降级 zoom JPEG）/ full（始终原图 PNG）/ compact（始终 ≤500px JPEG）。 */
  nativeImage: z.union(['auto', 'full', 'compact']).default('auto'),
  /** Mode D 观察者 provider 路由。 */
  visionProvider: z.string().default('deepseek-official'),
  /** Mode D 观察者模型（需声明 image 输入）。 */
  visionModel: z.string().default('deepseek-v4-flash-vision-exp'),
  browserBackend: z.union(['cua', 'playwright', 'chrome-extension']).default('playwright'),
  browserHeadless: z.boolean().default(true),
  /** Cross-frame budgets for output traversal and the independent safety scan. */
  browserObservationMaxNodes: z.number().default(10000),
  browserObservationSafetyMaxNodes: z.number().default(10000),
  browserObservationTimeoutMs: z.number().default(5000),
  chromeBridgeSocketPath: z.string().default(''),
  desktopIndicator: z.boolean().default(false),
})

/** 统一输出 schema：ok + result 文本。 */
const OUT = (extra = {}) => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      result: { type: 'string', required: true },
      errorCode: { type: 'string' },
      data: { type: 'object', additionalProperties: true },
      ...extra,
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.result }],
})

/** 图片块输出 schema 段（native 直读工具共用）。 */
const IMAGE_FIELD = {
  image: {
    type: 'object',
    additionalProperties: false,
    properties: {
      attachmentId: { type: 'string', required: true },
      mediaType: {
        type: 'string',
        enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        required: true,
      },
      bytes: { type: 'integer', required: true },
      width: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      height: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      name: { type: 'string' },
    },
  },
}

/** render：值含 image 时追加图片块（主模型原生直读）。 */
export function renderWithImage(_args, value) {
  if (!value.image) return [{ type: 'text', text: value.result }]
  return [
    { type: 'text', text: value.result },
    {
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name === undefined ? {} : { name: value.image.name }),
      },
    },
  ]
}

/** 统一的坐标/编号参数块（坐标 = 窗口本地截图像素）。 */
const TARGET_PARAMS = {
  element: {
    type: 'integer',
    description: 'screen_observe 输出的元素编号（如 5）。与 x/y 二选一，优先。',
  },
  snapshot_id: {
    type: 'string',
    description: '可选：最近一次 screen_observe 的 snapshotId，防止误用旧观察。',
  },
  from_zoom: {
    type: 'boolean',
    description: '可选：x/y 来自最近一张 zoom 或 compact 图片时设 true，驱动自动映射回整窗坐标。',
  },
  x: {
    type: 'integer',
    description:
      '窗口本地截图像素 x（screen_observe 的截图坐标系，模型所见即所点）。与 element 二选一。',
  },
  y: {
    type: 'integer',
    description: '窗口本地截图像素 y。',
  },
}

export function apply(ctx, config) {
  const cfg = {
    ttlMs: config.ttlMs ?? 120000,
    maxElements: config.maxElements ?? 500,
    allowedApps: Array.isArray(config.allowedApps) ? config.allowedApps : [],
    cursorTheme: config.cursorTheme,
    nativeImage: config.nativeImage || 'auto',
    visionProvider: config.visionProvider || 'deepseek-official',
    visionModel: config.visionModel || 'deepseek-v4-flash-vision-exp',
    browserBackend: config.browserBackend || 'playwright',
    browserHeadless: config.browserHeadless !== false,
    browserObservationMaxNodes: config.browserObservationMaxNodes ?? 10000,
    browserObservationSafetyMaxNodes: config.browserObservationSafetyMaxNodes ?? 10000,
    browserObservationTimeoutMs: config.browserObservationTimeoutMs ?? 5000,
    chromeBridgeSocketPath: config.chromeBridgeSocketPath || '',
    // The real host supplies schema defaults; raw minimal test hosts opt in.
    desktopIndicator: config.desktopIndicator === true,
  }

  if (!Number.isFinite(cfg.ttlMs) || cfg.ttlMs < 1000 || cfg.ttlMs > 600000) {
    throw new Error('ttlMs 需要在 1000–600000 毫秒之间。')
  }
  for (const option of ['browserObservationMaxNodes', 'browserObservationSafetyMaxNodes']) {
    if (!Number.isSafeInteger(cfg[option]) || cfg[option] < 100 || cfg[option] > 100000) {
      throw new Error(`${option} 需要在 100–100000 个节点之间。`)
    }
  }
  if (
    !Number.isSafeInteger(cfg.browserObservationTimeoutMs) ||
    cfg.browserObservationTimeoutMs < 100 ||
    cfg.browserObservationTimeoutMs > 30000
  ) {
    throw new Error('browserObservationTimeoutMs 需要在 100–30000 毫秒之间。')
  }
  const runScoped = createToolScope()
  const registered = new Map()
  const ownedActors = new Map()
  const indicator = createControlIndicator(ctx, cfg)
  const actorKey = (exec) => exec?.agent?.session || exec?.agent
  const endDriverNow = (record) => {
    if (!record || !(record.state.initialized || record.state.driverTouched)) return
    // Stop/cancel revokes the exact live driver immediately; the queued pass
    // below repeats cleanup after in-flight work to prevent stale overlays.
    return (record.immediateEnd ||= captureImmediateDriverEnd(record))
  }
  const releaseBrowserNow = (record, browser = record?.state.browser) => {
    if (!record || !browser?.owned) return
    if (record.browserReleases.has(browser)) return record.browserReleases.get(browser)
    // Invoke immediately, outside the tool queue: closing this owner's CDP
    // transport may be the only operation that can settle a stuck page call.
    let pending
    try {
      pending = Promise.resolve(browser.dispose?.())
    } catch (error) {
      pending = Promise.reject(error)
    }
    record.browserReleases.set(browser, pending)
    // The queued finalizer below observes failures and clears terminal state.
    // An immediate Stop/cancel callback itself must not reject unhandled.
    void pending.catch(() => undefined)
    return pending
  }
  const releaseActor = (record) => {
    if (!record || record.releasing) return record?.releasing
    record.state.controlReleasing = true
    // Hide UI immediately. Ordinary completion drains behind in-flight work;
    // Stop/cancel also releases its transport immediately to unblock that work.
    indicator.hide(record.exec)
    for (const [signal, abort] of record.signals) signal.removeEventListener('abort', abort)
    record.signals.clear()
    record.releasing = runScoped(
      record.exec,
      async () => {
        const state = getSessionState()
        const browser = state.browser
        try {
          releaseBrowserNow(record, browser)
          try {
            const outcomes = await Promise.allSettled(record.browserReleases.values())
            const failed = outcomes.find((outcome) => outcome.status === 'rejected')
            if (failed) throw failed.reason
          } finally {
            for (const owned of record.browserReleases.keys()) {
              owned.untrack?.()
              if (state.browser === owned) state.browser = null
            }
          }
        } finally {
          if (state.initialized || state.driverTouched) {
            await captureDriverRelease(record)
          }
          state.initialized = false
          state.driverTouched = false
          state.controlReleasing = false
          state.snapshot = null
          indicator.hide(record.exec)
          if (ownedActors.get(record.key) === record) ownedActors.delete(record.key)
        }
      },
      { enqueue: true },
    )
    return record.releasing
  }
  const trackActor = (exec) => {
    const key = actorKey(exec) || getSessionState()
    let record = ownedActors.get(key)
    if (!record || record.releasing) {
      // Cleanup has no aborted tool signal: it only releases this actor's owned
      // resources and remains valid after cancellation or a user Stop.
      record = {
        key,
        state: getSessionState(),
        exec: { agent: exec?.agent },
        signals: new Map(),
        browserReleases: new Map(),
      }
      ownedActors.set(key, record)
    }
    if (exec?.signal && !record.signals.has(exec.signal)) {
      const abort = () => {
        record.state.controlReleasing = true
        void endDriverNow(record)
        void releaseBrowserNow(record)
        void releaseActor(record)?.catch(() => undefined)
      }
      record.signals.set(exec.signal, abort)
      exec.signal.addEventListener('abort', abort, { once: true })
      if (exec.signal.aborted) abort()
    }
    return record
  }
  if (typeof ctx.on === 'function') {
    const hideAtEnd = ctx.on('session/event', (session, event) => {
      if (event?.type === 'turn/end') return releaseActor(ownedActors.get(session))
    })
    const hideDisposed = ctx.on('agent/disposed', ({ agent }) =>
      releaseActor(ownedActors.get(agent?.session || agent)),
    )
    registerCleanup(ctx, () => {
      hideAtEnd?.()
      hideDisposed?.()
    })
  }
  registerCleanup(ctx, async () => {
    await Promise.allSettled([...ownedActors.values()].map(releaseActor))
    ownedActors.clear()
    await indicator.dispose()
  })
  const register = (definition) => {
    registered.set(definition.name, definition)
    return ctx.tools.register(definition)
  }
  const conditions = new Set([
    'computer_verify',
    'computer_wait_for',
    'browser_verify',
    'browser_wait_for',
  ])
  const stopSafeTools = new Set([
    'computer_status',
    'browser_capabilities',
    'browser_close',
    'computer_skill',
  ])
  const failed = (toolName, err) =>
    conditions.has(toolName)
      ? {
          ok: false,
          result: err.message,
          status: err.code === 'CANCELLED' ? 'cancelled' : 'error',
          matched: false,
          data: {
            status: err.code === 'CANCELLED' ? 'cancelled' : 'error',
            matched: false,
            ...(err.code ? { code: String(err.code) } : {}),
          },
        }
      : {
          ok: false,
          result: `✗ ${err.message}`,
          ...(err.code ? { errorCode: String(err.code) } : {}),
        }

  /** 统一包装：先过安全护栏，再执行实现（exec 透传给需要 route 的实现）。 */
  const wrap = (toolName, impl) => (args, exec) =>
    runScoped(exec, async () => {
      try {
        const state = getSessionState()
        trackActor(exec)
        if ((state.controlStopped || indicator.isStopped(exec)) && !stopSafeTools.has(toolName)) {
          throw Object.assign(new Error('本次电脑控制已由用户停止，请新建会话后再操作。'), {
            code: 'CONTROL_STOPPED',
          })
        }
        if (exec?.signal?.aborted)
          throw Object.assign(new Error('操作已取消。'), { code: 'CANCELLED' })
        const desktop =
          !toolName.startsWith('browser_') &&
          !['app_list', 'computer_status', 'computer_wait', 'computer_skill', 'run_steps'].includes(
            toolName,
          )
        const updateIndicator = async (phase) => {
          if (!desktop || !cfg.desktopIndicator) return
          const visibility = await indicator.update(exec, {
            phase,
            window: getSnapshot()?.windowFrame,
            onStop: () => {
              state.controlStopped = true
              state.snapshot = null
              void endDriverNow(ownedActors.get(actorKey(exec) || state))
              void releaseBrowserNow(ownedActors.get(actorKey(exec) || state))
              try {
                exec?.agent?.cancel?.({ kind: 'user' }, { keepInbox: true })
              } catch {}
              void releaseActor(ownedActors.get(actorKey(exec) || state))?.catch(() => {})
            },
          })
          if (!visibility.available || visibility.visible === false) {
            throw Object.assign(
              new Error(
                `桌面控制状态面板不可用：${visibility.reason || 'unknown'}。请检查本机 Swift 工具链，或显式关闭 desktopIndicator。`,
              ),
              { code: 'CONTROL_INDICATOR_UNAVAILABLE' },
            )
          }
        }
        await updateIndicator('preparing')
        const before = getSnapshot()
        const g = await guard(ctx, cfg, toolName, args, exec)
        if (!g.ok) return failed(toolName, new Error(g.reason))
        if ((state.controlStopped || indicator.isStopped(exec)) && !stopSafeTools.has(toolName))
          throw Object.assign(new Error('本次电脑控制已停止。'), { code: 'CONTROL_STOPPED' })
        if (exec?.signal?.aborted)
          throw Object.assign(new Error('操作已取消。'), { code: 'CANCELLED' })
        if (
          toolName.startsWith('computer_') &&
          ![
            'computer_wait',
            'computer_status',
            'computer_verify',
            'computer_wait_for',
            'computer_skill',
          ].includes(toolName)
        ) {
          if (getSnapshot() !== before) throw new Error('审批期间观察快照已变化：请重新观察。')
          resolveWindow(cfg.ttlMs)
        }
        if (toolName === 'screen_observe') {
          const report = await getDriverCapabilities({ signal: exec?.signal })
          // A failed metadata probe cannot authorize a new protocol or disable
          // the previously supported AX path merely by timing out.
          state.driverCapabilities = report.expiresAt > Date.now() ? report : null
          const identityKey = state.driverCapabilities?.identity?.key
          if (identityKey) {
            await assertDriverCompatibility(identityKey, {
              feature: 'structuredElements',
              allowUnknown: true,
              signal: exec?.signal,
            })
          }
        }
        if (
          !state.initialized &&
          !conditions.has(toolName) &&
          !(
            ['playwright', 'chrome-extension'].includes(cfg.browserBackend) &&
            toolName.startsWith('browser_')
          ) &&
          !['app_list', 'computer_status', 'computer_wait', 'computer_skill', 'run_steps'].includes(
            toolName,
          )
        ) {
          await cuaCall('start_session', withSession())
          state.initialized = true
          if (cfg.cursorTheme)
            await cuaCall(
              'set_agent_cursor_theme',
              withSession({ theme_id: cfg.cursorTheme }),
            ).catch(() => undefined)
          await cuaCall('set_agent_cursor_enabled', withSession({ enabled: true })).catch(
            () => undefined,
          )
          await cuaCall(
            'set_agent_cursor_motion',
            withSession({
              idle_hide_ms: 1000,
              timing: 'calm',
              effects: { ripple: 'on', trail: 'off' },
            }),
          ).catch(() => undefined)
        }
        await updateIndicator(
          toolName === 'screen_observe' || toolName === 'screen_zoom' || conditions.has(toolName)
            ? 'observing'
            : 'acting',
        )
        const value = await impl(args, cfg, exec)
        // An adapter may finish after cancellation even when its transport cannot
        // be interrupted. Do not publish its late success or retain action refs.
        const assertResultActive = () => {
          if (exec?.signal?.aborted) {
            state.snapshot = null
            throw Object.assign(new Error('操作已取消；操作可能已执行，请重新观察，勿直接重试。'), {
              code: 'CANCELLED',
            })
          }
          if ((state.controlStopped || indicator.isStopped(exec)) && !stopSafeTools.has(toolName)) {
            state.snapshot = null
            throw Object.assign(new Error('本次电脑控制已停止；不重放已有动作。'), {
              code: 'CONTROL_STOPPED',
            })
          }
        }
        assertResultActive()
        if (desktop && cfg.desktopIndicator && !indicator.isStopped(exec))
          await indicator.update(exec, { phase: 'idle', window: getSnapshot()?.windowFrame })
        assertResultActive()
        return value
      } catch (err) {
        return failed(toolName, err)
      }
    })

  register(
    defineTool({
      name: 'screen_observe',
      description:
        '观察屏幕：对目标窗口生成"编号 + 控件 + 坐标"的界面树（AX 语义，零视觉 token 成本）。' +
        '操作电脑前必须先调用本工具取得快照；之后用 computer_click(element=[编号]) 或 computer_click(x=,y=) 操作（坐标为窗口本地截图像素）。' +
        'mode 选择：ax（默认，零成本树）/ vision（DeepSeek 视觉观察者结构化描述，免 ZHIPU key）/ native（截图直读，当前对话模型直接看图，需模型支持图片输入）。' +
        'AX 树无法解析（游戏/Canvas/Electron）时自动降级：native（若当前模型支持图片）→ vision → ax。' +
        '快照默认 120 秒过期（以 ttlMs 配置为准），过期后需重新观察；可用 run_steps 减少往返。',
      parameters: {
        window: {
          type: 'string',
          description: '可选：目标窗口，传 pid 数字或标题子串（如 "访达"）。缺省选最前窗口。',
        },
        pid: { type: 'integer', description: '可选：精确指定进程，多窗口时再指定 window_id。' },
        window_id: { type: 'integer', description: '可选：精确指定窗口，优先用于多窗口应用。' },
        mode: {
          type: 'string',
          enum: ['ax', 'vision', 'native'],
          description:
            'ax（默认）= 零成本的界面树；vision = 视觉观察者描述；native = 截图直读（模型直接看图）。',
        },
        query: {
          type: 'string',
          description: '可选：按控件标签过滤界面树（如 "提交"）。',
        },
        maxElements: {
          type: 'integer',
          description: '可选：最多返回多少个编号元素（防上下文爆炸）。',
        },
      },
      output: {
        ...OUT({
          window: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pid: { type: 'integer' },
              windowId: { type: 'integer' },
              app: { type: 'string' },
              title: { type: 'string' },
            },
          },
          snapshotId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          expiresAt: { type: 'number' },
          elementCount: { type: 'integer' },
          mode: { type: 'string' },
          elements: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                role: { type: 'string' },
                label: { type: 'string' },
                x: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                y: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              },
            },
          },
          screenshotFile: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          ...IMAGE_FIELD,
        }),
        render: renderWithImage,
      },
      execute: wrap('screen_observe', (args, cfg2, exec) => screenObserve(ctx, args, cfg2, exec)),
    }),
  )

  register(
    defineTool({
      name: 'screen_zoom',
      description:
        '区域截图直读：裁剪窗口某块区域（截图像素坐标）为 ≤500px JPEG 并以图片返回，当前对话模型直接看图。' +
        '用于"放大某块区域细看"（小字、图标、图表），图片 token 远小于整窗截图。' +
        '返回图片含驱动留白/缩放；根据图片点击时用 computer_click(x=,y=,from_zoom=true) 由驱动映射整窗坐标。',
      parameters: {
        pid: {
          type: 'integer',
          description: '可选：目标窗口所属进程 pid（screen_observe 输出）；缺省按 window_id 解析。',
        },
        window_id: { type: 'integer', description: '可选：已观察的窗口 id；省略时用当前快照。' },
        x1: { type: 'integer', description: '可选：区域左边界（整窗截图像素），默认 0。' },
        y1: { type: 'integer', description: '可选：区域上边界，默认 0。' },
        x2: { type: 'integer', description: '可选：区域右边界，默认窗口截图宽。' },
        y2: { type: 'integer', description: '可选：区域下边界，默认窗口截图高。' },
      },
      output: { ...OUT(IMAGE_FIELD), render: renderWithImage },
      execute: wrap('screen_zoom', (args, cfg2, exec) => screenZoom(ctx, args, cfg2, exec)),
    }),
  )

  register(
    defineTool({
      name: 'computer_click',
      description:
        '点击：传入 screen_observe 输出的元素编号（element），或窗口截图像素坐标（x,y）。点击的是 cua-driver 的虚拟光标，不抢真实鼠标。',
      parameters: {
        ...TARGET_PARAMS,
        count: { type: 'integer', description: '可选：点击次数，默认 1。' },
      },
      output: OUT(),
      execute: wrap('computer_click', (args, cfg2) => click(args, cfg2)),
    }),
  )

  register(
    defineTool({
      name: 'computer_double_click',
      description: '双击：element 编号 或 x/y 坐标。',
      parameters: TARGET_PARAMS,
      output: OUT(),
      execute: wrap('computer_double_click', (args, cfg2) => doubleClick(args, cfg2)),
    }),
  )

  register(
    defineTool({
      name: 'computer_right_click',
      description: '右键点击：element 编号 或 x/y 坐标。',
      parameters: TARGET_PARAMS,
      output: OUT(),
      execute: wrap('computer_right_click', (args, cfg2) => rightClick(args, cfg2)),
    }),
  )

  register(
    defineTool({
      name: 'computer_type',
      description:
        '文本输入：向当前焦点（或指定元素）输入一段文本。若驱动拒绝后台投递，前台重试会先请求本次用户批准并可能切换窗口焦点。不要在密码框使用——密码必须由用户本人输入（敏感输入保护）。',
      parameters: {
        text: { type: 'string', required: true, description: '要输入的文本。' },
        element: TARGET_PARAMS.element,
      },
      output: OUT(),
      execute: wrap('computer_type', (args, cfg2, exec) =>
        typeText(args, cfg2, {
          approval: ctx.approval,
          agent: exec?.agent,
          signal: exec?.signal,
        }),
      ),
    }),
  )

  register(
    defineTool({
      name: 'computer_key',
      description:
        '按键 / 快捷键：如 return、tab、escape、cmd+c、shift+tab。若驱动拒绝后台投递，前台重试会先请求本次用户批准并可能切换窗口焦点。',
      parameters: {
        key: {
          type: 'string',
          required: true,
          description: '按键名或组合（示例: return / cmd+c / shift+tab / cmd+shift+p）。',
        },
      },
      output: OUT(),
      execute: wrap('computer_key', (args, cfg2, exec) =>
        key(args, cfg2, {
          approval: ctx.approval,
          agent: exec?.agent,
          signal: exec?.signal,
        }),
      ),
    }),
  )

  register(
    defineTool({
      name: 'computer_scroll',
      description: '滚动：在目标窗口内向上/下/左/右滚动。',
      parameters: {
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: '滚动方向，默认 down。',
        },
        amount: { type: 'integer', description: '可选：滚动格数，默认 3。' },
        element: TARGET_PARAMS.element,
      },
      output: OUT(),
      execute: wrap('computer_scroll', (args, cfg2) => scroll(args, cfg2)),
    }),
  )

  register(
    defineTool({
      name: 'computer_drag',
      description:
        '拖拽：在快照窗口内从 (from_x,from_y) 拖到 (to_x,to_y)，坐标为窗口本地截图像素。',
      parameters: {
        from_x: { type: 'integer', required: true, description: '起点 x（截图像素）。' },
        from_y: { type: 'integer', required: true, description: '起点 y。' },
        to_x: { type: 'integer', required: true, description: '终点 x。' },
        to_y: { type: 'integer', required: true, description: '终点 y。' },
        duration_ms: { type: 'integer', description: '可选：拖拽耗时毫秒，默认 500。' },
      },
      output: OUT(),
      execute: wrap('computer_drag', (args, cfg2) => drag(args, cfg2)),
    }),
  )

  register(
    defineTool({
      name: 'computer_wait',
      description: '等待：暂停一段时间（如等待界面加载/动画完成），不调用引擎。',
      parameters: {
        ms: { type: 'integer', required: true, description: '等待毫秒数（1-60000）。' },
      },
      output: OUT(),
      execute: wrap('computer_wait', (args, _cfg, exec) => wait(args, { signal: exec?.signal })),
    }),
  )

  register(
    defineTool({
      name: 'app_list',
      description: '列出当前正在运行的应用（名称 + pid），用于选择要操作的目标。',
      parameters: {},
      output: OUT({
        apps: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              pid: { type: 'integer' },
              active: { type: 'boolean' },
            },
          },
        },
      }),
      execute: wrap('app_list', () => listApps()),
    }),
  )

  register(
    defineTool({
      name: 'app_launch',
      description:
        '启动一个应用（后台启动，不抢焦点；可选 bring_to_front 前置到前台）。用于"打开应用"这一步。',
      parameters: {
        name: {
          type: 'string',
          description: '应用显示名（如 "备忘录"）。与 bundle_id 二选一。',
        },
        bundle_id: {
          type: 'string',
          description: '应用 bundle id（如 com.apple.Notes）。优先于 name。',
        },
        bring_to_front: {
          type: 'boolean',
          description: '可选：启动后是否前置到前台（默认 false，后台启动）。',
        },
        creates_new_instance: {
          type: 'boolean',
          description: '可选：强制启动新实例（open -n），用于并发多会话隔离。',
        },
      },
      output: OUT({ pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] } }),
      execute: wrap('app_launch', (args) => launchApp(args)),
    }),
  )

  register(
    defineTool({
      name: 'computer_status',
      description:
        '只读诊断。默认 health 检查驱动、后台服务与系统权限；capabilities 核对实际驱动身份、工具 schema 与能力；control 只读当前任务的光标及生命周期。不创建或恢复控制会话，不接受其它会话标识。',
      parameters: {
        scope: {
          type: 'string',
          enum: ['health', 'control', 'capabilities'],
          description:
            '默认 health；capabilities 返回能力握手与健康状态；control 返回当前任务的只读光标及生命周期，读取失败不等于光标已隐藏。',
        },
      },
      output: OUT(),
      execute: wrap('computer_status', (args, _cfg, exec) =>
        computerStatus(args, { signal: exec?.signal }),
      ),
    }),
  )

  for (const tool of browserTools(ctx, cfg)) {
    register(
      defineTool({
        ...tool,
        output: { ...OUT(IMAGE_FIELD), render: renderWithImage },
        execute: wrap(tool.name, (args, _cfg, exec) => tool.execute(args, exec)),
      }),
    )
  }
  for (const tool of conditionTools(ctx, cfg)) {
    register(
      defineTool({
        ...tool,
        execute: wrap(tool.name, (args, _cfg, exec) => tool.execute(args, exec)),
      }),
    )
  }
  const disposeSkills = registerSkills(ctx, { ...cfg, registerTool: register })
  registerCleanup(ctx, disposeSkills)

  register(
    defineTool({
      name: 'run_steps',
      description:
        '声明式动态编排：每组1–20步，save_as保存结果，args用{$ref:"page.data.refs",where:{name:"姓名"},pick:"ref"}唯一选择新目标。when:{ref:"check.data.matched",equals:true}分支；repeat/steps/until有界循环或for_each/as/steps遍历。每个工具都过宿主权限和护栏；任一步失败立即停、不重放。最多60次工具、120秒、3层；优先用条件等待验证结果。',
      parameters: {
        variables: {
          type: 'object',
          additionalProperties: true,
          description: '可选：流程初始变量。',
        },
        return_vars: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：仅回显指定变量，避免重复整页内容。',
        },
        steps: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tool: {
                type: 'string',
                description: '工具步骤的本插件工具名；不允许嵌套 run_steps。',
              },
              args: {
                type: 'object',
                additionalProperties: true,
                description: '该工具的参数对象。',
              },
              save_as: {
                type: 'string',
                description: '将完整工具结果存为变量，如 page；后续可引用 page.data.refs。',
              },
              when: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ref: { type: 'string', required: true },
                  equals: {
                    oneOf: [
                      { type: 'string' },
                      { type: 'number' },
                      { type: 'boolean' },
                      { type: 'null' },
                    ],
                  },
                  not: { type: 'boolean' },
                },
              },
              repeat: { type: 'integer', description: '控制组重复上限1–10，不是失败重试。' },
              until: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ref: { type: 'string', required: true },
                  equals: {
                    oneOf: [
                      { type: 'string' },
                      { type: 'number' },
                      { type: 'boolean' },
                      { type: 'null' },
                    ],
                  },
                  not: { type: 'boolean' },
                },
              },
              for_each: {
                oneOf: [
                  { type: 'array', items: { type: 'json' } },
                  { type: 'object', additionalProperties: true },
                ],
                description: '控制组遍历最多20项数组或变量引用。',
              },
              as: { type: 'string', description: 'for_each 当前项的变量名。' },
              steps: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description: '控制组中的子步骤，结构与外层相同。',
              },
              otherwise: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description: 'when为false时的子步骤。',
              },
            },
          },
        },
      },
      output: {
        ...OUT({
          completed: { type: 'integer' },
          failedStep: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tool: { type: 'string' },
                ok: { type: 'boolean' },
                result: { type: 'string' },
              },
            },
          },
          ...IMAGE_FIELD,
        }),
        render: renderWithImage,
      },
      execute: wrap('run_steps', (args, _cfg, exec) =>
        runSteps(args, exec, registered, async (step, index, childExec = exec) => {
          // Nested calls must traverse the host policy pipeline, not only our own
          // guard. A denied leaf tool remains denied when requested through a batch.
          if (typeof ctx.tools.execute !== 'function')
            throw new Error('run_steps 需要宿主 tools.execute 执行逐步权限检查。')
          const result = await ctx.tools.execute({
            name: step.tool,
            arguments: step.args || {},
            agent: exec?.agent,
            signal: childExec?.signal || new AbortController().signal,
            callId: `${exec?.callId || 'run_steps'}:step:${index + 1}`,
            ...(exec?.rootCallId ? { rootCallId: exec.rootCallId } : {}),
            ...(exec?.token ? { parent: exec.token } : {}),
          })
          for (const context of result.additionalContexts || []) exec?.deferContext?.(context)
          if (result.concludesTurn) exec?.concludeTurn?.()
          if (result.isError)
            return { ok: false, result: result.error?.message || '宿主拒绝执行此步骤。' }
          return result.value
        }),
      ),
    }),
  )

  ctx.logger?.info(`dsh-computer-use: ${registered.size} 个工具已注册`)
}

export default { name, inject, Config, apply }
