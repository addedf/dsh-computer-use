/** Playwright DOM/ref controller. Standalone mode owns its process/context;
 * the Chrome companion exposes only this session's visible, owned tab group. */
import { randomUUID } from 'node:crypto'
import { lstat, realpath, open as openFile, unlink } from 'node:fs/promises'
import { isAbsolute, basename, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { getSessionState } from './session.js'
import { registerCleanup } from './lifecycle.js'
import { verifyBrowserWrite } from './browser-write-verification.js'
import {
  collectBrowserFrame,
  createBrowserObservationBudget,
  inspectBrowserDOM as describeElement,
} from './browser-observation.js'

const DANGER =
  /删除|移除|清空|格式化|卸载|支付|付款|购买|下单|结账|转账|汇款|退出登录|注销|\b(?:delete|remove|erase|clear|destroy|pay|purchase|buy|checkout|transfer|place order|log\s*out|sign\s*out)\b/i
const SENSITIVE =
  /密码|口令|密钥|\b(?:password|passphrase|secret|api[ _-]?key|access[ _-]?token)\b/i
const clean = (value) =>
  String(value || '')
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[URL omitted]')
    .slice(0, 600)
const result = (data) => ({ ok: true, data, result: JSON.stringify(data) })
const fail = (message, code = 'BROWSER_REFUSED') => {
  throw Object.assign(new Error(message), { code })
}
const active = (exec) => {
  if (exec?.signal?.aborted) fail('操作已取消。', 'ABORTED')
}
const safeURL = (value) => {
  try {
    const u = new URL(value)
    return u.protocol === 'about:' ? 'about:blank' : `${u.origin}${u.pathname}`
  } catch {
    return ''
  }
}
const ownedResources = new WeakMap()
function track(ctx, dispose) {
  let set = ownedResources.get(ctx)
  if (!set) {
    set = new Set()
    ownedResources.set(ctx, set)
    registerCleanup(ctx, async () => {
      await Promise.allSettled([...set].map((dispose) => dispose()))
      set.clear()
    })
  }
  set.add(dispose)
  return () => set.delete(dispose)
}
const checkedURL = (value) => {
  if (typeof value !== 'string') fail('需要完整 URL。')
  let url
  try {
    url = new URL(value)
  } catch {
    fail('URL 必须是完整的 http/https 或 about:blank。')
  }
  if (
    (!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank') ||
    url.username ||
    url.password
  )
    fail('仅允许无用户名密码的 http/https 或 about:blank。')
  return url.href
}

export function createPlaywrightController(
  ctx,
  cfg = {},
  { playwright, now = Date.now, chromeBridge } = {},
) {
  const companion = cfg.browserBackend === 'chrome-extension'
  const backend = companion ? 'chrome-extension' : 'playwright'
  const foreground = !companion && cfg.browserHeadless === false
  let bridge = chromeBridge
  const connectedBridge = async () => {
    if (!bridge) {
      const { createChromeBridge } = await import('./chrome-bridge.js')
      bridge = createChromeBridge(ctx, cfg)
      registerCleanup(ctx, () => bridge.dispose())
    }
    return bridge
  }
  if (companion)
    void connectedBridge()
      .then((relay) => relay.start?.())
      .catch((error) => {
        ctx?.logger?.warn?.(`Chrome 桥接准备失败：${error.code || 'CHROME_BRIDGE_UNAVAILABLE'}`)
      })
  const ttlMs = cfg.ttlMs || 120000
  const maxElements = Math.max(1, Math.min(500, cfg.maxElements || 500))
  const current = () => {
    const state = getSessionState().browser
    if (!state?.owned || state.backend !== backend || !state.context || state.released)
      fail(
        companion
          ? '请先 browser_open 连接 Chrome 专属标签分组。'
          : '请先 browser_open 创建独立 Playwright 浏览器。',
      )
    if (state.stopped || getSessionState().controlStopped)
      fail('本次控制已由用户停止，请新建 DSH 会话开始下一任务。', 'CONTROL_STOPPED')
    return state
  }
  const appAllowed = () => {
    const apps = cfg.allowedApps || []
    // channel:chrome selects the official installed Google Chrome executable.
    if (apps.length && !apps.includes('Google Chrome'))
      fail('区域限制：Google Chrome 不在 allowedApps 中。')
  }
  const pageOf = (state) => {
    const page = state.pages.get(state.tabId)
    if (!page || page.isClosed()) fail('目标标签页已关闭，请 browser_tabs 重新列举并选择。')
    return page
  }
  const registerPage = (state, page) => {
    for (const [id, existing] of state.pages) if (existing === page) return id
    const id = `tab-${randomUUID()}`
    state.pages.set(id, page)
    state.pageRevisions ||= new Map()
    state.pageRevisions.set(id, 0)
    page.on('framenavigated', (frame) => {
      state.pageRevisions.set(id, (state.pageRevisions.get(id) || 0) + 1)
      if (state.tabId === id) {
        state.screenshot = null
        if (frame === page.mainFrame()) invalidate(state)
      }
    })
    page.on('dialog', (dialog) => {
      state.dialogs.set(id, { id: `dialog-${randomUUID()}`, at: now(), dialog })
    })
    page.on('close', () => {
      if (state.tabId === id) state.observed = null
      state.dialogs.delete(id)
    })
    return id
  }
  const fresh = (state) => {
    if (!state.observed || now() - state.observed.at > ttlMs)
      fail('网页快照缺失或已过期，请 browser_observe。')
    if (state.observed.tabId !== state.tabId) fail('快照属于另一个标签页，请重新观察。')
    if (state.observed.url !== undefined && state.observed.url !== pageOf(state).url())
      fail('网页地址已变化，请重新 browser_observe。', 'BROWSER_TARGET_CHANGED')
    return state.observed
  }
  const refOf = (state, ref, action) => {
    const snap = fresh(state)
    const entry = snap.refs.get(ref)
    if (!entry) fail('ref 不属于本次网页观察，请重新 browser_observe。')
    if (action && !entry.actions.includes(action)) fail(`目标不支持 ${action}。`)
    if (entry.enabled === false) fail('目标控件已禁用。')
    return entry
  }
  const approve = async (toolName, reason, exec, required = false, exactReason = false) => {
    active(exec)
    if (!required && !DANGER.test(reason) && reason) return
    if (!ctx?.approval || !exec?.agent) fail('此操作需要用户审批，审批服务不可用。')
    // Explicit file selections must remain fully reviewable. The caller builds
    // this text from a safe URL and JSON-escaped paths, never raw page content.
    if (exactReason && reason.length > 16000) fail('文件授权详情过长，请减少所选文件或缩短路径。')
    let decision
    try {
      decision = await ctx.approval.request({
        toolName,
        agent: exec.agent,
        signal: exec.signal,
        ...(exec.callId ? { callId: exec.callId } : {}),
        reason: exactReason ? reason : clean(reason),
      })
    } catch {
      decision = 'unavailable'
    }
    active(exec)
    if (decision !== 'allowed-once') fail(`操作未获批准（${decision}）。`)
  }
  const invalidate = (state) => {
    if (companion) state.revision = (state.revision || 0) + 1
    state.retired ||= new Set()
    if (state.observed)
      for (const entry of state.observed.refs.values()) state.retired.add(entry.handle)
    state.observed = null
    state.screenshot = null
    for (const continuation of state.continuations.values()) {
      if (continuation.scopeHandle) state.retired.add(continuation.scopeHandle)
      for (const position of continuation.frames || [])
        if (position.cursor) state.retired.add(position.cursor)
    }
    state.continuations.clear()
  }
  const releaseRetired = async (state) => {
    if (!state?.retired || state.pendingInteraction) return
    const currentHandles = new Set(
      state.observed ? [...state.observed.refs.values()].map((entry) => entry.handle) : [],
    )
    for (const continuation of state.continuations.values())
      if (continuation.scopeHandle) currentHandles.add(continuation.scopeHandle)
    for (const continuation of state.continuations.values())
      for (const position of continuation.frames || [])
        if (position.cursor) currentHandles.add(position.cursor)
    const disposalBudget = state.retiredDisposalBudget
    for (const handle of [...state.retired]) {
      state.retired.delete(handle)
      if (currentHandles.has(handle)) continue
      if (disposalBudget) await disposalBudget.dispose(handle)
      else await handle.dispose().catch(() => {})
    }
    if (state.retiredDisposalBudget === disposalBudget) state.retiredDisposalBudget = null
  }
  const assertBackgroundScope = (token, exec) => {
    active(exec)
    if (
      current() !== token.state ||
      token.state.revision !== token.revision ||
      token.state.tabId !== token.tabId ||
      pageOf(token.state) !== token.page ||
      token.page.url() !== token.url ||
      now() - token.snapshot.at > ttlMs
    )
      fail('后台操作目标或快照已变化，请重新观察。', 'BROWSER_TARGET_CHANGED')
  }
  const inspectBackgroundPointer = async (token, entry, exec) => {
    assertBackgroundScope(token, exec)
    if (token.snapshot.refs.get(entry.ref) !== entry)
      fail('后台目标不属于本次观察，请重新观察。', 'BROWSER_TARGET_CHANGED')
    // Force bypasses Playwright's rAF-based stability and hit-target checks.
    // Restrict this path to the main frame where this readonly hit test covers
    // the entire page; iframe ancestors need a separate complete verification.
    if (!entry.frame || entry.frame !== token.page.mainFrame() || entry.frame.parentFrame())
      fail(
        '当前 iframe 无法完整验证后台点击目标，已拒绝操作。',
        'BROWSER_BACKGROUND_FRAME_UNSUPPORTED',
      )
    const frame = await entry.handle.ownerFrame()
    assertBackgroundScope(token, exec)
    if (frame !== entry.frame || frame.isDetached())
      fail('后台目标文档已变化，请重新观察。', 'BROWSER_TARGET_CHANGED')
    const live = await entry.handle.evaluate(describeElement, 'background-pointer')
    assertBackgroundScope(token, exec)
    if (!live?.connected || !live.enabled)
      fail('后台目标已隐藏、禁用或移除，请重新观察。', 'BROWSER_TARGET_UNAVAILABLE')
    if (
      live.role !== entry.role ||
      live.name !== entry.name ||
      Boolean(live.protected) !== Boolean(entry.protected) ||
      JSON.stringify(live.actions) !== JSON.stringify(entry.actions) ||
      (entry.checked !== undefined && live.checked !== entry.checked) ||
      (entry.identity && JSON.stringify(live.identity) !== JSON.stringify(entry.identity))
    )
      fail('后台目标的身份或操作语义已变化，请重新观察。', 'BROWSER_TARGET_CHANGED')
    if (!live.inViewport)
      fail('后台目标不在可见区域，请先滚动并重新观察。', 'BROWSER_TARGET_UNAVAILABLE')
    if (!live.hitTarget)
      fail('后台目标被遮挡或不能接收指针操作，请重新观察。', 'BROWSER_TARGET_UNAVAILABLE')
    return live
  }
  const stableBackgroundPointer = async (token, entry, exec) => {
    const first = await inspectBackgroundPointer(token, entry, exec)
    // Background Chrome may stop page rAF entirely. Sample using the host clock
    // instead of bypassing movement safety along with Playwright's rAF wait.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await inspectBackgroundPointer(token, entry, exec)
    if (
      !['x', 'y', 'width', 'height'].every(
        (key) => Number.isFinite(first.rect?.[key]) && first.rect[key] === second.rect?.[key],
      )
    )
      fail('后台目标仍在移动，请等待页面稳定后重新观察。', 'BROWSER_TARGET_UNSTABLE')
    return second
  }
  const linkToken = (state, entry) => {
    const snapshot = fresh(state),
      page = pageOf(state)
    return {
      state,
      snapshot,
      entry,
      revision: state.revision,
      tabId: state.tabId,
      page,
      url: snapshot.url || page.url(),
    }
  }
  const assertLinkReference = (token, exec) => {
    assertBackgroundScope(token, exec)
    if (
      fresh(token.state) !== token.snapshot ||
      token.snapshot.refs.get(token.entry.ref) !== token.entry
    )
      fail('链接 ref 已变化，请重新观察。', 'BROWSER_TARGET_CHANGED')
  }
  const inspectLinkReference = async (token, exec) => {
    assertLinkReference(token, exec)
    const entry = token.entry,
      frame = await entry.handle.ownerFrame()
    assertLinkReference(token, exec)
    if (
      !frame ||
      frame !== entry.frame ||
      frame.isDetached() ||
      (frame !== token.page.mainFrame() && !token.page.frames().includes(frame))
    )
      fail('链接所属文档已变化，请重新观察。', 'BROWSER_TARGET_CHANGED')
    const live = await entry.handle.evaluate(describeElement, 'open-link')
    assertLinkReference(token, exec)
    if (!live?.connected || !live.enabled)
      fail('链接已隐藏、禁用或移除，请重新观察。', 'BROWSER_TARGET_UNAVAILABLE')
    if (
      live.role !== entry.role ||
      live.name !== entry.name ||
      Boolean(live.protected) !== Boolean(entry.protected) ||
      JSON.stringify(live.actions) !== JSON.stringify(entry.actions) ||
      (entry.identity && JSON.stringify(live.identity) !== JSON.stringify(entry.identity)) ||
      (entry.link && JSON.stringify(live.link) !== JSON.stringify(entry.link))
    )
      fail('链接的身份或 href 已变化，请重新观察。', 'BROWSER_TARGET_CHANGED')
    return live
  }
  const checkedLinkDestination = (entry, live) => {
    if (entry.role !== 'link' || !live.link || typeof live.link.href !== 'string')
      fail('open_link 只支持带 href 的真实网页链接。', 'BROWSER_LINK_UNSUPPORTED')
    if (live.link.download || entry.link?.download)
      fail('open_link 不支持下载链接。', 'BROWSER_LINK_UNSUPPORTED')
    if (
      typeof entry.identity?.linkDestination !== 'string' ||
      entry.identity.linkDestination !== live.link.href
    )
      fail('链接缺少可核验的原始 href，请重新观察。', 'BROWSER_TARGET_CHANGED')
    let destination
    try {
      destination = new URL(live.link.href)
    } catch {
      fail('链接没有有效的 HTTP(S) 地址。', 'BROWSER_LINK_UNSUPPORTED')
    }
    if (
      !['http:', 'https:'].includes(destination.protocol) ||
      destination.username ||
      destination.password
    )
      fail(
        'open_link 仅支持无用户名密码的 HTTP(S) 链接；不能打开脚本、本地文件或其它协议。',
        'BROWSER_LINK_UNSUPPORTED',
      )
    return destination.href
  }
  const beforeMutation = async (state, tool, entries, exec, { backgroundPointer = false } = {}) => {
    appAllowed()
    active(exec)
    const snapshot = fresh(state)
    const token =
      companion && backgroundPointer
        ? {
            state,
            snapshot,
            revision: state.revision,
            tabId: state.tabId,
            page: pageOf(state),
            url: pageOf(state).url(),
            live: new Map(),
          }
        : null
    if (foreground) await pageOf(state).bringToFront()
    for (const entry of entries)
      await approve(tool, entry.name || '', exec, entry.nameComplete === false)
    fresh(state)
    active(exec)
    if (token) {
      for (const entry of entries)
        if (entry.handle) token.live.set(entry, await stableBackgroundPointer(token, entry, exec))
      if (fresh(state) !== snapshot)
        fail('后台操作的观察已变化，请重新观察。', 'BROWSER_TARGET_CHANGED')
    }
    invalidate(state)
    if (token) token.revision = state.revision
    return token
  }
  const observe = async (args = {}, exec) => {
    active(exec)
    appAllowed()
    const state = current()
    const page = pageOf(state)
    const old = state.observed
    const tabId = state.tabId
    const pageURL = page.url()
    const documentRevision = state.pageRevisions?.get(tabId)
    let scopeHandle = args.scope_ref === undefined ? null : refOf(state, args.scope_ref).handle
    let previous = null
    if (args.continuation !== undefined) {
      previous = state.continuations.get(args.continuation)
      if (
        !previous ||
        previous.tabId !== tabId ||
        previous.url !== pageURL ||
        previous.documentRevision !== documentRevision ||
        previous.snapshotId !== old?.snapshotId ||
        now() - old.at > ttlMs
      ) {
        if (previous) {
          state.retired ||= new Set()
          for (const position of previous.frames || [])
            if (position.cursor) state.retired.add(position.cursor)
          state.continuations.delete(args.continuation)
          state.retiredDisposalBudget = createBrowserObservationBudget(
            cfg,
            exec?.signal,
            () => getSessionState().browser === state,
          )
        }
        fail('continuation 已失效，请重新观察。')
      }
      if (
        args.scope_ref !== undefined ||
        (args.query !== undefined && args.query !== previous.query)
      )
        fail('continuation不能更换query或scope。')
      scopeHandle = previous.scopeHandle || null
      args = { ...args, query: previous.query || undefined }
    }
    const query = args.query === undefined ? '' : String(args.query).toLowerCase()
    if (query.length > 2000) fail('query不能超过2000字符。')
    if (companion) state.revision = (state.revision || 0) + 1
    state.observationGeneration = (state.observationGeneration || 0) + 1
    const generation = state.observationGeneration
    const stillCurrent = () =>
      getSessionState().browser === state &&
      !state.stopped &&
      !state.released &&
      state.tabId === tabId &&
      state.pages.get(tabId) === page &&
      !page.isClosed() &&
      page.url() === pageURL &&
      state.pageRevisions?.get(tabId) === documentRevision &&
      state.observationGeneration === generation
    const budget = createBrowserObservationBudget(cfg, exec?.signal, stillCurrent)
    state.retiredDisposalBudget = budget
    state.retired ||= new Set()
    if (old) for (const entry of old.refs.values()) state.retired.add(entry.handle)
    for (const continuation of state.continuations.values()) {
      if (continuation.scopeHandle) state.retired.add(continuation.scopeHandle)
      for (const item of continuation.frames || []) if (item.cursor) state.retired.add(item.cursor)
    }
    state.continuations.clear()
    state.observed = null
    state.screenshot = null
    const frames = page.frames()
    if (
      previous &&
      (previous.frames.length !== frames.length ||
        previous.frames.some((item, index) => item.frame !== frames[index]))
    )
      fail('网页frame已变化，请重新观察。', 'BROWSER_TARGET_CHANGED')
    const positions = frames.map((frame, index) => ({
      frame,
      cursor: previous?.frames[index]?.cursor || null,
      done: previous?.frames[index]?.done === true,
    }))
    const rows = []
    let title = '',
      text = '',
      scopeFrame = null,
      titleRead = false
    let safetyComplete = frames.length > 0
    let sensitive = false
    let scansComplete = true
    try {
      title = String(await budget.call(() => page.title())).slice(0, 201)
      titleRead = true
      if (scopeHandle) scopeFrame = await budget.call(() => scopeHandle.ownerFrame())
      if (scopeHandle && !frames.includes(scopeFrame))
        fail('scope_ref所属frame已变化。', 'BROWSER_TARGET_CHANGED')
      for (const position of positions) {
        budget.check()
        const { frame } = position
        const outputDone = position.done || Boolean(scopeFrame && scopeFrame !== frame)
        try {
          const collected = await collectBrowserFrame(
            frame,
            {
              operation: 'scan',
              scope: scopeFrame === frame ? scopeHandle : null,
              cursor: position.cursor,
              outputDone,
              query,
              outputNodes: Math.max(0, budget.maxNodes - budget.visited.output),
              safetyNodes: Math.max(0, budget.safetyMaxNodes - budget.visited.safety),
              timeoutMs: budget.remainingMs(),
              maxRows: Math.max(0, maxElements - rows.length),
              maxTextChars: Math.max(0, 16000 - text.length),
            },
            budget,
          )
          if (!collected.cursorValid)
            fail('网页续页的遍历位置已变化，请重新观察。', 'BROWSER_TARGET_CHANGED')
          budget.visited.output += collected.used.output
          budget.visited.safety += collected.used.safety
          for (const reason of collected.stopReasons) budget.stopReasons.add(reason)
          safetyComplete &&= collected.safetyComplete
          sensitive ||= collected.sensitive
          rows.push(...collected.rows)
          text += collected.text
          position.done = outputDone || collected.outputComplete
          position.cursor = collected.cursor
        } catch (error) {
          if (
            [
              'ABORTED',
              'BROWSER_OBSERVATION_TIMEOUT',
              'BROWSER_OBSERVATION_SUPERSEDED',
              'BROWSER_TARGET_CHANGED',
            ].includes(error.code)
          )
            throw error
          budget.stopReasons.add('frame_error')
          safetyComplete = false
          scansComplete = false
        }
      }
    } catch (error) {
      if (error.code !== 'BROWSER_OBSERVATION_TIMEOUT') {
        for (const position of positions) if (position.cursor) state.retired.add(position.cursor)
        for (const entry of rows) state.retired.add(entry.handle)
        throw error
      }
      safetyComplete = false
      scansComplete = false
      budget.stopReasons.add('timeout')
    }
    active(exec)
    if (!stillCurrent()) {
      for (const position of positions) if (position.cursor) state.retired.add(position.cursor)
      for (const entry of rows) state.retired.add(entry.handle)
      fail('网页观察目标已变化，请重新观察。', 'BROWSER_OBSERVATION_SUPERSEDED')
    }
    const snapshotId = `pw-${randomUUID()}`
    const refs = rows.map((entry, index) => ({ ...entry, ref: `${snapshotId}:${index}` }))
    const inputBlocked =
      !safetyComplete ||
      sensitive ||
      rows.some((entry) => entry.protected || SENSITIVE.test(entry.name))
    const timedOut = budget.stopReasons.has('timeout')
    const continuation =
      !timedOut && !budget.stopReasons.has('frame_error') && positions.some((item) => !item.done)
        ? `more-${randomUUID()}`
        : null
    if (continuation)
      state.continuations.set(continuation, {
        tabId,
        url: pageURL,
        documentRevision,
        query,
        scopeHandle,
        snapshotId,
        frames: positions,
      })
    else for (const position of positions) if (position.cursor) state.retired.add(position.cursor)
    const complete =
      !timedOut &&
      scansComplete &&
      safetyComplete &&
      !inputBlocked &&
      !scopeHandle &&
      !query &&
      !previous &&
      !continuation &&
      titleRead &&
      title.length <= 200 &&
      !rows.some(
        (entry) =>
          entry.nameComplete === false ||
          entry.name.length > 200 ||
          entry.valueComplete === false ||
          (typeof entry.value === 'string' && entry.value.length > 1000),
      )
    state.observed = {
      at: now(),
      tabId,
      snapshotId,
      url: pageURL,
      refs: new Map(refs.map((entry) => [entry.ref, entry])),
      inputBlocked,
    }
    const stopReasons = [...budget.stopReasons]
    return result({
      message: '网页观察完成。',
      backend,
      tabId,
      snapshotId,
      ttlMs,
      title: title.slice(0, 200),
      titleComplete: titleRead && title.length <= 200,
      url: safeURL(pageURL),
      origin: new URL(pageURL).origin,
      complete,
      textComplete: complete,
      inputBlocked,
      safetyComplete,
      scope: scopeHandle ? 'subtree' : query ? 'query' : 'page',
      continuation,
      observationBudget: {
        maxNodes: budget.maxNodes,
        safetyMaxNodes: budget.safetyMaxNodes,
        timeoutMs: budget.timeoutMs,
        visitedNodes: { ...budget.visited },
        stopReason: stopReasons[0] || 'complete',
        stopReasons,
      },
      outline: inputBlocked
        ? '本页含敏感字段或全页安全检查不完整，已隐藏可能含输入值的摘要。'
        : text,
      truncated: !complete,
      refs: refs.map((entry) => ({
        ref: entry.ref,
        role: entry.role,
        name: entry.name.slice(0, 200),
        ...(entry.nameComplete === false || entry.name.length > 200 ? { nameTruncated: true } : {}),
        ...(!inputBlocked &&
        (entry.valueComplete === false ||
          (typeof entry.value === 'string' && entry.value.length > 1000))
          ? { valueTruncated: true }
          : {}),
        actions: entry.actions,
        enabled: entry.enabled,
        states: {
          disabled: !entry.enabled,
          ...(entry.checked === undefined ? {} : { checked: entry.checked }),
          protected: entry.protected,
        },
        ...(entry.checked === undefined ? {} : { checked: entry.checked }),
        visibility: entry.inViewport ? 'in_viewport' : 'offscreen',
        ...(inputBlocked
          ? {}
          : { value: typeof entry.value === 'string' ? entry.value.slice(0, 1000) : entry.value }),
      })),
    })
  }
  const open = async (args = {}, exec) => {
    const url = checkedURL(args.url || 'about:blank')
    active(exec)
    appAllowed()
    const session = getSessionState()
    if (session.controlStopped) fail('本次控制已由用户停止，请新建 DSH 会话。', 'CONTROL_STOPPED')
    let state = session.browser
    if (state?.released) {
      await state.releaseTask?.catch(() => {})
      state = session.browser
      active(exec)
    }
    if (!state?.owned || state.backend !== backend) {
      const library = playwright || (await import('playwright-core'))
      let browser, context, lease
      try {
        if (companion) {
          lease = await (
            await connectedBridge()
          ).connect({
            owner: session.driverSession,
            title: '浏览器操作',
            signal: exec?.signal,
            onStopped: () => {
              session.controlStopped = true
              session.snapshot = null
              if (state) {
                state.stopped = true
                invalidate(state)
              }
              exec?.agent?.cancel?.({ kind: 'user' }, { keepInbox: true })
            },
          })
          // The companion's virtual CDP endpoint exposes ONLY registered tabs.
          // Never connect directly to the user's unrestricted debugging port.
          browser = await library.chromium.connectOverCDP(lease.endpointURL, {
            noDefaults: true,
            timeout: 15000,
          })
          active(exec)
          if (session.controlStopped) fail('用户已停止本次 Chrome 控制。', 'CONTROL_STOPPED')
          context = browser.contexts()[0]
          if (!context) fail('Chrome 扩展未提供当前会话的标签上下文。', 'CHROME_BRIDGE_UNAVAILABLE')
        } else {
          browser = await library.chromium.launch({
            channel: 'chrome',
            headless: cfg.browserHeadless !== false,
          })
          context = await browser.newContext({
            acceptDownloads: true,
            viewport: { width: 1280, height: 800 },
            deviceScaleFactor: 1,
          })
        }
        active(exec)
        const releaseResources = companion
          ? async () => {
              const outcome = await lease.release({ keepTabs: true })
              if (outcome?.warning) ctx?.logger?.warn?.(outcome.warning)
              return outcome
            }
          : async () => {
              await context.close().catch(() => {})
              await browser.close().catch(() => {})
            }
        const dispose = () => {
          if (state?.releaseTask) return state.releaseTask
          if (state) {
            state.released = true
            invalidate(state)
          }
          const pending = Promise.resolve()
            .then(releaseResources)
            .finally(() => {
              if (session.browser === state) session.browser = null
            })
          if (state) state.releaseTask = pending
          return pending
        }
        const untrack = track(ctx, dispose)
        state = {
          untrack,
          dispose,
          backend,
          owned: true,
          browser,
          context,
          pages: new Map(),
          dialogs: new Map(),
          continuations: new Map(),
          observed: null,
          screenshot: null,
          tabId: null,
        }
        context.on('page', (page) => registerPage(state, page))
        active(exec)
        const page = await context.newPage()
        state.tabId = registerPage(state, page)
        active(exec)
        session.browser = state
      } catch (error) {
        if (companion) await lease?.release({ keepTabs: true }).catch(() => {})
        else if (browser) await browser.close().catch(() => {})
        throw error
      }
    }
    active(exec)
    invalidate(state)
    await pageOf(state).goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    if (foreground) await pageOf(state).bringToFront()
    return observe({}, exec)
  }
  const navigate = async (args, exec) => {
    const url = checkedURL(args.url)
    const state = current()
    appAllowed()
    active(exec)
    invalidate(state)
    await pageOf(state).goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    return observe({}, exec)
  }
  const click = async (args, exec) => {
    const state = current()
    if (args.ref !== undefined) {
      if (args.x !== undefined || args.y !== undefined) fail('ref与坐标必须二选一。')
      const entry = refOf(state, args.ref, 'click')
      if (companion && entry.role === 'link') {
        const live = await inspectLinkReference(linkToken(state, entry), exec)
        if (live.link?.target === '_blank') {
          checkedLinkDestination(entry, live)
          fail(
            '后台新标签链接请使用 browser_tabs({action:"open_link",ref})；该动作只打开 href，不执行点击脚本。本次未投递点击，原 ref 仍可使用。',
            'BROWSER_BACKGROUND_LINK_REQUIRES_OPEN',
          )
        }
      }
      const token = await beforeMutation(state, 'browser_click', [entry], exec, {
        backgroundPointer: true,
      })
      active(exec)
      if (token) assertBackgroundScope(token, exec)
      await entry.handle.click({
        timeout: 5000,
        noWaitAfter: true,
        ...(token ? { force: true } : {}),
      })
    } else {
      const shot = state.screenshot
      if (!shot || shot.tabId !== state.tabId || now() - shot.at > ttlMs)
        fail('坐标操作需要当前标签页的新鲜 browser_screenshot。')
      // Production screenshots carry their original page/document binding.
      // Legacy injected fixtures bind to the current page before approval.
      const target = {
        state,
        page: shot.page || pageOf(state),
        tabId: shot.tabId,
        url: shot.url ?? pageOf(state).url(),
        revision: shot.revision ?? state.revision,
        documentRevision: shot.documentRevision ?? state.pageRevisions?.get(state.tabId),
      }
      assertScreenshotTarget(target, exec)
      if (
        ![args.x, args.y].every(Number.isFinite) ||
        args.x < 0 ||
        args.y < 0 ||
        args.x >= shot.width ||
        args.y >= shot.height
      )
        fail('坐标超出截图范围。')
      await approve('browser_click', '按当前截图坐标点击，目标语义未知。', exec, true)
      assertScreenshotTarget(target, exec)
      if (state.screenshot !== shot || shot.tabId !== state.tabId || now() - shot.at > ttlMs)
        fail('审批期间截图已失效，请重新截图。')
      invalidate(state)
      await target.page.mouse.click(args.x, args.y)
    }
    return result({ message: '点击已投递，请重新观察验证。' })
  }
  const writeToken = (state, entry) => ({
    state,
    entry,
    page: pageOf(state),
    tabId: state.tabId,
    url: pageOf(state).url(),
    frame: entry.frame,
    frameURL: entry.frame?.url?.(),
  })
  const performWrite = async (write, exec) => {
    try {
      await write()
      active(exec)
    } catch (error) {
      active(exec)
      if (error?.code === 'ABORTED') fail('操作已取消。', 'ABORTED')
      if (error?.code === 'CONTROL_STOPPED' || getSessionState().controlStopped)
        fail('本次控制已由用户停止，请新建 DSH 会话。', 'CONTROL_STOPPED')
      // Playwright call logs may include the supplied text/selected value.
      // Keep mutation diagnostics fixed; an error does not prove no effect.
      fail(
        '网页写入调用未正常完成，控件可能已变化；请重新观察，勿自动重复写入。',
        'BROWSER_WRITE_UNCONFIRMED',
      )
    }
  }
  const verifyWrite = async (token, expected, kind, exec) => {
    const { state, entry, page, tabId, url, frame, frameURL } = token
    const verification = await verifyBrowserWrite({
      signal: exec?.signal,
      validate: async () =>
        current() === state &&
        state.tabId === tabId &&
        pageOf(state) === page &&
        page.url() === url &&
        Boolean(frame) &&
        !frame.isDetached() &&
        frame.url() === frameURL &&
        (await entry.handle.ownerFrame()) === frame,
      read: () =>
        entry.handle.evaluate(
          (el, { expected, kind, identity }) => {
            if (!el.isConnected || el.ownerDocument !== document) return { available: false }
            const tag = el.tagName.toLowerCase(),
              type = (el.getAttribute('type') || '').toLowerCase()
            if (
              type === 'password' ||
              (identity && (tag !== identity.tag || type !== identity.type))
            )
              return { available: false }
            // Compare inside the document so neither actual nor expected values
            // become tool output or diagnostic text.
            if (kind === 'select')
              return tag === 'select' && !el.multiple
                ? {
                    available: true,
                    matches:
                      el.selectedOptions.length === 1 && el.selectedOptions[0].value === expected,
                  }
                : { available: false }
            if (['input', 'textarea'].includes(tag))
              return { available: true, matches: el.value === expected }
            if (el.isContentEditable)
              return { available: true, matches: el.textContent === expected }
            return { available: false }
          },
          { expected, kind, identity: entry.identity },
        ),
    })
    const matched = verification.status === 'matched'
    return {
      effect: matched ? 'verified' : 'unverifiable',
      verification: { ...verification, scope: 'control-value' },
      message: matched
        ? '控件当前值已读回验证；业务保存结果仍需重新观察。'
        : verification.status === 'mismatch'
          ? '写入已投递，但读回值未匹配；控件可能已变化，请重新观察，勿自动重复写入。'
          : '写入已投递，但无法确认当前控件值；请重新观察，勿自动重复写入。',
    }
  }
  const type = async (args, exec) => {
    if (typeof args.text !== 'string') fail('text必须是字符串。')
    const state = current(),
      entry = refOf(state, args.ref, 'type')
    if (state.observed.inputBlocked || entry.protected || SENSITIVE.test(entry.name))
      fail('本页有敏感字段，自动输入已暂停。')
    const token = writeToken(state, entry)
    await beforeMutation(state, 'browser_type', [entry], exec)
    await performWrite(
      () =>
        args.replace === true
          ? entry.handle.fill(args.text, { timeout: 5000 })
          : entry.handle.type(args.text, { timeout: 5000 }),
      exec,
    )
    const outcome =
      args.replace === true
        ? await verifyWrite(token, args.text, 'text', exec)
        : { effect: 'delivered', message: '文本已投递，请重新观察验证。' }
    return {
      ...result({ ...outcome, characters: Array.from(args.text).length }),
      ...(outcome.verification?.status === 'mismatch' ? { ok: false } : {}),
    }
  }
  const scroll = async (args, exec) => {
    const state = current()
    const entry = refOf(state, args.ref, 'pointer')
    const amount = args.amount ?? 500
    if (
      !['up', 'down', 'left', 'right'].includes(args.direction) ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > 5000
    )
      fail('滚动参数无效。')
    const token = await beforeMutation(state, 'browser_scroll', [entry], exec, {
      backgroundPointer: true,
    })
    await entry.handle.hover({ timeout: 5000, ...(token ? { force: true } : {}) })
    if (token) assertBackgroundScope(token, exec)
    await pageOf(state).mouse.wheel(
      ['left', 'right'].includes(args.direction)
        ? ['left'].includes(args.direction)
          ? -amount
          : amount
        : 0,
      ['up', 'down'].includes(args.direction) ? (args.direction === 'up' ? -amount : amount) : 0,
    )
    return result({ message: '已滚动，请重新观察。' })
  }
  const select = async (args, exec) => {
    if ((typeof args.label === 'string') === (typeof args.value === 'string'))
      fail('label和value必须且只能提供一个。')
    const state = current()
    const entry = refOf(state, args.ref, 'select')
    if (state.observed.inputBlocked || entry.protected || SENSITIVE.test(entry.name))
      fail('本页有敏感字段或安全检查不完整，自动选择已暂停。')
    const option = await entry.handle.evaluate(
      (element, selection) => {
        if (element.tagName.toLowerCase() !== 'select' || element.multiple) return null
        const found = [...element.options].filter((option) =>
          selection.label === undefined
            ? option.value === selection.value
            : option.label === selection.label,
        )
        if (found.length !== 1 || found[0].disabled || found[0].parentElement?.disabled) return null
        return { label: found[0].label, value: found[0].value }
      },
      { label: args.label, value: args.value },
    )
    if (!option) fail('原生单选目标不存在、歧义或已禁用。')
    const token = writeToken(state, entry)
    await beforeMutation(state, 'browser_select', [entry, { name: option.label }], exec)
    await performWrite(
      () => entry.handle.selectOption({ value: option.value }, { timeout: 5000 }),
      exec,
    )
    const outcome = await verifyWrite(token, option.value, 'select', exec)
    return {
      ...result(outcome),
      ...(outcome.verification.status === 'mismatch' ? { ok: false } : {}),
    }
  }
  const pointer = async (args, exec) => {
    if (!['hover', 'right_click', 'double_click', 'drag'].includes(args.action))
      fail('不支持的指针动作。')
    const state = current()
    const from = refOf(state, args.ref, 'pointer')
    const to = args.action === 'drag' ? refOf(state, args.destination_ref, 'pointer') : null
    if (to && from.frame !== to.frame) fail('拖拽目标必须在同一frame。')
    const token = await beforeMutation(
      state,
      'browser_pointer',
      [from, ...(to ? [to] : [])],
      exec,
      { backgroundPointer: true },
    )
    const options = { timeout: 5000, ...(token ? { force: true } : {}) }
    if (args.action === 'hover') await from.handle.hover(options)
    else if (args.action === 'right_click')
      await from.handle.click({ ...options, button: 'right', noWaitAfter: true })
    else if (args.action === 'double_click')
      await from.handle.dblclick({ ...options, noWaitAfter: true })
    else if (token) {
      const mouse = pageOf(state).mouse
      await from.handle.hover(options)
      await stableBackgroundPointer(token, from, exec)
      await mouse.down()
      try {
        await stableBackgroundPointer(token, to, exec)
        await to.handle.hover(options)
      } finally {
        await mouse.up()
      }
    } else {
      const a = await from.handle.boundingBox()
      const b = await to.handle.boundingBox()
      if (!a || !b) fail('拖拽目标不可见。')
      const mouse = pageOf(state).mouse
      await mouse.move(a.x + a.width / 2, a.y + a.height / 2)
      await mouse.down()
      try {
        await mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
      } finally {
        await mouse.up()
      }
    }
    return result({ message: '指针动作已投递，请重新观察。' })
  }
  const key = async (args, exec) => {
    if (typeof args.key !== 'string' || !args.key || args.key.length > 100) fail('需要有效key。')
    const state = current()
    const entry = refOf(state, args.ref)
    if (state.observed.inputBlocked || entry.protected) fail('敏感页面不允许自动键盘输入。')
    await beforeMutation(state, 'browser_key', [entry], exec)
    await entry.handle.press(args.key, { timeout: 5000, noWaitAfter: true })
    return result({ message: '按键已投递，请重新观察。' })
  }
  const openLink = async (args, exec) => {
    const state = current()
    appAllowed()
    active(exec)
    if (args.url !== undefined || args.tab_id !== undefined)
      fail(
        'open_link 仅接受当前观察的 ref，不能覆盖链接 URL 或指定其它标签。',
        'BROWSER_LINK_UNSUPPORTED',
      )
    const entry = refOf(state, args.ref, 'click')
    if (entry.role !== 'link') fail('open_link 只支持 link ref。', 'BROWSER_LINK_UNSUPPORTED')
    const token = linkToken(state, entry)
    let destination = checkedLinkDestination(entry, await inspectLinkReference(token, exec))
    await approve(
      'browser_tabs',
      `打开链接「${entry.name}」到 ${safeURL(destination)}；仅导航 href，不执行点击脚本。`,
      exec,
      !entry.name || entry.nameComplete === false,
      true,
    )
    checkedLinkDestination(entry, await inspectLinkReference(token, exec))
    // Explicit navigation creates a registered session-owned tab directly. It
    // deliberately does not run click/onclick handlers or rely on popup openerId.
    const page = await state.context.newPage()
    assertLinkReference(token, exec)
    destination = checkedLinkDestination(entry, await inspectLinkReference(token, exec))
    invalidate(state)
    state.tabId = registerPage(state, page)
    active(exec)
    await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const observed = await observe({}, exec)
    return result({
      ...observed.data,
      action: 'open_link',
      sourceTabId: token.tabId,
      openedTabId: state.tabId,
      openedUrl: safeURL(destination),
      navigationOnly: true,
      clickScriptsExecuted: false,
      message: '已在本会话新标签打开链接 href；这是 URL 导航，未执行原链接的点击脚本。',
    })
  }
  const tabs = async (args = {}, exec) => {
    const state = current()
    appAllowed()
    active(exec)
    for (const page of state.context.pages()) registerPage(state, page)
    const action = args.action || 'list'
    if (action === 'open_link') return openLink(args, exec)
    if (action === 'new') {
      const url = checkedURL(args.url || 'about:blank')
      const page = await state.context.newPage()
      state.tabId = registerPage(state, page)
      invalidate(state)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      if (foreground) await page.bringToFront()
      return observe({}, exec)
    }
    if (action === 'select' || action === 'close') {
      const page = state.pages.get(args.tab_id)
      if (!page || page.isClosed()) fail('tab_id不属于当前会话。')
      if (action === 'select') {
        state.tabId = args.tab_id
        if (foreground) await page.bringToFront()
      } else {
        await page.close({ runBeforeUnload: false })
        state.pages.delete(args.tab_id)
        if (state.tabId === args.tab_id)
          state.tabId = [...state.pages].find(([, p]) => !p.isClosed())?.[0] || null
      }
      invalidate(state)
      if (action === 'select') return observe({}, exec)
    } else if (action !== 'list') fail('tabs action无效。')
    const entries = []
    for (const [id, page] of state.pages)
      if (!page.isClosed())
        entries.push({
          tabId: id,
          title: (await page.title()).slice(0, 200),
          url: safeURL(page.url()),
          selected: state.tabId === id,
        })
    return result({ tabs: entries, selectedTabId: state.tabId })
  }
  const history = async (args, exec) => {
    if (!['back', 'forward', 'reload'].includes(args.action)) fail('history action无效。')
    const state = current()
    appAllowed()
    active(exec)
    invalidate(state)
    const p = pageOf(state)
    if (args.action === 'back') await p.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 })
    else if (args.action === 'forward')
      await p.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 })
    else await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
    return observe({}, exec)
  }
  const dialog = async (args, exec) => {
    const state = current()
    active(exec)
    appAllowed()
    const entry = state.dialogs.get(state.tabId)
    if ((args.action || 'inspect') === 'inspect')
      return result({
        dialog: entry
          ? {
              dialogId: entry.id,
              type: entry.dialog.type(),
              message: clean(entry.dialog.message()),
              at: entry.at,
            }
          : null,
      })
    if (
      !['accept', 'dismiss'].includes(args.action) ||
      !entry ||
      entry.id !== args.dialog_id ||
      now() - entry.at > ttlMs
    )
      fail('dialog_id缺失、过期或不属于当前对话框。')
    if (args.prompt_text !== undefined && typeof args.prompt_text !== 'string')
      fail('prompt_text必须是字符串。')
    await approve(
      'browser_dialog',
      `处理网页对话框 ${entry.dialog.type()}：${entry.dialog.message()}`,
      exec,
      args.action === 'accept',
    )
    if (state.dialogs.get(state.tabId) !== entry || now() - entry.at > ttlMs)
      fail('对话框已变化或过期。')
    active(exec)
    invalidate(state)
    if (args.action === 'accept') await entry.dialog.accept(args.prompt_text)
    else await entry.dialog.dismiss()
    state.dialogs.delete(state.tabId)
    if (state.pendingInteraction) {
      await state.pendingInteraction
      state.pendingInteraction = null
    }
    return result({ message: '对话框已处理。' })
  }
  const assertScreenshotTarget = (target, exec) => {
    active(exec)
    const { state, page, tabId, url, revision, documentRevision } = target
    if (
      current() !== state ||
      state.tabId !== tabId ||
      pageOf(state) !== page ||
      page.url() !== url ||
      state.revision !== revision ||
      state.pageRevisions?.get(tabId) !== documentRevision
    ) {
      state.screenshot = null
      fail(
        '截图所属页面或文档已变化；坐标授权已清除，请重新截图。',
        'BROWSER_SCREENSHOT_TARGET_CHANGED',
      )
    }
  }
  const screenshot = async (_args, exec) => {
    const state = current()
    appAllowed()
    active(exec)
    state.screenshot = null
    const page = pageOf(state),
      attachments = ctx?.get?.('attachments')
    if (!attachments) fail('宿主attachments服务不可用。')
    const target = {
      state,
      page,
      tabId: state.tabId,
      url: page.url(),
      revision: state.revision,
      documentRevision: state.pageRevisions?.get(state.tabId),
    }
    const data = await page.screenshot({
      type: 'png',
      fullPage: false,
      scale: 'css',
      timeout: 10000,
    })
    assertScreenshotTarget(target, exec)
    const size =
      page.viewportSize() ||
      (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    assertScreenshotTarget(target, exec)
    const image = await attachments.saveImage({
      data,
      mediaType: 'image/png',
      name: 'browser-viewport.png',
    })
    assertScreenshotTarget(target, exec)
    if (
      (image.width !== undefined && image.width !== null && image.width !== size.width) ||
      (image.height !== undefined && image.height !== null && image.height !== size.height)
    )
      fail(
        '截图附件尺寸与viewport CSS像素不一致；坐标授权已清除，请重新截图。',
        'BROWSER_SCREENSHOT_DIMENSIONS_CHANGED',
      )
    state.screenshot = {
      at: now(),
      tabId: target.tabId,
      page,
      url: target.url,
      revision: target.revision,
      documentRevision: target.documentRevision,
      width: size.width,
      height: size.height,
    }
    return {
      ...result({
        message: '浏览器截图完成；坐标为viewport CSS像素。',
        width: size.width,
        height: size.height,
        coordinateSpace: 'viewport_css_pixels',
      }),
      image: {
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width ?? size.width,
        height: image.height ?? size.height,
        ...(image.name ? { name: image.name } : {}),
      },
    }
  }
  const maxFileBytes = 10 * 1024 * 1024
  const hostFS = () => ctx?.get?.('fs') || ctx?.fs
  const authorizeUpload = async (files, exec) => {
    const fs = hostFS()
    if (
      !fs ||
      typeof fs.readBytes !== 'function' ||
      typeof fs.stat !== 'function' ||
      typeof fs.processPathFromHostPath !== 'function' ||
      typeof fs.resolve !== 'function' ||
      typeof fs.lstat !== 'function'
    )
      fail('宿主fs文件授权服务未配置，已拒绝读取上传文件。', 'FILE_AUTHORIZATION_UNAVAILABLE')
    if (
      !Array.isArray(files) ||
      files.length < 1 ||
      files.length > 32 ||
      files.some((path) => typeof path !== 'string' || !isAbsolute(path))
    )
      fail('files必须是1–32个明确的绝对普通文件路径。')
    const payloads = []
    let total = 0
    for (const path of files) {
      active(exec)
      const executionPath = await fs.processPathFromHostPath(path)
      if (typeof executionPath !== 'string')
        fail('宿主无法将此用户文件映射到执行环境。', 'FILE_AUTHORIZATION_UNAVAILABLE')
      const info = await fs.lstat(executionPath, {}, exec?.signal)
      if (info?.type !== 'file' || info.size > maxFileBytes)
        fail('上传仅允许10MiB以内的普通文件，不允许符号链接。')
      const target = await fs.resolve(executionPath, { signal: exec?.signal })
      const verified = await fs.stat(target, exec?.signal)
      if (verified?.type !== 'file' || verified.size !== info.size) fail('上传文件在读取前已变化。')
      const read = await fs.readBytes(target, exec?.signal, maxFileBytes)
      const bytes =
        read instanceof Uint8Array
          ? read
          : read?.data instanceof Uint8Array
            ? read.data
            : read?.bytes instanceof Uint8Array
              ? read.bytes
              : null
      if (!bytes)
        fail(
          '宿主fs.readBytes未返回受支持的字节数组，已拒绝上传。',
          'FILE_AUTHORIZATION_UNAVAILABLE',
        )
      total += bytes.byteLength
      if (bytes.byteLength !== info.size || total > maxFileBytes)
        fail('上传文件读取不完整或总大小超过10MiB。')
      payloads.push({
        name: basename(path),
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(bytes),
      })
    }
    return payloads
  }
  const upload = async (args, exec) => {
    if (companion)
      fail(
        '当前 Chrome 分组通路尚不提供文件上传；请在可见页面手动选择文件。',
        'BROWSER_UNSUPPORTED',
      )
    const state = current()
    appAllowed()
    const entry = refOf(state, args.ref, 'upload')
    if (
      !Array.isArray(args.files) ||
      args.files.length < 1 ||
      args.files.length > 32 ||
      args.files.some((path) => typeof path !== 'string' || !isAbsolute(path))
    )
      fail('files必须是1–32个明确的绝对普通文件路径。')
    const files = Object.freeze([...args.files])
    const snapshot = state.observed,
      tabId = state.tabId,
      page = pageOf(state),
      pageURL = page.url()
    const handle = entry.handle,
      frame = entry.frame,
      ref = args.ref,
      name = entry.name,
      role = entry.role
    if (
      !frame ||
      typeof frame.url !== 'function' ||
      typeof frame.isDetached !== 'function' ||
      typeof handle.ownerFrame !== 'function' ||
      typeof handle.evaluate !== 'function'
    )
      fail('上传目标无法安全复核，请重新观察。')
    const frameURL = frame.url()
    // Approval can take longer than an observation TTL. Keep that one grant
    // bound to the original element, page/frame and immutable file selection;
    // never renew the old snapshot or rediscover a replacement target.
    const changed = () =>
      fail(
        '本次上传审批已允许，但原目标已变化或无法安全复核；文件未交给页面，请重新观察并重新授权。',
        'UPLOAD_TARGET_CHANGED',
      )
    const assertContext = () => {
      active(exec)
      appAllowed()
      if (
        current() !== state ||
        state.observed !== snapshot ||
        state.tabId !== tabId ||
        snapshot.tabId !== tabId ||
        snapshot.refs.get(ref) !== entry ||
        entry.handle !== handle ||
        entry.frame !== frame ||
        entry.name !== name ||
        entry.role !== role ||
        pageOf(state) !== page ||
        page.url() !== pageURL ||
        frame.isDetached() ||
        frame.url() !== frameURL
      )
        changed()
    }
    const revalidate = async () => {
      try {
        assertContext()
        if ((await handle.ownerFrame()) !== frame) changed()
        assertContext()
        const live = await handle.evaluate(describeElement, true)
        assertContext()
        if (
          !live ||
          live.name !== name ||
          live.role !== role ||
          live.enabled !== true ||
          live.protected ||
          !live.actions.includes('upload')
        )
          changed()
      } catch (error) {
        active(exec)
        if (error.code === 'UPLOAD_TARGET_CHANGED') throw error
        changed()
      }
    }
    await approve(
      'browser_upload',
      `上传文件（完整路径）：${JSON.stringify({ page: safeURL(pageURL), ...(frameURL === pageURL ? {} : { frame: safeURL(frameURL) }), files })}`,
      exec,
      true,
      true,
    )
    await revalidate()
    const payloads = await authorizeUpload(files, exec)
    await revalidate()
    active(exec)
    invalidate(state)
    await handle.setInputFiles(payloads, { timeout: 10000 })
    return result({
      message: '文件已交给页面，请重新观察验证。',
      files: payloads.length,
      bytes: payloads.reduce((sum, file) => sum + file.buffer.length, 0),
    })
  }
  const destination = async (root, exec) => {
    if (typeof root !== 'string' || !isAbsolute(root))
      fail('destination_root必须是用户明确指定的绝对目录。')
    const policy = ctx?.get?.('sandboxPolicy') || ctx?.sandboxPolicy
    if (!policy || typeof policy.resolve !== 'function' || !exec?.agent?.session)
      fail('宿主sandboxPolicy文件写入授权未配置，已拒绝下载。', 'FILE_AUTHORIZATION_UNAVAILABLE')
    const decision = await policy.resolve({ session: exec.agent.session })
    if (!['workspace-write', 'danger-full-access'].includes(decision?.mode))
      fail('当前宿主文件策略禁止写入下载文件。', 'FILE_WRITE_DENIED')
    const canonical = await realpath(root)
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink())
      fail('下载目录必须存在且为canonical普通目录，不允许符号链接。')
    if (decision.mode === 'workspace-write') {
      if (typeof decision.workspaceRoot !== 'string' || !isAbsolute(decision.workspaceRoot))
        fail('宿主workspaceRoot不可验证，已拒绝写入。', 'FILE_WRITE_DENIED')
      const roots = [await realpath(decision.workspaceRoot), await realpath(tmpdir())]
      const within = roots.some((allowed) => {
        const path = relative(allowed, canonical)
        return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
      })
      if (!within) fail('下载目录不在宿主允许的workspace或临时目录内。', 'FILE_WRITE_DENIED')
    }
    return canonical
  }
  const download = async (args, exec) => {
    if (companion)
      fail(
        '当前 Chrome 分组通路尚不提供受宿主授权的下载保存；请在可见页面手动下载。',
        'BROWSER_UNSUPPORTED',
      )
    const state = current()
    const entry = refOf(state, args.ref, 'click')
    appAllowed()
    const root = await destination(args.destination_root, exec)
    active(exec)
    await beforeMutation(state, 'browser_download', [entry], exec)
    const page = pageOf(state)
    let onDownload, onAbort, timer
    const pending = new Promise((resolve, reject) => {
      onDownload = (item) => resolve(item)
      onAbort = () => reject(Object.assign(new Error('操作已取消。'), { code: 'ABORTED' }))
      page.on('download', onDownload)
      exec?.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => reject(new Error('等待下载超时。')), 15000)
      if (exec?.signal?.aborted) onAbort()
    })
    let item
    let stream
    let transferAbort
    let transferTimer
    let file
    let path
    let created = false
    let bytes = 0
    try {
      const received = await Promise.all([
        pending,
        entry.handle.click({ timeout: 5000, noWaitAfter: true }),
      ])
      item = received[0]
      active(exec)
      const suggested = item.suggestedFilename()
      // eslint-disable-next-line no-control-regex -- Reject control characters in download names.
      const unsafeDownloadCharacters = /[\\/\x00]/
      if (
        typeof suggested !== 'string' ||
        !suggested ||
        basename(suggested) !== suggested ||
        unsafeDownloadCharacters.test(suggested) ||
        ['.', '..'].includes(suggested)
      )
        fail('下载文件名不安全，已拒绝保存。')
      // Recheck the canonical parent after the page/download event await.
      if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
        fail('下载目录在等待期间已变化。')
      active(exec)
      path = join(root, suggested)
      file = await openFile(path, 'wx', 0o600)
      created = true
      active(exec)
      clearTimeout(timer)
      let rejectTransfer
      const interrupted = new Promise((_, reject) => {
        rejectTransfer = reject
      })
      const interrupt = (code, message) => {
        const error = Object.assign(new Error(message), { code })
        stream?.destroy?.(error)
        void item.cancel().catch(() => {})
        rejectTransfer(error)
      }
      transferAbort = () => interrupt('ABORTED', '操作已取消。')
      exec?.signal?.addEventListener('abort', transferAbort, { once: true })
      transferTimer = setTimeout(
        () => interrupt('DOWNLOAD_TIMEOUT', '下载数据流超过15秒上限。'),
        15000,
      )
      if (exec?.signal?.aborted) transferAbort()
      stream = await Promise.race([item.createReadStream(), interrupted])
      if (!stream || typeof stream.destroy !== 'function') fail('下载数据流契约不可验证。')
      active(exec)
      for await (const chunk of stream) {
        active(exec)
        bytes += chunk.length
        if (bytes > maxFileBytes) fail('下载超过10MiB上限，已取消。')
        await file.writeFile(chunk, { signal: exec?.signal })
      }
      active(exec)
      if (await item.failure()) fail('下载失败。')
      active(exec)
      await file.close()
      file = null
      active(exec)
      return result({ message: '下载已保存为新文件。', savedFile: path, bytes })
    } catch (error) {
      if (item) await item.cancel().catch(() => {})
      if (file) await file.close().catch(() => {})
      if (created) await unlink(path).catch(() => {})
      throw error
    } finally {
      clearTimeout(timer)
      clearTimeout(transferTimer)
      exec?.signal?.removeEventListener('abort', transferAbort)
      page.off('download', onDownload)
      exec?.signal?.removeEventListener('abort', onAbort)
    }
  }
  const close = async (_args, exec) => {
    const state = getSessionState().browser
    if (!state?.owned || state.backend !== backend) fail('没有本会话拥有的浏览器资源。')
    active(exec)
    let outcome
    if (state.dispose) outcome = await state.dispose()
    else {
      await state.context.close()
      await state.browser.close()
    }
    state.untrack?.()
    getSessionState().browser = null
    return result({
      message: companion
        ? `本次 Chrome 控制已释放，页面保留；原有浏览器仍在运行。${outcome?.groupCleanup?.complete === true ? '本次己方标签已取消分组。' : ''}${outcome?.warning || ''}`
        : '本会话独立浏览器已关闭。',
      ...(companion && outcome?.groupCleanup ? { groupCleanup: outcome.groupCleanup } : {}),
      ...(outcome?.warning ? { warning: outcome.warning } : {}),
    })
  }
  const capabilities = async () =>
    result({
      backend,
      isolated: !companion,
      headless: companion ? false : cfg.browserHeadless !== false,
      ...(companion
        ? {
            scope: 'session-owned-tab-group',
            background: true,
            focusPolicy: 'preserve-user-focus',
            releasePolicy: 'ungroup-preserve-tabs',
            transportConcurrency: 'parallel-rpc',
            visibleIndicator: 'extension-badge-and-popup',
            stopControl: 'extension-popup',
            requiresCompanionExtension: true,
          }
        : {}),
      tabs: ['list', 'new', 'select', 'close', 'open_link'],
      backgroundLinkMode: 'explicit-href-navigation',
      history: ['back', 'forward', 'reload'],
      actions: [
        'click',
        'type',
        'select',
        'key',
        'hover',
        'right_click',
        'double_click',
        'drag',
        'scroll',
        'dialog',
        'screenshot',
      ],
      reads: ['query', 'scope_ref', 'continuation'],
      files: {
        upload:
          !companion &&
          ['readBytes', 'processPathFromHostPath', 'resolve', 'stat', 'lstat'].every(
            (name) => typeof hostFS()?.[name] === 'function',
          ),
        download:
          !companion && Boolean((ctx?.get?.('sandboxPolicy') || ctx?.sandboxPolicy)?.resolve),
        maxBytes: maxFileBytes,
      },
      existingUserProfile: companion,
    })
  const safe =
    (fn) =>
    async (args = {}, exec) => {
      let page, onDialog
      const owner = getSessionState()
      const cancelCompanion = () => {
        const state = owner.browser
        if (!companion) return
        owner.controlStopped = true
        if (!state?.owned || state.backend !== backend) return
        state.stopped = true
        invalidate(state)
        void state.dispose?.().catch(() => {})
      }
      if (companion && fn !== capabilities)
        exec?.signal?.addEventListener('abort', cancelCompanion, { once: true })
      try {
        active(exec)
        const state = getSessionState().browser
        if (state?.pendingInteraction && ![dialog, close, capabilities].includes(fn))
          fail('页面存在待处理对话框，请先browser_dialog。')
        if (state?.backend === backend && [click, pointer, key, select, type].includes(fn)) {
          page = pageOf(state)
          const appeared = new Promise((resolve) => {
            onDialog = () => resolve({ dialog: true })
            page.on('dialog', onDialog)
          })
          const running = Promise.resolve().then(() => fn(args, exec))
          const outcome = await Promise.race([running.then((value) => ({ value })), appeared])
          if (outcome.dialog) {
            active(exec)
            state.pendingInteraction = running.catch(() => undefined)
            return result({
              message: '操作已触发网页对话框，请browser_dialog检查并处理。',
              dialogPending: true,
            })
          }
          return outcome.value
        }
        return await fn(args, exec)
      } catch (error) {
        return {
          ok: false,
          result: JSON.stringify({
            message: clean(error.message),
            code: error.code || 'PLAYWRIGHT_ERROR',
          }),
        }
      } finally {
        exec?.signal?.removeEventListener('abort', cancelCompanion)
        if (page && onDialog) page.off('dialog', onDialog)
        await releaseRetired(getSessionState().browser)
      }
    }
  return Object.fromEntries(
    Object.entries({
      open,
      observe,
      navigate,
      click,
      type,
      scroll,
      select,
      pointer,
      key,
      tabs,
      history,
      dialog,
      screenshot,
      upload,
      download,
      close,
      capabilities,
    }).map(([name, fn]) => [name, safe(fn)]),
  )
}
