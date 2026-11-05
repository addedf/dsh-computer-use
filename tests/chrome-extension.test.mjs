import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { WebSocketServer, WebSocket } from 'ws'
import { chromium } from 'playwright-core'
import { createChromeBroker } from '../chrome-extension/broker.js'

function event(){const listeners=new Set();return {addListener:(fn)=>listeners.add(fn),removeListener:(fn)=>listeners.delete(fn),emit:(...args)=>{for(const fn of listeners)fn(...args)}}}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function fixture(){
  const values=new Map([[10,{id:10,windowId:7,groupId:-1,url:'https://user.example/private',active:true}]])
  const calls=[],events=[],groups=new Map();let nextTab=20,nextGroup=50,nextUuid=0
  const api={
    tabs:{onUpdated:event(),onCreated:event(),onRemoved:event(),onDetached:event(),
      async create(args){calls.push(['create',args]);const tab={id:nextTab++,windowId:args.windowId??7,groupId:-1,url:args.url,active:args.active};values.set(tab.id,tab);api.tabs.onCreated.emit({...tab});return {...tab}},
      async get(id){const tab=values.get(id);if(!tab)throw new Error('No tab');return {...tab}},
      async query(args){calls.push(['query',args]);return [...values.values()].filter((tab)=>tab.groupId===args.groupId).map((tab)=>({...tab}))},
      async group(args){calls.push(['group',args]);const id=args.groupId??nextGroup++;if(!groups.has(id))groups.set(id,{id});for(const tabId of args.tabIds){const tab=values.get(tabId);tab.groupId=id;api.tabs.onUpdated.emit(tabId,{groupId:id},{...tab})}return id},
      async ungroup(ids){for(const id of Array.isArray(ids)?ids:[ids]){calls.push(['ungroup',id]);const tab=values.get(id);if(!tab)throw new Error('No tab');const oldGroup=tab.groupId;tab.groupId=-1;api.tabs.onUpdated.emit(id,{groupId:-1},{...tab});if(![...values.values()].some((value)=>value.groupId===oldGroup))groups.delete(oldGroup)}},
      async update(id,args){calls.push(['update',id,args]);Object.assign(values.get(id),args);return {...values.get(id)}},
      async remove(id){calls.push(['remove',id]);values.delete(id);api.tabs.onRemoved.emit(id,{windowId:7,isWindowClosing:false})},
      async move(id,args){calls.push(['move',id,args]);Object.assign(values.get(id),{windowId:args.windowId});return {...values.get(id)}},
    },
    tabGroups:{async update(id,args){calls.push(['group-update',id,args]);const group={...groups.get(id),id,...args};groups.set(id,group);return group}},
    windows:{async update(id,args){calls.push(['window-update',id,args]);return {id,...args}},async get(id){return {id,left:0,top:0,width:1280,height:800,state:'normal'}}},
    debugger:{onEvent:event(),onDetach:event(),
      async attach(target,version){calls.push(['attach',target,version])},
      async detach(target){calls.push(['detach',target]);api.debugger.onDetach.emit(target,'canceled_by_user')},
      async sendCommand(target,method,params){calls.push(['cdp',target,method,params]);if(method==='Target.getTargetInfo')return {targetInfo:{targetId:`real-${target.tabId}`,type:'page'}};return {ack:true}},
    },
  }
  const broker=createChromeBroker(api,{emit:(value)=>events.push(value),uuid:()=>String(++nextUuid)})
  let id=0
  const command=(method,params={})=>broker.handleCommand({id:++id,method,params})
  const cdp=(owner,method,params={},sessionId)=>command('cdp.send',{owner,message:{id:++id,method,params,...(sessionId?{sessionId}:{})}})
  const open=async(owner='owner-a')=>{assert.ok((await command('session.open',{owner,title:'可见测试'})).result);assert.ok((await cdp(owner,'Target.setAutoAttach',{autoAttach:true,flatten:true})).result.result);const created=await cdp(owner,'Target.createTarget',{url:'about:blank'});assert.equal(created.result.error,undefined);return {targetId:created.result.result.targetId,sessionId:events.filter((e)=>e.owner===owner&&e.message?.method==='Target.attachedToTarget').at(-1).message.params.sessionId}}
  return {api,broker,values,groups,calls,events,command,cdp,open}
}

