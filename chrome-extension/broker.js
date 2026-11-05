/** A deliberately small, owner-scoped CDP browser implemented with chrome.debugger.
 * The native host cannot enumerate or attach the user's pre-existing tabs.
 */
export const NATIVE_HOST = 'com.dsh.computer_use'
export const CAPABILITIES = Object.freeze({ existingUserProfile: true, visible: true, background: true, focusPolicy: 'preserve-user-focus', releasePolicy: 'ungroup-preserve-tabs', tabGroups: true, upload: false, download: false })

const ROOT_METHODS = new Set(['Browser.getVersion', 'Browser.getWindowForTarget', 'Browser.getWindowBounds', 'Target.getBrowserContexts', 'Target.getTargets', 'Target.getTargetInfo', 'Target.setDiscoverTargets', 'Target.setAutoAttach', 'Target.createTarget', 'Target.closeTarget', 'Target.activateTarget', 'Target.attachToTarget', 'Target.attachToBrowserTarget', 'Target.detachFromTarget'])
const PAGE_METHODS = new Set([
  'Page.enable', 'Page.disable', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.createIsolatedWorld', 'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument', 'Page.navigate', 'Page.reload', 'Page.stopLoading', 'Page.bringToFront', 'Page.captureScreenshot', 'Page.setLifecycleEventsEnabled', 'Page.handleJavaScriptDialog', 'Page.getNavigationHistory', 'Page.navigateToHistoryEntry',
  'Runtime.enable', 'Runtime.disable', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.getProperties', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup', 'Runtime.addBinding', 'Runtime.removeBinding', 'Runtime.runIfWaitingForDebugger',
  'DOM.enable', 'DOM.disable', 'DOM.describeNode', 'DOM.getDocument', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.resolveNode', 'DOM.requestNode', 'DOM.getContentQuads', 'DOM.getBoxModel', 'DOM.scrollIntoViewIfNeeded', 'DOM.getNodeForLocation', 'DOM.focus',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchTouchEvent', 'Input.synthesizeScrollGesture', 'Input.synthesizeTapGesture',
  'Network.enable', 'Network.disable', 'Network.setCacheDisabled', 'Network.setBypassServiceWorker', 'Network.setExtraHTTPHeaders',
  'Log.enable', 'Log.disable', 'Accessibility.enable', 'Accessibility.disable', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree', 'Accessibility.queryAXTree', 'Accessibility.getRootAXNode', 'Accessibility.getChildAXNodes', 'Accessibility.getAXNodeAndAncestors',
  'Emulation.setFocusEmulationEnabled', 'Emulation.setEmulatedMedia', 'Emulation.setTouchEmulationEnabled', 'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setDefaultBackgroundColorOverride', 'Emulation.setScrollbarsHidden',
  'Debugger.enable', 'Debugger.disable', 'Debugger.setAsyncCallStackDepth', 'Debugger.setBlackboxPatterns', 'Performance.enable', 'Performance.disable', 'Performance.getMetrics', 'Target.setAutoAttach',
])
const FORBIDDEN_HEADERS = /^(?:cookie|set-cookie|authorization|proxy-authorization)$/i
const SAFE_EVENTS = /^(?:Page|Runtime|DOM|Input|Log|Accessibility|Emulation|Debugger|Performance)\./
const NETWORK_EVENTS = new Set(['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Network.requestServedFromCache'])
const ownKey = (owner) => typeof owner === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(owner)
// eslint-disable-next-line no-control-regex -- Strip control characters from visible group titles.
const cleanTitle = (value) => String(value || '浏览器任务').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 50)
function refused(message, code = 'CHROME_SCOPE_REFUSED') { const error = new Error(message); error.code = code; throw error }
function safeURL(value) {
  const parsed = new URL(value || 'about:blank')
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.href !== 'about:blank') || parsed.username || parsed.password) refused('Only ordinary HTTP(S) pages and about:blank may be opened.')
  return parsed.href
}
function scrubEvent(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((entry) => scrubEvent(entry, depth + 1))
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (['postData', 'postDataEntries', 'associatedCookies', 'blockedCookies', 'headersText', 'requestHeadersText'].includes(key)) continue
    if (key === 'headers' && item && typeof item === 'object') result[key] = Object.fromEntries(Object.entries(item).filter(([name]) => !FORBIDDEN_HEADERS.test(name)))
    else result[key] = scrubEvent(item, depth + 1)
  }
  return result
}

