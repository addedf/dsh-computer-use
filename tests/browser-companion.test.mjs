import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {createPlaywrightController} from '../lib/browser-playwright.js'
import {createBrowserController,browserTools} from '../lib/browser.js'
import {createToolScope,getSessionState} from '../lib/session.js'

async function fixture(check,releaseOutcome={closed:true,keptTabs:true,groupCleanup:{ungroupedTabs:1,preservedOutsideScope:0,failedTabs:0,complete:true}}){
  const events=[], pages=[]
  const context=new EventEmitter()
  context.close=async()=>{throw new Error('Must not close user context')}
  context.pages=()=>pages
  context.newPage=async()=>{
    const page=new EventEmitter();let url='about:blank',closed=false
    page.url=()=>url;page.title=async()=> 'Companion test'
    const frame={parentFrame:()=>null,isDetached:()=>false,url:()=>url}
    page.mainFrame=()=>frame
    page.isClosed=()=>closed;page.frames=()=>[]
    page.goto=async(value)=>{url=value}
    page.bringToFront=async()=>{events.push(['focus',pages.indexOf(page)])}
    page.close=async()=>{closed=true;page.emit('close')}
    page.screenshot=async(options)=>{events.push(['screenshot',options]);return Buffer.from('test image')}
    page.viewportSize=()=>null
    page.evaluate=async()=>({width:1440,height:900})
    page.mouse={wheel:async(...args)=>events.push(['wheel',...args]),down:async()=>events.push(['down']),up:async()=>events.push(['up'])}
    pages.push(page);context.emit('page',page);return page
  }
  const browser={contexts:()=>[context],newContext:async()=>{throw new Error('Must not create profile')},close:async()=>{throw new Error('Must not close user browser')}}
  let stopped
  const chromeBridge={start:async()=>{},connect:async(options)=>{stopped=options.onStopped;return {endpointURL:'ws://127.0.0.1/private-test',release:async(options)=>{events.push(['release',options]);return releaseOutcome}}}}
  const playwright={chromium:{connectOverCDP:async(url,options)=>{events.push(['connect',options]);return browser},launch:async()=>{throw new Error('Must not launch another browser')}}}
  const agent={session:{},cancel:()=>events.push(['cancel'])}
  const exec={agent,signal:new AbortController().signal}
  const ctx={get:(name)=>name==='attachments'?{saveImage:async()=>({attachmentId:'test',mediaType:'image/png',bytes:10})}:undefined}
  await createToolScope()(exec,async()=>{
    const controller=createPlaywrightController(ctx,{browserBackend:'chrome-extension'},{chromeBridge,playwright})
    await check({controller,exec,events,pages,ctx,stop:()=>stopped?.(),state:()=>getSessionState()})
  })
}

function pointerRefs(h,names=['Action']){
  const state=h.state().browser,page=state.pages.get(state.tabId),frame=page.mainFrame()
  const targets=names.map((name,index)=>{
    const entry={ref:`pointer-${index}`,name,role:'button',enabled:true,protected:false,actions:['pointer','click'],frame,identity:{tag:'button',type:'',linkDestination:null}}
    const live={...entry,connected:true,inViewport:true,hitTarget:true,backgroundLink:false,identity:{...entry.identity},rect:{x:10,y:10,width:100,height:30}}
    delete live.frame
    const deliver=(kind)=>async(options)=>{if(!options.force)throw new Error('Animation frame stability never completes in this background fixture');h.events.push([kind,entry.ref,options])}
    entry.handle={ownerFrame:async()=>frame,evaluate:async()=>structuredClone(live),click:deliver('pointer-click'),dblclick:deliver('double-click'),hover:deliver('hover'),dispose:async()=>{}}
    return {entry,live}
  })
  state.observed={at:Date.now(),tabId:state.tabId,refs:new Map(targets.map(({entry})=>[entry.ref,entry])),inputBlocked:false}
  return targets
}

function linkRef(h,{href='https://fixture.test/brief?private=not-returned#fragment',name='Brief',target='_blank',download=false}={}){
  const state=h.state().browser,page=state.pages.get(state.tabId),frame=page.mainFrame()
  const entry={ref:'owned-link',name,role:'link',enabled:true,protected:false,actions:['pointer','click'],frame,identity:{tag:'a',type:'',linkDestination:href},link:{href,target,download}}
  const live={...entry,connected:true,inViewport:true,hitTarget:true,identity:{...entry.identity},link:{...entry.link},rect:{x:10,y:10,width:100,height:30}}
  delete live.frame
  entry.handle={ownerFrame:async()=>frame,evaluate:async()=>structuredClone(live),click:async(options)=>h.events.push(['native-link-click',options]),dispose:async()=>{}}
  state.observed={at:Date.now(),url:page.url(),tabId:state.tabId,refs:new Map([[entry.ref,entry]]),inputBlocked:false}
  return {entry,live}
}

