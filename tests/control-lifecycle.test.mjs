import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import plugin, { Config } from '../index.js'
import { createToolScope, getSessionState } from '../lib/session.js'
import { cuaCall, withSession } from '../lib/cua.js'

const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function within(promise,ms=2000){
  let timer
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Lifecycle did not settle')),ms)})])}
  finally{clearTimeout(timer)}
}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'dsh-control-lifecycle-'))
  const log=join(root,'calls.jsonl'), driver=join(root,'driver.mjs')
  await writeFile(log,'')
  await writeFile(driver,`#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';\nconst [, , verb, tool, json] = process.argv;\nconst args=JSON.parse(json);\nconst log=${JSON.stringify(log)};\nappendFileSync(log,JSON.stringify({tool,args})+'\\n');\nif(tool==='launch_app'&&args.name==='Delayed'){const deadline=Date.now()+3000;while(Date.now()<deadline&&!readFileSync(log,'utf8').includes('"tool":"end_session"'))await new Promise(r=>setTimeout(r,5));appendFileSync(log,JSON.stringify({tool:'fixture/action-finished',args})+'\\n');}\nconsole.log(JSON.stringify(tool==='launch_app'?{pid:42}:{ok:true}));\n`)
  await chmod(driver,0o700)
  const previous=process.env.CUA_DRIVER_BIN
  process.env.CUA_DRIVER_BIN=driver
  let fiber
  t.after(async()=>{
    await fiber?.dispose()
    if(previous===undefined)delete process.env.CUA_DRIVER_BIN
    else process.env.CUA_DRIVER_BIN=previous
    await rm(root,{recursive:true,force:true})
  })
  const ctx=new Context()
  new SystemPrompt(ctx,{})
  const runtime=new ToolRuntime(ctx)
  ctx.provide('approval',{})
  fiber=ctx.plugin(plugin,{browserBackend:'playwright',cursorTheme:''})
  await tick()
  const calls=async()=>String(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
  const run=(actor,name,args={},signal=new AbortController().signal)=>runtime.execute({name,arguments:args,agent:actor,signal,callId:`lifecycle:${name}`})
  return {ctx,runtime,fiber,calls,run}
}

test('real ToolRuntime and Cordis turn/disposal events release only their owner and allow a later turn',async t=>{
  assert.equal(Config({}).desktopIndicator,false)
  const h=await fixture(t)
  const one={session:{}},two={session:{}}
  assert.equal((await h.run(one,'app_launch',{name:'Fixture'})).isError,false)
  assert.equal((await h.run(two,'app_launch',{name:'Fixture'})).isError,false)
  let stateOne,stateTwo,firstDisposed=0
  await createToolScope()({agent:one},async()=>{
    stateOne=getSessionState();stateOne.snapshot={target:'one'}
    stateOne.browser={owned:true,dispose:async()=>{firstDisposed++},untrack(){}}
  })
  await createToolScope()({agent:two},async()=>{stateTwo=getSessionState();stateTwo.snapshot={target:'two'}})
  const before=await h.calls()
  assert.deepEqual(before.filter(c=>c.tool==='set_agent_cursor_motion').map(c=>c.args.idle_hide_ms),[1000,1000])
  assert.notEqual(stateOne.driverSession,stateTwo.driverSession)
  await h.ctx.parallel('session/event',one.session,{type:'turn/end'})
  assert.equal(firstDisposed,1)
  assert.equal(stateOne.browser,null)
  assert.equal(stateOne.snapshot,null)
  assert.equal(stateOne.initialized,false)
  assert.equal(stateTwo.initialized,true)
  assert.deepEqual(stateTwo.snapshot,{target:'two'})
  let calls=await h.calls()
  assert.deepEqual(calls.filter(c=>c.tool==='end_session').map(c=>c.args.session),[stateOne.driverSession])
  assert.deepEqual(calls.filter(c=>c.tool==='set_agent_cursor_enabled'&&c.args.enabled===false).map(c=>c.args.session),[stateOne.driverSession])
  // A repeated end event is harmless; a new turn acquires its own driver again.
  await h.ctx.parallel('session/event',one.session,{type:'turn/end'})
  assert.equal((await h.run(one,'app_launch',{name:'Fixture'})).isError,false)
  await h.ctx.parallel('agent/disposed',{agent:two})
  calls=await h.calls()
  assert.equal(calls.filter(c=>c.tool==='start_session'&&c.args.session===stateOne.driverSession).length,2)
  assert.deepEqual(calls.filter(c=>c.tool==='end_session').map(c=>c.args.session),[stateOne.driverSession,stateTwo.driverSession])
  assert.equal(stateTwo.snapshot,null)
  await h.fiber.dispose()
  calls=await h.calls()
  assert.equal(calls.filter(c=>c.tool==='end_session'&&c.args.session===stateOne.driverSession).length,2)
})