test('opening a session does not enumerate or attach existing user tabs',async()=>{
  const f=fixture();const result=await f.command('session.open',{owner:'owner-a',title:'Example'})
  assert.equal(result.result.existingUserProfile,true);assert.equal(result.result.upload,false);assert.equal(result.result.download,false)
  assert.equal(result.result.releasePolicy,'ungroup-preserve-tabs')
  assert.deepEqual(f.calls,[]);assert.equal(f.values.size,1)
  const listed=await f.cdp('owner-a','Target.getTargets');assert.deepEqual(listed.result.result.targetInfos,[])
})

test('new pages create a real purple group in background and attach before replying',async()=>{
  const f=fixture();const page=await f.open()
  assert.equal(page.targetId,'real-20')
  assert.ok(f.calls.some(([name,id,args])=>name==='group-update'&&id===50&&args.color==='purple'))
  assert.equal(f.calls.find(([name])=>name==='create')[1].active,false)
  assert.equal(f.calls.some(([name])=>name==='update'||name==='window-update'),false)
  assert.equal(f.events.filter((e)=>e.message?.method==='Target.attachedToTarget').length,1)
  assert.equal(f.values.get(10).groupId,-1)
  assert.equal(f.values.get(10).active,true)
})

test('CDP activation and bringToFront preserve the user selected tab and focused window',async()=>{
  const f=fixture();const page=await f.open();const before=f.calls.length
  assert.equal((await f.cdp('owner-a','Target.activateTarget',{targetId:page.targetId})).result.error,undefined)
  assert.equal((await f.cdp('owner-a','Page.bringToFront',{},page.sessionId)).result.error,undefined)
  assert.deepEqual(f.calls.slice(before),[])
  assert.equal(f.values.get(10).active,true)
  assert.equal(f.values.get(20).active,false)
})

test('an attached iframe cannot use bringToFront to activate its parent Chrome page',async()=>{
  const f=fixture();await f.open()
  f.api.debugger.onEvent.emit({tabId:20},'Target.attachedToTarget',{sessionId:'real-child',targetInfo:{targetId:'child-target',type:'iframe'},waitingForDebugger:false})
  await f.broker.settle()
  const child=f.events.filter((entry)=>entry.message?.method==='Target.attachedToTarget').at(-1).message.params.sessionId
  const before=f.calls.length
  assert.equal((await f.cdp('owner-a','Page.bringToFront',{},child)).result.error,undefined)
  assert.deepEqual(f.calls.slice(before),[])
  assert.equal(f.values.get(10).active,true)
})

test('release preserves owned pages and removes the empty task group without switching tabs',async()=>{
  const f=fixture();await f.open();const result=await f.command('session.close',{owner:'owner-a',keepTabs:true})
  assert.equal(result.result.closed,true)
  assert.equal(f.values.get(20).groupId,-1)
  assert.equal(f.groups.has(50),false)
  assert.deepEqual(result.result.groupCleanup,{ungroupedTabs:1,preservedOutsideScope:0,failedTabs:0,complete:true})
  assert.equal(f.values.has(20),true)
  assert.equal(f.values.get(10).active,true)
  assert.equal(f.calls.some(([name])=>['remove','update','window-update'].includes(name)),false)
  assert.deepEqual(f.broker.snapshot().sessions,[])
})

test('stop ungroups owned pages without closing them or recursively stopping itself',async()=>{
  const f=fixture();await f.open();await f.broker.stop('owner-a');await f.broker.settle()
  assert.equal(f.values.get(20).groupId,-1)
  assert.equal(f.groups.has(50),false)
  assert.equal(f.broker.snapshot().sessions[0].tabCount,0)
  assert.equal(f.broker.snapshot().sessions[0].groupId,null)
  assert.equal(f.events.filter((entry)=>entry.event==='stopped').length,1)
  assert.equal(f.values.has(20),true)
  assert.equal(f.values.get(10).active,true)
  assert.equal(f.calls.some(([name])=>['remove','update','window-update'].includes(name)),false)
})

test('ungrouping the selected owned page preserves that same active page',async()=>{
  const f=fixture();await f.open();f.values.get(10).active=false;f.values.get(20).active=true
  const before=f.calls.length;await f.command('session.close',{owner:'owner-a',keepTabs:true})
  assert.equal(f.values.get(20).groupId,-1)
  assert.equal(f.groups.has(50),false)
  assert.equal(f.values.get(20).active,true)
  assert.equal(f.calls.slice(before).some(([name])=>name==='update'||name==='window-update'),false)
})

