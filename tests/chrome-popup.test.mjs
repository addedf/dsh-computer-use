import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('popup polling preserves the live Stop button and recovers its view after errors',()=>{
  const popup=fileURLToPath(new URL('../chrome-extension/popup.js',import.meta.url))
  const script=String.raw`
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {pathToFileURL} from 'node:url'
class Element{
  children=[];dataset={};listeners=new Map();hidden=false;replacements=0
  constructor(tagName=''){this.tagName=tagName}
  addEventListener(name,callback){this.listeners.set(name,callback)}
  replaceChildren(...children){this.children=children;this.replacements++}
  append(...children){this.children.push(...children)}
}
const elements=new Map(['connection','connect','stop-all','error','sessions','compatibility-summary','compatibility-local','compatibility-worker'].map((id)=>[id,new Element()]))
const document={hidden:false,getElementById:(id)=>elements.get(id),createElement:(tagName)=>new Element(tagName)}
const state={ok:true,connected:true,connectionError:'',sessions:[{owner:'owned-task',title:'Visible test',stopped:false,tabCount:2}],blockedOwners:[]}
let poll,failed=false;const requests=[]
const chrome={runtime:{async sendMessage(message){requests.push(message);if(failed)throw new Error('Worker temporarily unavailable');if(message.action==='stop')state.sessions[0].stopped=true;return structuredClone(state)}}}
const context=vm.createContext({document,chrome,setTimeout,clearTimeout,setInterval:(callback)=>{poll=callback},console})
const cache=new Map()
async function load(identifier){if(cache.has(identifier))return cache.get(identifier);const module=new vm.SourceTextModule(fs.readFileSync(new URL(identifier),'utf8'),{context,identifier});cache.set(identifier,module);await module.link((specifier,referrer)=>load(new URL(specifier,referrer.identifier).href));return module}
const entry=await load(pathToFileURL(process.argv[1]).href);await entry.evaluate()
const flush=()=>new Promise(setImmediate)
await flush()
const list=elements.get('sessions'),first=list.children[0].children.at(-1)
assert.equal(first.textContent,'停止控制');assert.equal(list.replacements,1)
poll();await flush();poll();await flush()
assert.equal(list.children[0].children.at(-1),first,'Unchanged polls must preserve the exact live button')
assert.equal(list.replacements,1)
failed=true;poll();await flush()
assert.equal(elements.get('connection').textContent,'扩展连接未就绪');assert.equal(elements.get('error').hidden,false)
failed=false;poll();await flush()
assert.equal(elements.get('connection').textContent,'已连接本机 DSH');assert.equal(elements.get('error').hidden,true)
assert.equal(list.replacements,2,'Recovery must repaint even when the restored state matches the old fingerprint')
const recovered=list.children[0].children.at(-1)
poll();await flush();assert.equal(list.children[0].children.at(-1),recovered)
recovered.listeners.get('click')();await flush()
assert.ok(requests.some((request)=>request.action==='stop'&&request.owner==='owned-task'))
assert.equal(list.children[0].children.at(-1).textContent,'该任务控制已停止，请在 DSH 新建会话开始下一任务。')
assert.equal(list.children[0].children.some((element)=>element.tagName==='button'),false,'Stopped tasks must not offer a misleading Resume button')
assert.equal(elements.get('stop-all').disabled,true)
state.sessions=[];state.blockedOwners=['prior-stopped-task'];poll();await flush()
assert.equal(list.children[0].children.at(-1).textContent,'该任务控制已停止，请在 DSH 新建会话开始下一任务。')
assert.equal(list.children[0].children.some((element)=>element.tagName==='button'),false,'Persisted stopped tasks must not offer Resume either')
assert.equal(requests.some((request)=>request.action==='resume'),false)
console.log('popup identity and recovery passed')
`
  const result=execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',script,popup],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']})
  assert.match(result,/popup identity and recovery passed/)
})