test('companion opens only the scoped default context and releases without closing Chrome',async()=>fixture(async({controller,exec,events})=>{
  assert.equal((await controller.open({url:'https://fixture.test/'},exec)).ok,true)
  assert.equal(events.find(e=>e[0]==='connect')[1].noDefaults,true)
  assert.equal((await controller.close({},exec)).ok,true)
  assert.deepEqual(events.find(e=>e[0]==='release'),['release',{keepTabs:true}])
}))

test('release preserves an incomplete ungroup warning without claiming the group was removed',async()=>{
  const outcome={closed:true,keptTabs:true,groupCleanup:{ungroupedTabs:0,preservedOutsideScope:0,failedTabs:1,complete:false},warning:'控制已释放，但部分任务页面未能退出分组。'}
  await fixture(async({controller,exec,state})=>{
    await controller.open({url:'https://fixture.test/'},exec)
    const closed=await controller.close({},exec)
    assert.equal(closed.ok,true)
    assert.deepEqual(closed.data.groupCleanup,outcome.groupCleanup)
    assert.equal(closed.data.warning,outcome.warning)
    assert.ok(closed.data.message.includes(outcome.warning))
    assert.equal(closed.data.message.includes('本次己方标签已取消分组'),false)
    assert.equal(state().browser,null)
  },outcome)
})

test('owner cleanup releases once, clears the old lease and permits a later task to reconnect',async()=>fixture(async({controller,exec,events,state})=>{
  await controller.open({url:'https://fixture.test/'},exec)
  const owned=state().browser
  await Promise.all([owned.dispose(),owned.dispose()])
  assert.equal(owned.released,true)
  assert.equal(state().browser,null)
  assert.equal(events.filter(([name])=>name==='release').length,1)
  assert.equal((await controller.open({url:'https://fixture.test/next'},exec)).ok,true)
  assert.notEqual(state().browser,owned)
  assert.equal(events.filter(([name])=>name==='connect').length,2)
}))

test('opening and selecting companion tabs changes the model target without fronting Chrome',async()=>fixture(async({controller,exec,events})=>{
  const first=await controller.open({url:'https://fixture.test/'},exec)
  await controller.tabs({action:'new',url:'https://fixture.test/second'},exec)
  const selected=await controller.tabs({action:'select',tab_id:first.data.tabId},exec)
  assert.equal(selected.data.url,'https://fixture.test/')
  assert.equal(events.some(([name])=>name==='focus'),false)
}))

test('typing into a companion ref delivers to the owned page without fronting Chrome',async()=>fixture(async({controller,exec,events,state})=>{
  const opened=await controller.open({url:'https://fixture.test/'},exec)
  const entry={ref:'own-input',name:'Name',role:'textbox',enabled:true,actions:['type'],handle:{fill:async(text)=>events.push(['fill',text]),dispose:async()=>{}}}
  state().browser.observed={at:Date.now(),tabId:opened.data.tabId,refs:new Map([[entry.ref,entry]]),inputBlocked:false}
  assert.equal((await controller.type({ref:entry.ref,text:'background input',replace:true},exec)).ok,true)
  assert.deepEqual(events.filter(([name])=>name==='fill'),[['fill','background input']])
  assert.equal(events.some(([name])=>name==='focus'),false)
}))

test('native blank links refuse clicks without invalidating the ref needed for explicit href opening',async()=>fixture(async(h)=>{
  const opened=await h.controller.open({url:'https://fixture.test/'},h.exec)
  const {entry}=linkRef(h),snapshot=h.state().browser.observed
  const refused=await h.controller.click({ref:entry.ref},h.exec)
  assert.equal(refused.ok,false);assert.match(refused.result,/BROWSER_BACKGROUND_LINK_REQUIRES_OPEN/)
  assert.equal(h.events.some(([name])=>name==='native-link-click'||name==='focus'),false)
  assert.equal(h.pages.length,1)
  assert.equal(h.state().browser.observed,snapshot)
  const result=await h.controller.tabs({action:'open_link',ref:entry.ref},h.exec)
  assert.equal(result.ok,true,result.result)
  assert.equal(result.data.action,'open_link')
  assert.equal(result.data.openedUrl,'https://fixture.test/brief')
  assert.equal(result.data.sourceTabId,opened.data.tabId)
  assert.equal(result.data.openedTabId,result.data.tabId)
  assert.notEqual(result.data.openedTabId,opened.data.tabId)
  assert.equal(result.data.navigationOnly,true)
  assert.equal(result.data.clickScriptsExecuted,false)
  assert.equal(result.result.includes('not-returned'),false)
  assert.equal(h.pages.length,2)
  assert.equal(h.pages[1].url(),'https://fixture.test/brief?private=not-returned#fragment')
  assert.equal(h.events.some(([name])=>name==='native-link-click'||name==='focus'),false)
  assert.equal((await h.controller.tabs({action:'list'},h.exec)).data.tabs.length,2)
}))

