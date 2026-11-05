import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlaywrightController } from '../lib/browser-playwright.js'
import { createToolScope, getSessionState } from '../lib/session.js'

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'dsh-pw-boundary-'))
  const scope=createToolScope()
  const owner={agent:{session:{}},signal:new AbortController().signal}
  const page=new EventEmitter()
  page.isClosed=()=>false
  page.url=()=> 'https://example.test/'
  page.goto=async()=>{throw new Error('navigation fixture ends here')}
  const disposed=[]
  const handle={click:async()=>{},dispose:async()=>disposed.push('target')}
  const entry={ref:'p:1',name:'Confirm',actions:['click'],handle,frame:{}}
  const state={backend:'playwright',owned:true,context:{},pages:new Map([['tab',page]]),tabId:'tab',dialogs:new Map(),continuations:new Map([['old',{tabId:'tab',url:page.url(),snapshotId:'p',offset:1}]]),observed:{at:1000,tabId:'tab',snapshotId:'p',refs:new Map([['p:1',entry]])},screenshot:null}
  const ctx={approval:{request:async()=> 'allowed-once'},sandboxPolicy:{resolve:async()=>({mode:'workspace-write',workspaceRoot:root})}}
  try {
    await scope(owner,async()=>{getSessionState().browser=state;const c=createPlaywrightController(ctx,{ttlMs:100},{now:()=>1000});await run({c,state,page,handle,disposed,root,owner,ctx})})
  } finally { await rm(root,{recursive:true,force:true}) }
}

test('mutation releases retired handles after dispatch and invalidates continuation',async()=>fixture(async({c,state,handle,disposed,owner})=>{
  handle.click=async()=>assert.deepEqual(disposed,[])
  const result=await c.click({ref:'p:1'},owner)
  assert.equal(result.ok,true)
  assert.deepEqual(disposed,['target'])
  assert.equal(state.continuations.size,0)
  assert.equal(state.observed,null)
}))

test('navigation invalidates continuation and disposes old refs even when navigation fails',async()=>fixture(async({c,state,disposed,owner})=>{
  const result=await c.navigate({url:'https://example.test/next'},owner)
  assert.equal(result.ok,false)
  assert.equal(state.continuations.size,0)
  assert.deepEqual(disposed,['target'])
}))

test('click failure disposes the download listener instead of leaving a live timeout',async()=>fixture(async({c,page,handle,root,owner})=>{
  handle.click=async()=>{throw new Error('click failed')}
  const result=await c.download({ref:'p:1',destination_root:root},owner)
  assert.equal(result.ok,false)
  assert.equal(page.listenerCount('download'),0)
  assert.deepEqual(await readdir(root),[])
}))

test('cancellation after the download event cannot create a destination file',async()=>fixture(async({c,page,handle,root,owner})=>{
  const abort=new AbortController();owner.signal=abort.signal
  let streamRequested=false
  handle.click=async()=>{
    page.emit('download',{suggestedFilename:()=> 'fixture.txt',cancel:async()=>{},createReadStream:async()=>{streamRequested=true;return[]}})
    abort.abort()
  }
  const result=await c.download({ref:'p:1',destination_root:root},owner)
  assert.equal(result.ok,false)
  assert.equal(JSON.parse(result.result).code,'ABORTED')
  assert.equal(streamRequested,false)
  assert.deepEqual(await readdir(root),[])
  assert.equal(page.listenerCount('download'),0)
}))

test('cancellation at an empty stream end removes the newly created zero-byte file',async()=>fixture(async({c,page,handle,root,owner})=>{
  const abort=new AbortController();owner.signal=abort.signal
  let canceled=false
  handle.click=async()=>page.emit('download',{
    suggestedFilename:()=> 'fixture.txt',cancel:async()=>{canceled=true},failure:async()=>null,
    // eslint-disable-next-line require-yield -- Empty stream tests cancellation at EOF.
    createReadStream:async()=>Readable.from((async function*(){abort.abort()})()),
  })
  const result=await c.download({ref:'p:1',destination_root:root},owner)
  assert.equal(result.ok,false)
  assert.equal(canceled,true)
  assert.deepEqual(await readdir(root),[])
}))