test('release never ungroups a user-added page even when it leaves the task group nonempty',async()=>{
  const f=fixture();await f.open();f.values.set(30,{id:30,windowId:7,groupId:50,url:'https://user.example/added',active:true})
  const before=f.calls.length;await f.command('session.close',{owner:'owner-a',keepTabs:true})
  assert.deepEqual(f.calls.slice(before).filter(([name])=>name==='ungroup'),[['ungroup',20]])
  assert.equal(f.values.get(20).groupId,-1)
  assert.equal(f.values.has(30),true)
  assert.equal(f.values.get(30).groupId,50)
  assert.equal(f.values.get(30).active,true)
  assert.equal(f.groups.has(50),true)
})

test('release leaves an owned page that was moved outside the original group untouched',async()=>{
  const f=fixture();await f.open();f.values.get(20).groupId=99
  const result=await f.command('session.close',{owner:'owner-a',keepTabs:true})
  assert.equal(f.calls.some(([name])=>name==='ungroup'),false)
  assert.equal(f.values.has(20),true)
  assert.equal(f.values.get(20).groupId,99)
  assert.equal(result.result.groupCleanup.preservedOutsideScope,1)
})

test('releasing one owner cannot ungroup a different owner task',async()=>{
  const f=fixture();await f.open('owner-a');await f.open('owner-b')
  await f.command('session.close',{owner:'owner-a',keepTabs:true})
  assert.deepEqual(f.calls.filter(([name])=>name==='ungroup'),[['ungroup',20]])
  assert.equal(f.values.get(21).groupId,51)
  assert.equal(f.groups.has(51),true)
  assert.equal(f.broker.snapshot().sessions[0].owner,'owner-b')
})

test('ungroup failures report incomplete UI cleanup while revoking all target authority',async()=>{
  const f=fixture();const page=await f.open()
  f.api.tabs.ungroup=async()=>{throw new Error('Tabs cannot be edited right now')}
  const result=await f.command('session.close',{owner:'owner-a',keepTabs:true})
  assert.equal(result.result.closed,true)
  assert.equal(result.result.groupCleanup.complete,false)
  assert.equal(result.result.groupCleanup.failedTabs,1)
  assert.match(result.result.warning,/部分任务页面未能退出分组/)
  assert.equal(f.values.get(20).groupId,50)
  assert.deepEqual(f.broker.snapshot().sessions,[])
  const refused=await f.cdp('owner-a','Page.bringToFront',{},page.sessionId)
  assert.ok(refused.error)
})

test('repeated stop and close preserve pages and do not ungroup a tab more than once',async()=>{
  const f=fixture();await f.open();await f.broker.stop('owner-a');await f.broker.settle()
  await f.broker.stop('owner-a');await f.broker.settle()
  const [one,two]=await Promise.all([f.command('session.close',{owner:'owner-a',keepTabs:true}),f.command('session.close',{owner:'owner-a',keepTabs:true})])
  assert.equal(one.result.closed,true);assert.equal(two.result.closed,true)
  assert.deepEqual(f.calls.filter(([name])=>name==='ungroup'),[['ungroup',20]])
  assert.equal(f.values.has(20),true)
})

test('a second close after normal release is a harmless no-op',async()=>{
  const f=fixture();await f.open();await f.command('session.close',{owner:'owner-a',keepTabs:true})
  const before=f.calls.length;const result=await f.command('session.close',{owner:'owner-a',keepTabs:true})
  assert.equal(result.result.closed,true);assert.equal(result.result.alreadyClosed,true)
  assert.equal(f.calls.length,before)
})

test('one owner cannot send commands through another owner debugger session',async()=>{
  const f=fixture();const page=await f.open('owner-a');await f.open('owner-b')
  const before=f.calls.filter(([name])=>name==='cdp').length
  const result=await f.cdp('owner-b','Runtime.evaluate',{expression:'document.title'},page.sessionId)
  assert.match(result.result.error.message,/not owned/)
  assert.equal(f.calls.filter(([name])=>name==='cdp').length,before)
  const listed=await f.cdp('owner-a','Target.getTargets');assert.deepEqual(listed.result.result.targetInfos.map((entry)=>entry.targetId),['real-20'])
})

