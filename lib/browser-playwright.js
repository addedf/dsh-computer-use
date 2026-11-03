/** Optional standalone Playwright backend. Creates its own browser process and
 * context through the installed Chrome channel; never attaches to user Chrome. */
import { randomUUID } from 'node:crypto'
import { lstat, realpath, open as openFile, unlink } from 'node:fs/promises'
import { isAbsolute, basename, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { getSessionState } from './session.js'
import { registerCleanup } from './lifecycle.js'

const DANGER = /删除|移除|清空|格式化|卸载|支付|付款|购买|下单|结账|转账|汇款|退出登录|注销|\b(?:delete|remove|erase|clear|destroy|pay|purchase|buy|checkout|transfer|place order|log\s*out|sign\s*out)\b/i
const SENSITIVE = /密码|口令|密钥|\b(?:password|passphrase|secret|api[ _-]?key|access[ _-]?token)\b/i
const clean = (value) => String(value || '').replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[URL omitted]').slice(0, 600)
const result = (data) => ({ ok: true, data, result: JSON.stringify(data) })
const fail = (message, code = 'BROWSER_REFUSED') => { throw Object.assign(new Error(message), { code }) }
const active = (exec) => { if (exec?.signal?.aborted) fail('操作已取消。', 'ABORTED') }
const safeURL = (value) => { try { const u = new URL(value); return u.protocol === 'about:' ? 'about:blank' : `${u.origin}${u.pathname}` } catch { return '' } }
const ownedResources = new WeakMap()
function track(ctx, browser, context) {
  let set = ownedResources.get(ctx)
  if (!set) {
    set = new Set(); ownedResources.set(ctx,set)
    registerCleanup(ctx, async () => { await Promise.allSettled([...set].map(async(item)=>{await item.context.close().catch(()=>{});await item.browser.close().catch(()=>{})}));set.clear() })
  }
  const item={browser,context};set.add(item);return()=>set.delete(item)
}
const checkedURL = (value) => {
  if (typeof value !== 'string') fail('需要完整 URL。')
  let url
  try { url = new URL(value) } catch { fail('URL 必须是完整的 http/https 或 about:blank。') }
  if ((!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank') || url.username || url.password) fail('仅允许无用户名密码的 http/https 或 about:blank。')
  return url.href
}

function describeElement(el, uploadOnly = false) {
  if(uploadOnly&&(!el.isConnected||el.ownerDocument!==document||!(el instanceof HTMLInputElement)||el.tagName.toLowerCase()!=='input'||el.type!=='file'))return null
  const r=el.getBoundingClientRect();const style=getComputedStyle(el)
  if(r.width<=0||r.height<=0||style.visibility==='hidden'||style.display==='none')return null
  const tag=el.tagName.toLowerCase();const type=(el.getAttribute('type')||'').toLowerCase()
  const role=el.getAttribute('role')||(tag==='input'?(['checkbox','radio'].includes(type)?type:['submit','button','reset'].includes(type)?'button':type==='file'?'fileinput':'textbox'):({button:'button',a:'link',textarea:'textbox',select:'combobox',option:'option'})[tag]||(el.isContentEditable?'textbox':'region'))
  const name=(el.getAttribute('aria-label')||(el.getAttribute('aria-labelledby')||'').split(/\s+/).map((id)=>document.getElementById(id)?.textContent||'').join(' ').trim()||(el.labels?Array.from(el.labels).map((label)=>label.innerText).join(' '):'')||el.getAttribute('placeholder')||el.innerText||el.getAttribute('title')||'').trim()
  const protectedField=type==='password';const enabled=!(el.matches(':disabled')||el.disabled||el.getAttribute('aria-disabled')==='true')
  const editable=['input','textarea'].includes(tag)||el.isContentEditable
  const actions=['pointer']
  if(['button','link','checkbox','radio'].includes(role)||el.getAttribute('onclick')||el.tabIndex>=0)actions.push('click')
  if(editable&&type!=='file'&&!['checkbox','radio','submit','button','reset'].includes(type))actions.push('type')
  if(tag==='select')actions.push('select')
  if(type==='file')actions.push('upload')
  const checked=typeof el.checked==='boolean'?el.checked:el.hasAttribute('aria-checked')?(el.getAttribute('aria-checked')==='mixed'?null:el.getAttribute('aria-checked')==='true'):undefined
  return{role,name,actions,protected:protectedField,enabled,...(['checkbox','radio'].includes(role)&&checked!==undefined?{checked}:{}),value:protectedField?null:editable?(el.value??el.textContent??''):tag==='select'?el.value:null,rect:{x:r.x,y:r.y,width:r.width,height:r.height},inViewport:r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth}
}

export function createPlaywrightController(ctx, cfg = {}, { playwright, now = Date.now } = {}) {
  const ttlMs = cfg.ttlMs || 120000
  const maxElements = Math.max(1, Math.min(500, cfg.maxElements || 500))
  const current = () => {
    const state = getSessionState().browser
    if (!state?.owned || state.backend !== 'playwright' || !state.context) fail('请先 browser_open 创建独立 Playwright 浏览器。')
    return state
  }
  const appAllowed = () => {
    const apps = cfg.allowedApps || []
    // channel:chrome selects the official installed Google Chrome executable.
    if (apps.length && !apps.includes('Google Chrome')) fail('区域限制：Google Chrome 不在 allowedApps 中。')
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
    page.on('dialog', (dialog) => { state.dialogs.set(id, { id: `dialog-${randomUUID()}`, at: now(), dialog }) })
    page.on('close', () => { if (state.tabId === id) state.observed = null; state.dialogs.delete(id) })
    return id
  }
  const fresh = (state) => {
    if (!state.observed || now() - state.observed.at > ttlMs) fail('网页快照缺失或已过期，请 browser_observe。')
    if (state.observed.tabId !== state.tabId) fail('快照属于另一个标签页，请重新观察。')
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
    try { decision = await ctx.approval.request({ toolName, agent: exec.agent, signal: exec.signal, ...(exec.callId ? { callId: exec.callId } : {}), reason: exactReason ? reason : clean(reason) }) } catch { decision = 'unavailable' }
    active(exec)
    if (decision !== 'allowed-once') fail(`操作未获批准（${decision}）。`)
  }
  const invalidate = (state) => {
    state.retired ||= new Set()
    if(state.observed) for(const entry of state.observed.refs.values()) state.retired.add(entry.handle)
    state.observed=null
    state.screenshot=null
    for(const continuation of state.continuations.values())if(continuation.scopeHandle)state.retired.add(continuation.scopeHandle)
    state.continuations.clear()
  }
  const releaseRetired = async (state) => {
    if(!state?.retired||state.pendingInteraction) return
    const currentHandles=new Set(state.observed?[...state.observed.refs.values()].map((entry)=>entry.handle):[])
    for(const continuation of state.continuations.values())if(continuation.scopeHandle)currentHandles.add(continuation.scopeHandle)
    for(const handle of state.retired) if(!currentHandles.has(handle)) await handle.dispose().catch(()=>{})
    state.retired.clear()
  }
  const beforeMutation = async (state, tool, entries, exec) => {
    appAllowed(); active(exec)
    for (const entry of entries) await approve(tool, entry.name || '', exec)
    fresh(state); active(exec)
    invalidate(state)
  }
  const observe = async (args = {}, exec) => {
    active(exec); appAllowed()
    const state = current()
    const page = pageOf(state)
    const old = state.observed
    let scopeHandle = null
    if (args.scope_ref !== undefined) scopeHandle = refOf(state, args.scope_ref).handle
    let offset = 0
    let textOffset = 0
    if (args.continuation !== undefined) {
      const continuation = state.continuations.get(args.continuation)
      if (!continuation || continuation.tabId !== state.tabId || continuation.url !== page.url() || continuation.snapshotId !== old?.snapshotId || now()-old.at>ttlMs) fail('continuation 已失效，请重新观察。')
      if(args.scope_ref!==undefined||(args.query!==undefined&&args.query!==continuation.query))fail('continuation不能更换query或scope。')
      scopeHandle=continuation.scopeHandle||null
      args={...args,query:continuation.query||undefined}
      offset = continuation.offset
      textOffset = continuation.textOffset || 0
      if (args.query===undefined && continuation.query) args={...args,query:continuation.query}
    }
    state.retired ||= new Set()
    if(old)for(const entry of old.refs.values())state.retired.add(entry.handle)
    state.observed = null
    for(const continuation of state.continuations.values())if(continuation.scopeHandle)state.retired.add(continuation.scopeHandle)
    state.continuations.clear()
    // DOM evaluation is fixed, read-only code. No page-provided JavaScript or
    // arbitrary evaluation string is accepted from the model.
    const frames = scopeHandle ? [await scopeHandle.ownerFrame()] : page.frames()
    const rows = []
    let text = ''
    let complete = true
    let inputBlocked = false
    for (const frame of frames) {
      active(exec)
      try {
        const root = scopeHandle || await frame.locator('body').elementHandle({ timeout: 3000 })
        if (!root) continue
        const metadata=await root.evaluate((container)=>({text:container.innerText||'',password:container.matches('input[type="password"]')||Boolean(container.querySelector('input[type="password"]'))}))
        inputBlocked ||= metadata.password
        text += `${metadata.text}\n`
        const selector='button,a[href],input,textarea,select,[role],[contenteditable="true"],[tabindex]'
        const handles=await root.$$(selector)
        if(await root.evaluate((el,selector)=>el.matches(selector),selector))handles.unshift(root)
        for(const handle of handles){
          active(exec)
          try{const entry=await handle.evaluate(describeElement);if(entry)rows.push({...entry,handle,frame});else await handle.dispose()}catch{complete=false;await handle.dispose().catch(()=>{})}
        }
        if(!scopeHandle && !await root.evaluate((el)=>el.matches('button,a[href],input,textarea,select,[role],[contenteditable="true"],[tabindex]')))await root.dispose().catch(()=>{})
        if (scopeHandle) break
      } catch { complete = false }
    }
    active(exec)
    const query = args.query === undefined ? '' : String(args.query).toLowerCase()
    const selected = query ? rows.filter((entry) => `${entry.role} ${entry.name} ${entry.protected ? '' : entry.value || ''}`.toLowerCase().includes(query)) : rows
    const selectedText = query ? text.split(/\n+/).filter((line)=>line.toLowerCase().includes(query)).join('\n') : text
    const textSlice=selectedText.slice(textOffset,textOffset+16000)
    const slice = selected.slice(offset, offset + maxElements)
    for(const entry of rows)if(!slice.includes(entry)&&entry.handle!==scopeHandle)await entry.handle.dispose().catch(()=>{})
    const snapshotId = `pw-${randomUUID()}`
    const refs = slice.map((entry, index) => ({ ...entry, ref: `${snapshotId}:${index}` }))
    const sensitive = !complete || inputBlocked || rows.some((entry) => entry.protected || SENSITIVE.test(entry.name))
    const continuation = offset + slice.length < selected.length || textOffset+textSlice.length<selectedText.length ? `more-${randomUUID()}` : null
    if (continuation) state.continuations.set(continuation, { tabId: state.tabId, url: page.url(), offset: offset + slice.length,textOffset:textOffset+textSlice.length,query:args.query||'',scopeHandle,snapshotId })
    const allComplete = complete && !scopeHandle && !query && !continuation && offset === 0 && textOffset===0 && !sensitive && selectedText.length <= 16000 && !refs.some((entry)=>entry.name.length>200||(typeof entry.value==='string'&&entry.value.length>1000))
    state.observed = { at: now(), tabId: state.tabId, snapshotId, refs: new Map(refs.map((entry) => [entry.ref, entry])), inputBlocked: sensitive }
    state.screenshot = null
    // Dispose handles from old observations only after the new read has finished.
    if (old) for (const entry of old.refs.values()) if (entry.handle!==scopeHandle&&!refs.some((next) => next.handle === entry.handle)) await entry.handle.dispose().catch(() => {})
    return result({ message: '网页观察完成。', backend: 'playwright', tabId: state.tabId, snapshotId, ttlMs, title: (await page.title()).slice(0,200), titleComplete:(await page.title()).length<=200, url: safeURL(page.url()), origin: new URL(page.url()).origin,
      complete: allComplete, textComplete: allComplete, inputBlocked: sensitive, scope: scopeHandle ? 'subtree' : query ? 'query' : 'page', continuation,
      outline: sensitive ? '本页含敏感字段，已隐藏可能含输入值的摘要。' : textSlice, truncated: !allComplete,
      refs: refs.map(({ handle, frame, rect, ...entry }) => ({ ref:entry.ref,role:entry.role,name:entry.name.slice(0,200),...(entry.name.length>200?{nameTruncated:true}:{}),...(!sensitive&&typeof entry.value==='string'&&entry.value.length>1000?{valueTruncated:true}:{}),actions:entry.actions,enabled:entry.enabled,states:{disabled:!entry.enabled,...(entry.checked===undefined?{}:{checked:entry.checked}),protected:entry.protected},...(entry.checked===undefined?{}:{checked:entry.checked}),visibility:entry.inViewport?'in_viewport':'offscreen',...(sensitive?{}:{value: typeof entry.value==='string'?entry.value.slice(0,1000):entry.value}) })) })
  }
  const open = async (args = {}, exec) => {
    const url = checkedURL(args.url || 'about:blank'); active(exec); appAllowed()
    let state = getSessionState().browser
    if (!state?.owned || state.backend !== 'playwright') {
      const library = playwright || await import('playwright-core')
      const browser = await library.chromium.launch({ channel:'chrome', headless:cfg.browserHeadless !== false })
      try {
        const context = await browser.newContext({ acceptDownloads: true, viewport:{width:1280,height:800}, deviceScaleFactor:1 })
        const untrack = track(ctx,browser,context)
        state = { untrack, backend:'playwright', owned:true, browser, context, pages:new Map(), dialogs:new Map(), continuations:new Map(), observed:null, screenshot:null, tabId:null }
        context.on('page', (page) => registerPage(state,page))
        const page = await context.newPage(); state.tabId = registerPage(state,page)
        getSessionState().browser = state
      } catch (error) { await browser.close(); throw error }
    }
    active(exec)
    invalidate(state)
    await pageOf(state).goto(url,{waitUntil:'domcontentloaded',timeout:30000})
    return observe({},exec)
  }
  const navigate = async (args,exec) => { const url=checkedURL(args.url);const state=current();appAllowed();active(exec);invalidate(state);await pageOf(state).goto(url,{waitUntil:'domcontentloaded',timeout:30000});return observe({},exec) }
  const click = async (args,exec) => {
    const state=current()
    if (args.ref !== undefined) { if(args.x!==undefined||args.y!==undefined)fail('ref与坐标必须二选一。'); const entry=refOf(state,args.ref,'click');await beforeMutation(state,'browser_click',[entry],exec);await entry.handle.click({timeout:5000,noWaitAfter:true}) }
    else {
      const shot=state.screenshot
      if (!shot || shot.tabId!==state.tabId || now()-shot.at>ttlMs) fail('坐标操作需要当前标签页的新鲜 browser_screenshot。')
      if (![args.x,args.y].every(Number.isFinite)||args.x<0||args.y<0||args.x>=shot.width||args.y>=shot.height) fail('坐标超出截图范围。')
      await approve('browser_click','按当前截图坐标点击，目标语义未知。',exec,true);active(exec);if(state.screenshot!==shot||shot.tabId!==state.tabId||now()-shot.at>ttlMs)fail('审批期间截图已失效，请重新截图。');invalidate(state);await pageOf(state).mouse.click(args.x,args.y)
    }
    return result({message:'点击已投递，请重新观察验证。'})
  }
  const type = async (args,exec) => { if(typeof args.text!=='string')fail('text必须是字符串。');const state=current();const entry=refOf(state,args.ref,'type');if(state.observed.inputBlocked||entry.protected||SENSITIVE.test(entry.name))fail('本页有敏感字段，自动输入已暂停。');await beforeMutation(state,'browser_type',[entry],exec);if(args.replace===true)await entry.handle.fill(args.text,{timeout:5000});else await entry.handle.type(args.text,{timeout:5000});return result({message:'文本已投递，请重新观察验证。',characters:Array.from(args.text).length}) }
  const scroll = async (args,exec) => { const state=current();const entry=refOf(state,args.ref,'pointer');const amount=args.amount??500;if(!['up','down','left','right'].includes(args.direction)||!Number.isFinite(amount)||amount<=0||amount>5000)fail('滚动参数无效。');await beforeMutation(state,'browser_scroll',[entry],exec);await entry.handle.hover({timeout:5000});await pageOf(state).mouse.wheel(['left','right'].includes(args.direction)?(['left'].includes(args.direction)?-amount:amount):0,['up','down'].includes(args.direction)?(args.direction==='up'?-amount:amount):0);return result({message:'已滚动，请重新观察。'}) }
  const select = async (args,exec) => {
    if((typeof args.label==='string')===(typeof args.value==='string'))fail('label和value必须且只能提供一个。')
    const state=current()
    const entry=refOf(state,args.ref,'select')
    const option=await entry.handle.evaluate((element,selection)=>{
      if(element.tagName.toLowerCase()!=='select'||element.multiple)return null
      const found=[...element.options].filter((option)=>selection.label===undefined?option.value===selection.value:option.label===selection.label)
      if(found.length!==1||found[0].disabled||found[0].parentElement?.disabled)return null
      return{label:found[0].label,value:found[0].value}
    },{label:args.label,value:args.value})
    if(!option)fail('原生单选目标不存在、歧义或已禁用。')
    await beforeMutation(state,'browser_select',[entry,{name:option.label}],exec)
    await entry.handle.selectOption({value:option.value},{timeout:5000})
    return result({message:'已选择，请重新观察。'})
  }
  const pointer = async (args,exec) => {
    if(!['hover','right_click','double_click','drag'].includes(args.action))fail('不支持的指针动作。')
    const state=current();const from=refOf(state,args.ref,'pointer');const to=args.action==='drag'?refOf(state,args.destination_ref,'pointer'):null
    if(to&&from.frame!==to.frame)fail('拖拽目标必须在同一frame。')
    await beforeMutation(state,'browser_pointer',[from,...(to?[to]:[])],exec)
    if(args.action==='hover')await from.handle.hover({timeout:5000})
    else if(args.action==='right_click')await from.handle.click({button:'right',timeout:5000,noWaitAfter:true})
    else if(args.action==='double_click')await from.handle.dblclick({timeout:5000,noWaitAfter:true})
    else {const a=await from.handle.boundingBox();const b=await to.handle.boundingBox();if(!a||!b)fail('拖拽目标不可见。');const mouse=pageOf(state).mouse;await mouse.move(a.x+a.width/2,a.y+a.height/2);await mouse.down();try{await mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:12})}finally{await mouse.up()}}
    return result({message:'指针动作已投递，请重新观察。'})
  }
  const key = async(args,exec)=>{if(typeof args.key!=='string'||!args.key||args.key.length>100)fail('需要有效key。');const state=current();const entry=refOf(state,args.ref);if(state.observed.inputBlocked||entry.protected)fail('敏感页面不允许自动键盘输入。');await beforeMutation(state,'browser_key',[entry],exec);await entry.handle.press(args.key,{timeout:5000,noWaitAfter:true});return result({message:'按键已投递，请重新观察。'})}
  const tabs = async(args={},exec)=>{
    const state=current();appAllowed();active(exec)
    for(const page of state.context.pages())registerPage(state,page)
    const action=args.action||'list'
    if(action==='new'){const url=checkedURL(args.url||'about:blank');const page=await state.context.newPage();state.tabId=registerPage(state,page);invalidate(state);await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});return observe({},exec)}
    if(action==='select'||action==='close'){
      const page=state.pages.get(args.tab_id);if(!page||page.isClosed())fail('tab_id不属于当前会话。')
      if(action==='select')state.tabId=args.tab_id
      else{await page.close({runBeforeUnload:false});state.pages.delete(args.tab_id);if(state.tabId===args.tab_id)state.tabId=[...state.pages].find(([,p])=>!p.isClosed())?.[0]||null}
      invalidate(state)
      if(action==='select')return observe({},exec)
    }else if(action!=='list')fail('tabs action无效。')
    const entries=[];for(const[id,page]of state.pages)if(!page.isClosed())entries.push({tabId:id,title:(await page.title()).slice(0,200),url:safeURL(page.url()),selected:state.tabId===id})
    return result({tabs:entries,selectedTabId:state.tabId})
  }
  const history = async(args,exec)=>{if(!['back','forward','reload'].includes(args.action))fail('history action无效。');const state=current();appAllowed();active(exec);invalidate(state);const p=pageOf(state);if(args.action==='back')await p.goBack({waitUntil:'domcontentloaded',timeout:30000});else if(args.action==='forward')await p.goForward({waitUntil:'domcontentloaded',timeout:30000});else await p.reload({waitUntil:'domcontentloaded',timeout:30000});return observe({},exec)}
  const dialog = async(args,exec)=>{
    const state=current();active(exec);appAllowed();const entry=state.dialogs.get(state.tabId)
    if((args.action||'inspect')==='inspect')return result({dialog:entry?{dialogId:entry.id,type:entry.dialog.type(),message:clean(entry.dialog.message()),at:entry.at}:null})
    if(!['accept','dismiss'].includes(args.action)||!entry||entry.id!==args.dialog_id||now()-entry.at>ttlMs)fail('dialog_id缺失、过期或不属于当前对话框。')
    if(args.prompt_text!==undefined&&typeof args.prompt_text!=='string')fail('prompt_text必须是字符串。')
    await approve('browser_dialog',`处理网页对话框 ${entry.dialog.type()}：${entry.dialog.message()}`,exec,args.action==='accept')
    if(state.dialogs.get(state.tabId)!==entry||now()-entry.at>ttlMs)fail('对话框已变化或过期。');active(exec);invalidate(state)
    if(args.action==='accept')await entry.dialog.accept(args.prompt_text);else await entry.dialog.dismiss();state.dialogs.delete(state.tabId);if(state.pendingInteraction){await state.pendingInteraction;state.pendingInteraction=null}return result({message:'对话框已处理。'})
  }
  const screenshot = async(_args,exec)=>{const state=current();appAllowed();active(exec);const page=pageOf(state);const attachments=ctx?.get?.('attachments');if(!attachments)fail('宿主attachments服务不可用。');const data=await page.screenshot({type:'png',fullPage:false,timeout:10000});active(exec);const size=page.viewportSize();const image=await attachments.saveImage({data,mediaType:'image/png',name:'browser-viewport.png'});state.screenshot={at:now(),tabId:state.tabId,width:size.width,height:size.height};return {...result({message:'浏览器截图完成；坐标为viewport CSS像素，deviceScaleFactor=1。',width:size.width,height:size.height,coordinateSpace:'viewport_css_pixels'}),image:{attachmentId:image.attachmentId,mediaType:image.mediaType,bytes:image.bytes,width:image.width??size.width,height:image.height??size.height,...(image.name?{name:image.name}:{})}}}
  const maxFileBytes = 10 * 1024 * 1024
  const hostFS = () => ctx?.get?.('fs') || ctx?.fs
  const authorizeUpload = async (files, exec) => {
    const fs = hostFS()
    if (!fs || typeof fs.readBytes !== 'function' || typeof fs.stat !== 'function' || typeof fs.processPathFromHostPath !== 'function' || typeof fs.resolve !== 'function' || typeof fs.lstat !== 'function') fail('宿主fs文件授权服务未配置，已拒绝读取上传文件。','FILE_AUTHORIZATION_UNAVAILABLE')
    if (!Array.isArray(files) || files.length < 1 || files.length > 32 || files.some((path) => typeof path !== 'string' || !isAbsolute(path))) fail('files必须是1–32个明确的绝对普通文件路径。')
    const payloads=[]
    let total=0
    for (const path of files) {
      active(exec)
      const executionPath=await fs.processPathFromHostPath(path)
      if(typeof executionPath!=='string')fail('宿主无法将此用户文件映射到执行环境。','FILE_AUTHORIZATION_UNAVAILABLE')
      const info=await fs.lstat(executionPath,{},exec?.signal)
      if(info?.type!=='file'||info.size>maxFileBytes)fail('上传仅允许10MiB以内的普通文件，不允许符号链接。')
      const target=await fs.resolve(executionPath,{signal:exec?.signal})
      const verified=await fs.stat(target,exec?.signal)
      if(verified?.type!=='file'||verified.size!==info.size)fail('上传文件在读取前已变化。')
      const read=await fs.readBytes(target,exec?.signal,maxFileBytes)
      const bytes=read instanceof Uint8Array?read:read?.data instanceof Uint8Array?read.data:read?.bytes instanceof Uint8Array?read.bytes:null
      if(!bytes)fail('宿主fs.readBytes未返回受支持的字节数组，已拒绝上传。','FILE_AUTHORIZATION_UNAVAILABLE')
      total+=bytes.byteLength
      if(bytes.byteLength!==info.size||total>maxFileBytes)fail('上传文件读取不完整或总大小超过10MiB。')
      payloads.push({name:basename(path),mimeType:'application/octet-stream',buffer:Buffer.from(bytes)})
    }
    return payloads
  }
  const upload = async(args,exec)=>{
    const state=current();appAllowed();const entry=refOf(state,args.ref,'upload')
    if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 32 || args.files.some((path) => typeof path !== 'string' || !isAbsolute(path))) fail('files必须是1–32个明确的绝对普通文件路径。')
    const files=Object.freeze([...args.files])
    const snapshot=state.observed,tabId=state.tabId,page=pageOf(state),pageURL=page.url()
    const handle=entry.handle,frame=entry.frame,ref=args.ref,name=entry.name,role=entry.role
    if(!frame||typeof frame.url!=='function'||typeof frame.isDetached!=='function'||typeof handle.ownerFrame!=='function'||typeof handle.evaluate!=='function')fail('上传目标无法安全复核，请重新观察。')
    const frameURL=frame.url()
    // Approval can take longer than an observation TTL. Keep that one grant
    // bound to the original element, page/frame and immutable file selection;
    // never renew the old snapshot or rediscover a replacement target.
    const changed=()=>fail('本次上传审批已允许，但原目标已变化或无法安全复核；文件未交给页面，请重新观察并重新授权。','UPLOAD_TARGET_CHANGED')
    const assertContext=()=>{
      active(exec);appAllowed()
      if(current()!==state||state.observed!==snapshot||state.tabId!==tabId||snapshot.tabId!==tabId||snapshot.refs.get(ref)!==entry||entry.handle!==handle||entry.frame!==frame||entry.name!==name||entry.role!==role||pageOf(state)!==page||page.url()!==pageURL||frame.isDetached()||frame.url()!==frameURL)changed()
    }
    const revalidate=async()=>{
      try{
        assertContext()
        if(await handle.ownerFrame()!==frame)changed()
        assertContext()
        const live=await handle.evaluate(describeElement,true)
        assertContext()
        if(!live||live.name!==name||live.role!==role||live.enabled!==true||live.protected||!live.actions.includes('upload'))changed()
      }catch(error){active(exec);if(error.code==='UPLOAD_TARGET_CHANGED')throw error;changed()}
    }
    await approve('browser_upload',`上传文件（完整路径）：${JSON.stringify({page:safeURL(pageURL),...(frameURL===pageURL?{}:{frame:safeURL(frameURL)}),files})}`,exec,true,true)
    await revalidate()
    const payloads=await authorizeUpload(files,exec)
    await revalidate()
    active(exec);invalidate(state)
    await handle.setInputFiles(payloads,{timeout:10000})
    return result({message:'文件已交给页面，请重新观察验证。',files:payloads.length,bytes:payloads.reduce((sum,file)=>sum+file.buffer.length,0)})
  }
  const destination = async(root,exec)=>{
    if(typeof root!=='string'||!isAbsolute(root))fail('destination_root必须是用户明确指定的绝对目录。')
    const policy=ctx?.get?.('sandboxPolicy')||ctx?.sandboxPolicy
    if(!policy||typeof policy.resolve!=='function'||!exec?.agent?.session)fail('宿主sandboxPolicy文件写入授权未配置，已拒绝下载。','FILE_AUTHORIZATION_UNAVAILABLE')
    const decision=await policy.resolve({session:exec.agent.session})
    if(!['workspace-write','danger-full-access'].includes(decision?.mode))fail('当前宿主文件策略禁止写入下载文件。','FILE_WRITE_DENIED')
    const canonical=await realpath(root);const info=await lstat(root)
    if(!info.isDirectory()||info.isSymbolicLink())fail('下载目录必须存在且为canonical普通目录，不允许符号链接。')
    if(decision.mode==='workspace-write'){
      if(typeof decision.workspaceRoot!=='string'||!isAbsolute(decision.workspaceRoot))fail('宿主workspaceRoot不可验证，已拒绝写入。','FILE_WRITE_DENIED')
      const roots=[await realpath(decision.workspaceRoot),await realpath(tmpdir())]
      const within=roots.some((allowed)=>{const path=relative(allowed,canonical);return path===''||(!path.startsWith(`..${sep}`)&&path!=='..'&&!isAbsolute(path))})
      if(!within)fail('下载目录不在宿主允许的workspace或临时目录内。','FILE_WRITE_DENIED')
    }
    return canonical
  }
  const download = async(args,exec)=>{
    const state=current()
    const entry=refOf(state,args.ref,'click')
    appAllowed()
    const root=await destination(args.destination_root,exec)
    active(exec)
    await beforeMutation(state,'browser_download',[entry],exec)
    const page=pageOf(state)
    let onDownload,onAbort,timer
    const pending=new Promise((resolve,reject)=>{
      onDownload=(item)=>resolve(item)
      onAbort=()=>reject(Object.assign(new Error('操作已取消。'),{code:'ABORTED'}))
      page.on('download',onDownload)
      exec?.signal?.addEventListener('abort',onAbort,{once:true})
      timer=setTimeout(()=>reject(new Error('等待下载超时。')),15000)
      if(exec?.signal?.aborted)onAbort()
    })
    let item
    let stream
    let transferAbort
    let transferTimer
    let file
    let path
    let created=false
    let bytes=0
    try{
      const received=await Promise.all([pending,entry.handle.click({timeout:5000,noWaitAfter:true})])
      item=received[0]
      active(exec)
      const suggested=item.suggestedFilename()
      if(typeof suggested!=='string'||!suggested||basename(suggested)!==suggested||/[\\/\x00]/.test(suggested)||['.','..'].includes(suggested))fail('下载文件名不安全，已拒绝保存。')
      // Recheck the canonical parent after the page/download event await.
      if(await realpath(root)!==root||!(await lstat(root)).isDirectory())fail('下载目录在等待期间已变化。')
      active(exec)
      path=join(root,suggested)
      file=await openFile(path,'wx',0o600)
      created=true
      active(exec)
      clearTimeout(timer)
      let rejectTransfer
      const interrupted=new Promise((_,reject)=>{rejectTransfer=reject})
      const interrupt=(code,message)=>{
        const error=Object.assign(new Error(message),{code})
        stream?.destroy?.(error)
        void item.cancel().catch(()=>{})
        rejectTransfer(error)
      }
      transferAbort=()=>interrupt('ABORTED','操作已取消。')
      exec?.signal?.addEventListener('abort',transferAbort,{once:true})
      transferTimer=setTimeout(()=>interrupt('DOWNLOAD_TIMEOUT','下载数据流超过15秒上限。'),15000)
      if(exec?.signal?.aborted)transferAbort()
      stream=await Promise.race([item.createReadStream(),interrupted])
      if(!stream||typeof stream.destroy!=='function')fail('下载数据流契约不可验证。')
      active(exec)
      for await(const chunk of stream){
        active(exec)
        bytes+=chunk.length
        if(bytes>maxFileBytes)fail('下载超过10MiB上限，已取消。')
        await file.writeFile(chunk,{signal:exec?.signal})
      }
      active(exec)
      if(await item.failure())fail('下载失败。')
      active(exec)
      await file.close()
      file=null
      active(exec)
      return result({message:'下载已保存为新文件。',savedFile:path,bytes})
    }catch(error){
      if(item)await item.cancel().catch(()=>{})
      if(file)await file.close().catch(()=>{})
      if(created)await unlink(path).catch(()=>{})
      throw error
    }finally{
      clearTimeout(timer)
      clearTimeout(transferTimer)
      exec?.signal?.removeEventListener('abort',transferAbort)
      page.off('download',onDownload)
      exec?.signal?.removeEventListener('abort',onAbort)
    }
  }
  const close = async(_args,exec)=>{const state=current();active(exec);await state.context.close();await state.browser.close();state.untrack?.();getSessionState().browser=null;return result({message:'本会话独立浏览器已关闭。'})}
  const capabilities = async()=>result({backend:'playwright',isolated:true,headless:cfg.browserHeadless!==false,tabs:['list','new','select','close'],history:['back','forward','reload'],actions:['click','type','select','key','hover','right_click','double_click','drag','scroll','dialog','screenshot'],reads:['query','scope_ref','continuation'],files:{upload:['readBytes','processPathFromHostPath','resolve','stat','lstat'].every((name)=>typeof hostFS()?.[name]==='function'),download:Boolean((ctx?.get?.('sandboxPolicy')||ctx?.sandboxPolicy)?.resolve),maxBytes:maxFileBytes},existingUserProfile:false})
  const safe=(fn)=>async(args={},exec)=>{
    let page,onDialog
    try{
      active(exec)
      const state=getSessionState().browser
      if(state?.pendingInteraction&&![dialog,close,capabilities].includes(fn))fail('页面存在待处理对话框，请先browser_dialog。')
      if(state?.backend==='playwright'&&[click,pointer,key,select].includes(fn)){
        page=pageOf(state)
        const appeared=new Promise((resolve)=>{onDialog=()=>resolve({dialog:true});page.on('dialog',onDialog)})
        const running=Promise.resolve().then(()=>fn(args,exec))
        const outcome=await Promise.race([running.then((value)=>({value})),appeared])
        if(outcome.dialog){active(exec);state.pendingInteraction=running.catch(()=>undefined);return result({message:'操作已触发网页对话框，请browser_dialog检查并处理。',dialogPending:true})}
        return outcome.value
      }
      return await fn(args,exec)
    }catch(error){return{ok:false,result:JSON.stringify({message:clean(error.message),code:error.code||'PLAYWRIGHT_ERROR'})}}
    finally{if(page&&onDialog)page.off('dialog',onDialog);await releaseRetired(getSessionState().browser)}
  }
  return Object.fromEntries(Object.entries({open,observe,navigate,click,type,scroll,select,pointer,key,tabs,history,dialog,screenshot,upload,download,close,capabilities}).map(([name,fn])=>[name,safe(fn)]))
}