test('file operations refuse unconfigured host services before reading or clicking',async()=>fixture(async({state,page,handle,owner,root})=>{
  let clicked=false;handle.click=async()=>{clicked=true}
  const c=createPlaywrightController({}, {}, {now:()=>1000})
  const download=await c.download({ref:'p:1',destination_root:root},owner)
  assert.equal(download.ok,false)
  assert.equal(JSON.parse(download.result).code,'FILE_AUTHORIZATION_UNAVAILABLE')
  const entry=state.observed.refs.get('p:1');entry.actions.push('upload')
  const upload=await c.upload({ref:'p:1',files:[join(root,'file.txt')]},owner)
  assert.equal(upload.ok,false)
  assert.equal(clicked,false)
  assert.equal(page.listenerCount('download'),0)
}))

test('rejected upload approval cannot read file contents',async()=>fixture(async({c,state,root,owner,ctx,page,handle})=>{
  const target=state.observed.refs.get('p:1');target.actions.push('upload')
  target.frame={url:page.url,isDetached:()=>false}
  handle.ownerFrame=async()=>target.frame
  handle.evaluate=async()=>({name:target.name,role:'fileinput',enabled:true,protected:false,actions:['upload']})
  let reads=0
  ctx.fs={readBytes:async()=>{reads++;return Buffer.from('test')}}
  ctx.approval.request=async()=> 'rejected'
  const value=await c.upload({ref:'p:1',files:[join(root,'selected.txt')]},owner)
  assert.equal(value.ok,false)
  assert.match(value.result,/rejected/)
  assert.equal(reads,0)
}))

test('upload approval retains exact escaped paths and safe destination before host reads',async()=>fixture(async({c,state,page,handle,root,owner,ctx})=>{
  const target=state.observed.refs.get('p:1');target.actions.push('upload');target.role='fileinput'
  const selected=join(root,'long-'.repeat(160)+'selected.txt')
  page.url=()=> 'https://example.test/upload?private=query#hidden'
  target.frame={url:page.url,isDetached:()=>false}
  handle.ownerFrame=async()=>target.frame
  handle.evaluate=async()=>({name:target.name,role:'fileinput',enabled:true,protected:false,actions:['upload']})
  let approved=false,reads=0
  ctx.approval.request=async(req)=>{
    assert.equal(req.toolName,'browser_upload')
    assert.ok(req.reason.includes(JSON.stringify(selected)))
    assert.ok(req.reason.includes('https://example.test/upload'))
    assert.ok(!req.reason.includes('private=query'))
    assert.ok(!req.reason.includes('#hidden'))
    approved=true;return 'allowed-once'
  }
  ctx.fs={processPathFromHostPath:path=>path,resolve:path=>({displayPath:path}),lstat:async()=>({type:'file',size:4}),stat:async()=>({type:'file',size:4}),readBytes:async()=>{assert.equal(approved,true);reads++;return Buffer.from('test')}}
  handle.setInputFiles=async(payloads)=>assert.equal(payloads[0].buffer.toString(),'test')
  const value=await c.upload({ref:'p:1',files:[selected]},owner)
  assert.equal(value.ok,true)
  assert.equal(reads,1)
}))

test('abort destroys a stalled download stream promptly and removes the partial file',async()=>fixture(async({c,page,handle,root,owner})=>{
  const abort=new AbortController();owner.signal=abort.signal
  let requested
  const streamReady=new Promise(resolve=>{requested=resolve})
  const stream=new Readable({read(){}})
  let canceled=0
  handle.click=async()=>page.emit('download',{
    suggestedFilename:()=> 'stalled.txt',cancel:async()=>{canceled++},failure:async()=>null,
    createReadStream:async()=>{requested();return stream},
  })
  const running=c.download({ref:'p:1',destination_root:root},owner)
  await streamReady
  await new Promise(resolve=>setImmediate(resolve))
  abort.abort()
  let timer
  let result
  try{result=await Promise.race([running,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('abort did not stop download')),500)})])}finally{clearTimeout(timer)}
  assert.equal(result.ok,false)
  assert.equal(JSON.parse(result.result).code,'ABORTED')
  assert.equal(stream.destroyed,true)
  assert.ok(canceled>0)
  assert.deepEqual(await readdir(root),[])
}))
