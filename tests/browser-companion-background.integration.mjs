// Explicit real-Chrome regression (kept outside the browser-free unit glob):
// node --test tests/browser-companion-background.integration.mjs
// Owns a fresh headless Chrome process/context; never attaches to user Chrome.
import test from 'node:test'
import assert from 'node:assert/strict'
import {chromium} from 'playwright-core'
import {createPlaywrightController} from '../lib/browser-playwright.js'
import {createToolScope,getSessionState} from '../lib/session.js'

const content=`<!doctype html><meta charset="utf-8"><style>
body{margin:0}button,a{position:absolute;left:30px;top:30px;display:block;width:180px;height:44px}
a{top:110px}#cover{display:none;position:fixed;inset:0;z-index:100;background:white}
</style><button id="action" type="button">Preview</button><a id="brief" href="https://fixture.invalid/old" target="_blank">Brief</a><div id="cover"></div>
<script>window.delivered=[];document.addEventListener('click',event=>window.delivered.push({id:event.target.id,trusted:event.isTrusted}));</script>`

test('real Playwright background actions remain safe when Chrome stops animation frames',{timeout:20000},async(t)=>{
  const browser=await chromium.launch({channel:'chrome',headless:true})
  async function fixture(check,{iframe=false}={}){
    const context=await browser.newContext({viewport:{width:800,height:600}})
    const exec={agent:{session:{}},signal:new AbortController().signal}
    const calls=[]
    const bridge={start:async()=>{},connect:async()=>({endpointURL:'ws://127.0.0.1/unused-test-adapter',release:async()=>({closed:true,keptTabs:true,groupCleanup:{complete:true}})})}
    const library={chromium:{connectOverCDP:async()=>({contexts:()=>[context]})}}
    const ctx={approval:{request:async(request)=>{calls.push(request.toolName);return 'allowed-once'}}}
    try{
      await createToolScope()(exec,async()=>{
        const controller=createPlaywrightController(ctx,{browserBackend:'chrome-extension'},{playwright:library,chromeBridge:bridge})
        await controller.open({url:'about:blank'},exec)
        const state=getSessionState().browser,page=state.pages.get(state.tabId)
        await page.setContent(content+(iframe?'<iframe srcdoc="<button>Frame action</button>"></iframe>':''))
        const observed=await controller.observe({},exec)
        assert.equal(observed.ok,true)
        const cdp=await context.newCDPSession(page)
        await cdp.send('Emulation.setVirtualTimePolicy',{policy:'pause'})
        const ref=(name)=>{const found=observed.data.refs.find((entry)=>entry.name===name);assert.ok(found,name);return found.ref}
        await check({controller,exec,page,state,ref,calls})
        await controller.close({},exec)
      })
    }finally{await context.close()}
  }
  try{
    await t.test('ordinary Playwright stalls on stable, but validated controller input delivers a trusted click',async()=>fixture(async({controller,exec,page,state,ref})=>{
      const target=ref('Preview'),handle=state.observed.refs.get(target).handle
      await assert.rejects(handle.click({timeout:250}),(error)=>/visible, enabled and stable/.test(error.message))
      const result=await controller.click({ref:target},exec)
      assert.equal(result.ok,true,result.result)
      assert.deepEqual(await page.evaluate(()=>window.delivered),[{id:'action',trusted:true}])
    }))
    for(const [label,change]of[
      ['hidden',()=>{document.querySelector('#action').style.display='none'}],
      ['disabled',()=>{document.querySelector('#action').disabled=true}],
      ['renamed to an unapproved action',()=>{document.querySelector('#action').textContent='Delete everything'}],
      ['covered by another element',()=>{document.querySelector('#cover').style.display='block'}],
      ['outside the viewport',()=>{document.querySelector('#action').style.top='2000px'}],
    ])await t.test(`${label} targets are rejected before native input`,async()=>fixture(async({controller,exec,page,ref,calls})=>{
      await page.evaluate(change)
      const result=await controller.click({ref:ref('Preview')},exec)
      assert.equal(result.ok,false)
      assert.deepEqual(await page.evaluate(()=>window.delivered),[])
      assert.deepEqual(calls,[])
    }))
    await t.test('a changed link destination is refused instead of navigating to an unapproved URL',async()=>fixture(async({controller,exec,page,ref})=>{
      await page.evaluate(()=>{document.querySelector('#brief').href='https://fixture.invalid/changed'})
      const result=await controller.click({ref:ref('Brief')},exec)
      assert.equal(result.ok,false);assert.match(result.result,/BROWSER_TARGET_CHANGED/)
      assert.equal(page.url(),'about:blank')
      assert.deepEqual(await page.evaluate(()=>window.delivered),[])
    }))
    await t.test('iframe pointer input is refused while outer hit-target verification is unavailable',async()=>fixture(async({controller,exec,page,ref})=>{
      const result=await controller.click({ref:ref('Frame action')},exec)
      assert.equal(result.ok,false);assert.match(result.result,/BROWSER_BACKGROUND_FRAME_UNSUPPORTED/)
      assert.deepEqual(await page.evaluate(()=>window.delivered),[])
    },{iframe:true}))
  }finally{await browser.close()}
})
