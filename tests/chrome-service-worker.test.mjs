import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { requestRuntimeMessage } from '../chrome-extension/popup-request.js'

// Exercise the actual MV3 entry module and its import graph in a separate VM.
// Unlike importing a broker factory, this catches Chrome's async-module-graph
// startup restriction and observes real listener registration before storage.
const workerPath=fileURLToPath(new URL('../chrome-extension/service-worker.js',import.meta.url))
const harness=String.raw`
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { webcrypto } from 'node:crypto'
const scenario=process.argv[2]
function event(){const listeners=new Set();return {listeners,addListener:(fn)=>listeners.add(fn),removeListener:(fn)=>listeners.delete(fn),emit:(...args)=>{for(const fn of listeners)fn(...args)}}}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const read=deferred(),messages=[],badges=[],nativeCalls=[],readRegistrations=[],ports=[]
const tabs=new Map([[10,{id:10,windowId:7,groupId:-1,active:true}]]);let nextTab=20
let writesFail=false
function createPort(){const port={onMessage:event(),onDisconnect:event(),sent:[],postMessage:(message)=>{port.sent.push(message);messages.push(message)},disconnect(){port.disconnected=true;port.onDisconnect.emit()}};ports.push(port);return port}
const port=createPort()
const api={
  runtime:{id:'fixture-extension',onMessage:event(),getURL:(path)=>'chrome-extension://fixture-extension/'+path,connectNative:(name)=>{nativeCalls.push(name);return nativeCalls.length===1?port:createPort()}},
  storage:{local:{get:()=>{readRegistrations.push(api.runtime.onMessage.listeners.size);return read.promise},set:async()=>{if(writesFail)throw new Error('Storage write failed')}}},
  action:{setBadgeText:async(value)=>{badges.push(value.text)},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
  debugger:{onEvent:event(),onDetach:event(),attach:async()=>{},detach:async()=>{},sendCommand:async({tabId},method)=>method==='Target.getTargetInfo'?{targetInfo:{targetId:'target-'+tabId}}:{}},
  tabs:{onUpdated:event(),onCreated:event(),onRemoved:event(),onDetached:event(),create:async(args)=>{const tab={id:nextTab++,windowId:7,groupId:-1,...args};tabs.set(tab.id,tab);return {...tab}},get:async(id)=>({...tabs.get(id)}),group:async({tabIds})=>{for(const id of tabIds)tabs.get(id).groupId=50;return 50},ungroup:async(id)=>{tabs.get(id).groupId=-1;api.tabs.onUpdated.emit(id,{groupId:-1},{...tabs.get(id)})}},
  tabGroups:{update:async()=>{}},
}
const context=vm.createContext({chrome:api,navigator:{userAgent:'Chrome/156.0.0.0'},crypto:webcrypto,TextEncoder,URL,setTimeout,clearTimeout,console})
const cache=new Map()
async function load(identifier){
  if(cache.has(identifier))return cache.get(identifier)
  const module=new vm.SourceTextModule(fs.readFileSync(new URL(identifier),'utf8'),{context,identifier})
  cache.set(identifier,module)
  await module.link((specifier,referrer)=>load(new URL(specifier,referrer.identifier).href))
  return module
}
const entry=await load(pathToFileURL(process.argv[1]).href)
if(typeof entry.hasTopLevelAwait==='function')assert.equal(entry.hasTopLevelAwait(),false)
if(typeof entry.hasAsyncGraph==='function')assert.equal(entry.hasAsyncGraph(),false)
const evaluated=entry.evaluate()
assert.equal(api.runtime.onMessage.listeners.size,1,'Runtime listener must register during synchronous evaluation')
await evaluated
assert.deepEqual(readRegistrations,[1],'Storage starts only after listener registration')
assert.equal(api.debugger.onEvent.listeners.size,0,'Broker is not opened while stopped-owner storage is pending')
const listener=[...api.runtime.onMessage.listeners][0]
function dispatch(message){let answered=false;const promise=new Promise((resolve)=>{const held=listener(message,{id:api.runtime.id,url:api.runtime.getURL('popup.html')},(value)=>{answered=true;resolve(value)});assert.equal(held,true)});return {promise,answered:()=>answered}}
async function native(request,targetPort=port){targetPort.onMessage.emit(request);for(let n=0;n<100;n++){const response=messages.find((item)=>item.id===request.id);if(response)return response;await new Promise(setImmediate)}throw new Error('No native response for '+request.method)}
async function pendingEvaluation(owner,id){
  assert.ok((await native({id,method:'session.open',params:{owner}})).result)
  const created=await native({id:id+1,method:'cdp.send',params:{owner,message:{id:1,method:'Target.createTarget',params:{url:'about:blank'}}}})
  const targetId=created.result.result.targetId
  const attached=await native({id:id+2,method:'cdp.send',params:{owner,message:{id:2,method:'Target.attachToTarget',params:{targetId}}}})
  const sessionId=attached.result.result.sessionId
  const entered=deferred(),result=deferred(),original=api.debugger.sendCommand
  api.debugger.sendCommand=async(source,method,params)=>{if(method==='Runtime.callFunctionOn'){entered.resolve();return result.promise}return original(source,method,params)}
  const request={id:id+3,method:'cdp.send',params:{owner,message:{id:3,sessionId,method:'Runtime.callFunctionOn',params:{functionDeclaration:'async function(){return await new Promise(()=>{})}',awaitPromise:true}}}}
  port.onMessage.emit(request);await entered.promise
  assert.equal(messages.some((item)=>item.id===request.id),false)
  return {request,result}
}
const status=dispatch({action:'status'}),connect=dispatch({action:'connect'})
await new Promise(setImmediate)
assert.equal(status.answered(),false);assert.equal(connect.answered(),false);assert.equal(nativeCalls.length,0)
if(scenario==='pending'){
  read.resolve({blockedOwners:['stopped-owner']})
  const [state,connected]=await Promise.all([status.promise,connect.promise])
  assert.equal(state.ok,true);assert.deepEqual([...state.blockedOwners],['stopped-owner']);assert.equal(connected.ok,true);assert.equal(nativeCalls.length,1)
  assert.equal(state.capabilities.releasePolicy,'ungroup-preserve-tabs')
  port.onMessage.emit({id:71,method:'session.open',params:{owner:'stopped-owner',title:'Must stay stopped'}})
  await new Promise(setImmediate);await new Promise(setImmediate)
  assert.equal(messages.find((value)=>value.id===71).error.code,'CHROME_CONTROL_STOPPED')
  assert.equal(listener({action:'connect'},{id:api.runtime.id,url:api.runtime.getURL('popup.html')+'/untrusted'},()=>{}),false)
}else if(scenario==='activity-badge'){
  read.resolve({blockedOwners:[]});await Promise.all([status.promise,connect.promise])
  assert.equal(badges.at(-1),'','An idle connection must not leave an ON badge')
  assert.ok((await native({id:81,method:'session.open',params:{owner:'background-owner'}})).result)
  assert.equal(badges.at(-1),'','A connected owner without pages is not active control')
  assert.ok((await native({id:82,method:'cdp.send',params:{owner:'background-owner',message:{id:1,method:'Target.createTarget',params:{url:'about:blank'}}}})).result.result)
  assert.equal(badges.at(-1),'1')
  const detach=deferred();api.debugger.detach=()=>detach.promise
  port.onMessage.emit({id:83,method:'session.close',params:{owner:'background-owner',keepTabs:true}})
  await new Promise(setImmediate);await new Promise(setImmediate)
  assert.equal(badges.at(-1),'','Task completion clears activity before a slow detach finishes')
  assert.equal(messages.some((item)=>item.id===83),false)
  detach.resolve();for(let n=0;n<100&&!messages.some((item)=>item.id===83);n++)await new Promise(setImmediate)
  assert.ok(messages.find((item)=>item.id===83).result.closed)
  assert.equal(messages.find((item)=>item.id===83).result.groupCleanup.complete,true)
  assert.equal(messages.find((item)=>item.id===83).result.groupCleanup.ungroupedTabs,1)
  assert.equal(tabs.get(10).active,true);assert.equal(tabs.get(20).active,false)
  assert.equal(tabs.get(20).groupId,-1)
  await dispatch({action:'disconnect'}).promise
  assert.equal(badges.at(-1),'','Disconnected idle state must not leave an OFF badge')
}else if(scenario==='pending-cdp-close'||scenario==='pending-cdp-stop'){
  read.resolve({blockedOwners:[]});await Promise.all([status.promise,connect.promise])
  const pending=await pendingEvaluation('blocked-evaluation',100)
  const method=scenario==='pending-cdp-close'?'session.close':'session.stop'
  const cleaned=await native({id:104,method,params:{owner:'blocked-evaluation',keepTabs:true}})
  assert.ok(method==='session.close'?cleaned.result.closed:cleaned.result.stopped)
  assert.equal(messages.some((item)=>item.id===pending.request.id),false,'Cleanup must complete before the pending evaluation responds')
  // Other owners can still open and use their independent CDP browser while
  // the first target is indefinitely awaiting an in-page Promise.
  const other=await native({id:105,method:'session.open',params:{owner:'independent-owner'}})
  assert.equal(other.result.transportConcurrency,'parallel-rpc')
  const browser=await native({id:106,method:'cdp.send',params:{owner:'independent-owner',message:{id:4,method:'Browser.getVersion'}}})
  assert.equal(browser.result.result.product,'Chrome/156.0.0.0')
  assert.equal((await dispatch({action:'status'}).promise).capabilities.transportConcurrency,'parallel-rpc')
  for(let n=0;n<100&&tabs.get(20).groupId!==-1;n++)await new Promise(setImmediate)
  assert.equal(tabs.get(20).groupId,-1,'Cleanup must ungroup and preserve the owned page while evaluation is pending')
  assert.equal(tabs.get(20).active,false);assert.equal(tabs.get(10).active,true)
  pending.result.resolve({result:{type:'string',value:'late evaluation'}})
  for(let n=0;n<100&&!messages.some((item)=>item.id===pending.request.id);n++)await new Promise(setImmediate)
  const late=messages.find((item)=>item.id===pending.request.id)
  assert.ok(late.result.error,'A late completion cannot regain the released target')
}else if(scenario==='pending-old-port'){
  read.resolve({blockedOwners:[]});await Promise.all([status.promise,connect.promise])
  const pending=await pendingEvaluation('old-port-owner',110)
  port.disconnect()
  const reconnected=await dispatch({action:'connect'}).promise
  assert.equal(reconnected.connected,true);assert.equal(ports.length,2)
  const fresh=ports[1]
  assert.ok((await native({id:114,method:'session.open',params:{owner:'new-port-owner'}},fresh)).result)
  pending.result.resolve({result:{type:'string',value:'old port reply'}})
  for(let n=0;n<5;n++)await new Promise(setImmediate)
  assert.equal(port.sent.some((item)=>item.id===pending.request.id),false,'Disconnected port must not receive late replies')
  assert.equal(fresh.sent.some((item)=>item.id===pending.request.id),false,'Old replies must not be redirected to a new native port')
  port.onMessage.emit({id:115,method:'session.open',params:{owner:'stale-port-request'}})
  port.onDisconnect.emit()
  for(let n=0;n<5;n++)await new Promise(setImmediate)
  const current=await dispatch({action:'status'}).promise
  assert.equal(current.connected,true)
  assert.equal(current.sessions.some((item)=>item.owner==='stale-port-request'),false,'Stale port messages cannot mutate broker state')
  assert.equal(current.sessions.some((item)=>item.owner==='new-port-owner'&&!item.stopped),true)
}else if(scenario==='read-failure'||scenario==='invalid'){
  if(scenario==='invalid')read.resolve({blockedOwners:'corrupt'})
  else read.reject(new Error('Cannot read storage'))
  const [state,connected]=await Promise.all([status.promise,connect.promise])
  assert.equal(state.ok,false);assert.equal(connected.ok,false);assert.match(state.error,/无法读取停止控制状态/)
  assert.equal(nativeCalls.length,0);assert.equal(api.debugger.onEvent.listeners.size,0);assert.ok(badges.includes('ERR'))
}else if(scenario==='write-failure'){
  read.resolve({blockedOwners:[]});await Promise.all([status.promise,connect.promise]);writesFail=true
  port.onMessage.emit({id:72,method:'session.open',params:{owner:'new-owner',title:'Storage failure must stop'}})
  await new Promise(setImmediate);await new Promise(setImmediate)
  assert.ok(port.disconnected);assert.ok(badges.includes('ERR'))
  const retry=await dispatch({action:'connect'}).promise;assert.equal(retry.ok,false);assert.match(retry.error,/无法保存停止控制状态/);assert.equal(nativeCalls.length,1)
}else throw new Error('Unknown scenario')
console.log(JSON.stringify({scenario,passed:true}))
`