test('manual group changes stop control before another command can be sent',async()=>{
  const f=fixture();const page=await f.open();f.values.get(20).groupId=99
  const result=await f.cdp('owner-a','Runtime.evaluate',{expression:'document.title'},page.sessionId)
  assert.match(result.result.error.message,/left its dedicated group/)
  assert.equal(f.broker.snapshot().sessions[0].stopped,true)
  assert.ok(f.events.some((event)=>event.event==='stopped'&&event.owner==='owner-a'))
  assert.equal(f.calls.some(([name,,method])=>name==='cdp'&&method==='Runtime.evaluate'),false)
})

test('stop persists through host reopen and only trusted popup resume clears it',async()=>{
  const f=fixture();await f.open();await f.broker.stop('owner-a')
  const reopened=await f.command('session.open',{owner:'owner-a'})
  assert.equal(reopened.error.code,'CHROME_CONTROL_STOPPED')
  const resumedByHost=await f.command('session.resume',{owner:'owner-a'});assert.ok(resumedByHost.error)
  await f.broker.resume('owner-a');assert.ok((await f.command('session.open',{owner:'owner-a'})).result)
})

test('restored stopped owners remain stopped across service worker restart',async()=>{
  const f=fixture();const broker=createChromeBroker(f.api,{initialBlockedOwners:['old-owner']})
  const result=await broker.handleCommand({id:1,method:'session.open',params:{owner:'old-owner'}})
  assert.equal(result.error.code,'CHROME_CONTROL_STOPPED')
  await broker.resume('old-owner');const ready=await broker.handleCommand({id:2,method:'session.open',params:{owner:'old-owner'}});assert.ok(ready.result)
  await broker.dispose()
})

test('cleanup closes exact owned tabs and preserves user-added tabs in the group',async()=>{
  const f=fixture();await f.open();f.values.set(30,{id:30,windowId:7,groupId:50,url:'https://user.example/added'})
  const result=await f.command('session.close',{owner:'owner-a',keepTabs:false})
  assert.ok(result.result.closed);assert.equal(f.values.has(20),false);assert.equal(f.values.has(10),true);assert.equal(f.values.has(30),true)
  assert.deepEqual(f.calls.filter(([name])=>name==='remove'),[['remove',20]])
})

test('browser close, profile storage, cookies and network body exports fail closed',async()=>{
  const f=fixture();const page=await f.open()
  for(const [method,params,sessionId]of [['Browser.close',{},undefined],['Storage.clearDataForOrigin',{origin:'https://user.example'},page.sessionId],['Network.getAllCookies',{},page.sessionId],['Network.getResponseBody',{requestId:'x'},page.sessionId],['DOM.setFileInputFiles',{files:['/private/user.txt']},page.sessionId]]){
    const result=await f.cdp('owner-a',method,params,sessionId);assert.ok(result.result.error,method)
  }
  assert.equal(f.values.has(10),true)
})

test('user closing an owned tab stops the session instead of adopting another tab',async()=>{
  const f=fixture();await f.open();await f.api.tabs.remove(20);await f.broker.settle()
  assert.equal(f.broker.snapshot().sessions[0].stopped,true)
  assert.equal(f.calls.filter(([name])=>name==='create').length,1)
  assert.ok(f.events.some((event)=>event.message?.method==='Target.targetDestroyed'))
})

test('network events omit cookie and authorization headers and POST bodies',async()=>{
  const f=fixture();await f.open()
  f.api.debugger.onEvent.emit({tabId:20},'Network.requestWillBeSent',{requestId:'x',request:{url:'https://test.example/',headers:{Cookie:'never',Authorization:'never',Accept:'text/html'},postData:'never'},headersText:'Cookie: never'})
  await f.broker.settle()
  const event=f.events.find((entry)=>entry.message?.method==='Network.requestWillBeSent')
  assert.deepEqual(event.message.params.request.headers,{Accept:'text/html'})
  assert.equal(event.message.params.request.postData,undefined);assert.equal(event.message.params.headersText,undefined)
})

