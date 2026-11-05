/** Session-owned Chromium tools backed by the cua-driver 0.38 browser contract.
 * No user-profile attachment, JavaScript evaluation, arbitrary driver arguments,
 * foreground escalation, or synthetic DOM-event fallback is exposed here.
 */
import { cuaCall, withSession } from './cua.js'
import { getSessionState } from './session.js'

const DANGER = /删除|移除|清空|清倒|格式化|卸载|永久|支付|付款|购买|下单|结账|转账|汇款|提交订单|确认交易|退出登录|注销|登出|\b(?:delete|remove|erase|empty|clear|destroy|format|uninstall|pay|payment|purchase|buy|checkout|transfer|send money|place order|submit order|log\s*out|sign\s*out)\b/i
const PASSWORD = /(?:type\s*=\s*["']?password\b)|密码|口令|密钥|\b(?:password|passphrase|secret|api[ _-]?key)\b/i
const OUT = {
  schema: { type: 'object', additionalProperties: false, properties: {
    ok: { type: 'boolean', required: true }, result: { type: 'string', required: true },
    data: { type: 'object', additionalProperties: true },
    image: { type:'object',additionalProperties:false,properties:{attachmentId:{type:'string',required:true},mediaType:{type:'string',required:true},bytes:{type:'integer',required:true},width:{oneOf:[{type:'integer'},{type:'null'}]},height:{oneOf:[{type:'integer'},{type:'null'}]},name:{type:'string'}} },
  } },
  render: (_args, value) => [{ type: 'text', text: value.result },...(value.image?[{type:'image',attachment:value.image}]:[])],
}

function fail(message) { throw new Error(message) }
function active(exec) { if (exec?.signal?.aborted) fail('操作已取消。') }
function cleanDiagnostic(value) {
  return String(value || '').replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[URL omitted]').slice(0, 600)
}
function success(value) { return { ok: true, result: JSON.stringify(value), data: value } }
function checked(value, tool, phase) {
  if (!value || typeof value !== 'object' || value.isError === true
    || value.effect === 'refused' || value.effect === 'suspected_noop'
    || (value.status && value.status !== 'ok' && value.status !== 'success')) {
    const nested = value?.error || value?.refusal || value?.detail?.error || value?.detail?.refusal
    const code = cleanDiagnostic(value?.code || nested?.code || value?.status || 'invalid_response')
    const message = cleanDiagnostic(value?.reason || value?.message || nested?.reason || nested?.message || '')
    const error = new Error(`${tool}${phase ? ` (${phase})` : ''} 失败：${code}${message ? ` — ${message}` : ''}`)
    error.code = code
    error.tool = tool
    throw error
  }
  return value
}
function urlOf(value) {
  if (typeof value !== 'string' || !value.trim()) fail('需要 url。')
  let url
  try { url = new URL(value) } catch { fail('url 必须是完整的 http/https 地址或 about:blank。') }
  if (!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank') fail('仅允许 http/https 或 about:blank，不能执行脚本或访问本地文件。')
  if (url.username || url.password) fail('url 不得包含用户名或密码。')
  return url.href
}
function safeOrigin(value) {
  try { const url = new URL(value); return url.protocol === 'about:' ? 'about:blank' : url.origin } catch { return '' }
}

function safeURL(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'about:' ? 'about:blank' : `${url.origin}${url.pathname}`
  } catch { return '' }
}
function safeStates(entry) {
  const result = {}
  for (const name of ['checked', 'disabled', 'selected', 'expanded', 'required', 'focused', 'focusable', 'protected']) {
    if (typeof entry.states?.[name] === 'boolean') result[name] = entry.states[name]
  }
  return result
}

/** Injectable controller is also used by fixture tests; callers supply tool scope. */
export function createBrowserController(ctx, cfg = {}, options = {}) {
  if (['playwright', 'chrome-extension'].includes(cfg.browserBackend)) {
    let loaded
    const controller = () => loaded ||= import('./browser-playwright.js').then((module) => module.createPlaywrightController(ctx, cfg, options))
    // Prepare the native companion listener before the user clicks Connect.
    if (cfg.browserBackend === 'chrome-extension') void controller().catch(() => undefined)
    return Object.fromEntries(['open','observe','navigate','click','type','scroll','select','pointer','key','tabs','history','dialog','screenshot','upload','download','close','capabilities'].map((name) => [name, async (...args) => (await controller())[name](...args)]))
  }
  const { call = cuaCall, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options
  const ttlMs = Number.isFinite(cfg.ttlMs) && cfg.ttlMs > 0 ? cfg.ttlMs : 120000
  const allowedApps = Array.isArray(cfg.allowedApps) ? cfg.allowedApps : []
  const invoke = async (tool, args, exec) => {
    active(exec)
    const value = checked(await call(tool, withSession(args)), tool, tool === 'get_browser_state' ? (args.pid ? 'bind' : args.snapshot_format) : undefined)
    active(exec)
    return value
  }
  const readState = async (args, exec) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await invoke('get_browser_state', args, exec)
      } catch (error) {
        // A new isolated native window or a navigation can be ahead of its CDP
        // target. Repeat only this exact read, never guess a target or replay setup,
        // navigation, pointer/text actions, or authorization refusals.
        const notReady = error.code === 'browser_wrong_target_refused' && /no CDP target correlates/i.test(error.message)
        if (!notReady || attempt === 3) throw error
        active(exec)
        await pause(150 * (attempt + 1))
      }
    }
  }
  const current = () => {
    const state = getSessionState().browser
    if (!state?.owned || !Number.isInteger(state.pid) || state.pid <= 0) fail('没有独立浏览器会话：请先调用 browser_open。')
    return state
  }
  const exactWindow = async (state, exec) => {
    const result = await invoke('list_windows', { on_screen_only: false }, exec)
    const match = (result.windows || []).find((win) => win.pid === state.pid && (!state.windowId || win.window_id === state.windowId))
    if (!match || !Number.isInteger(match.window_id) || match.window_id <= 0 || typeof match.app_name !== 'string' || !match.app_name) fail('无法将独立浏览器精确映射到本机窗口，已拒绝；请重新 browser_observe。')
    if (allowedApps.length && !allowedApps.includes(match.app_name)) fail(`区域限制：浏览器应用 "${match.app_name}" 不在 allowedApps 中。`)
    state.windowId = match.window_id
    state.appName = match.app_name
    return match
  }
  const bind = async (state, exec) => {
    await exactWindow(state, exec)
    if (state.targetId && state.tabId) return
    const result = await readState({ pid: state.pid, window_id: state.windowId }, exec)
    if (result.binding_quality !== 'exact' || result.mutation_allowed !== true || result.endpoint_access_class !== 'driver_owned') {
      fail('浏览器未获得精确的 driver_owned 绑定，已拒绝操作；不接管已有用户浏览器。')
    }
    const tab = result.tabs?.find((entry) => entry.active) || result.tabs?.[0]
    if (typeof result.target_id !== 'string' || typeof tab?.tab_id !== 'string') fail('浏览器绑定没有返回可用 tab，请重新观察。')
    state.targetId = result.target_id
    state.tabId = tab.tab_id
  }
  const target = (state) => ({ target_id: state.targetId, tab_id: state.tabId })
  const fresh = (state) => {
    if (!state.observed) fail('请先调用 browser_observe 获取最新网页 ref；每次动作后都需重新观察。')
    if (now() - state.observed.at > ttlMs) {
      state.observed = null
      fail(`网页快照已过期（${Math.round(ttlMs / 1000)} 秒）：请重新 browser_observe。`)
    }
    return state.observed
  }
  const reference = (observed, args, capability) => {
    if (typeof args.ref !== 'string' || !observed.refs.has(args.ref)) fail('ref 不属于本次网页观察，请重新 browser_observe。')
    const entry = observed.refs.get(args.ref)
    if (!(Array.isArray(capability) ? capability : [capability]).some((action) => entry.actions?.includes(action))) fail(`ref 不支持 ${capability} 动作。`)
    if (entry.states?.disabled === true) fail('目标控件当前已禁用。')
    return entry
  }
  const approve = async (toolName, entry, exec) => {
    const label = [entry.name, entry.label].filter(Boolean).join(' ')
    if (!DANGER.test(label) && label && !PASSWORD.test(label)) return
    if (!ctx?.approval || !exec?.agent) fail('目标敏感、危险或语义不明，需要用户审批；当前审批服务不可用。')
    let outcome
    try { outcome = await ctx.approval.request({ agent: exec.agent, toolName, signal: exec.signal, reason: `即将对网页控件「${cleanDiagnostic(label) || '未命名控件'}」执行 ${toolName}，请批准本次操作。` }) } catch { outcome = 'unavailable' }
    active(exec)
    if (outcome !== 'allowed-once') fail(`网页操作未获批准（${outcome}）。`)
  }
  const observe = async (args = {}, exec) => {
    const state = current()
    state.screenshot=null
    const scoped = args.scope_ref !== undefined || args.continuation !== undefined
    if(args.scope_ref!==undefined && !fresh(state).refs.has(args.scope_ref)) fail('scope_ref不是当前快照ref。')
    if(args.continuation!==undefined && args.continuation!==state.continuation) fail('continuation不是本次会话最近一次观察返回值。')
    state.observed = null
    await bind(state, exec)
    // v0.38 DOM refs retain type=password, but semantic_v2 omits that attribute.
    // Conversely DOM refs omit button text. Read DOM for input safety first;
    // use the final semantic snapshot for exact named action refs and approvals.
    const dom = scoped ? {truncated:true,refs:[]} : await readState({ ...target(state), snapshot_format: 'dom_refs_v1', include_screenshot: false }, exec)
    const domComplete = dom.truncated === false && Array.isArray(dom.refs)
    const passwordPresent = !domComplete || dom.refs.some((entry) => PASSWORD.test([entry.label, entry.node, entry.role].filter(Boolean).join(' ')))
    const semantic = await readState({ ...target(state), snapshot_format: 'semantic_v2', include_screenshot: false,...(args.query===undefined?{}:{query:String(args.query)}),...(args.scope_ref===undefined?{}:{scope_ref:String(args.scope_ref)}),...(args.continuation===undefined?{}:{continuation:String(args.continuation)}) }, exec)
    if (semantic.snapshot?.format !== 'semantic_v2' || !Array.isArray(semantic.refs) || typeof semantic.snapshot?.id !== 'string') fail('驱动未返回 semantic_v2 网页快照，请检查 cua-driver 版本。')
    if (semantic.target_id !== state.targetId || semantic.tab_id !== state.tabId) fail('网页快照目标不匹配，已拒绝缓存。')
    const allRefs = [...semantic.refs,...(Array.isArray(semantic.content_refs)?semantic.content_refs:[])].filter((entry) => typeof entry.ref === 'string' && entry.ref.startsWith(`${semantic.snapshot.id}:`))
    const limit = Math.max(1, Math.min(500, Math.floor(cfg.maxElements || 500)))
    const refs = allRefs.slice(0, limit)
    const stringsTruncated = refs.some((entry) => String(entry.name || '').length > 200 || String(entry.role || '').length > 60 || (typeof entry.value === 'string' && entry.value.length > 1000))
    const sensitive = passwordPresent || allRefs.some((entry) => PASSWORD.test([entry.name, entry.label, entry.role].filter(Boolean).join(' ')) || entry.states?.protected === true)
    state.continuation=semantic.snapshot.continuation||null
    state.observed = { at: now(), refs: new Map(refs.map((entry) => [entry.ref, entry])), inputBlocked: sensitive, snapshotId: semantic.snapshot.id }
    return success({
      message: '网页观察完成；动作使用本次 refs，动作后请重新观察。',
      app: state.appName, title: String(semantic.page?.title || '').slice(0, 200), titleComplete: typeof semantic.page?.title==='string' && semantic.page.title.length<=200, origin: safeOrigin(semantic.page?.url), url: safeURL(semantic.page?.url),
      snapshotId: semantic.snapshot.id, ttlMs, inputBlocked: sensitive, continuation:state.continuation,
      complete: semantic.snapshot.complete === true && domComplete && allRefs.length <= refs.length && (semantic.outline?.length || 0) <= 16000 && !stringsTruncated && !sensitive && !scoped && args.query===undefined,
      textComplete: semantic.snapshot.complete === true && domComplete && allRefs.length <= refs.length && (semantic.outline?.length || 0) <= 16000 && !stringsTruncated && !sensitive && !scoped && args.query===undefined,
      ...(sensitive ? { inputBlockReason: '本页有密码/密钥字段或 DOM 检查不完整；0.38 语义快照无法逐 ref 证明字段类型，整页自动输入已暂停。' } : {}),
      outline: sensitive ? '本页含敏感字段或 DOM 检查不完整，已隐藏可能包含输入值的页面摘要；请参考 refs 的角色与名称。' : (typeof semantic.outline === 'string' ? semantic.outline.slice(0, 16000) : ''),
      truncated: allRefs.length > refs.length || (semantic.outline?.length || 0) > 16000 || semantic.snapshot.complete === false,
      refs: refs.map((entry) => ({
        ref: entry.ref, role: String(entry.role || '').slice(0, 60), name: String(entry.name || '').slice(0, 200),
        ...(String(entry.name || '').length > 200 ? { nameTruncated: true } : {}),
        ...(!sensitive && typeof entry.value === 'string' && entry.value.length > 1000 ? { valueTruncated: true } : {}),
        actions: Array.isArray(entry.actions) ? entry.actions.filter((action) => typeof action === 'string').slice(0, 8) : [],
        visibility: String(entry.visibility || '').slice(0, 40), states: safeStates(entry),
        ...(typeof entry.states?.checked === 'boolean' ? { checked: entry.states.checked } : {}),
        ...(typeof entry.states?.disabled === 'boolean' ? { enabled: !entry.states.disabled } : {}),
        ...(!sensitive && !entry.states?.protected && (entry.value === null || ['string', 'number', 'boolean'].includes(typeof entry.value))
          ? { value: typeof entry.value === 'string' ? entry.value.slice(0, 1000) : entry.value } : {}),
      })),
    })
  }
  const navigate = async (args, exec) => {
    const url = urlOf(args.url)
    const state = current()
    await bind(state, exec)
    state.observed = null
    await invoke('browser_navigate', { ...target(state), url }, exec)
    return observe({}, exec)
  }
  const open = async (args = {}, exec) => {
    // Validate before launching any process, including when a caller bypasses schema.
    const url = args.url === undefined ? 'about:blank' : urlOf(args.url)
    let state = getSessionState().browser
    if (!state?.owned) {
      const prepared = await invoke('browser_prepare', {
        allow_launch: true, profile: { mode: 'isolated_new' }, delivery_mode: 'background',
      }, exec)
      if (prepared.prepared !== true || prepared.action !== 'launched_isolated_browser' || (!Number.isInteger(prepared.prepared_pid) || prepared.prepared_pid <= 0)) fail('驱动未启动独立浏览器；请按驱动 setup/权限提示处理，插件不会更改 daemon 授权策略。')
      state = { owned: true, pid: prepared.prepared_pid, windowId: null, targetId: null, tabId: null, observed: null }
      getSessionState().browser = state
    }
    return navigate({ url }, exec)
  }
  const forceApproval=async(toolName,reason,exec)=>{
    if(!ctx?.approval||!exec?.agent)fail('此操作需要用户审批，审批服务不可用。')
    let outcome;try{outcome=await ctx.approval.request({agent:exec.agent,toolName,reason,signal:exec.signal})}catch{outcome='unavailable'}
    active(exec);if(outcome!=='allowed-once')fail(`操作未获批准（${outcome}）。`)
  }
  const click = async (args, exec) => {
    const state=current()
    if(args.ref===undefined){
      const shot=state.screenshot
      if(!shot||shot.tabId!==state.tabId||now()-shot.at>ttlMs)fail('坐标点击需要当前标签页的新鲜browser_screenshot。')
      if(![args.x,args.y].every(Number.isFinite)||args.x<0||args.y<0||args.x>=shot.width||args.y>=shot.height)fail('坐标超出截图范围。')
      await exactWindow(state,exec);await forceApproval('browser_click','按当前浏览器截图像素点击，目标语义未知，请确认本次动作。',exec)
      if(state.screenshot!==shot||now()-shot.at>ttlMs)fail('审批期间截图已失效，请重新截图。')
      state.observed=null;state.screenshot=null
      await invoke('browser_click',{...target(state),x:args.x*shot.scaleX,y:args.y*shot.scaleY,delivery_mode:'background',input_route:'trusted'},exec)
    }else{
      if(args.x!==undefined||args.y!==undefined)fail('ref与坐标必须二选一。')
      const entry=reference(fresh(state),args,'click')
      await exactWindow(state,exec);await approve('browser_click',entry,exec);fresh(state)
      state.observed=null;state.screenshot=null
      await invoke('browser_click',{...target(state),ref:args.ref,delivery_mode:'background',input_route:'trusted'},exec)
    }
    return success({message:'点击已投递，请重新观察验证。'})
  }
  const type = async (args, exec) => {
    if (typeof args.text !== 'string') fail('text 必须是字符串。')
    const state = current()
    const observed = fresh(state)
    const entry = reference(observed, args, 'type')
    if (observed.inputBlocked || PASSWORD.test([entry.name, entry.label, entry.role].join(' ')) || entry.states?.protected) fail('敏感输入保护：本页有密码/密钥字段或 DOM 检查不完整，自动输入已暂停；请由用户输入。')
    await exactWindow(state, exec)
    await approve('browser_type', entry, exec)
    fresh(state)
    state.observed = null
    await invoke('browser_type', { ...target(state), ref: args.ref, text: args.text, replace: args.replace === true, mode: 'insert_text' }, exec)
    return success({ message: '文本已投递，请 browser_observe 验证字段结果。', characters: Array.from(args.text).length })
  }
  const scroll = async (args, exec) => {
    if (!['up', 'down', 'left', 'right'].includes(args.direction)) fail('direction 需要 up/down/left/right。')
    const amount = args.amount === undefined ? 500 : args.amount
    if (!Number.isFinite(amount) || amount <= 0 || amount > 5000) fail('amount 必须是 1 到 5000 的 CSS 像素。')
    const state = current()
    const observed = fresh(state)
    const entry = reference(observed, args, ['scroll', 'pointer'])
    await exactWindow(state, exec)
    await approve('browser_scroll', entry, exec)
    fresh(state)
    state.observed = null
    const horizontal = ['left', 'right'].includes(args.direction)
    const delta = ['up', 'left'].includes(args.direction) ? -amount : amount
    await invoke('browser_pointer', { ...target(state), ref: args.ref, action: 'scroll', delta_x: horizontal ? delta : 0, delta_y: horizontal ? 0 : delta, delivery_mode: 'background', input_route: 'trusted' }, exec)
    return success({ message: '滚动已投递，请 browser_observe 获取新位置。' })
  }

  const unsupported = async () => fail('当前 cua typed 后端未提供该能力或宿主授权契约；可显式配置 Playwright 后端使用其支持的独立浏览器能力。')
  const pointer = async (args, exec) => {
    if (!['hover','right_click','double_click','drag'].includes(args.action)) fail('不支持的 pointer action。')
    const state = current(); const snap = fresh(state); const from = reference(snap,args,'pointer')
    const to = args.action === 'drag' ? reference(snap,{ref:args.destination_ref},'pointer') : null
    if (to && from.frame !== to.frame) fail('拖拽源与目标必须在同一 frame。')
    await exactWindow(state,exec); await approve('browser_pointer',from,exec)
    if(to) await approve('browser_pointer',to,exec)
    fresh(state); active(exec); state.observed=null
    await invoke('browser_pointer',{...target(state),action:args.action,ref:args.ref,...(to?{destination_ref:args.destination_ref}:{}),delivery_mode:'background',input_route:'trusted'},exec)
    return success({message:'指针动作已投递，请重新观察。'})
  }
  const select = async (args,exec) => {
    if ((typeof args.label==='string') === (typeof args.value==='string')) fail('label 与 value 必须且只能提供一个。')
    const state=current();const entry=reference(fresh(state),args,['select','pointer'])
    await exactWindow(state,exec);await approve('browser_select',entry,exec);
    if(args.value!==undefined)await forceApproval('browser_select','按value选择选项；当前cua快照未证明该value的可见语义，请确认本次选择。',exec)
    else await approve('browser_select',{name:args.label,label:args.label},exec)
    fresh(state);active(exec);state.observed=null
    await invoke('browser_select',{...target(state),ref:args.ref,...(args.label===undefined?{value:args.value}:{label:args.label})},exec)
    return success({message:'选项已设置，请重新观察验证。'})
  }
  const tabs = async (args={},exec) => {
    const action=args.action||'list'
    if(action==='open_link')throw Object.assign(new Error('当前 cua 后端不支持 open_link；该能力需要 Playwright 或 Chrome 扩展后端。'),{code:'BROWSER_UNSUPPORTED'})
    const state=current();await exactWindow(state,exec)
    if(!['list','select'].includes(action))return unsupported()
    const bound=await readState({pid:state.pid,window_id:state.windowId},exec)
    if(bound.binding_quality!=='exact'||bound.endpoint_access_class!=='driver_owned')fail('无法精确绑定本会话浏览器。')
    const list=Array.isArray(bound.tabs)?bound.tabs:[]
    const chosen=action==='select'?list.find((tab)=>tab.tab_id===args.tab_id):list.find((tab)=>tab.tab_id===state.tabId)||list.find((tab)=>tab.active)||list[0]
    if(!chosen)fail('tab_id不在当前精确标签页列表中。')
    state.targetId=bound.target_id;state.tabId=chosen.tab_id;state.observed=null
    if(action==='select')return observe({},exec)
    return success({tabs:list.map((tab)=>({tabId:tab.tab_id,title:String(tab.title||'').slice(0,200),url:safeURL(tab.url),selected:tab.tab_id===state.tabId})),selectedTabId:state.tabId})
  }
  const screenshot=async(_args,exec)=>{
    const state=current();await bind(state,exec)
    const attachments=ctx?.get?.('attachments')||ctx?.attachments
    if(!attachments?.saveImage)fail('宿主attachments服务不可用。')
    state.observed=null;state.screenshot=null
    const captured=await readState({...target(state),snapshot_format:'semantic_v2',include_screenshot:true},exec)
    const shot=captured.screenshot
    if(shot?.coordinate_space!=='viewport_css_px'||![shot.width,shot.height,shot.pixel_to_css_scale_x,shot.pixel_to_css_scale_y].every((value)=>Number.isFinite(value)&&value>0)||typeof captured.screenshot_png_b64!=='string')fail('驱动截图坐标契约缺失，已拒绝创建坐标快照。')
    if(![shot.viewport_css_width,shot.viewport_css_height].every((value)=>Number.isFinite(value)&&value>0)||Math.abs(shot.width*shot.pixel_to_css_scale_x-shot.viewport_css_width)>1||Math.abs(shot.height*shot.pixel_to_css_scale_y-shot.viewport_css_height)>1)fail('驱动截图像素与viewport比例不一致。')
    const bytes=Buffer.from(captured.screenshot_png_b64,'base64')
    if(!bytes.length||bytes.length>20*1024*1024)fail('截图为空或超过20MiB上限。')
    const ref=await attachments.saveImage({data:bytes,mediaType:'image/png',name:'browser-viewport.png'})
    active(exec);state.screenshot={at:now(),tabId:state.tabId,width:shot.width,height:shot.height,scaleX:shot.pixel_to_css_scale_x,scaleY:shot.pixel_to_css_scale_y}
    return{...success({message:'截图完成；browser_click(x,y)使用此图片像素，插件转换为viewport CSS坐标。',width:shot.width,height:shot.height,coordinateSpace:'screenshot_pixels',pixelToCSSScaleX:shot.pixel_to_css_scale_x,pixelToCSSScaleY:shot.pixel_to_css_scale_y}),image:{attachmentId:ref.attachmentId,mediaType:ref.mediaType,bytes:ref.bytes,width:ref.width??shot.width,height:ref.height??shot.height,...(ref.name?{name:ref.name}:{})}}
  }
  const close=async(_args,exec)=>{current();active(exec);await invoke('end_session',{},exec);const session=getSessionState();session.browser=null;session.snapshot=null;session.initialized=false;return success({message:'本会话driver session及其独立浏览器已关闭。'})}
  const capabilities=async()=>success({backend:'cua',isolated:true,reads:['query','scope_ref','continuation'],tabs:['list','select'],history:[],actions:['click','type','select','hover','right_click','double_click','drag','scroll'],files:{upload:false,download:false,reason:'DRIVER_HOST_AUTHORIZATION_UNAVAILABLE'},existingUserProfile:false,screenshot:true})
  const safe = (fn) => async (args = {}, exec) => {
    try { active(exec); return await fn(args, exec) } catch (error) { return { ok: false, result: JSON.stringify({ message: cleanDiagnostic(error.message), ...(error.code ? { code: error.code } : {}) }) } }
  }
  return Object.fromEntries(Object.entries({open,observe,navigate,click,type,scroll,select,pointer,tabs,capabilities,key:unsupported,history:unsupported,dialog:unsupported,screenshot,upload:unsupported,download:unsupported,close}).map(([name,fn])=>[name,safe(fn)]))
}