export function createChromeBroker(api, { emit = () => {}, onStatus = () => {}, userAgent = 'Chrome/156.0.0.0', uuid = () => crypto.randomUUID(), initialBlockedOwners = [] } = {}) {
  const sessions = new Map()
  const blockedOwners = new Set(initialBlockedOwners.filter(ownKey))
  const tabs = new Map()
  const debuggerSessions = new Map()
  const eventQueues = new Map()
  const listeners = []
  const pendingEvents = new Set()
  let generation = 0
  const track = (promise) => { pendingEvents.add(promise); promise.catch(() => {}).finally(() => pendingEvents.delete(promise)); return promise }
  const notify = () => { try { onStatus(snapshot()) } catch {} }
  function snapshot() { return { capabilities: CAPABILITIES, sessions: [...sessions.values()].map((entry) => ({ owner: entry.owner, title: entry.title, groupId: entry.groupId, tabCount: entry.tabs.size, stopped: entry.stopped, closing: entry.closing, reason: entry.reason || null, ...(entry.groupCleanup ? { groupCleanup: entry.groupCleanup } : {}) })), blockedOwners: [...blockedOwners] } }
  const sessionFor = (owner, { allowStopped = false } = {}) => {
    if (!ownKey(owner)) refused('Invalid session owner.')
    const session = sessions.get(owner)
    if (!session) refused('Open an owner session first.')
    if (!allowStopped && (session.stopped || blockedOwners.has(owner))) refused('Control was stopped. Resume explicitly in the extension popup.', 'CHROME_CONTROL_STOPPED')
    return session
  }
  const targetInfo = (entry) => ({ targetId: entry.targetId, browserContextId: `dsh-context-${entry.owner}`, type: 'page', title: '', url: entry.url || 'about:blank', attached: Boolean(entry.sessionId), canAccessOpener: false, ...(entry.openerTargetId ? { openerId: entry.openerTargetId } : {}) })
  const browserInfo = (session) => ({ targetId: `dsh-browser-${session.owner}`, type: 'browser', title: 'DSH scoped Chrome', url: '', attached: true, canAccessOpener: false })
  const cdpEvent = (session, message) => emit({ event: 'cdp', owner: session.owner, message })
  function assertActive(session, entry, expectedGeneration = session.generation) {
    if (sessions.get(session.owner) !== session || session.generation !== expectedGeneration || session.closing || session.stopped || blockedOwners.has(session.owner)) refused('Control was stopped or the session changed.', 'CHROME_CONTROL_STOPPED')
    if (entry === undefined) return
    if (!entry || entry.owner !== session.owner || !session.tabs.has(entry.tabId) || tabs.get(entry.tabId) !== entry) refused('Tab is not owned by this session.')
  }
  function assertEntry(session, entry, expectedGeneration) {
    assertActive(session, undefined, expectedGeneration)
    if (!entry || entry.owner !== session.owner || !session.tabs.has(entry.tabId) || tabs.get(entry.tabId) !== entry) refused('Tab is not owned by this session.')
  }
  async function checkTab(session, entry, expectedGeneration = session.generation) {
    assertEntry(session, entry, expectedGeneration)
    let current
    try { current = await api.tabs.get(entry.tabId) } catch {
      assertEntry(session, entry, expectedGeneration)
      void stop(session.owner, 'An owned tab was closed.')
      refused('Owned tab no longer exists.')
    }
    assertEntry(session, entry, expectedGeneration)
    const expectedGroup=entry.provisioning?entry.pendingGroupId:session.groupId
    const expectedWindow=entry.provisioning?entry.pendingWindowId:session.windowId
    if (current.groupId !== expectedGroup || current.windowId !== expectedWindow) { entry.scopeRevoked = true; void stop(session.owner, 'An owned tab was moved outside its group or window.'); refused('Owned tab left its dedicated group.') }
    return current
  }
  // CDP clients can request activation while preparing an input action. Accept
  // that protocol operation without changing the user's selected tab/window.
  // Input and DOM operations are already scoped to the debugger target.
  async function acknowledgeActivation(session, entry, expectedGeneration = session.generation) {
    await checkTab(session, entry, expectedGeneration)
    assertEntry(session, entry, expectedGeneration)
  }
  const cleanupSummary = () => ({ ungroupedTabs: 0, preservedOutsideScope: 0, failedTabs: 0, complete: true })
  const countCleanup = (summary, outcome) => {
    if (outcome === 'ungrouped') summary.ungroupedTabs++
    else if (outcome === 'failed') { summary.failedTabs++; summary.complete = false }
    else if (outcome === 'outside-scope') summary.preservedOutsideScope++
  }
  const cleanupResult = (summary) => ({ groupCleanup: summary, ...(summary.failedTabs ? { warning: '控制已释放，但部分任务页面未能退出分组。' } : {}) })
  const ownsEntry = (session, entry) => entry?.owner === session.owner && tabs.get(entry.tabId) === entry && session.tabs.has(entry.tabId)
  async function ungroupOwned(session, entry, stillCurrent) {
    if (!stillCurrent() || !ownsEntry(session, entry)) return 'superseded'
    if (entry.groupReleased) return 'ungrouped'
    if (entry.ungroupTask) {
      await entry.ungroupTask
      // A newer Stop/close can supersede the generation which owned the pending
      // read. Recheck under this generation rather than trusting that old read.
      return ungroupOwned(session, entry, stillCurrent)
    }
    const run = async () => {
      let current
      try { current = await api.tabs.get(entry.tabId) }
      catch { return !stillCurrent() || !ownsEntry(session, entry) ? 'superseded' : 'failed' }
      if (!stillCurrent() || !ownsEntry(session, entry)) return 'superseded'
      if (entry.scopeRevoked || current?.groupId !== session.groupId || current?.windowId !== session.windowId) return 'outside-scope'
      // Single-tab get -> scope/generation check -> ungroup, without a batch
      // snapshot. Chrome provides no compare-and-swap for tab group membership.
      entry.intentionalUngroup = true
      try {
        await api.tabs.ungroup(entry.tabId)
        entry.groupReleased = true
        return 'ungrouped'
      } catch { return 'failed' }
      finally { entry.intentionalUngroup = false }
    }
    const pending = run()
    entry.ungroupTask = pending
    try { return await pending }
    finally { if (entry.ungroupTask === pending) entry.ungroupTask = null }
  }
  function forgetEntries(session, entries) {
    for (const entry of entries) {
      if (!ownsEntry(session, entry)) continue
      tabs.delete(entry.tabId)
      session.tabs.delete(entry.tabId)
    }
  }
  async function attach(session, entry, expectedGeneration = session.generation) {
    await checkTab(session, entry, expectedGeneration)
    assertEntry(session, entry, expectedGeneration)
    if (entry.sessionId) return entry.sessionId
    entry.intentionalDetach = false
    try {
      assertEntry(session, entry, expectedGeneration)
      if(!entry.debuggerAttached){
        const pending = api.debugger.attach({ tabId: entry.tabId }, '1.3')
        entry.attachPending = pending
        await pending
        entry.attachPending = null
        entry.debuggerAttached = true
      }
      await checkTab(session, entry, expectedGeneration)
      assertEntry(session, entry, expectedGeneration)
      const info = await api.debugger.sendCommand({ tabId: entry.tabId }, 'Target.getTargetInfo', {})
      await checkTab(session, entry, expectedGeneration)
      assertEntry(session, entry, expectedGeneration)
      if (!info?.targetInfo?.targetId) refused('Chrome did not identify the owned target.')
      entry.targetId = info.targetInfo.targetId
      entry.sessionId = `dsh-page-${uuid()}`
      debuggerSessions.set(entry.sessionId, { entry, actualSessionId: null })
      if (session.discover) { assertEntry(session, entry, expectedGeneration); cdpEvent(session, { method: 'Target.targetCreated', params: { targetInfo: targetInfo(entry) } }) }
      assertEntry(session, entry, expectedGeneration)
      cdpEvent(session, { method: 'Target.attachedToTarget', params: { sessionId: entry.sessionId, targetInfo: targetInfo(entry), waitingForDebugger: false } })
      return entry.sessionId
    } catch (error) {
      entry.attachPending = null
      await detach(entry)
      throw error
    }
  }
  function detach(entry) {
    if (entry.detaching) return entry.detaching
    const ids = [...debuggerSessions].filter(([, value]) => value.entry === entry).map(([id]) => id)
    for (const id of ids) debuggerSessions.delete(id)
    entry.intentionalDetach = true
    entry.sessionId = null
    if (!entry.debuggerAttached || tabs.get(entry.tabId) !== entry) return Promise.resolve()
    entry.debuggerAttached = false
    let pending
    try { pending = Promise.resolve(api.debugger.detach({ tabId: entry.tabId })).catch(() => {entry.debuggerAttached=true}) } catch { entry.debuggerAttached=true;pending = Promise.resolve() }
    const finished = pending.finally(() => { if (entry.detaching === finished) entry.detaching = null })
    entry.detaching = finished
    return finished
  }
  async function createPage(session, params = {}, opener, expectedGeneration = session.generation) {
    assertActive(session, undefined, expectedGeneration)
    if (params.browserContextId || params.newWindow || params.enableBeginFrameControl) refused('Only new tabs in the dedicated regular Chrome group are supported.')
    const url = safeURL(params.url)
    let tab
    if (opener) tab = opener
    else {
      assertActive(session, undefined, expectedGeneration)
      tab = await api.tabs.create({ url, active: false, ...(Number.isInteger(session.windowId) ? { windowId: session.windowId } : {}) })
    }
    const entry = { owner: session.owner, tabId: tab.id, targetId: `pending-${tab.id}`, url, provisioning: true, pendingGroupId:tab.groupId??-1, pendingWindowId:tab.windowId, sessionId: null, intentionalDetach: false, debuggerAttached: false, attachPending: null, detaching: null, openerTargetId: opener ? tabs.get(opener.openerTabId)?.targetId : null }
    if (!Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) refused('Chrome returned an unverifiable tab.')
    // A tab returned after STOP is not adopted or mutated; it remains visible to the user.
    assertActive(session, undefined, expectedGeneration)
    session.tabs.add(tab.id); tabs.set(tab.id, entry)
    try {
      assertEntry(session, entry, expectedGeneration)
      if (session.windowId === null) session.windowId = tab.windowId
      if (tab.windowId !== session.windowId) {
        if (!opener) refused('New tab appeared in an unexpected Chrome window.')
        await checkTab(session, entry, expectedGeneration)
        assertEntry(session, entry, expectedGeneration)
        await api.tabs.move(tab.id, { windowId: session.windowId, index: -1 })
        assertEntry(session, entry, expectedGeneration)
        entry.pendingWindowId=session.windowId
      }
      await checkTab(session, entry, expectedGeneration)
      assertEntry(session, entry, expectedGeneration)
      const groupId = await api.tabs.group({ tabIds: [tab.id], ...(session.groupId === null ? { createProperties: { windowId: session.windowId } } : { groupId: session.groupId }) })
      assertEntry(session, entry, expectedGeneration)
      if (session.groupId === null) session.groupId = groupId
      if (groupId !== session.groupId) refused('Chrome group identity changed.')
      entry.pendingGroupId=groupId;entry.pendingWindowId=session.windowId
      entry.provisioning = false
      await checkTab(session, entry, expectedGeneration)
      assertEntry(session, entry, expectedGeneration)
      await api.tabGroups.update(groupId, { title: `DSH · ${session.title}`, color: 'purple' })
      await checkTab(session, entry, expectedGeneration)
      await attach(session, entry, expectedGeneration)
      assertEntry(session, entry, expectedGeneration)
      notify()
      return entry
    } catch (error) {
      await detach(entry)
      // STOP relinquishes pages. Failure cleanup may remove only an exact still-owned
      // new tab while this original session generation remains active.
      if (!opener && sessions.get(session.owner)===session && session.generation===expectedGeneration && !session.stopped && !session.closing && !blockedOwners.has(session.owner)) {
        const current=await api.tabs.get(tab.id).catch(()=>null)
        if(current?.groupId===session.groupId&&current?.windowId===session.windowId){
          try { assertEntry(session,entry,expectedGeneration); entry.intentionalClose=true; await api.tabs.remove(tab.id) } catch {}
        }
      }
      if(tabs.get(tab.id)===entry){session.tabs.delete(tab.id);tabs.delete(tab.id)}
      throw error
    }
  }
  async function stop(owner, reason = 'Stopped by the user.') {
    const session = sessionFor(owner, { allowStopped: true })
    blockedOwners.add(owner); session.stopped = true; session.reason = String(reason).slice(0, 160)
    const stoppedGeneration=session.generation=++generation
    const stillStopped=()=>sessions.get(owner)===session&&session.generation===stoppedGeneration&&session.stopped
    // Notify and cancel the agent immediately. Chrome detach may fail or stall,
    // but it must never delay the stop latch, toolbar badge or host cancellation.
    try { emit({ event: 'stopped', owner, reason: session.reason }) } catch {}
    notify()
    const entries=[...session.tabs].map((id)=>tabs.get(id)).filter(Boolean)
    const summary=session.groupCleanup || cleanupSummary()
    const cleanup=Promise.allSettled(entries.map(async(entry)=>{
      if(entry.attachPending)await Promise.resolve(entry.attachPending).catch(()=>{})
      await detach(entry)
      countCleanup(summary, await ungroupOwned(session, entry, stillStopped))
    })).then(async()=>{
      if (!stillStopped()) return
      // The stopped owner loses all target authority even when Chrome refuses
      // a UI cleanup. A warning describes that failure; control is never revived.
      forgetEntries(session, entries)
      session.groupId=null;session.windowId=null;session.groupCleanup=summary
      notify()
    })
    session.cleanup=cleanup
    track(cleanup)
    return { stopped: true }
  }
  async function resume(owner) {
    if(ownKey(owner)&&blockedOwners.has(owner)&&!sessions.has(owner)){blockedOwners.delete(owner);notify();return {resumed:true}}
    const session = sessionFor(owner, { allowStopped: true })
    const expectedGeneration=session.generation
    const stillStopped=()=>{if(sessions.get(owner)!==session||session.generation!==expectedGeneration||!session.stopped||!blockedOwners.has(owner))refused('The stopped session changed. Read the current popup state before resuming.')}
    stillStopped()
    await session.cleanup
    stillStopped()
    await session.closeTask
    stillStopped()
    // This method is exposed only to the trusted popup, never to native messages.
    for (const tabId of session.tabs) { const entry=tabs.get(tabId);const tab = await api.tabs.get(tabId);stillStopped();if(tabs.get(tabId)!==entry||entry?.owner!==owner||!session.tabs.has(tabId))refused('Owned tabs changed while resuming.');if (tab.groupId !== session.groupId || tab.windowId !== session.windowId) refused('Move changed tabs back before resuming, or start a new task.') }
    if(session.closing){session.groupId=null;session.windowId=null;session.closing=false}
    session.closeTask=null;session.cleanup=null
    stillStopped()
    blockedOwners.delete(owner); session.stopped = false; session.reason = null;session.generation=++generation
    session.groupCleanup=null
    const resumedGeneration=session.generation
    if (Number.isInteger(session.groupId)){assertActive(session,undefined,resumedGeneration);await api.tabGroups.update(session.groupId, { title: `DSH · ${session.title}`, color: 'purple' });assertActive(session,undefined,resumedGeneration)}
    // The prior transport has been revoked. A subsequent session.open may reuse this session.
    notify(); return { resumed: true }
  }
  async function close(owner, { keepTabs = true } = {}) {
    if (!ownKey(owner)) refused('Invalid session owner.')
    if (!sessions.has(owner)) return { closed: true, keptTabs: keepTabs, alreadyClosed: true }
    const session = sessionFor(owner, { allowStopped: true })
    if(session.closeTask)return session.closeTask
    session.closing = true
    const closedGeneration=session.generation=++generation
    notify()
    const stillClosing=()=>sessions.get(owner)===session&&session.generation===closedGeneration&&session.closing
    const interrupted=async()=>{
      // A newer STOP preserves the remaining pages, then relinquishes their
      // bookkeeping so explicit popup resume can start a fresh dedicated group.
      await session.cleanup
      if(sessions.get(owner)===session&&session.closing&&session.stopped){
        for(const tabId of session.tabs){if(tabs.get(tabId)?.owner===owner)tabs.delete(tabId)}
        session.tabs.clear();notify()
      }
      return {closed:false,keptTabs:true,...(session.groupCleanup ? cleanupResult(session.groupCleanup) : {})}
    }
    const run=async()=>{
      const summary=session.groupCleanup || cleanupSummary()
      for (const tabId of [...session.tabs]) {
        const entry = tabs.get(tabId)
        if (!entry||entry.owner!==owner) continue
        if(entry.attachPending)await Promise.resolve(entry.attachPending).catch(()=>{})
        if(!stillClosing())return interrupted()
        await detach(entry)
        if(!stillClosing())return interrupted()
        let current
        try { current = await api.tabs.get(tabId) } catch {}
        if(!stillClosing())return interrupted()
        if(tabs.get(tabId)!==entry||!session.tabs.has(tabId))continue
        if (!keepTabs && current?.groupId === session.groupId && current?.windowId === session.windowId) { entry.intentionalClose = true; await api.tabs.remove(tabId).catch(() => {});if(!stillClosing())return interrupted() }
        if(keepTabs){countCleanup(summary,await ungroupOwned(session,entry,stillClosing));if(!stillClosing())return interrupted()}
        if(tabs.get(tabId)===entry)tabs.delete(tabId)
      }
      if(!stillClosing())return interrupted()
      session.tabs.clear()
      session.groupId=null;session.windowId=null;session.groupCleanup=summary
      if (!blockedOwners.has(owner)) sessions.delete(owner)
      notify(); return { closed: true, keptTabs: keepTabs, ...cleanupResult(summary) }
    }
    session.closeTask=run()
    return session.closeTask
  }
  const findTarget = (session, targetId) => [...session.tabs].map((id) => tabs.get(id)).find((entry) => entry?.targetId === targetId)
  async function rootCommand(session, method, params, expectedGeneration = session.generation) {
    assertActive(session, undefined, expectedGeneration)
    if (!ROOT_METHODS.has(method)) refused(`Browser command is not supported: ${method}`)
    if (method === 'Browser.getVersion') return { protocolVersion: '1.3', product: /(?:Chrome|Chromium)\/[^ ]+/.exec(userAgent)?.[0] || 'Chrome/156.0.0.0', revision: '', userAgent, jsVersion: '' }
    if (method === 'Target.getBrowserContexts') return { browserContextIds: [] }
    if (method === 'Target.getTargets') { const infos=[];for(const id of session.tabs){const entry=tabs.get(id);await checkTab(session,entry,expectedGeneration);assertEntry(session,entry,expectedGeneration);infos.push(targetInfo(entry))}return { targetInfos: infos } }
    if (method === 'Target.getTargetInfo') { if (!params.targetId) return { targetInfo: browserInfo(session) }; const entry=findTarget(session,params.targetId);await checkTab(session,entry,expectedGeneration);assertEntry(session,entry,expectedGeneration);return { targetInfo: targetInfo(entry) } }
    if (method === 'Target.setDiscoverTargets') { session.discover = params.discover === true; if(session.discover)for(const id of session.tabs){const entry=tabs.get(id);await checkTab(session,entry,expectedGeneration);assertEntry(session,entry,expectedGeneration);cdpEvent(session,{method:'Target.targetCreated',params:{targetInfo:targetInfo(entry)}})}return {} }
    if (method === 'Target.setAutoAttach') { session.autoAttach=params.autoAttach===true;if(session.autoAttach)for(const id of session.tabs)await attach(session,tabs.get(id),expectedGeneration);return {} }
    if (method === 'Target.createTarget') { const entry=await createPage(session,params,undefined,expectedGeneration);assertEntry(session,entry,expectedGeneration);return { targetId:entry.targetId } }
    if (method === 'Target.attachToBrowserTarget') return { sessionId:`dsh-root-${session.owner}` }
    if (method === 'Target.detachFromTarget') { if(params.sessionId===`dsh-root-${session.owner}`)return {};const mapped=debuggerSessions.get(params.sessionId);await checkTab(session,mapped?.entry,expectedGeneration);assertEntry(session,mapped.entry,expectedGeneration);if(mapped.actualSessionId){await api.debugger.sendCommand({tabId:mapped.entry.tabId},'Target.detachFromTarget',{sessionId:mapped.actualSessionId});assertEntry(session,mapped.entry,expectedGeneration);debuggerSessions.delete(params.sessionId)}else await detach(mapped.entry);return {} }
    if (method === 'Browser.getWindowBounds') { if(params.windowId!==session.windowId)refused('Unowned window.');const win=await api.windows.get(session.windowId);assertActive(session,undefined,expectedGeneration);return {bounds:{left:win.left,top:win.top,width:win.width,height:win.height,windowState:win.state||'normal'}} }
    const entry=findTarget(session,params.targetId)
    await checkTab(session,entry,expectedGeneration)
    assertEntry(session,entry,expectedGeneration)
    if(method==='Target.attachToTarget')return {sessionId:await attach(session,entry,expectedGeneration)}
    if(method==='Target.activateTarget'){await acknowledgeActivation(session,entry,expectedGeneration);return {}}
    if(method==='Target.closeTarget'){assertEntry(session,entry,expectedGeneration);entry.intentionalClose=true;await api.tabs.remove(entry.tabId);assertActive(session,undefined,expectedGeneration);return {success:true}}
    if(method==='Browser.getWindowForTarget'){const win=await api.windows.get(session.windowId);assertEntry(session,entry,expectedGeneration);return {windowId:session.windowId,bounds:{left:win.left,top:win.top,width:win.width,height:win.height,windowState:win.state||'normal'}}}
    refused(`Unsupported browser command: ${method}`)
  }
  async function sendCDP(owner, message) {
    const session=sessionFor(owner)
    const expectedGeneration=session.generation
    if (!message || !Number.isInteger(message.id) || typeof message.method!=='string' || (message.params!==undefined&&(!message.params||typeof message.params!=='object'||Array.isArray(message.params)))) refused('Malformed CDP request.')
    const { id, method, params = {}, sessionId }=message
    try {
      let value
      if (!sessionId || sessionId===`dsh-root-${owner}`) value=await rootCommand(session,method,params,expectedGeneration)
      else {
        const mapped=debuggerSessions.get(sessionId)
        await checkTab(session,mapped?.entry,expectedGeneration)
        assertEntry(session,mapped.entry,expectedGeneration)
        if(method==='Target.getTargetInfo'){if(params.targetId&&params.targetId!==mapped.entry.targetId)refused('Unowned target.');value={targetInfo:targetInfo(mapped.entry)}}
        else if(method==='Browser.getWindowForTarget')value=await rootCommand(session,method,{targetId:mapped.entry.targetId},expectedGeneration)
        else {
        if(!PAGE_METHODS.has(method))refused(`Page command is not supported: ${method}`)
        if(method==='Page.navigate')safeURL(params.url)
        if(method==='Network.setExtraHTTPHeaders'&&Object.keys(params.headers||{}).some((key)=>FORBIDDEN_HEADERS.test(key)))refused('Sensitive headers cannot be exported or overwritten.')
        if(method==='Page.bringToFront'){await acknowledgeActivation(session,mapped.entry,expectedGeneration);value={}}
        else {assertEntry(session,mapped.entry,expectedGeneration);if(debuggerSessions.get(sessionId)!==mapped)refused('Debugger session was revoked.');value=await api.debugger.sendCommand({tabId:mapped.entry.tabId,...(mapped.actualSessionId?{sessionId:mapped.actualSessionId}:{})},method,params)}
        await checkTab(session,mapped.entry,expectedGeneration)
        }
      }
      assertActive(session,undefined,expectedGeneration)
      return {id,result:value||{},...(sessionId?{sessionId}:{})}
    } catch(error){return {id,error:{code:-32000,message:String(error.message||error).slice(0,300)},...(sessionId?{sessionId}:{})}}
  }
  async function handleCommand(command) {
    try {
      if(!command || !['string','number'].includes(typeof command.id) || typeof command.method!=='string')refused('Malformed native request.')
      const params=command.params||{}
      let result
      if(command.method==='session.open'){
        if(!ownKey(params.owner))refused('Invalid owner.')
        if(blockedOwners.has(params.owner))refused('Resume in the extension popup first.','CHROME_CONTROL_STOPPED')
        if(!sessions.has(params.owner))sessions.set(params.owner,{owner:params.owner,title:cleanTitle(params.title),groupId:null,windowId:null,tabs:new Set(),autoAttach:false,discover:false,stopped:false,closing:false,generation:++generation})
        else {const session=sessions.get(params.owner);if(session.closing)refused('Session cleanup is still in progress.');session.title=cleanTitle(params.title||session.title)}
        notify();result={...CAPABILITIES}
      } else if(command.method==='session.close')result=await close(params.owner,params)
      else if(command.method==='session.stop')result=await stop(params.owner)
      else if(command.method==='cdp.send')result=await sendCDP(params.owner,command.params.message)
      else refused('Unsupported native command.')
      return {id:command.id,result}
    }catch(error){return {id:command?.id??null,error:{code:error.code||'CHROME_BRIDGE_ERROR',message:String(error.message||error).slice(0,300)}}}
  }
  const listen=(event,fn)=>{event?.addListener(fn);listeners.push(()=>event?.removeListener(fn))}
  listen(api.debugger.onEvent,(source,method,params={})=>{
    // Preserve Chrome's per-tab CDP event order across the asynchronous scope check.
    const previous=eventQueues.get(source.tabId)||Promise.resolve()
    const queued=previous.catch(()=>{}).then(async()=>{
    const entry=tabs.get(source.tabId);if(!entry)return
    const session=sessions.get(entry.owner);if(!session||session.stopped||entry.provisioning)return
    const expectedGeneration=session.generation
    await checkTab(session,entry,expectedGeneration)
    assertEntry(session,entry,expectedGeneration)
    const parent=[...debuggerSessions].find(([,value])=>value.entry===entry&&value.actualSessionId===(source.sessionId||null))
    if(!parent)return
    let eventParams=params
    if(method==='Target.attachedToTarget'){
      if(!['iframe','worker'].includes(params.targetInfo?.type))return
      const virtualId=`dsh-child-${uuid()}`
      debuggerSessions.set(virtualId,{entry,actualSessionId:params.sessionId})
      eventParams={...params,sessionId:virtualId}
    }else if(method==='Target.detachedFromTarget'){
      const mapped=[...debuggerSessions].find(([,value])=>value.entry===entry&&value.actualSessionId===params.sessionId)
      if(!mapped)return;debuggerSessions.delete(mapped[0]);eventParams={...params,sessionId:mapped[0]}
    }else if(!SAFE_EVENTS.test(method)&&!NETWORK_EVENTS.has(method)&&method!=='Inspector.targetCrashed')return
    assertEntry(session,entry,expectedGeneration)
    cdpEvent(session,{method,params:scrubEvent(eventParams),sessionId:parent[0]})
    })
    eventQueues.set(source.tabId,queued)
    track(queued).finally(()=>{if(eventQueues.get(source.tabId)===queued)eventQueues.delete(source.tabId)}).catch(()=>{})
  })
  listen(api.debugger.onDetach,(source,reason)=>{const entry=tabs.get(source.tabId);if(entry&&!entry.intentionalDetach)track(stop(entry.owner,`Chrome detached control: ${reason||'user interruption'}`))})
  listen(api.tabs.onUpdated,(tabId,change,tab)=>{const entry=tabs.get(tabId);if(!entry||entry.provisioning)return;const session=sessions.get(entry.owner);if(!session)return
    if(tab.groupId!==session.groupId||tab.windowId!==session.windowId){
      if(entry.intentionalUngroup&&tab.groupId===-1&&tab.windowId===session.windowId)return
      entry.scopeRevoked=true
      if(!session.stopped&&!session.closing)track(stop(entry.owner,'An owned tab was moved out of its group.'))
      return
    }
    if(session.stopped||session.closing)return
    if(change.url){entry.url=change.url;if(session.discover)cdpEvent(session,{method:'Target.targetInfoChanged',params:{targetInfo:targetInfo(entry)}})}
  })
  listen(api.tabs.onRemoved,(tabId)=>{const entry=tabs.get(tabId);if(!entry)return;const session=sessions.get(entry.owner);tabs.delete(tabId);session?.tabs.delete(tabId)
    const sessionId=entry.sessionId;for(const [id,value]of debuggerSessions)if(value.entry===entry)debuggerSessions.delete(id)
    if(session){if(sessionId)cdpEvent(session,{method:'Target.detachedFromTarget',params:{sessionId,targetId:entry.targetId}});cdpEvent(session,{method:'Target.targetDestroyed',params:{targetId:entry.targetId}});if(!entry.intentionalClose&&!session.closing&&!session.stopped)track(stop(session.owner,'An owned tab was closed by the user.'));notify()}
  })
  listen(api.tabs.onDetached,(tabId)=>{const entry=tabs.get(tabId);if(entry&&!entry.provisioning){entry.scopeRevoked=true;const session=sessions.get(entry.owner);if(session&&!session.closing&&!session.stopped)track(stop(entry.owner,'An owned tab moved to another window.'))}})
  listen(api.tabs.onCreated,(tab)=>{const opener=tabs.get(tab.openerTabId);if(!opener||tabs.has(tab.id))return;const session=sessions.get(opener.owner);if(!session||session.stopped||session.closing)return;const expectedGeneration=session.generation;track(checkTab(session,opener,expectedGeneration).then(()=>createPage(session,{url:tab.url||'about:blank'},tab,expectedGeneration)).catch(()=>{if(sessions.get(session.owner)===session&&session.generation===expectedGeneration&&!session.stopped&&!session.closing)return stop(session.owner,'A popup could not be safely placed in its group.')}))})
  return {handleCommand,stop,resume,snapshot,async settle(){await Promise.allSettled([...pendingEvents])},async dispose(){for(const remove of listeners)remove();for(const owner of [...sessions.keys()])await close(owner,{keepTabs:true})}}
}
