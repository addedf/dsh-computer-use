import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

// Keep observed windows and driver lifecycle labels local to the owning agent.
// A WeakMap lets disposed agent/session objects and their snapshots be collected.
const scope = new AsyncLocalStorage()
// Cancellation belongs to one invocation, not to the long-lived owner state.
// In particular, nested batch calls may replace the parent's execution signal
// and queued cleanup must run without an already-aborted tool signal.
const executionScope = new AsyncLocalStorage()
const owners = new WeakMap()
const fallback = createState(false)

function createState(isolated = true) {
  return {
    snapshot: null,
    browser: null,
    controlStopped: false,
    driverSession: isolated ? `dsh-cu-${randomUUID()}` : undefined,
  }
}

export function getSessionState() {
  return scope.getStore() || fallback
}

export function getDriverSession() {
  return getSessionState().driverSession
}

export function getExecutionSignal() {
  return executionScope.getStore()
}

/** Construct a queue per plugin instance; each tool runs to completion before
 * another tool can observe or act. A batch uses this once and dispatches its
 * steps inside the same scope, so it never deadlocks by taking the queue twice.
 */
export function createToolScope() {
  let tail = Promise.resolve()
  const localFallback = createState()
  return function runScoped(exec, task, { enqueue = false } = {}) {
    const session = exec?.agent?.session
    const owner =
      session && (typeof session === 'object' || typeof session === 'function')
        ? session
        : exec?.agent
    const active = scope.getStore()
    if (active && !enqueue) {
      if (owner && active.owner !== owner)
        return Promise.reject(new Error('跨 Agent 嵌套电脑操作已拒绝：请在目标会话单独执行。'))
      return Promise.resolve().then(() => executionScope.run(exec?.signal, task))
    }
    let state = localFallback
    if (owner && (typeof owner === 'object' || typeof owner === 'function')) {
      state = owners.get(owner)
      if (!state) {
        state = createState()
        state.owner = owner
        owners.set(owner, state)
      }
    }
    const running = tail.then(() => scope.run(state, () => executionScope.run(exec?.signal, task)))
    tail = running.catch(() => undefined)
    return running
  }
}