test('only popups created by an owned opener enter the session group',async()=>{
  const f=fixture();await f.open()
  const own={id:31,windowId:7,groupId:-1,url:'https://test.example/brief',openerTabId:20};f.values.set(31,own);f.api.tabs.onCreated.emit({...own});await f.broker.settle()
  assert.equal(f.values.get(31).groupId,50);assert.equal(f.broker.snapshot().sessions[0].tabCount,2)
  const unrelated={id:32,windowId:7,groupId:-1,url:'https://test.example/',openerTabId:10};f.values.set(32,unrelated);f.api.tabs.onCreated.emit({...unrelated});await f.broker.settle()
  assert.equal(f.values.get(32).groupId,-1);assert.equal(f.broker.snapshot().sessions[0].tabCount,2)
})

test('packaged extension identity and PNG action icons are valid',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../chrome-extension/manifest.json',import.meta.url),'utf8'))
  const metadata=JSON.parse(await readFile(new URL('../chrome-extension/extension-id.json',import.meta.url),'utf8'))
  const hex=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)
  assert.equal([...hex].map((char)=>String.fromCharCode(97+parseInt(char,16))).join(''),metadata.id)
  assert.equal(manifest.key,metadata.key)
  assert.equal(manifest.permissions.includes('cookies'),false);assert.equal(manifest.permissions.includes('history'),false)
  assert.equal(manifest.host_permissions,undefined)
  for(const [dimension,path]of Object.entries(manifest.action.default_icon)){
    const bytes=await readFile(new URL('../chrome-extension/'+path,import.meta.url))
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a')
    assert.equal(bytes.readUInt32BE(16),Number(dimension));assert.equal(bytes.readUInt32BE(20),Number(dimension))
  }
})

test('CDP commands without an explicit params object are accepted',async()=>{
  const f=fixture();await f.command('session.open',{owner:'owner-a'})
  const result=await f.command('cdp.send',{owner:'owner-a',message:{id:1,method:'Browser.getVersion'}})
  assert.equal(result.result.result.protocolVersion,'1.3')
})

test('STOP while a tab scope read is pending prevents later debugger delivery',async()=>{
  const f=fixture();const page=await f.open();const entered=deferred(),release=deferred();const get=f.api.tabs.get;let held=false
  f.api.tabs.get=async(id)=>{if(!held){held=true;entered.resolve();return release.promise}return get(id)}
  const pending=f.cdp('owner-a','Runtime.evaluate',{expression:'document.title'},page.sessionId)
  await entered.promise;await f.broker.stop('owner-a')
  assert.equal(f.broker.snapshot().sessions[0].stopped,true)
  release.resolve(await get(20));const result=await pending
  assert.match(result.result.error.message,/stopped|changed/)
  assert.equal(f.calls.some(([name,,method])=>name==='cdp'&&method==='Runtime.evaluate'),false)
  await f.broker.settle()
})

test('resume cannot revive an old command suspended before STOP',async()=>{
  const f=fixture();const page=await f.open();const entered=deferred(),release=deferred();const get=f.api.tabs.get;let held=false
  f.api.tabs.get=async(id)=>{if(!held){held=true;entered.resolve();return release.promise}return get(id)}
  const pending=f.cdp('owner-a','Runtime.evaluate',{expression:'document.title'},page.sessionId)
  await entered.promise;await f.broker.stop('owner-a');await f.broker.settle();await f.broker.resume('owner-a')
  release.resolve(await get(20));const result=await pending
  assert.match(result.result.error.message,/stopped|changed/)
  assert.equal(f.calls.some(([name,,method])=>name==='cdp'&&method==='Runtime.evaluate'),false)
})

test('closing and reopening the same owner cannot inherit an old pending command',async()=>{
  const f=fixture();const page=await f.open();const entered=deferred(),release=deferred();const get=f.api.tabs.get;let held=false
  const oldTab=await get(20)
  f.api.tabs.get=async(id)=>{if(!held){held=true;entered.resolve();return release.promise}return get(id)}
  const pending=f.cdp('owner-a','Runtime.evaluate',{expression:'document.title'},page.sessionId)
  await entered.promise;await f.command('session.close',{owner:'owner-a',keepTabs:false});await f.open('owner-a')
  release.resolve(oldTab);const result=await pending
  assert.match(result.result.error.message,/stopped|changed/)
  assert.equal(f.calls.some(([name,,method])=>name==='cdp'&&method==='Runtime.evaluate'),false)
  assert.equal(f.values.has(21),true)
})

