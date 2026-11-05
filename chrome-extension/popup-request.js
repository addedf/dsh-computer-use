/** A dead or failed MV3 worker must become a visible popup error, never a spinner. */
export async function requestRuntimeMessage(runtime, message, { timeoutMs = 5000 } = {}) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('扩展后台未在 5 秒内响应。请在扩展管理页刷新 DSH Chrome Control，再重新打开本窗口。')), timeoutMs)
  })
  try { return await Promise.race([Promise.resolve().then(() => runtime.sendMessage(message)), timeout]) }
  finally { clearTimeout(timer) }
}
