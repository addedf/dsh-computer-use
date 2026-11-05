import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const harness=String.raw`
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {pathToFileURL} from 'node:url'
const scenario=process.argv[2]
class Element{
  dataset={};listeners=new Map();hidden=false
  addEventListener(name,callback){this.listeners.set(name,callback)}
}
const popupHtml=fs.readFileSync(new URL('popup.html',pathToFileURL(process.argv[1])),'utf8')
const elements=new Map([...popupHtml.matchAll(/id="([^"]+)"/g)].map((match)=>[match[1],new Element()]))
const document={hidden:false,getElementById:(id)=>elements.get(id)}
const state={ok:true,connected:false,connecting:false,autoConnect:false,connectionError:''}
if(scenario==='offline')Object.assign(state,{autoConnect:true,connectionError:'Specified native messaging host not found.'})
if(scenario==='slow-status'||scenario==='recovery')Object.assign(state,{autoConnect:true,connected:true})
if(scenario==='connecting')Object.assign(state,{autoConnect:true,connecting:true})
let poll,holdStatus=false,resolveStatus,failed=false;const requests=[]
const chrome={runtime:{async sendMessage(message){
  requests.push(message)
  if(failed)throw new Error('Worker temporarily unavailable')
  if(message.action==='status'&&holdStatus){const stale=structuredClone(state);return new Promise((resolve)=>{resolveStatus=()=>resolve(stale)})}
  if(message.action==='connect')Object.assign(state,{autoConnect:true,connected:true,connecting:false,connectionError:''})
  if(message.action==='disconnect')Object.assign(state,{autoConnect:false,connected:false,connecting:false,connectionError:''})
  return structuredClone(state)
}}}
const context=vm.createContext({document,chrome,setTimeout,clearTimeout,setInterval:(callback)=>{poll=callback},console})
const cache=new Map()
async function load(identifier){if(cache.has(identifier))return cache.get(identifier);const module=new vm.SourceTextModule(fs.readFileSync(new URL(identifier),'utf8'),{context,identifier});cache.set(identifier,module);await module.link((specifier,referrer)=>load(new URL(specifier,referrer.identifier).href));return module}
const entry=await load(pathToFileURL(process.argv[1]).href);await entry.evaluate()
const flush=()=>new Promise(setImmediate)
await flush()
assert.equal(JSON.stringify(requests),JSON.stringify([{action:'status'}]),'Opening the popup only reads status; it must not grant trust implicitly')
const connect=elements.get('connect'),revoke=elements.get('revoke-offline')
if(scenario==='permission'){
  assert.equal(connect.textContent,'授权并连接')
  assert.equal(revoke.hidden,true)
  await connect.listeners.get('click')();await flush()
  assert.equal(requests.at(-1).action,'connect')
  assert.equal(connect.textContent,'撤销授权')
  assert.equal(connect.dataset.action,'disconnect')
  poll();await flush()
  assert.equal(requests.filter((message)=>message.action==='connect').length,1)
  await connect.listeners.get('click')();await flush()
  assert.equal(requests.at(-1).action,'disconnect')
  assert.equal(connect.textContent,'授权并连接')
  assert.equal(connect.dataset.action,'connect')
}else if(scenario==='offline'){
  assert.equal(connect.textContent,'立即重试')
  assert.equal(revoke.hidden,false,'Persisted trust must be revocable even when the host is offline')
  assert.match(elements.get('error').textContent,/扩展会自动重试/)
  assert.doesNotMatch(elements.get('error').textContent,/Specified/,'Native transport details must not appear in the popup')
  await revoke.listeners.get('click')();await flush()
  assert.equal(requests.at(-1).action,'disconnect')
  assert.equal(revoke.hidden,true)
  assert.equal(connect.textContent,'授权并连接')
}else if(scenario==='connecting'){
  assert.equal(elements.get('connection').textContent,'正在连接本机 DSH')
  assert.equal(connect.textContent,'撤销授权')
  assert.equal(connect.dataset.action,'disconnect')
  await connect.listeners.get('click')();await flush()
  assert.equal(requests.at(-1).action,'disconnect')
  assert.equal(elements.get('connection').textContent,'尚未授权连接')
}else if(scenario==='slow-status'){
  holdStatus=true;poll();await flush()
  assert.equal(connect.disabled,false,'Status polling must not disable a focused authorization button')
  await connect.listeners.get('click')();await flush()
  assert.equal(requests.at(-1).action,'disconnect','A slow status read must not swallow revocation')
  assert.equal(elements.get('connection').textContent,'尚未授权连接')
  resolveStatus();await flush()
  assert.equal(elements.get('connection').textContent,'尚未授权连接','A stale poll response must not repaint revoked authorization as connected')
  assert.equal(connect.textContent,'授权并连接')
}else if(scenario==='recovery'){
  failed=true;poll();await flush()
  assert.equal(elements.get('connection').textContent,'扩展连接未就绪')
  assert.equal(elements.get('error').hidden,false)
  failed=false;poll();await flush()
  assert.equal(elements.get('connection').textContent,'已连接本机 DSH')
  assert.equal(elements.get('error').hidden,true)
  assert.equal(connect.textContent,'撤销授权')
}else throw new Error('Unknown popup scenario')
assert.equal(requests.every((message)=>['status','connect','disconnect'].includes(message.action)),true)
console.log('popup passed')
`
function checkPopup(scenario){
  const popup=fileURLToPath(new URL('../chrome-extension/popup.js',import.meta.url))
  const result=execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',harness,popup,scenario],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']})
  assert.match(result,/popup passed/)
}
test('popup distinguishes first authorization, automatic connection and revocation',()=>checkPopup('permission'))
test('popup lets an offline user revoke automatic connection authorization',()=>checkPopup('offline'))
test('popup allows revoking authorization while the native handshake is pending',()=>checkPopup('connecting'))
test('popup allows revocation during a slow status poll and ignores the stale reply',()=>checkPopup('slow-status'))
test('popup recovers connection status after a temporary worker failure',()=>checkPopup('recovery'))