test('STOP during an activation scope read prevents completing the old activation request',async()=>{
  const f=fixture();const page=await f.open();const entered=deferred(),release=deferred();const get=f.api.tabs.get;let held=false
  f.api.tabs.get=async(id)=>{if(!held){held=true;entered.resolve();return release.promise}return get(id)}
  const before=f.calls.length
  const pending=f.cdp('owner-a','Target.activateTarget',{targetId:page.targetId})
  await entered.promise;await f.broker.stop('owner-a');release.resolve(await get(20));const result=await pending
  assert.match(result.result.error.message,/stopped|changed/)
  assert.equal(f.calls.slice(before).some(([name])=>name==='update'||name==='window-update'),false)
  await f.broker.settle()
})

test('a tab creation response after STOP is not grouped, focused or attached',async()=>{
  const f=fixture();await f.command('session.open',{owner:'owner-a'});const entered=deferred(),release=deferred();const create=f.api.tabs.create
  f.api.tabs.create=async(args)=>{const result=await create(args);entered.resolve();await release.promise;return result}
  const pending=f.cdp('owner-a','Target.createTarget',{url:'about:blank'})
  await entered.promise;await f.broker.stop('owner-a');release.resolve();const result=await pending
  assert.match(result.result.error.message,/stopped|changed/)
  assert.equal(f.calls.some(([name])=>['group','update','window-update','attach'].includes(name)),false)
  assert.equal(f.broker.snapshot().sessions[0].tabCount,0)
  assert.equal(f.values.has(10),true)
})

test('STOP during group creation prevents title, focus and debugger actions afterwards',async()=>{
  const f=fixture();await f.command('session.open',{owner:'owner-a'});const entered=deferred(),release=deferred();const group=f.api.tabs.group
  f.api.tabs.group=async(args)=>{const result=await group(args);entered.resolve();await release.promise;return result}
  const pending=f.cdp('owner-a','Target.createTarget',{url:'about:blank'})
  await entered.promise;await f.broker.stop('owner-a');release.resolve();const result=await pending
  assert.match(result.result.error.message,/stopped|changed/)
  assert.equal(f.calls.some(([name])=>['group-update','update','window-update','attach'].includes(name)),false)
  assert.equal(f.events.some((event)=>event.message?.method==='Target.attachedToTarget'),false)
})

test('STOP during debugger attachment prevents target probing and publishing',async()=>{
  const f=fixture();await f.command('session.open',{owner:'owner-a'});const entered=deferred(),release=deferred();const attach=f.api.debugger.attach
  f.api.debugger.attach=async(...args)=>{await attach(...args);entered.resolve();await release.promise}
  const pending=f.cdp('owner-a','Target.createTarget',{url:'about:blank'})
  await entered.promise;await f.broker.stop('owner-a')
  assert.ok(f.events.some((event)=>event.event==='stopped'))
  release.resolve();const result=await pending;await f.broker.settle()
  assert.match(result.result.error.message,/stopped|changed/)
  assert.equal(f.calls.some(([name,,method])=>name==='cdp'&&method==='Target.getTargetInfo'),false)
  assert.equal(f.events.some((event)=>event.message?.method==='Target.attachedToTarget'),false)
  assert.ok(f.calls.some(([name])=>name==='detach'))
})

test('STOP during target probing cannot publish a revived attached session',async()=>{
  const f=fixture();await f.command('session.open',{owner:'owner-a'});const entered=deferred(),release=deferred();const send=f.api.debugger.sendCommand
  f.api.debugger.sendCommand=async(target,method,params)=>{const result=await send(target,method,params);if(method==='Target.getTargetInfo'){entered.resolve();await release.promise}return result}
  const pending=f.cdp('owner-a','Target.createTarget',{url:'about:blank'})
  await entered.promise;await f.broker.stop('owner-a');release.resolve();const result=await pending;await f.broker.settle()
  assert.match(result.result.error.message,/stopped|changed/)
  assert.equal(f.events.some((event)=>event.message?.method==='Target.attachedToTarget'),false)
})