test('ordinary self-target links retain validated native click delivery without Meta input',async()=>fixture(async(h)=>{
  await h.controller.open({url:'https://fixture.test/'},h.exec)
  const {entry}=linkRef(h,{target:'_self'})
  const result=await h.controller.click({ref:entry.ref},h.exec)
  assert.equal(result.ok,true,result.result)
  const calls=h.events.filter(([name])=>name==='native-link-click')
  assert.equal(calls.length,1)
  assert.equal(calls[0][1].force,true)
  assert.equal(calls[0][1].modifiers,undefined)
  assert.equal(h.pages.length,1)
  assert.equal(h.events.some(([name])=>name==='focus'),false)
}))

test('open_link rejects downloads, scripts, files and embedded credentials without creating a page',async()=>{
  for(const options of [
    {download:true},
    {href:'javascript:window.open("https://fixture.test/")'},
    {href:'file:///private/data.txt'},
    {href:'data:text/html,example'},
    {href:'about:blank'},
    {href:'https://username:password@fixture.test/brief'},
  ])await fixture(async(h)=>{
    await h.controller.open({url:'https://fixture.test/'},h.exec)
    const {entry}=linkRef(h,options)
    const result=await h.controller.tabs({action:'open_link',ref:entry.ref},h.exec)
    assert.equal(result.ok,false);assert.match(result.result,/BROWSER_LINK_UNSUPPORTED/)
    assert.equal(h.pages.length,1)
    assert.equal(h.events.some(([name])=>name==='native-link-click'||name==='focus'),false)
  })
})

test('open_link retains dangerous-link approval and rejects href changes made while waiting',async()=>{
  for(const decision of ['rejected','allowed-once'])await fixture(async(h)=>{
    await h.controller.open({url:'https://fixture.test/'},h.exec)
    const {entry,live}=linkRef(h,{name:'Delete test item'});let approvals=0
    h.ctx.approval={request:async(request)=>{approvals++;assert.equal(request.toolName,'browser_tabs');assert.equal(request.reason.includes('not-returned'),false);if(decision==='allowed-once'){live.identity.linkDestination='https://fixture.test/changed';live.link.href=live.identity.linkDestination}return decision}}
    const result=await h.controller.tabs({action:'open_link',ref:entry.ref},h.exec)
    assert.equal(result.ok,false)
    assert.match(result.result,decision==='rejected'?/rejected/:/BROWSER_TARGET_CHANGED/)
    assert.equal(approvals,1)
    assert.equal(h.pages.length,1)
    assert.equal(h.events.some(([name])=>name==='native-link-click'),false)
  })
})

test('open_link rejects stale, hidden, disabled or semantically changed link refs before page creation',async()=>{
  const changes=[
    (h)=>{h.state().browser.observed.at=Date.now()-120001},
    (_h,target)=>{target.entry.handle.evaluate=async()=>null},
    (_h,target)=>{target.live.enabled=false},
    (_h,target)=>{target.live.name='Different link'},
    (_h,target)=>{target.live.link.href='https://fixture.test/changed'},
  ]
  for(const change of changes)await fixture(async(h)=>{
    await h.controller.open({url:'https://fixture.test/'},h.exec)
    const target=linkRef(h);change(h,target)
    assert.equal((await h.controller.tabs({action:'open_link',ref:target.entry.ref},h.exec)).ok,false)
    assert.equal(h.pages.length,1)
    assert.equal(h.events.some(([name])=>name==='native-link-click'),false)
  })
})

