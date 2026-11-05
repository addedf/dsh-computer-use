import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChromeBridge, createNativeDecoder, encodeNativeFrame } from '../lib/chrome-bridge.js'

const extensionId='pbnchgmbihcaifkhfebngggflieijidb'
const host=new URL('../tools/chrome-native-host.mjs',import.meta.url)
const delay=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms))
async function until(check){
  const limit=Date.now()+8000
  while(Date.now()<limit){if(check())return;await delay(10)}
  assert.fail('Native transport did not reach the expected state')
}

test('native host waits for DSH, reconnects after restart, and never replays offline messages',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'dsh-native-reconnect-'))
  const path=join(directory,'bridge.sock'),messages=[],received=[]
  let bridge, server, peer
  const child=spawn(process.execPath,[host.pathname,'--socket',path,'--extension-id',extensionId,`chrome-extension://${extensionId}/`],{stdio:['pipe','pipe','pipe']})
  t.after(async()=>{child.kill();peer?.destroy();if(server)await new Promise((resolve)=>server.close(resolve));await bridge?.dispose();await rm(directory,{recursive:true,force:true})})
  child.stdout.on('data',createNativeDecoder((message)=>{
    messages.push(message)
    if(message.type)return
    received.push(message)
    child.stdin.write(encodeNativeFrame({id:message.id,result:{nativeGroup:true,background:true,focusPolicy:'preserve-user-focus',releasePolicy:'ungroup-preserve-tabs',transportConcurrency:'parallel-rpc'}}))
  },(error)=>{throw error}))
  await until(()=>messages.some((message)=>message.type==='bridge-disconnected'))
  assert.equal(child.exitCode,null,'A DSH app that has not started is not a fatal native-host error')
  bridge=createChromeBridge({}, {socketPath:path,extensionId,connectTimeoutMs:8000})
  await bridge.start()
  await until(()=>messages.some((message)=>message.type==='bridge-ready'))
  const lease=await bridge.connect({owner:'before-restart'})
  assert.ok(lease.endpointURL)
  await bridge.dispose()
  await until(()=>messages.at(-1)?.type==='bridge-disconnected')
  assert.equal(child.exitCode,null)
  child.stdin.write(encodeNativeFrame({id:999,result:{offline:'must never reach a later DSH'}}))
  const readiness=messages.filter((message)=>message.type==='bridge-ready').length
  const nextInput=[]
  server=createServer((connection)=>{
    peer=connection
    peer.on('data',createNativeDecoder((message)=>{
      nextInput.push(message)
      if(message.type==='native-hello')peer.write(encodeNativeFrame({type:'bridge-ready',protocol:1}))
    },(error)=>{throw error}))
  })
  await new Promise((resolve)=>server.listen(path,resolve))
  await until(()=>messages.filter((message)=>message.type==='bridge-ready').length>readiness)
  peer.write(encodeNativeFrame({id:42,method:'session.open',params:{owner:'after-restart'}}))
  await until(()=>nextInput.some((message)=>message.id===42))
  assert.equal(received.filter((message)=>message.method==='session.open').length,2)
  assert.equal(nextInput.some((message)=>message.id===999),false,'An offline frame must not be delivered to the replacement DSH socket')
  child.stdin.end()
  assert.deepEqual(await once(child,'exit'),[0,null])
})
