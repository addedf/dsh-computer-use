import { requestRuntimeMessage } from './popup-request.js'

const byId = (id) => document.getElementById(id)
const setText = (element, value) => { if (element.textContent !== value) element.textContent = value }
let inFlight = false
let polling = false
let actionGeneration = 0

async function action(message) {
  const readOnly = message.action === 'status'
  if (inFlight || (readOnly && polling)) return
  const generation = readOnly ? actionGeneration : ++actionGeneration
  if (readOnly) polling = true
  else { inFlight = true; byId('connect').disabled = true; byId('revoke-offline').disabled = true }
  try {
    const value = await requestRuntimeMessage(chrome.runtime, message)
    if (generation !== actionGeneration) return
    if (!value?.ok) throw new Error('Connection unavailable.')
    render(value)
  } catch {
    if (generation !== actionGeneration) return
    setText(byId('connection'), '扩展连接未就绪')
    byId('status-dot').dataset.state = 'error'
    byId('error').hidden = false
    setText(byId('error'), '连接暂不可用，请确认本机 DSH 已启动后重试。')
  } finally {
    if (readOnly) polling = false
    else inFlight = false
    if (!inFlight) { byId('connect').disabled = false; byId('revoke-offline').disabled = false }
  }
}

function render(state) {
  const authorized = state.autoConnect === true
  const connecting = state.connecting === true
  setText(byId('connection'), state.connected ? '已连接本机 DSH' : connecting ? '正在连接本机 DSH' : authorized ? '等待本机 DSH' : '尚未授权连接')
  byId('status-dot').dataset.state = state.connected ? 'connected' : connecting ? 'connecting' : state.connectionError ? 'error' : 'idle'
  setText(byId('connect'), state.connected || connecting ? '撤销授权' : authorized ? '立即重试' : '授权并连接')
  byId('connect').dataset.action = state.connected || connecting ? 'disconnect' : 'connect'
  // Authorization remains revocable while the local host is offline.
  byId('revoke-offline').hidden = !authorized || state.connected || connecting
  byId('error').hidden = !state.connectionError
  setText(byId('error'), state.connectionError ? authorized ? '暂时无法连接。请确认本机 DSH 已启动，扩展会自动重试。' : '连接未就绪，请确认已安装本机连接组件后重试。' : '')
}

byId('connect').addEventListener('click', () => action({ action: byId('connect').dataset.action || 'connect' }))
byId('revoke-offline').addEventListener('click', () => action({ action: 'disconnect' }))
void action({ action: 'status' })
setInterval(() => { if (!document.hidden) void action({ action: 'status' }) }, 1500)
