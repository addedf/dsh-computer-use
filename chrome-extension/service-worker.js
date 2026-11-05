import { createChromeBroker, NATIVE_HOST } from './broker.js'

let nativePort = null
let connected = false
let connectionError = ''
let broker = null
let storageFailure = null
let resolveReady, rejectReady
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
void ready.catch(() => {})
const MAX_MESSAGE_BYTES=1024*1024
const TRANSPORT_CONCURRENCY='parallel-rpc'
const messageFits=(value)=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=MAX_MESSAGE_BYTES
const publish = (value) => {
  if(!nativePort)return
  if(!messageFits(value)){
    if(value.owner)void broker.stop(value.owner,'A browser event exceeded the native message size limit.').catch(()=>{})
    return
  }
  try{nativePort.postMessage(value)}catch{}
}
function initializeBroker(stored) {
return createChromeBroker(chrome, {
  emit: publish,
  userAgent: navigator.userAgent,
  initialBlockedOwners: Array.isArray(stored.blockedOwners) ? stored.blockedOwners : [],
  onStatus: (state) => {
    if(storageFailure)return
    let writing
    try{writing=chrome.storage.local.set({blockedOwners:state.blockedOwners})}catch{failStorage('无法保存停止控制状态，连接已保持关闭。请刷新扩展后重试。');return}
    void Promise.resolve(writing).catch(() => failStorage('无法保存停止控制状态，连接已保持关闭。请刷新扩展后重试。'))
    const active = state.sessions.filter((session) => !session.stopped && !session.closing && session.tabCount > 0).length
    void chrome.action.setBadgeText({ text: active ? String(active) : '' })
    void chrome.action.setBadgeBackgroundColor({ color: '#7050e8' })
    void chrome.action.setTitle({ title: active ? 'DSH 正在控制专属分组 · 点击可停止' : 'DSH Chrome 控制 · 点击连接或查看状态' })
  },
})
}

function assertReady(){if(storageFailure)throw storageFailure;if(!broker)throw new Error('DSH 控制状态尚未就绪。')}
function failStorage(message){
  if(storageFailure)return
  storageFailure=new Error(message);connectionError=message;connected=false
  void chrome.action.setBadgeText({text:'ERR'}).catch(()=>{})
  void chrome.action.setTitle({title:'DSH 状态读取失败 · 控制保持关闭'}).catch(()=>{})
  if(broker)for(const session of broker.snapshot().sessions)void broker.stop(session.owner,message).catch(()=>{})
  const port=nativePort;nativePort=null;try{port?.disconnect()}catch{}
}

function status() {
  assertReady()
  const snapshot=broker.snapshot()
  return { connected, connectionError, ...snapshot, capabilities:{...snapshot.capabilities,transportConcurrency:TRANSPORT_CONCURRENCY} }
}
async function dispatchNative(port,request) {
  // CDP may await an in-page Promise indefinitely. Responses are matched by id,
  // so awaiting one command must not hold up Stop, release or another owner.
  // The broker retains target event order and revalidates owner/generation
  // around each asynchronous Chrome operation.
  try{
    await ready
    assertReady()
    if(nativePort!==port)return
    let response=await broker.handleCommand(request)
    assertReady()
    // Only this dispatcher advertises concurrent transport. A new broker
    // imported by an old serial worker must not imply the worker was updated.
    if(request?.method==='session.open'&&response?.result&&typeof response.result==='object'&&!Array.isArray(response.result)){
      response={...response,result:{...response.result,transportConcurrency:TRANSPORT_CONCURRENCY}}
    }
    if(nativePort!==port)return
    const value=messageFits(response)?response:{id:request?.id??null,error:{code:'CHROME_MESSAGE_SIZE',message:'Browser response exceeds the 1 MiB native message limit. Use a smaller screenshot or observation.'}}
    try{port.postMessage(value)}catch{}
  }catch(error){
    if(nativePort===port)try{port.postMessage({id:request?.id??null,error:{code:'CHROME_EXTENSION_ERROR',message:String(error.message||error).slice(0,200)}})}catch{}
  }
}
async function connect() {
  await ready
  assertReady()
  if(nativePort)return status()
  connectionError=''
  let port
  try{port=chrome.runtime.connectNative(NATIVE_HOST)}catch(error){connectionError=String(error.message||error).slice(0,300);throw error}
  nativePort=port;connected=true
  port.onMessage.addListener((request)=>{void dispatchNative(port,request)})
  port.onDisconnect.addListener(()=>{
    if(nativePort!==port)return
    connectionError=chrome.runtime.lastError?.message||'本机连接已结束。'
    nativePort=null;connected=false
    for(const session of broker.snapshot().sessions)void broker.stop(session.owner,'Native host disconnected.').catch(()=>{})
    void chrome.action.setBadgeText({text:''})
    void chrome.action.setTitle({title:'DSH Chrome 控制已断开 · 点击查看'})
  })
  await chrome.action.setBadgeText({text:''})
  await chrome.action.setBadgeBackgroundColor({color:'#7050e8'})
  return status()
}

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  // Runtime messages must come from this extension's trusted popup, never a page.
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return false
  const run=async()=>{
    await ready
    assertReady()
    if(message?.action==='status')return status()
    if(message?.action==='connect')return connect()
    if(message?.action==='stop'){await broker.stop(message.owner);return status()}
    if(message?.action==='resume'){await broker.resume(message.owner);return status()}
    if(message?.action==='stopAll'){for(const session of broker.snapshot().sessions)await broker.stop(session.owner);return status()}
    if(message?.action==='disconnect'){
      for(const session of broker.snapshot().sessions)await broker.stop(session.owner,'Disconnected by the user.')
      const port=nativePort;nativePort=null;connected=false;port?.disconnect();await chrome.action.setBadgeText({text:''});return status()
    }
    throw new Error('Unknown popup action.')
  }
  const respond=(value)=>{try{reply(value)}catch{}}
  run().then((value)=>respond({ok:true,...value}),(error)=>respond({ok:false,connected:false,error:String(error.message||error).slice(0,300)}))
  return true
})

// MV3 listener registration above is synchronous. Do not use top-level await:
// Chrome service workers reject asynchronous module dependency graphs.
async function initialize(){
  try{
    const stored=await chrome.storage.local.get('blockedOwners')
    const blocked=stored?.blockedOwners
    if(blocked!==undefined&&(!Array.isArray(blocked)||blocked.some((owner)=>typeof owner!=='string'||!/^[A-Za-z0-9:_-]{1,200}$/.test(owner))))throw new Error('Invalid stopped-owner storage.')
    broker=initializeBroker({blockedOwners:blocked||[]})
    resolveReady(broker)
  }catch{
    failStorage('无法读取停止控制状态，连接已保持关闭。请刷新扩展后重试。')
    rejectReady(storageFailure)
  }
}
void initialize()