test('cancellation revokes the driver immediately, then clears late resources without removing the Stop latch',async t=>{
  const h=await fixture(t)
  const actor={session:{}},cancelled=new AbortController()
  const running=h.run(actor,'app_launch',{name:'Delayed'},cancelled.signal)
  // Wait for the fixture to receive the actual action, then cancel while its
  // response is pending. Kill this invocation promptly, and repeat owner
  // cleanup after it settles; cancellation must not wait for a late success.
  // Driver initialization launches three CLI children before the action. Give
  // their startup enough time under the full suite's parallel process load.
  const startupDeadline=Date.now()+5000
  let observed=false
  while(Date.now()<startupDeadline){
    if((await h.calls()).some(c=>c.tool==='launch_app')){observed=true;break}
    await new Promise(resolve=>setTimeout(resolve,5))
  }
  assert.equal(observed,true,'Delayed driver did not receive launch_app within 5s')
  cancelled.abort()
  const outcome=await running
  // ToolRuntime owns the public cancellation envelope; the driver layer's
  // CANCELLED error is separately covered by cua-cancellation.test.mjs.
  assert.equal(outcome.isError,true)
  assert.equal(outcome.error.info.code,'ABORTED')
  await h.ctx.parallel('session/event',actor.session,{type:'turn/end'})
  const calls=await h.calls()
  const ends=calls.flatMap((c,i)=>c.tool==='end_session'?[i]:[])
  assert.equal(ends.length,2)
  assert.ok(ends[0]<ends[1])
  assert.equal(calls.some(c=>c.tool==='fixture/action-finished'),false)
  assert.equal(calls.filter(c=>c.tool==='launch_app').length,1)
  await createToolScope()({agent:actor},async()=>{
    const state=getSessionState();assert.equal(state.initialized,false)
    state.controlStopped=true
    state.browser={owned:true,dispose:async()=>{},untrack(){}}
  })
  await h.run(actor,'computer_wait',{ms:0})
  await h.ctx.parallel('session/event',actor.session,{type:'turn/end'})
  await createToolScope()({agent:actor},async()=>assert.equal(getSessionState().controlStopped,true))
})

test('a scoped condition-driver call is cleaned up even without wrapper initialization',async t=>{
  const h=await fixture(t),actor={session:{}}
  await h.run(actor,'computer_wait',{ms:0})
  let driverSession
  await createToolScope()({agent:actor},async()=>{
    assert.equal(getSessionState().initialized,undefined)
    driverSession=getSessionState().driverSession
    await cuaCall('verify_state',withSession({pid:42,window_id:7,expect:[]}))
  })
  await h.ctx.parallel('session/event',actor.session,{type:'turn/end'})
  const calls=await h.calls()
  assert.deepEqual(calls.slice(0,2).map(c=>c.tool),['verify_state','set_agent_cursor_enabled'])
  assert.deepEqual(calls.slice(2,-1).map(c=>c.tool).sort(),['get_agent_cursor_state','get_session'])
  assert.equal(calls.at(-1).tool,'end_session')
  assert.ok(calls.every(c=>c.args.session===driverSession))
})

test('forced lifecycle work waits behind the active scope instead of running as a nested tool',async()=>{
  const run=createToolScope(),exec={agent:{session:{}}},events=[]
  let cleanup
  await run(exec,async()=>{
    events.push('tool')
    cleanup=run(exec,async()=>{events.push('cleanup')},{enqueue:true})
    await tick()
    events.push('tool finished')
  })
  await cleanup
  assert.deepEqual(events,['tool','tool finished','cleanup'])
})

for(const disposeFails of [false,true])test(`cancel releases a stuck owned browser before queued finalization (${disposeFails?'release failure':'release success'})`,async t=>{
  const h=await fixture(t),one={session:{}},two={session:{}},cancelled=new AbortController()
  await h.run(two,'computer_wait',{ms:0})
  let otherDisposed=0,otherState,ownState,disposeCount=0,untracked=0
  const events=[]
  let entered,interrupt
  const started=new Promise(resolve=>{entered=resolve})
  const stuck=new Promise((_,reject)=>{interrupt=reject})
  const frame={evaluateHandle:()=>{events.push('page call');entered();return stuck.finally(()=>events.push('page call settled'))}}
  const page={isClosed:()=>false,url:()=> 'https://fixture.test/',title:async()=> 'Stuck fixture',frames:()=>[frame]}
  await createToolScope()({agent:two},async()=>{
    otherState=getSessionState()
    otherState.browser={owned:true,dispose:async()=>{otherDisposed++}}
  })
  await createToolScope()({agent:one},async()=>{
    ownState=getSessionState()
    ownState.snapshot={before:'cancel'}
    ownState.browser={
      owned:true,backend:'playwright',context:{},pages:new Map([['fixture',page]]),tabId:'fixture',observed:null,dialogs:new Map(),continuations:new Map(),
      dispose:async()=>{
        disposeCount++;events.push('dispose')
        interrupt(new Error('Own transport closed'))
        if(disposeFails)throw new Error('Native release failed after transport closure')
      },
      untrack:()=>{untracked++;events.push('untrack')},
    }
  })
  const running=h.run(one,'browser_observe',{},cancelled.signal)
  try{
    await within(started)
    ownState.controlStopped=true
    cancelled.abort()
    await within(running)
    await h.ctx.parallel('session/event',one.session,{type:'turn/end'}).catch(()=>undefined)
    assert.equal(disposeCount,1)
    assert.equal(untracked,1)
    assert.ok(events.indexOf('dispose')<events.indexOf('page call settled'))
    assert.ok(events.indexOf('page call settled')<events.indexOf('untrack'))
    assert.equal(ownState.browser,null)
    assert.equal(ownState.snapshot,null)
    assert.equal(ownState.controlReleasing,false)
    assert.equal(ownState.controlStopped,true)
    assert.equal(otherDisposed,0)
    assert.ok(otherState.browser?.owned)
    // Repeated finalization is terminal, including a failed native release.
    await h.ctx.parallel('session/event',one.session,{type:'turn/end'})
    assert.equal(disposeCount,1)
    assert.equal(untracked,1)
  }finally{
    interrupt(new Error('Test cleanup'))
    await running
  }
})
