import { createChromeBroker, NATIVE_HOST } from './broker.js'

let nativePort = null
let connected = false
let connecting = false
let autoConnect = false
let hasConnectionPreference = false
let connectionError = ''
let broker = null
let storageFailure = null
let reconnectTimer = null
let reconnectDelay = 1000
let transportGeneration = 0
let preferenceTail = Promise.resolve()
let resolveReady, rejectReady
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
void ready.catch(() => {})
const MAX_MESSAGE_BYTES=1024*1024
const TRANSPORT_CONCURRENCY='parallel-rpc'
const RECONNECT_ALARM='dsh-native-reconnect'
const messageFits=(value)=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=MAX_MESSAGE_BYTES
const publish = (value) => {
  if(!nativePort||!connected)return
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
    void chrome.action.setBadgeBackgroundColor({ color: '#252525' })
    void chrome.action.setTitle({ title: 'DSH Chrome 控制 · 点击查看授权状态' })
  },
})
}

function assertReady(){if(storageFailure)throw storageFailure;if(!broker)throw new Error('DSH 控制状态尚未就绪。')}
function cancelReconnect(){
  clearTimeout(reconnectTimer);reconnectTimer=null
  void chrome.alarms.clear(RECONNECT_ALARM).catch(()=>{})
}
function stopOwners(reason){
  if(broker)for(const session of broker.snapshot().sessions)if(!session.stopped&&!session.closing)void broker.stop(session.owner,reason).catch(()=>{})
}
function failStorage(message){
  if(storageFailure)return
  storageFailure=new Error(message);connectionError=message;connected=false;connecting=false
  ++transportGeneration;cancelReconnect()
  void chrome.action.setBadgeText({text:'ERR'}).catch(()=>{})
  void chrome.action.setTitle({title:'DSH 状态读取失败 · 控制保持关闭'}).catch(()=>{})
  stopOwners(message)
  const port=nativePort;nativePort=null;try{port?.disconnect()}catch{}
}
function scheduleReconnect(){
  if(!autoConnect||storageFailure||nativePort||reconnectTimer)return
  // Alarms survive MV3 suspension; the short timer also covers a DSH task
  // started immediately after a native-host crash.
  void chrome.alarms.create(RECONNECT_ALARM,{periodInMinutes:0.5}).catch(()=>{})
  reconnectTimer=setTimeout(()=>{reconnectTimer=null;void connect().catch(()=>{})},reconnectDelay)
  reconnectDelay=Math.min(30000,reconnectDelay*2)
}
function status() {
  assertReady()
  const snapshot=broker.snapshot()
  return { connected, connecting, autoConnect, connectionError, ...snapshot, capabilities:{...snapshot.capabilities,transportConcurrency:TRANSPORT_CONCURRENCY} }
}
async function dispatchNative(port,request) {
  const generation=transportGeneration
  // Responses are matched by id. A pending page command must never block Stop,
  // another owner, or be replayed into a newly connected DSH process.
  try{
    await ready
    assertReady()
    if(nativePort!==port||!connected||generation!==transportGeneration)return
    let response=await broker.handleCommand(request)
    assertReady()
    if(request?.method==='session.open'&&response?.result&&typeof response.result==='object'&&!Array.isArray(response.result)){
      response={...response,result:{...response.result,transportConcurrency:TRANSPORT_CONCURRENCY}}
    }
    if(nativePort!==port||!connected||generation!==transportGeneration)return
    const value=messageFits(response)?response:{id:request?.id??null,error:{code:'CHROME_MESSAGE_SIZE',message:'Browser response exceeds the 1 MiB native message limit. Use a smaller screenshot or observation.'}}
    try{port.postMessage(value)}catch{}
  }catch(error){
    if(nativePort===port&&connected&&generation===transportGeneration)try{port.postMessage({id:request?.id??null,error:{code:'CHROME_EXTENSION_ERROR',message:String(error.message||error).slice(0,200)}})}catch{}
  }
}
async function connect() {
  await ready
  assertReady()
  if(!autoConnect||nativePort)return status()
  cancelReconnect();connecting=true;connectionError=''
  let port
  try{port=chrome.runtime.connectNative(NATIVE_HOST)}catch(error){
    connecting=false;connectionError=String(error.message||error).slice(0,300);scheduleReconnect();return status()
  }
  nativePort=port;connected=false;++transportGeneration
  port.onMessage.addListener((request)=>{
    if(nativePort!==port)return
    if(request?.type==='bridge-ready'&&request.protocol===1){
      connected=true;connecting=false;connectionError='';reconnectDelay=1000
      cancelReconnect()
      void chrome.action.setTitle({title:'DSH Chrome 控制 · 已连接，等待任务'})
    }else if(request?.type==='bridge-disconnected'&&request.protocol===1){
      connected=false;connecting=true;++transportGeneration
      connectionError='正在等待本机 DSH，启动后将自动连接。'
      stopOwners('Local DSH bridge disconnected.')
      void chrome.action.setBadgeText({text:''})
    }else if(!request?.type){void dispatchNative(port,request)}
  })
  port.onDisconnect.addListener(()=>{
    if(nativePort!==port)return
    connectionError=chrome.runtime.lastError?.message||'本机连接已结束，正在自动重试。'
    nativePort=null;connected=false;connecting=false;++transportGeneration
    stopOwners('Native host disconnected.')
    void chrome.action.setBadgeText({text:''})
    void chrome.action.setTitle({title:'DSH Chrome 控制 · 等待自动重连'})
    scheduleReconnect()
  })
  await chrome.action.setBadgeText({text:''})
  await chrome.action.setBadgeBackgroundColor({color:'#252525'})
  return status()
}
async function setAutoConnect(enabled){
  try{await chrome.storage.local.set({autoConnect:enabled})}catch{
    failStorage('无法保存本机连接授权，控制已保持关闭。请刷新扩展后重试。')
    throw storageFailure
  }
  assertReady();autoConnect=enabled;hasConnectionPreference=true
}
function preferenceAction(run){
  const operation=preferenceTail.then(run)
  preferenceTail=operation.catch(()=>{})
  return operation
}
async function disconnect(){
  // Revoke in durable storage before dropping the transport; a restart must
  // not turn a deliberate disconnect back into permission to reconnect.
  await setAutoConnect(false);cancelReconnect()
  const port=nativePort;nativePort=null;connected=false;connecting=false;connectionError='';++transportGeneration
  stopOwners('Disconnected by the user.')
  try{port?.disconnect()}catch{}
  await chrome.action.setBadgeText({text:''})
  return status()
}

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return false
  const run=async()=>{
    await ready
    assertReady()
    if(message?.action==='status')return status()
    if(message?.action==='connect')return preferenceAction(async()=>{await setAutoConnect(true);return connect()})
    if(message?.action==='stop'){await broker.stop(message.owner);return status()}
    if(message?.action==='resume'){await broker.resume(message.owner);return status()}
    if(message?.action==='stopAll'){for(const session of broker.snapshot().sessions)await broker.stop(session.owner);return status()}
    if(message?.action==='disconnect')return preferenceAction(disconnect)
    throw new Error('Unknown popup action.')
  }
  const respond=(value)=>{try{reply(value)}catch{}}
  run().then((value)=>respond({ok:true,...value}),(error)=>respond({ok:false,connected:false,error:String(error.message||error).slice(0,300)}))
  return true
})
chrome.runtime.onStartup.addListener(()=>{void connect().catch(()=>{})})
chrome.runtime.onInstalled.addListener((details)=>{
  void preferenceAction(async()=>{
    await ready;assertReady()
    // Only a first installation inherits the nativeMessaging permission just
    // accepted in Chrome. Updates and re-enabling must respect a revocation.
    if(details?.reason==='install'&&!hasConnectionPreference)await setAutoConnect(true)
    await connect()
  }).catch(()=>{})
})
chrome.alarms.onAlarm.addListener((alarm)=>{
  if(alarm?.name===RECONNECT_ALARM)void connect().catch(()=>{})
})

// Register listeners synchronously. MV3 rejects async module graphs.
async function initialize(){
  try{
    const stored=await chrome.storage.local.get(['blockedOwners','autoConnect'])
    const blocked=stored?.blockedOwners
    if(blocked!==undefined&&(!Array.isArray(blocked)||blocked.some((owner)=>typeof owner!=='string'||!/^[A-Za-z0-9:_-]{1,200}$/.test(owner))))throw new Error('Invalid stopped-owner storage.')
    if(stored?.autoConnect!==undefined&&typeof stored.autoConnect!=='boolean')throw new Error('Invalid connection permission.')
    autoConnect=stored?.autoConnect===true;hasConnectionPreference=stored?.autoConnect!==undefined
    broker=initializeBroker({blockedOwners:blocked||[]})
    resolveReady(broker)
    if(autoConnect)void connect().catch(()=>{})
    else cancelReconnect()
  }catch{
    failStorage('无法读取停止控制状态或连接授权，连接已保持关闭。请刷新扩展后重试。')
    rejectReady(storageFailure)
  }
}
void initialize()
