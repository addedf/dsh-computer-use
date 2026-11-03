import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

// Keep observed windows and driver lifecycle labels local to the owning agent.
// A WeakMap lets disposed agent/session objects and their snapshots be collected.
const scope = new AsyncLocalStorage()
const owners = new WeakMap()
const fallback = createState(false)

function createState(isolated = true) {
  return { snapshot: null, browser: null, driverSession: isolated ? `dsh-cu-${randomUUID()}` : undefined }
}

export function getSessionState() {
  return scope.getStore() || fallback
}

export function getDriverSession() {
  return getSessionState().driverSession
}

/** Construct a queue per plugin instance; each tool runs to completion before
 * another tool can observe or act. A batch uses this once and dispatches its
 * steps inside the same scope, so it never deadlocks by taking the queue twice.
 */
export function createToolScope() {
  let tail = Promise.resolve()
  const localFallback = createState()
  return function runScoped(exec, task) {
    const session = exec?.agent?.session
    const owner = session && (typeof session === 'object' || typeof session === 'function') ? session : exec?.agent
    const active = scope.getStore()
    if (active) {
      if (owner && active.owner !== owner) return Promise.reject(new Error('跨 Agent 嵌套电脑操作已拒绝：请在目标会话单独执行。'))
      return Promise.resolve().then(task)
    }
    let state = localFallback
    if (owner && (typeof owner === 'object' || typeof owner === 'function')) {
      state = owners.get(owner)
      if (!state) { state = createState(); state.owner = owner; owners.set(owner, state) }
    }
    const running = tail.then(() => scope.run(state, task))
    tail = running.catch(() => undefined)
    return running
  }
}