test('Stop during owned page creation prevents open_link navigation without closing any page',async()=>fixture(async(h)=>{
  await h.controller.open({url:'https://fixture.test/'},h.exec)
  const {entry}=linkRef(h),context=h.state().browser.context,newPage=context.newPage
  context.newPage=async()=>{const page=await newPage();h.stop();return page}
  const result=await h.controller.tabs({action:'open_link',ref:entry.ref},h.exec)
  assert.equal(result.ok,false);assert.match(result.result,/CONTROL_STOPPED/)
  assert.equal(h.pages.length,2)
  assert.equal(h.pages[1].url(),'about:blank')
  assert.equal(h.pages.some((page)=>page.isClosed()),false)
  assert.equal(h.events.some(([name])=>name==='native-link-click'||name==='focus'),false)
}))

test('open_link schema uses the existing tabs tool and CUA refuses it without touching the driver',async()=>{
  const definition=browserTools({}, {browserBackend:'cua'}).find((tool)=>tool.name==='browser_tabs')
  assert.ok(definition.parameters.action.enum.includes('open_link'))
  assert.equal(definition.parameters.ref.type,'string')
  let driverCalls=0
  const controller=createBrowserController({}, {browserBackend:'cua'}, {call:async()=>{driverCalls++}})
  const exec={agent:{session:{}},signal:new AbortController().signal}
  await createToolScope()(exec,async()=>{
    const result=await controller.tabs({action:'open_link',ref:'unused'},exec)
    assert.equal(result.ok,false);assert.match(result.result,/BROWSER_UNSUPPORTED/)
    assert.equal(driverCalls,0)
  })
})

test('background click, pointer and wheel routes skip rAF stability only after validating the owned target',async()=>{
  const cases=[
    (h,[{entry}])=>h.controller.click({ref:entry.ref},h.exec),
    (h,[{entry}])=>h.controller.pointer({action:'hover',ref:entry.ref},h.exec),
    (h,[{entry}])=>h.controller.pointer({action:'right_click',ref:entry.ref},h.exec),
    (h,[{entry}])=>h.controller.pointer({action:'double_click',ref:entry.ref},h.exec),
    (h,[{entry}])=>h.controller.scroll({ref:entry.ref,direction:'down',amount:100},h.exec),
    (h,[from,to])=>h.controller.pointer({action:'drag',ref:from.entry.ref,destination_ref:to.entry.ref},h.exec),
  ]
  for(const run of cases)await fixture(async(h)=>{
    await h.controller.open({url:'https://fixture.test/'},h.exec)
    const targets=pointerRefs(h,['Action','Destination'])
    const outcome=await run(h,targets)
    assert.equal(outcome.ok,true,outcome.result)
    assert.equal(h.events.some(([name])=>name==='focus'),false)
    assert.ok(h.events.some(([name])=>['pointer-click','double-click','hover'].includes(name)))
    assert.equal(h.events.filter(([name])=>['pointer-click','double-click','hover'].includes(name)).every(([, ,options])=>options.force===true),true)
    if(h.events.some(([name])=>name==='down'))assert.equal(h.events.filter(([name])=>name==='up').length,1)
  })
})

test('background force never bypasses hidden, disabled, covered, offscreen or changed target checks',async()=>{
  const changes=[
    (target)=>{target.live.connected=false},
    (target)=>{target.live.enabled=false},
    (target)=>{target.live.hitTarget=false},
    (target)=>{target.live.inViewport=false},
    (target)=>{target.live.name='Changed action'},
    (target)=>{target.live.role='link'},
    (target)=>{target.live.identity.type='file'},
    (target)=>{target.entry.handle.evaluate=async()=>null},
  ]
  for(const change of changes)await fixture(async(h)=>{
    await h.controller.open({url:'https://fixture.test/'},h.exec)
    const [target]=pointerRefs(h);change(target)
    const outcome=await h.controller.click({ref:target.entry.ref},h.exec)
    assert.equal(outcome.ok,false)
    assert.equal(h.events.some(([name])=>name==='pointer-click'),false)
    assert.equal(h.events.some(([name])=>name==='focus'),false)
  })
})

test('background target changes during approval are refused before any forced input',async()=>fixture(async(h)=>{
  await h.controller.open({url:'https://fixture.test/'},h.exec)
  const [target]=pointerRefs(h,['Delete test item']);let approvals=0
  h.ctx.approval={request:async()=>{approvals++;target.live.name='Different operation';return 'allowed-once'}}
  const outcome=await h.controller.click({ref:target.entry.ref},h.exec)
  assert.equal(outcome.ok,false)
  assert.match(outcome.result,/BROWSER_TARGET_CHANGED/)
  assert.equal(approvals,1)
  assert.equal(h.events.some(([name])=>name==='pointer-click'),false)
}))

