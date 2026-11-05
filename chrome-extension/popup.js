import { requestRuntimeMessage } from './popup-request.js'
import { CAPABILITIES } from './broker.js'

const byId=(id)=>document.getElementById(id)
const LOCAL_CONTRACT={...CAPABILITIES,transportConcurrency:'parallel-rpc'}
const currentContract=(value)=>value?.background===true&&value?.focusPolicy==='preserve-user-focus'&&value?.releasePolicy==='ungroup-preserve-tabs'&&value?.transportConcurrency==='parallel-rpc'
const policyText=(value)=>value===undefined||value===null?'缺失':typeof value==='string'&&/^[a-z-]{1,64}$/.test(value)?value:'非预期值'
const contractText=(value)=>`background=${typeof value?.background==='boolean'?String(value.background):'缺失'}；focusPolicy=${policyText(value?.focusPolicy)}；releasePolicy=${policyText(value?.releasePolicy)}；transportConcurrency=${policyText(value?.transportConcurrency)}`
const setText=(element,value)=>{if(element.textContent!==value)element.textContent=value}
function renderCompatibility(running,{waiting=false,unavailable=false}={}){
  const localCurrent=currentContract(LOCAL_CONTRACT)
  const matching=localCurrent&&currentContract(running)
  const summary=!localCurrent?'本地扩展文件未更新：当前文件不支持完整后台操作与结束取消分组。':waiting?'本地文件已更新，正在读取后台能力。':unavailable?'本地文件已更新，后台能力读取失败。':matching?'后台操作 · 保留前台 · 结束取消分组（本地与后台一致）':'本地文件已更新，后台服务未刷新：运行中的控制能力仍不匹配。'
  setText(byId('compatibility-summary'),summary)
  for(const id of ['compatibility-local','compatibility-worker'])byId(id).hidden=matching
  setText(byId('compatibility-local'),matching?'':`本地文件：${contractText(LOCAL_CONTRACT)}`)
  setText(byId('compatibility-worker'),matching?'':waiting?'运行后台：读取中':unavailable?'运行后台：未取得能力信息':`运行后台：${contractText(running)}`)
}
let inFlight=false
let lastFingerprint=null
async function action(message){
  if(inFlight)return
  inFlight=true
  try{
    const value=await requestRuntimeMessage(chrome.runtime,message)
    if(!value?.ok)throw new Error(value?.error||'无法读取本机连接状态。')
    render(value)
  }catch(error){lastFingerprint=null;renderCompatibility(undefined,{unavailable:true});byId('connection').textContent='扩展连接未就绪';byId('error').hidden=false;byId('error').textContent=error.message}
  finally{inFlight=false}
}
function render(state){
  // Capability-only changes must be inspectable without replacing the live Stop
  // button. Bundled metadata comes from this popup's own broker resource; state
  // capabilities come independently from the currently running service worker.
  renderCompatibility(state.capabilities)
  const displayed=[...state.sessions,...state.blockedOwners.filter((owner)=>!state.sessions.some((session)=>session.owner===owner)).map((owner)=>({owner,title:'已停止的 DSH 任务',stopped:true,tabCount:0}))]
  const fingerprint=JSON.stringify({connected:state.connected,connectionError:state.connectionError||'',sessions:displayed.map(({owner,title,stopped,closing,tabCount,reason,groupCleanup})=>({owner,title,stopped,closing,tabCount,reason:reason||'',groupCleanup:groupCleanup||null}))})
  // Polling must not replace the Stop button while a user is focusing/clicking it.
  if(fingerprint===lastFingerprint)return
  byId('connection').textContent=state.connected?'已连接本机 DSH':'尚未连接'
  byId('connect').textContent=state.connected?'断开连接':'连接本机 DSH'
  byId('connect').dataset.connected=String(state.connected)
  byId('stop-all').disabled=!state.sessions.some((session)=>!session.stopped&&!session.closing)
  byId('error').hidden=!state.connectionError
  byId('error').textContent=state.connectionError||''
  const list=byId('sessions');list.replaceChildren()
  if(!displayed.length){const empty=document.createElement('p');empty.className='hint';empty.textContent=state.connected?'已准备好，等待 DSH 创建任务分组。':'请先安装本机连接组件，再点击连接。';list.append(empty)}
  for(const session of displayed){
    const finished=session.stopped||session.closing
    const card=document.createElement('section');card.className=`session${finished?' stopped':''}`
    const heading=document.createElement('h2');heading.textContent=session.title
    const info=document.createElement('p');info.textContent=session.stopped?'已停止控制':session.closing?'正在释放控制':`正在控制 · ${session.tabCount} 个任务页面`
    card.append(heading,info)
    if(session.reason){const reason=document.createElement('p');reason.textContent=session.reason;card.append(reason)}
    if(session.groupCleanup?.failedTabs){const warning=document.createElement('p');warning.textContent='控制已释放，但部分任务页面未能退出分组。';card.append(warning)}
    if(finished){const guidance=document.createElement('p');guidance.textContent=session.stopped?'该任务控制已停止，请在 DSH 新建会话开始下一任务。':'任务页面将保留并退出分组，控制连接正在释放。';card.append(guidance)}
    else{const button=document.createElement('button');button.textContent='停止控制';button.className='danger';button.addEventListener('click',()=>action({action:'stop',owner:session.owner}));card.append(button)}
    list.append(card)
  }
  lastFingerprint=fingerprint
}
byId('connect').addEventListener('click',()=>action({action:byId('connect').dataset.connected==='true'?'disconnect':'connect'}))
byId('stop-all').addEventListener('click',()=>action({action:'stopAll'}))
renderCompatibility(undefined,{waiting:true})
void action({action:'status'})
setInterval(()=>{if(!document.hidden)void action({action:'status'})},1500)