/** Read-only structured adapter. The caller owns tool/session scope; all facts
 * come from this refresh and carry only the same sanitized page data as tools.
 * Query credentials, secret fields and driver transport details never escape.
 */
export async function observeBrowser(ctx, args = {}, cfg = {}, exec, options) {
  const result = await createBrowserController(ctx, cfg, options).observe(args, exec)
  if (!result.ok) return result
  const observation = result.data
  const text = [observation.outline, ...observation.refs.flatMap((entry) => [entry.name, typeof entry.value === 'string' ? entry.value : ''])].filter(Boolean).join('\n')
  return {
    ...result, observation,
    facts: {
      url: observation.url, title: observation.title, titleComplete: observation.titleComplete, text,
      complete: observation.complete, textComplete: observation.textComplete,
      refs: observation.refs,
    },
  }
}

/** Definitions are registered by index.js through the same scoped executor. */
export function browserTools(ctx, cfg, options) {
  const controller = createBrowserController(ctx, cfg, options)
  const optionalRef = { type: 'string', description: 'browser_observe 最新快照的 ref。' }
  const ref = { ...optionalRef, required: true }
  const optionalUrl = { type: 'string', description: '完整 http/https 地址或 about:blank。' }
  const url = { ...optionalUrl, required: true }
  return [
    { name: 'browser_open', description: '按宿主配置打开本会话浏览器：chrome-extension 在当前 Chrome 的可见专属分组内操作；playwright/cua 使用独立浏览器。先 browser_capabilities 确认范围，不自动切换浏览器或接管无关标签。导航后返回 DOM/语义观察。', parameters: { url: optionalUrl }, execute: controller.open },
    { name: 'browser_observe', description: '读取本会话拥有的网页文字与可操作 ref。每次动作后必须重新观察；不返回截图，不列举其它用户标签。', parameters: {query:{type:'string'},scope_ref:{type:'string'},continuation:{type:'string'}}, execute: controller.observe },
    { name: 'browser_navigate', description: '在本会话拥有的标签页导航至指定地址，然后返回新观察。', parameters: { url }, execute: controller.navigate },
    { name: 'browser_click', description: '用最新网页 ref 后台点击；危险标签需要本次审批，动作后必须重新观察。Chrome扩展中的新标签链接请改用browser_tabs open_link，避免原生弹页无法登记。', parameters: { ref:optionalRef,x:{type:'number'},y:{type:'number'} }, execute: controller.click },
    { name: 'browser_type', description: '向最新 ref 输入普通文本；replace=true 替换。检测到密码/密钥字段或不完整 DOM 时整页暂停自动输入。动作后重新观察。', parameters: { ref, text: { type: 'string', required: true }, replace: { type: 'boolean', description: 'true 替换整个字段，默认 false 在光标处插入。' } }, execute: controller.type },
    { name: 'browser_scroll', description: '在最新 ref 位置后台滚动，amount 使用 CSS 像素。动作后重新观察。', parameters: { ref, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], required: true }, amount: { type: 'number', description: 'CSS 像素，默认 500，最大 5000。' } }, execute: controller.scroll },

    {name:'browser_capabilities',description:'报告当前浏览器后端的具体能力与限制。',parameters:{},execute:controller.capabilities},
    {name:'browser_select',description:'设置原生下拉框；label与value二选一。',parameters:{ref,label:{type:'string'},value:{type:'string'}},execute:controller.select},
    {name:'browser_pointer',description:'执行hover/right_click/double_click/drag，使用最新ref。',parameters:{action:{type:'string',enum:['hover','right_click','double_click','drag'],required:true},ref,destination_ref:{type:'string'}},execute:controller.pointer},
    {name:'browser_key',description:'向当前ref发送浏览器按键，Playwright后端支持。',parameters:{ref,key:{type:'string',required:true}},execute:controller.key},
    {name:'browser_tabs',description:'列举或精确选择本会话tab；Playwright/Chrome扩展支持new/close及open_link。open_link用新鲜link ref在己方新标签中打开HTTP(S) href，只导航URL，不执行click/onclick脚本；不支持下载链接，cua不支持。',parameters:{action:{type:'string',enum:['list','new','select','close','open_link']},tab_id:{type:'string'},url:optionalUrl,ref:optionalRef},execute:controller.tabs},
    {name:'browser_history',description:'本会话浏览器back/forward/reload，Playwright后端支持。',parameters:{action:{type:'string',enum:['back','forward','reload'],required:true}},execute:controller.history},
    {name:'browser_dialog',description:'检查或处理页面JavaScript对话框；使用inspect返回的dialog_id。',parameters:{action:{type:'string',enum:['inspect','accept','dismiss'],required:true},dialog_id:{type:'string'},prompt_text:{type:'string'}},execute:controller.dialog},
    {name:'browser_screenshot',description:'截取当前tab viewport，返回图片及准确坐标空间。',parameters:{},execute:controller.screenshot},
    {name:'browser_upload',description:'给指定file input设置用户明确指定的绝对文件路径，需要宿主文件读取授权及发送审批。',parameters:{ref,files:{type:'array',items:{type:'string'},required:true}},execute:controller.upload},
    {name:'browser_download',description:'将指定ref的下载保存到用户明确指定的目录，需要宿主文件写入授权。',parameters:{ref,destination_root:{type:'string',required:true}},execute:controller.download},
    {name:'browser_close',description:'结束本会话浏览器控制。独立模式关闭己方进程；Chrome扩展模式释放控制、保留页面并取消己方分组，始终不关闭用户整个浏览器。',parameters:{},execute:controller.close},
  ].map((definition) => ({ ...definition, output: OUT }))
}
