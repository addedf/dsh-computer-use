/**
 * Repeatable local browser acceptance through the real Cordis ToolRuntime.
 * Run: node verify-browser.mjs
 * Requires cua-driver 0.38+ and an available platform-attested Chromium install.
 * Opens only a throwaway driver-owned profile; never attaches to user Chrome.
 * Browser processes owned by this script and the loopback fixture are closed.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, lstat as fsLstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply } from './index.js'
import { cuaCall } from './lib/cua.js'
import { createToolScope, getSessionState, getDriverSession } from './lib/session.js'

const backend = process.env.BROWSER_BACKEND === 'playwright' ? 'playwright' : 'cua'
const fixtureRoot = await mkdtemp(join(tmpdir(),'dsh-browser-acceptance-'))
const checks = []
const check = (name, condition) => {
  checks.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`)
  assert.ok(condition, name)
}
const articleNonce = `PURE_ARTICLE_END_${Date.now()}`
const fixtureState = { confirmations: 0, confirmedValue: '', dangerousClicks: 0 }
const fixtureHtml = `<!doctype html>
<meta charset="utf-8"><title>DSH isolated browser acceptance</title>
<style>body{font:18px sans-serif;margin:30px}label,button,output{display:block;margin:15px}#scroll-box{height:160px;overflow:auto;border:1px solid #888;margin:15px;padding:8px}#scroll-content{height:1000px}</style>
<label>姓名<input id="name" aria-label="测试姓名"></label>
<button aria-label="确认测试" onclick="confirmFixture()">确认测试</button>
<button aria-label="Delete record" onclick="fetch('/danger',{method:'POST'})">Delete record</button>
<output id="result" aria-label="测试结果">等待确认</output>
<div id="scroll-box" role="region" aria-label="测试滚动区域" tabindex="0"><div id="scroll-content">区域顶部<br>可滚动测试内容</div></div>
<select aria-label="测试选择" onchange="document.querySelector('#result').textContent='选项：'+this.value"><option value="a">Alpha</option><option value="b">Beta</option></select>
<input type="checkbox" aria-label="测试复选框">
<input type="file" aria-label="测试上传" onchange="this.files[0].text().then(text=>fetch('/upload',{method:'POST',body:text}))">
<a href="/download" download aria-label="测试下载">测试下载</a>
<button aria-label="测试对话框" onclick="document.querySelector('#result').textContent=confirm('确认测试对话框')?'接受对话框':'取消对话框'">测试对话框</button>
<div tabindex="0" role="button" aria-label="测试指针" onmouseover="this.dataset.hover='yes';document.querySelector('#result').textContent='悬停成功'" ondblclick="document.querySelector('#result').textContent='双击成功'" oncontextmenu="event.preventDefault();document.querySelector('#result').textContent='右键成功'">测试指针</div>
<div tabindex="0" role="button" aria-label="拖拽源" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','fixture')">拖拽源</div><div tabindex="0" role="button" aria-label="拖拽目标" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.querySelector('#result').textContent='拖拽成功'">拖拽目标</div>
<script>
async function confirmFixture(){const value=document.querySelector('#name').value;await fetch('/confirm',{method:'POST',headers:{'Content-Type':'text/plain'},body:value});document.querySelector('#result').textContent='已确认：'+value}
document.querySelector('#scroll-box').addEventListener('scroll',()=>fetch('/scrolled',{method:'POST'}))
</script>`
let scrollEvents = 0
let uploadedText = ''
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  if (request.url === '/download') {
    response.setHeader('Content-Disposition','attachment; filename=fixture-download.txt');response.end('download fixture OK')
  } else if (request.url === '/upload' && request.method === 'POST') {
    for await(const chunk of request) uploadedText += chunk; response.end('ok')
  } else if (request.url === '/confirm' && request.method === 'POST') {
    let text = ''
    for await (const chunk of request) text += chunk
    fixtureState.confirmations++
    fixtureState.confirmedValue = text
    response.end('ok')
  } else if (request.url === '/danger' && request.method === 'POST') {
    fixtureState.dangerousClicks++
    response.end('ok')
  } else if (request.url === '/scrolled' && request.method === 'POST') {
    scrollEvents++
    response.end('ok')
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(request.url === '/article' ? '<title>Pure long article</title><article>'+('纯文本文章内容，没有交互控件。'.repeat(2500))+articleNonce+'</article>' : request.url === '/long' ? '<title>Long fixture</title><section role="region" aria-label="分页区域">'+Array.from({length:120},(_,i)=>'<button aria-label="row '+i+'">row '+i+'</button>').join('')+'<p>'+('long content '.repeat(1700))+'END_LONG_FIXTURE</p></section><button aria-label="Outside scope">Outside scope</button>' : request.url === '/second' ? fixtureHtml.replace('DSH isolated browser acceptance','DSH second page') : fixtureHtml)
  }
})

const ctx = new Context()
ctx.provide('systemPrompt', { tools() {} })
ctx.provide('attachments',{async saveImage({data,mediaType,name}){return{attachmentId:'sha256:'+createHash('sha256').update(data).digest('hex'),mediaType,bytes:data.length,name}}})
// Fixture host services intentionally authorize only this script's temp root.
const insideFixture = (path) => {const rel=relative(fixtureRoot,path);if(!isAbsolute(path)||rel.startsWith('..')||isAbsolute(rel))throw new Error('fixture file path refused');return path}
ctx.provide('fs',{processPathFromHostPath:insideFixture,resolve:(path)=>({displayPath:insideFixture(path)}),async lstat(path){const info=await fsLstat(insideFixture(path));return{type:info.isFile()?'file':info.isSymbolicLink()?'symlink':'directory',size:info.size}},async stat(target){return this.lstat(target.displayPath)},async readBytes(target,signal,maxBytes){signal?.throwIfAborted();const bytes=await readFile(insideFixture(target.displayPath));if(bytes.length>maxBytes)throw new Error('fixture read exceeds limit');return bytes}})
ctx.provide('sandboxPolicy',{resolve:async()=>({mode:'workspace-write',workspaceRoot:fixtureRoot})})
const approvals = []
ctx.provide('approval', { async request(request) {
  approvals.push({ toolName: request.toolName, reason: request.reason })
  return request.toolName === 'browser_upload' || request.toolName === 'browser_dialog' ? 'allowed-once' : 'denied'
} })
const runtime = new ToolRuntime(ctx)
apply(ctx, { browserBackend:backend, browserHeadless:true, cursorTheme: '', ttlMs: 120000, maxElements: 100, allowedApps: [] })
const agent = { session: {} }
const otherAgent = { session: {} }
const actors = [agent, otherAgent]
const cleanupScope = createToolScope()
let counter = 0
const run = async (name, args = {}, owner = agent) => {
  const result = await runtime.execute({ name, arguments: args, callId: `browser-acceptance-${++counter}`, agent: owner, signal: new AbortController().signal })
  if (result.isError) throw new Error(`${name}: ${result.error?.message || 'ToolRuntime rejected execution'}`)
  return result.value
}
const pageOf = (value) => {
  assert.equal(value?.ok, true, value?.result || 'missing tool result')
  return JSON.parse(value.result)
}
const refOf = (page, name, capability) => {
  const entry = page.refs.find((entry) => entry.name === name && (!capability || entry.actions.includes(capability)))
  assert.ok(entry, `missing ${name} ${capability || ''} ref`)
  return entry.ref
}
const inspect = async () => pageOf(await run('browser_observe'))
const pollPage = async (predicate) => {
  let page
  for (let attempt = 0; attempt < 6; attempt++) {
    page = await inspect()
    if (predicate(page)) return page
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return page
}

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  let page = pageOf(await run('browser_open', { url }))
  check('真实 ToolRuntime 注册并运行独立浏览器工具', page.title === 'DSH isolated browser acceptance')
  check('网页观察无需图片或 DevTools 地址', !('image' in page) && !JSON.stringify(page).includes('devtools'))

  const firstRef = refOf(page, '测试姓名', 'type')
  pageOf(await run('browser_type', { ref: firstRef, text: '待清空中文', replace: true }))
  page = await inspect()
  check('中文输入可观察读回', page.refs.some((entry) => entry.name === '测试姓名' && entry.value === '待清空中文'))
  pageOf(await run('browser_type', { ref: refOf(page, '测试姓名', 'type'), text: '', replace: true }))
  page = await inspect()
  const cleared = page.refs.find((entry) => entry.name === '测试姓名')
  check('replace=true 与空字符串可清空输入框', cleared && (cleared.value === null || cleared.value === '') && !page.outline.includes('待清空中文'))

  const text = '浏览器闭环验收 OK 123'
  pageOf(await run('browser_type', { ref: refOf(page, '测试姓名', 'type'), text, replace: true }))
  const stale = await run('browser_click', { ref: firstRef })
  check('动作后拒绝复用旧快照 ref', stale.ok === false)
  page = await inspect()
  pageOf(await run('browser_click', { ref: refOf(page, '确认测试', 'click') }))
  page = await pollPage((current) => current.outline.includes(`已确认：${text}`))
  check('普通 ref 点击后重新观察确认结果', fixtureState.confirmations === 1 && fixtureState.confirmedValue === text && page.outline.includes(`已确认：${text}`))
  check('普通输入与明确按钮无需额外审批', approvals.length === 0)

  const danger = await run('browser_click', { ref: refOf(page, 'Delete record', 'click') })
  check('英文危险标签触发审批并遵从拒绝', danger.ok === false && approvals.length === 1 && approvals[0].toolName === 'browser_click' && /Delete record/.test(approvals[0].reason))
  page = await inspect()
  check('拒绝危险点击后 fixture 无副作用', fixtureState.dangerousClicks === 0)

  const isolated = await run('browser_observe', {}, otherAgent)
  check('另一个会话无法读取当前浏览器观察', isolated.ok === false)
  const cross = await run('browser_click', { ref: refOf(page, '确认测试', 'click') }, otherAgent)
  check('另一个会话无法使用当前网页 ref', cross.ok === false)

  const scrollRef = page.refs.find((entry) => entry.name === '测试滚动区域' && entry.actions.some((action) => ['pointer', 'scroll'].includes(action)))
  assert.ok(scrollRef, 'missing scroll region ref')
  pageOf(await run('browser_scroll', { ref: scrollRef.ref, direction: 'down', amount: 350 }))
  page = await inspect()
  for (let attempt = 0; attempt < 5 && !scrollEvents; attempt++) await new Promise((resolve) => setTimeout(resolve, 100))
  check('后台 ref 滚动产生真实滚动事件', scrollEvents > 0)

  const batch = await run('run_steps', { steps: [{ tool: 'browser_observe', args: {} }] })
  check('run_steps 通过真实 runtime 嵌套调用浏览器工具', batch.ok === true)

  if(backend==='playwright'){
    page=await inspect()
    pageOf(await run('browser_select',{ref:refOf(page,'测试选择','select'),value:'b'}));page=await inspect()
    check('原生select设置及读回',page.refs.some(entry=>entry.name==='测试选择'&&entry.value==='b'))
    pageOf(await run('browser_click',{ref:refOf(page,'测试复选框','click')}));page=await inspect()
    check('checkbox显式状态读回',page.refs.some(entry=>entry.name==='测试复选框'&&entry.checked===true))
    const verified=await run('browser_verify',{expect:[{kind:'checked',name:'测试复选框',value:true}]})
    check('条件工具通过实际后端检查checked',verified.ok===true)
    page=await inspect();pageOf(await run('browser_pointer',{action:'double_click',ref:refOf(page,'测试指针','pointer')}));page=await inspect()
    check('double_click真实页面结果',page.outline.includes('双击成功'))
    pageOf(await run('browser_pointer',{action:'right_click',ref:refOf(page,'测试指针','pointer')}));page=await inspect()
    check('right_click真实页面结果',page.outline.includes('右键成功'))
    const shot=await run('browser_screenshot');check('截图attachment及CSS坐标空间',shot.ok&&shot.image?.bytes>0&&shot.data.coordinateSpace==='viewport_css_pixels')
    const tabList=pageOf(await run('browser_tabs',{action:'list'}));const firstTab=tabList.selectedTabId
    pageOf(await run('browser_tabs',{action:'new',url:url+'second'}));let list=pageOf(await run('browser_tabs',{action:'list'}))
    check('独立多tab创建与列举',list.tabs.length===2)
    pageOf(await run('browser_history',{action:'reload'}))
    pageOf(await run('browser_tabs',{action:'select',tab_id:firstTab}));list=pageOf(await run('browser_tabs',{action:'list'}))
    const second=list.tabs.find(tab=>tab.tabId!==firstTab);pageOf(await run('browser_tabs',{action:'close',tab_id:second.tabId}))
    check('精确选择与关闭其他tab',pageOf(await run('browser_tabs',{action:'list'})).tabs.length===1)
    pageOf(await run('browser_navigate',{url:url+'second'}));page=pageOf(await run('browser_history',{action:'back'}));check('back返回真实前页',page.title==='DSH isolated browser acceptance')
    page=pageOf(await run('browser_history',{action:'forward'}));check('forward回到真实后页',page.title==='DSH second page')
    page=pageOf(await run('browser_navigate',{url}))
    const file=join(fixtureRoot,'upload-fixture.txt');await writeFile(file,'upload fixture 中文 OK')
    pageOf(await run('browser_upload',{ref:refOf(page,'测试上传','upload'),files:[file]}));for(let i=0;i<10&&!uploadedText;i++)await new Promise(resolve=>setTimeout(resolve,50))
    check('上传经宿主fixture fs及具体目标审批',uploadedText==='upload fixture 中文 OK')
    page=await inspect();const downloaded=pageOf(await run('browser_download',{ref:refOf(page,'测试下载','click'),destination_root:fixtureRoot}))
    check('下载经宿主fixture sandbox保存新文件',await readFile(downloaded.savedFile,'utf8')==='download fixture OK')
    page=await inspect();const noOverwrite=await run('browser_download',{ref:refOf(page,'测试下载','click'),destination_root:fixtureRoot})
    check('下载不覆盖已有文件',noOverwrite.ok===false&&await readFile(downloaded.savedFile,'utf8')==='download fixture OK')
    page=await inspect();const clicked=await run('browser_click',{ref:refOf(page,'测试对话框','click')});check('触发对话框的点击及时成功返回',clicked.ok===true&&clicked.data.dialogPending===true);
    const dialog=pageOf(await run('browser_dialog',{action:'inspect'}));check('页面dialog检查返回opaque id',Boolean(dialog.dialog?.dialogId))
    pageOf(await run('browser_dialog',{action:'accept',dialog_id:dialog.dialog.dialogId}));page=await inspect();check('审批后处理当前dialog',page.outline.includes('接受对话框'))
    const queried=pageOf(await run('browser_observe',{query:'测试姓名'}));check('query返回匹配当前refs',queried.refs.some(entry=>entry.name==='测试姓名')&&queried.complete===false)
    page=await inspect();pageOf(await run('browser_pointer',{action:'hover',ref:refOf(page,'测试指针','pointer')}));page=await inspect();check('hover产生真实页面结果',page.outline.includes('悬停成功'))
    pageOf(await run('browser_key',{ref:refOf(page,'测试姓名','type'),key:'End'}));page=await inspect();pageOf(await run('browser_type',{ref:refOf(page,'测试姓名','type'),text:' 追加中文'}));page=await inspect();check('按键与默认追加文本读回',page.refs.some(entry=>entry.name==='测试姓名'&&entry.value.endsWith('追加中文')))
    const scoped=pageOf(await run('browser_observe',{scope_ref:refOf(page,'测试滚动区域','pointer')}));check('scope_ref定向子树读取',scoped.scope==='subtree'&&scoped.complete===false)
    page=await inspect();pageOf(await run('browser_pointer',{action:'drag',ref:refOf(page,'拖拽源','pointer'),destination_ref:refOf(page,'拖拽目标','pointer')}));page=await inspect();check('drag产生真实页面drop结果',page.outline.includes('拖拽成功'))
    const long=pageOf(await run('browser_navigate',{url:url+'long'}));check('长页观察返回受限内容及continuation',long.refs.length<=100&&long.outline.length<=16000&&Boolean(long.continuation))
    const next=pageOf(await run('browser_observe',{continuation:long.continuation}));check('continuation读取长页剩余内容',next.outline.includes('END_LONG_FIXTURE'))
    page=await inspect();const subtree=pageOf(await run('browser_observe',{scope_ref:refOf(page,'分页区域','pointer')}));const subtreeNext=pageOf(await run('browser_observe',{continuation:subtree.continuation}));check('子树continuation保留原scope',subtreeNext.scope==='subtree'&&!subtreeNext.refs.some(entry=>entry.name==='Outside scope'))
    page=await inspect();const oldToken=page.continuation;pageOf(await run('browser_click',{ref:refOf(page,'row 0','click')}));const staleToken=await run('browser_observe',{continuation:oldToken});check('mutation使旧continuation失效',staleToken.ok===false)
    let article=pageOf(await run('browser_navigate',{url:url+'article'}))
    check('纯长文零控件仍返回文本continuation',article.refs.length===0&&Boolean(article.continuation)&&!article.outline.includes(articleNonce))
    let articleText=article.outline;let pagesRead=1
    while(article.continuation&&pagesRead<5){article=pageOf(await run('browser_observe',{continuation:article.continuation}));assert.equal(article.refs.length,0);assert.ok(article.outline.length<=16000);articleText+=article.outline;pagesRead++}
    check('纯长文续页可读取末端独有nonce',pagesRead>=3&&article.continuation===null&&articleText.endsWith(articleNonce+'\n'))
    pageOf(await run('browser_close'));check('独立浏览器显式关闭',true)
  }
} catch (error) {
  if (!checks.some((item) => !item.ok)) checks.push({ name: '完整闭环执行', ok: false })
  console.error(`FAIL ${String(error.message).replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, '[URL omitted]')}`)
  process.exitCode = 1
} finally {
  for (const owner of actors) {
    await cleanupScope({ agent: owner }, async () => {
      const state = getSessionState()
      if(state.browser?.backend==='playwright'){await state.browser.context.close().catch(()=>{});await state.browser.browser.close().catch(()=>{});state.browser.untrack?.();state.browser=null;return}
      if (!state.initialized) return
      try {
        await cuaCall('end_session', { session: getDriverSession() })
        state.browser = null
        state.snapshot = null
        state.initialized = false
      } catch (error) {
        console.error(`FAIL 测试会话清理：${error.code || error.name}`)
        process.exitCode = 1
      }
    })
  }
  await rm(fixtureRoot,{recursive:true,force:true})
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  const failed = checks.filter((item) => !item.ok).length
  console.log(`${checks.length - failed}/${checks.length} checks passed; test sessions and HTTP fixture closed.`)
}
