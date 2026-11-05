import test from 'node:test'
import assert from 'node:assert/strict'
import {createCuaCall} from '../lib/cua.js'
import {createToolScope,getSessionState} from '../lib/session.js'
import plugin from '../index.js'

test('a user stop blocks delivery and session revival but allows owned cleanup', async()=>{
  const calls=[]
  const call=createCuaCall(async(tool)=>{calls.push(tool);return {ok:true}})
  await createToolScope()({agent:{session:{}}},async()=>{
    getSessionState().controlStopped=true
    await assert.rejects(call('click'),{code:'CONTROL_STOPPED'})
    await assert.rejects(call('start_session'),{code:'CONTROL_STOPPED'})
    await call('end_session')
  })
  assert.deepEqual(calls,['end_session'])
})

test('a stop arriving with an ended-session response never replays the action', async()=>{
  const calls=[]
  const call=createCuaCall(async(tool)=>{
    calls.push(tool)
    getSessionState().controlStopped=true
    throw new Error('session has ended')
  })
  await createToolScope()({agent:{session:{}}},async()=>{
    await assert.rejects(call('click'),{code:'CONTROL_STOPPED'})
  })
  assert.deepEqual(calls,['click'])
})

test('cleanup of an already-ended driver session never starts it again',async()=>{
  const calls=[]
  const call=createCuaCall(async(tool)=>{calls.push(tool);throw new Error('session has ended')})
  await createToolScope()({agent:{session:{}}},async()=>{
    getSessionState().controlStopped=true
    await assert.rejects(call('end_session'),/session has ended/)
  })
  assert.deepEqual(calls,['end_session'])
})

test('hiding a stopped or ended cursor never revives its driver session', async()=>{
  const calls=[]
  const call=createCuaCall(async(tool,args)=>{calls.push({tool,args});throw new Error('session has ended')})
  await createToolScope()({agent:{session:{}}},async()=>{
    getSessionState().controlStopped=true
    await assert.rejects(call('set_agent_cursor_enabled',{enabled:false}),/session has ended/)
    await assert.rejects(call('set_agent_cursor_enabled',{enabled:true}),{code:'CONTROL_STOPPED'})
  })
  assert.deepEqual(calls,[{tool:'set_agent_cursor_enabled',args:{enabled:false}}])
})

test('cancellation cleanup prevents ended-session recovery from replaying an in-flight action',async()=>{
  const calls=[]
  const call=createCuaCall(async(tool)=>{
    calls.push(tool)
    getSessionState().controlReleasing=true
    throw new Error('session has ended')
  })
  await createToolScope()({agent:{session:{}}},async()=>{
    await assert.rejects(call('click'),{code:'CONTROL_RELEASED'})
  })
  assert.deepEqual(calls,['click'])
})

test('the registered browser_close can release owned resources after Stop without resuming control',async()=>{
  const definitions=new Map();let released=0
  const ctx={tools:{register(tool){definitions.set(tool.name,tool);return ()=>{}}},on:()=>()=>{},logger:{info(){},warn(){}}}
  plugin.apply(ctx,{ttlMs:120000,maxElements:500,browserBackend:'playwright',desktopIndicator:false})
  const exec={agent:{session:{}},signal:new AbortController().signal}
  await createToolScope()(exec,async()=>{
    const state=getSessionState()
    state.controlStopped=true
    state.browser={backend:'playwright',owned:true,context:{},pages:new Map(),dispose:async()=>{released++}}
    const value=await definitions.get('browser_close').execute({},exec)
    assert.equal(value.ok,true)
    assert.equal(released,1)
    assert.equal(state.browser,null)
    assert.equal(state.controlStopped,true)
  })
})