const diagnosticHarness=String.raw`
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {pathToFileURL} from 'node:url'
const scenario=process.argv[2]
class Element{
  children=[];dataset={};listeners=new Map();hidden=false;replacements=0
  constructor(tagName=''){this.tagName=tagName}
  addEventListener(name,callback){this.listeners.set(name,callback)}
  replaceChildren(...children){this.children=children;this.replacements++}
  append(...children){this.children.push(...children)}
}
const elements=new Map(['connection','connect','stop-all','error','sessions','compatibility-summary','compatibility-local','compatibility-worker'].map((id)=>[id,new Element()]))
const document={hidden:false,getElementById:(id)=>elements.get(id),createElement:(tag)=>new Element(tag)}
const latest={background:true,focusPolicy:'preserve-user-focus',releasePolicy:'ungroup-preserve-tabs',transportConcurrency:'parallel-rpc'}
const old={visible:true,tabGroups:true}
const state={ok:true,connected:true,sessions:[{owner:'own-task',title:'Acceptance',tabCount:1}],blockedOwners:[],capabilities:scenario==='worker-old'?old:latest}
let poll,failed=scenario==='read-failure';const requests=[]
const chrome={runtime:{async sendMessage(message){requests.push(message);if(failed)throw new Error('Worker unavailable');return structuredClone(state)}}}
const context=vm.createContext({document,chrome,setTimeout,clearTimeout,setInterval:(callback)=>{poll=callback},console})
const cache=new Map()
async function load(identifier){
  if(cache.has(identifier))return cache.get(identifier)
  if(scenario==='local-old'&&identifier.endsWith('/broker.js')){
    const module=new vm.SyntheticModule(['CAPABILITIES'],function(){this.setExport('CAPABILITIES',old)},{context,identifier})
    cache.set(identifier,module);return module
  }
  const module=new vm.SourceTextModule(fs.readFileSync(new URL(identifier),'utf8'),{context,identifier})
  cache.set(identifier,module);await module.link((specifier,referrer)=>load(new URL(specifier,referrer.identifier).href));return module
}
const entry=await load(pathToFileURL(process.argv[1]).href);await entry.evaluate()
const flush=()=>new Promise(setImmediate)
await flush()
const summary=elements.get('compatibility-summary'),local=elements.get('compatibility-local'),worker=elements.get('compatibility-worker')
if(scenario==='local-old'){
  assert.match(summary.textContent,/本地扩展文件未更新/)
  assert.doesNotMatch(summary.textContent,/后台服务未刷新/)
  assert.match(local.textContent,/background=缺失.*focusPolicy=缺失.*releasePolicy=缺失/)
  assert.match(worker.textContent,/background=true.*focusPolicy=preserve-user-focus.*releasePolicy=ungroup-preserve-tabs/)
  assert.equal(local.hidden,false);assert.equal(worker.hidden,false)
}else if(scenario==='worker-old'){
  assert.match(summary.textContent,/本地文件已更新，后台服务未刷新/)
  assert.match(local.textContent,/background=true.*focusPolicy=preserve-user-focus.*releasePolicy=ungroup-preserve-tabs/)
  assert.match(worker.textContent,/background=缺失.*focusPolicy=缺失.*releasePolicy=缺失/)
  assert.equal(worker.hidden,false)
}else if(scenario==='latest'){
  assert.match(summary.textContent,/后台操作 · 保留前台 · 结束取消分组.*本地与后台一致/)
  assert.equal(local.hidden,true);assert.equal(worker.hidden,true)
  const list=elements.get('sessions'),button=list.children[0].children.at(-1),replacements=list.replacements
  state.capabilities={...latest,releasePolicy:'collapse-preserve-tabs'};poll();await flush()
  assert.match(summary.textContent,/后台服务未刷新/)
  assert.match(worker.textContent,/releasePolicy=collapse-preserve-tabs/)
  assert.equal(list.children[0].children.at(-1),button,'Capability diagnosis must preserve the existing Stop node')
  assert.equal(list.replacements,replacements)
  state.capabilities=latest;poll();await flush()
  assert.match(summary.textContent,/本地与后台一致/)
  assert.equal(list.children[0].children.at(-1),button)
  assert.equal(worker.hidden,true)
}else if(scenario==='read-failure'){
  assert.match(summary.textContent,/本地文件已更新，后台能力读取失败/)
  assert.doesNotMatch(summary.textContent,/后台服务未刷新/)
  assert.match(local.textContent,/releasePolicy=ungroup-preserve-tabs/)
  assert.equal(worker.textContent,'运行后台：未取得能力信息')
  assert.equal(elements.get('error').hidden,false)
}else throw new Error('Unknown diagnostic scenario')
assert.equal(requests.every((request)=>request.action==='status'),true,'Diagnostics must not request mutations or worker reload')
console.log('diagnostic passed')
`
function checkDiagnostic(scenario){
  const popup=fileURLToPath(new URL('../chrome-extension/popup.js',import.meta.url))
  const result=execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',diagnosticHarness,popup,scenario],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']})
  assert.match(result,/diagnostic passed/)
}
test('popup distinguishes stale bundled files from a new running worker',()=>checkDiagnostic('local-old'))
test('popup identifies a stale running worker despite new bundled files',()=>checkDiagnostic('worker-old'))
test('popup confirms matching capabilities and changes diagnostics without replacing Stop',()=>checkDiagnostic('latest'))
test('popup reports unavailable worker capabilities separately from outdated versions',()=>checkDiagnostic('read-failure'))