test('STOP notification and latch do not wait for a stalled or failed Chrome detach',async()=>{
  const f=fixture();await f.open();const release=deferred()
  f.api.debugger.detach=()=>release.promise
  const stopped=f.broker.stop('owner-a')
  assert.equal(f.broker.snapshot().sessions[0].stopped,true)
  assert.ok(f.events.some((event)=>event.event==='stopped'))
  await stopped
  const result=await f.command('session.open',{owner:'owner-a'})
  assert.equal(result.error.code,'CHROME_CONTROL_STOPPED')
  release.reject(new Error('Chrome detach failed'));await f.broker.settle()
  assert.equal(f.broker.snapshot().sessions[0].stopped,true)
})

test('another STOP while popup resume waits for cleanup keeps the session stopped',async()=>{
  const f=fixture();await f.open()
  const entered=deferred(),release=deferred();const ungroup=f.api.tabs.ungroup
  f.api.tabs.ungroup=async(id)=>{entered.resolve();await release.promise;return ungroup(id)}
  await f.broker.stop('owner-a');await entered.promise
  const pending=f.broker.resume('owner-a')
  await f.broker.stop('owner-a');release.resolve()
  await assert.rejects(pending,/stopped session changed/)
  assert.equal(f.broker.snapshot().sessions[0].stopped,true)
  await f.broker.settle()
})

test('STOP interrupting close preserves pages and explicit resume starts a fresh group',async()=>{
  const f=fixture();await f.open();const entered=deferred(),release=deferred();const get=f.api.tabs.get;let held=false
  f.api.tabs.get=async(id)=>{if(!held){held=true;entered.resolve();return release.promise}return get(id)}
  const pending=f.command('session.close',{owner:'owner-a',keepTabs:false})
  await entered.promise;await f.broker.stop('owner-a');release.resolve(await get(20))
  const closed=await pending;await f.broker.settle()
  assert.equal(closed.result.keptTabs,true);assert.equal(f.values.has(20),true)
  assert.equal(f.values.get(20).groupId,-1);assert.equal(f.groups.has(50),false)
  assert.equal(f.broker.snapshot().sessions[0].tabCount,0)
  await f.broker.resume('owner-a');await f.open('owner-a')
  assert.equal(f.values.get(21).groupId,51)
  await f.command('session.close',{owner:'owner-a',keepTabs:false})
  assert.equal(f.values.has(21),false);assert.equal(f.values.has(20),true)
})

test('STOP during a close detach takes over ungroup cleanup before ownership is forgotten',async()=>{
  const f=fixture();await f.open();const entered=deferred(),release=deferred();const detach=f.api.debugger.detach
  f.api.debugger.detach=async(target)=>{await detach(target);entered.resolve();await release.promise}
  const pending=f.command('session.close',{owner:'owner-a',keepTabs:true})
  await entered.promise;await f.broker.stop('owner-a');release.resolve()
  const result=await pending;await f.broker.settle()
  assert.equal(result.result.keptTabs,true)
  assert.equal(f.values.get(20).groupId,-1)
  assert.equal(f.groups.has(50),false)
  assert.deepEqual(f.calls.filter(([name])=>name==='ungroup'),[['ungroup',20]])
  assert.equal(f.broker.snapshot().sessions[0].tabCount,0)
})

test('STOP during close ungroup coalesces the same pending tab mutation without losing cleanup',async()=>{
  const f=fixture();await f.open();const entered=deferred(),release=deferred();const ungroup=f.api.tabs.ungroup
  f.api.tabs.ungroup=async(id)=>{entered.resolve();await release.promise;return ungroup(id)}
  const pending=f.command('session.close',{owner:'owner-a',keepTabs:true})
  await entered.promise;await f.broker.stop('owner-a');release.resolve()
  const result=await pending;await f.broker.settle()
  assert.equal(result.result.keptTabs,true)
  assert.equal(result.result.groupCleanup.complete,true)
  assert.equal(f.values.get(20).groupId,-1)
  assert.deepEqual(f.calls.filter(([name])=>name==='ungroup'),[['ungroup',20]])
  assert.equal(f.events.filter((event)=>event.event==='stopped').length,1)
})