function run(scenario){
  let result
  try{result=execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',harness,workerPath,scenario],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']})}
  catch(error){throw new Error(`Service-worker scenario ${scenario} failed:\n${String(error.stderr||error.message).slice(-6000)}`,{cause:error})}
  assert.equal(JSON.parse(result.trim()).passed,true)
}

test('actual service worker has a synchronous module graph and waits for stored STOP state',()=>run('pending'))
test('service worker clears idle activity badges without waiting for Chrome detach',()=>run('activity-badge'))
test('a pending CDP evaluation cannot block native close or another owner',()=>run('pending-cdp-close'))
test('a pending CDP evaluation cannot block native stop or another owner',()=>run('pending-cdp-stop'))
test('disconnected native requests neither starve nor leak replies into a new port',()=>run('pending-old-port'))
test('service worker storage-read failure responds with error and keeps native access closed',()=>run('read-failure'))
test('corrupt stored STOP state cannot silently become an empty allow state',()=>run('invalid'))
test('losing STOP-state persistence closes an already connected native port',()=>run('write-failure'))

test('popup request times out instead of waiting indefinitely for a failed worker',async()=>{
  await assert.rejects(requestRuntimeMessage({sendMessage:()=>new Promise(()=>{})},{action:'status'},{timeoutMs:10}),/扩展后台未在.*响应.*刷新/)
})
test('popup request preserves worker errors and successful replies',async()=>{
  const expected={ok:false,error:'Stopped-owner storage unavailable'}
  assert.equal(await requestRuntimeMessage({sendMessage:async()=>expected},{action:'status'},{timeoutMs:100}),expected)
  await assert.rejects(requestRuntimeMessage({sendMessage:async()=>{throw new Error('No receiving end')}},{action:'status'},{timeoutMs:100}),/No receiving end/)
})
