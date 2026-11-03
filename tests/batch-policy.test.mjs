import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { apply } from '../index.js'
import { getSessionState } from '../lib/session.js'

// These checks use the real host registry and policy waterfalls. Waiting is a
// plugin tool that needs neither the native driver nor a desktop application.
function createHost() {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  const runtime = new ToolRuntime(ctx)
  apply(ctx, { cursorTheme: '' })
  return { ctx, runtime }
}

function executeBatch(runtime, steps, callId = 'batch-policy-test') {
  return runtime.execute({
    name: 'run_steps',
    arguments: { steps },
    callId,
    agent: { session: {} },
    signal: new AbortController().signal,
  })
}

test('run_steps retains host pre-policy denial for a nested tool', { timeout: 2000 }, async () => {
  const { ctx, runtime } = createHost()
  const seen = []
  let childDispatched = false
  ctx.on('tools/pre-execute', async (exec, next) => {
    seen.push(exec.name)
    return exec.name === 'computer_wait'
      ? { kind: 'deny', reason: 'leaf tool denied by host policy' }
      : next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'computer_wait') childDispatched = true
    return next()
  })

  const result = await executeBatch(runtime, [
    { tool: 'computer_wait', args: { ms: 1 } },
    { tool: 'computer_wait', args: { ms: 1 } },
  ])

  assert.equal(result.isError, false)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.failedStep, 1)
  assert.equal(result.value.completed, 0)
  assert.match(result.value.steps[0].result, /leaf tool denied by host policy/)
  assert.deepEqual(seen, ['run_steps', 'computer_wait'])
  assert.equal(childDispatched, false)
})

test('runtime sub-dispatches preserve parent identity and finish inside the batch scope', { timeout: 2000 }, async () => {
  const { ctx, runtime } = createHost()
  const events = []
  const children = []
  const scopes = []
  let parentToken
  ctx.on('tools/pre-execute', async (exec, next) => {
    events.push(`pre:${exec.name}`)
    if (exec.name === 'run_steps') parentToken = exec.token
    else {
      children.push(exec)
      scopes.push(getSessionState())
    }
    return next()
  })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    events.push(`post:${exec.name}`)
    return next()
  })

  const result = await executeBatch(runtime, [
    { tool: 'computer_wait', args: { ms: 1 } },
    { tool: 'computer_wait', args: { ms: 1 } },
  ], 'batch-with-children')

  assert.equal(result.isError, false)
  assert.equal(result.value.ok, true)
  assert.equal(result.value.completed, 2)
  assert.equal(result.value.failedStep, null)
  assert.deepEqual(events, [
    'pre:run_steps',
    'pre:computer_wait', 'post:computer_wait',
    'pre:computer_wait', 'post:computer_wait',
    'post:run_steps',
  ])
  assert.equal(children.length, 2)
  assert.notEqual(children[0].callId, children[1].callId)
  for (const child of children) {
    assert.equal(child.parent, parentToken)
    assert.equal(child.rootCallId, 'batch-with-children')
  }
  assert.equal(scopes[0], scopes[1])
  assert.match(scopes[0].driverSession, /^dsh-cu-/)
})

test('run_steps stops when host post-policy blocks a completed child', { timeout: 2000 }, async () => {
  const { ctx, runtime } = createHost()
  let dispatchedChildren = 0
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'computer_wait') dispatchedChildren++
    return next()
  })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    return exec.name === 'computer_wait'
      ? { kind: 'block', feedback: [{ type: 'text', text: 'child result blocked by host policy' }] }
      : next()
  })

  const result = await executeBatch(runtime, [
    { tool: 'computer_wait', args: { ms: 1 } },
    { tool: 'computer_wait', args: { ms: 1 } },
  ])

  assert.equal(result.isError, false)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.failedStep, 1)
  assert.equal(result.value.completed, 0)
  assert.equal(dispatchedChildren, 1)
  assert.match(result.value.steps[0].result, /child result blocked by host policy/)
})