test('background host-clock sampling refuses a moving target without waiting for page rAF',async()=>fixture(async(h)=>{
  await h.controller.open({url:'https://fixture.test/'},h.exec)
  const [target]=pointerRefs(h);let reads=0
  target.entry.handle.evaluate=async()=>({...structuredClone(target.live),rect:{...target.live.rect,x:++reads*10}})
  const outcome=await h.controller.click({ref:target.entry.ref},h.exec)
  assert.equal(outcome.ok,false);assert.match(outcome.result,/BROWSER_TARGET_UNSTABLE/)
  assert.equal(reads,2)
  assert.equal(h.events.some(([name])=>name==='pointer-click'),false)
}))

test('rejected background approval and Stop arriving during inspection never deliver input',async()=>{
  await fixture(async(h)=>{
    await h.controller.open({url:'https://fixture.test/'},h.exec)
    const [target]=pointerRefs(h,['Delete test item'])
    h.ctx.approval={request:async()=> 'rejected'}
    const outcome=await h.controller.click({ref:target.entry.ref},h.exec)
    assert.equal(outcome.ok,false);assert.match(outcome.result,/rejected/)
    assert.equal(h.events.some(([name])=>name==='pointer-click'),false)
  })
  await fixture(async(h)=>{
    await h.controller.open({url:'https://fixture.test/'},h.exec)
    const [target]=pointerRefs(h)
    target.entry.handle.evaluate=async()=>{h.stop();return target.live}
    const outcome=await h.controller.click({ref:target.entry.ref},h.exec)
    assert.equal(outcome.ok,false);assert.match(outcome.result,/CONTROL_STOPPED/)
    assert.equal(h.events.some(([name])=>name==='pointer-click'),false)
  })
})

test('background iframe pointers are refused when the outer hit-target chain is not verified',async()=>fixture(async(h)=>{
  await h.controller.open({url:'https://fixture.test/'},h.exec)
  const [target]=pointerRefs(h),parent=target.entry.frame
  target.entry.frame={parentFrame:()=>parent,isDetached:()=>false}
  const outcome=await h.controller.click({ref:target.entry.ref},h.exec)
  assert.equal(outcome.ok,false);assert.match(outcome.result,/BROWSER_BACKGROUND_FRAME_UNSUPPORTED/)
  assert.equal(h.events.some(([name])=>name==='pointer-click'),false)
}))

test('companion truthfully refuses unsupported file transfers before touching files or targets',async()=>fixture(async({controller,exec})=>{
  const caps=await controller.capabilities({},exec)
  assert.equal(caps.data.existingUserProfile,true)
  assert.equal(caps.data.isolated,false)
  assert.equal(caps.data.headless,false)
  assert.equal(caps.data.background,true)
  assert.equal(caps.data.focusPolicy,'preserve-user-focus')
  assert.equal(caps.data.releasePolicy,'ungroup-preserve-tabs')
  assert.equal(caps.data.transportConcurrency,'parallel-rpc')
  assert.ok(caps.data.tabs.includes('open_link'))
  assert.equal(caps.data.backgroundLinkMode,'explicit-href-navigation')
  assert.equal(caps.data.files.upload,false)
  assert.equal(caps.data.files.download,false)
  assert.match((await controller.upload({files:['/never-read']},exec)).result,/BROWSER_UNSUPPORTED/)
  assert.match((await controller.download({ref:'never-click'},exec)).result,/BROWSER_UNSUPPORTED/)
}))

test('extension Stop latches the DSH owner and allows release without resurrecting Chrome control',async()=>fixture(async({controller,exec,events,stop,state})=>{
  await controller.open({url:'https://fixture.test/'},exec)
  stop()
  assert.equal(state().controlStopped,true)
  assert.match((await controller.observe({},exec)).result,/CONTROL_STOPPED/)
  assert.match((await controller.open({url:'https://fixture.test/'},exec)).result,/CONTROL_STOPPED/)
  assert.equal(events.filter(e=>e[0]==='cancel').length,1)
  assert.equal((await controller.close({},exec)).ok,true)
}))

test('existing-Chrome screenshots retain CSS coordinates without changing user viewport',async()=>fixture(async({controller,exec,events})=>{
  await controller.open({url:'https://fixture.test/'},exec)
  const screenshot=await controller.screenshot({},exec)
  assert.equal(screenshot.ok,true)
  assert.equal(screenshot.data.width,1440)
  assert.equal(screenshot.data.height,900)
  assert.equal(events.find(e=>e[0]==='screenshot')[1].scale,'css')
}))