test('a user move while close reads tab membership revokes stale ungroup authority',async()=>{
  for(const moved of [{groupId:99,windowId:7},{groupId:50,windowId:9}]){
    const f=fixture();await f.open();const entered=deferred(),release=deferred();const get=f.api.tabs.get;let reads=0
    const prior=await get(20)
    f.api.tabs.get=async(id)=>{if(id===20&&++reads===2){entered.resolve();return release.promise}return get(id)}
    const pending=f.command('session.close',{owner:'owner-a',keepTabs:true})
    await entered.promise;Object.assign(f.values.get(20),moved)
    if(moved.windowId!==7)f.api.tabs.onDetached.emit(20,{oldWindowId:7,oldPosition:0})
    else f.api.tabs.onUpdated.emit(20,{groupId:moved.groupId},{...f.values.get(20)})
    release.resolve(prior)
    const result=await pending
    assert.equal(result.result.groupCleanup.preservedOutsideScope,1)
    assert.equal(f.calls.some(([name])=>name==='ungroup'),false)
    assert.equal(f.values.get(20).groupId,moved.groupId)
    assert.equal(f.values.get(20).windowId,moved.windowId)
  }
})

test('failed Stop group cleanup remains visible through repeated Stop and final release',async()=>{
  const f=fixture();await f.open();let attempts=0
  f.api.tabs.ungroup=async()=>{attempts++;throw new Error('Tabs cannot be edited right now')}
  await f.broker.stop('owner-a');await f.broker.settle()
  assert.equal(f.broker.snapshot().sessions[0].groupCleanup.failedTabs,1)
  await f.broker.stop('owner-a');await f.broker.settle()
  const result=await f.command('session.close',{owner:'owner-a',keepTabs:true})
  assert.equal(result.result.groupCleanup.failedTabs,1)
  assert.match(result.result.warning,/部分任务页面未能退出分组/)
  assert.equal(attempts,1)
})

test('real Playwright CDP client creates a page through the extension broker', {timeout:10000},async()=>{
  const f=fixture();const send=f.api.debugger.sendCommand
  f.api.debugger.sendCommand=async(target,method,params)=>{
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:`real-${target.tabId}`,loaderId:'loader1',url:'about:blank',securityOrigin:'null',mimeType:'text/html'}}}
    if(method==='Page.addScriptToEvaluateOnNewDocument')return {identifier:'script1'}
    if(method==='Page.createIsolatedWorld')return {executionContextId:2}
    if(method==='Runtime.enable')queueMicrotask(()=>f.api.debugger.onEvent.emit(target,'Runtime.executionContextCreated',{context:{id:1,origin:'null',name:'',uniqueId:'ctx1',auxData:{frameId:`real-${target.tabId}`,isDefault:true}}}))
    return send(target,method,params)
  }
  let socket,sequence=0,browser
  const server=new WebSocketServer({host:'127.0.0.1',port:0})
  // Relay broker events without patching or synthesizing any targetInfo fields.
  const originalPush=f.events.push.bind(f.events)
  f.events.push=(event)=>{originalPush(event);if(event.event==='cdp'&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(event.message));return f.events.length}
  await f.command('session.open',{owner:'real-client'})
  server.on('connection',(ws)=>{socket=ws;let queue=Promise.resolve();ws.on('message',(bytes)=>{queue=queue.then(async()=>{const message=JSON.parse(bytes.toString());const answer=await f.broker.handleCommand({id:++sequence,method:'cdp.send',params:{owner:'real-client',message}});ws.send(JSON.stringify(answer.result??{id:message.id,sessionId:message.sessionId,error:{code:-32000,message:answer.error.message}}))}).catch(()=>ws.close())})})
  await once(server,'listening')
  let deadline
  try{
    browser=await chromium.connectOverCDP(`ws://127.0.0.1:${server.address().port}`,{noDefaults:true,timeout:3000,artifactsDir:tmpdir()})
    const page=await Promise.race([browser.contexts()[0].newPage(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Page creation exceeded deadline')),3000)})])
    assert.equal(page.url(),'about:blank')
    const attached=f.events.find((event)=>event.message?.method==='Target.attachedToTarget')
    assert.equal(attached.message.params.targetInfo.browserContextId,'dsh-context-real-client')
    assert.equal(f.values.get(10).groupId,-1)
  }finally{
    clearTimeout(deadline)
    await browser?.close().catch(()=>{})
    for(const client of server.clients)client.terminate()
    await new Promise((resolve)=>server.close(resolve))
    await f.broker.dispose()
  }
})
