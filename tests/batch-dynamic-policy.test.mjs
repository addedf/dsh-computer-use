import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { apply } from '../index.js'
import { runSteps } from '../lib/batch.js'

// computer_wait is the plugin's local, non-mutating tool: these tests traverse
// the production batch registration and real host policy without a driver.
function fixture() {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {} })
  const runtime = new ToolRuntime(ctx)
  apply(ctx, { cursorTheme: '' })
  const seen = [], dispatched = []
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'computer_wait') seen.push(exec.arguments.ms)
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'computer_wait') dispatched.push(exec.arguments.ms)
    return next()
  })
  const run = (args, signal = new AbortController().signal) => runtime.execute({
    name: 'run_steps', arguments: args, callId: 'dynamic-policy',
    agent: { session: {} }, signal,
  })
  return { ctx, runtime, seen, dispatched, run }
}

test('references inside a foreach/otherwise branch still face host pre-policy and stop on denial', { timeout: 2000 }, async () => {
  const f = fixture()
  f.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'computer_wait' && exec.arguments.ms === 1
    ? { kind: 'deny', reason: 'first branch item denied by host' } : next())
  const result = await f.run({ variables: { matched: false, rows: [{ delay: 1 }, { delay: 2 }] }, steps: [
    { when: { ref: 'matched' }, steps: [{ tool: 'computer_wait', args: { ms: 9 } }], otherwise: [
      { for_each: { $ref: 'rows' }, as: 'row', steps: [{ tool: 'computer_wait', args: { ms: { $ref: 'row.delay' } } }] },
    ] },
    { tool: 'computer_wait', args: { ms: 3 } },
  ] })
  assert.equal(result.isError, false)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.data.executed, 1)
  assert.deepEqual(f.dispatched, [])
  assert.match(result.value.result, /first branch item denied/)
})

test('a post-policy block inside a repeat never becomes a loop retry or an alternate action', { timeout: 2000 }, async () => {
  const f = fixture()
  f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'computer_wait'
    ? { kind: 'block', feedback: [{ type: 'text', text: 'blocked leaf after dispatch' }] } : next())
  const result = await f.run({ steps: [
    { repeat: 4, steps: [{ tool: 'computer_wait', args: { ms: 0 } }] },
    { tool: 'computer_wait', args: { ms: 5 } },
  ] })
  assert.equal(result.isError, false)
  assert.equal(result.value.ok, false)
  assert.deepEqual(f.dispatched, [0])
  assert.match(result.value.result, /blocked leaf after dispatch/)
})

test('ambiguous data bindings prevent the selected leaf from entering host dispatch', { timeout: 2000 }, async () => {
  const f = fixture()
  const result = await f.run({ variables: { refs: [{ name: 'same', delay: 1 }, { name: 'same', delay: 2 }] }, steps: [
    { repeat: 3, steps: [{ tool: 'computer_wait', args: { ms: { $ref: 'refs', where: { name: 'same' }, pick: 'delay' } } }] },
    { tool: 'computer_wait', args: { ms: 3 } },
  ] })
  assert.equal(result.isError, false)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.data.executed, 0)
  assert.deepEqual(f.seen, [])
  assert.match(result.value.result, /唯一匹配/)
})

test('malformed conditions in nested steps are rejected before any leaf acts', { timeout: 2000 }, async () => {
  for (const when of [false, null, 0, {}, { ref: 'flag', not: 'false' }]) {
    const f = fixture()
    const result = await f.run({ variables: { flag: true }, steps: [
      { tool: 'computer_wait', args: { ms: 0 } },
      { steps: [{ tool: 'computer_wait', args: { ms: 1 }, when }] },
    ] })
    assert.equal(result.isError, false)
    assert.equal(result.value.ok, false, `invalid condition accepted: ${JSON.stringify(when)}`)
    assert.deepEqual(f.dispatched, [], `a leaf ran before condition validation: ${JSON.stringify(when)}`)
  }
})

test('tool steps cannot hide a control declaration behind a falsy value', { timeout: 2000 }, async () => {
  for (const control of [{ repeat: 0 }, { until: null }, { for_each: false }, { as: '' }]) {
    const f = fixture()
    const result = await f.run({ steps: [{ steps: [{ tool: 'computer_wait', args: { ms: 0 }, ...control }] }] })
    assert.equal(result.isError, false)
    assert.equal(result.value.ok, false, `invalid tool/control mix accepted: ${JSON.stringify(control)}`)
    assert.deepEqual(f.dispatched, [])
  }
})

test('an empty failure reason from accepted host output cannot make the batch successful', { timeout: 2000 }, async () => {
  const f = fixture()
  f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'computer_wait'
    ? { kind: 'accept', value: { ok: false, result: '' } } : next())
  const result = await f.run({ steps: [
    { tool: 'computer_wait', args: { ms: 0 } },
    { tool: 'computer_wait', args: { ms: 1 } },
  ] })
  assert.equal(result.isError, false)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.failedStep, 1)
  assert.equal(result.value.completed, 0)
  assert.deepEqual(f.dispatched, [0])
})

test('the shared call budget also bounds multiplied nested loops', { timeout: 3000 }, async () => {
  const f = fixture()
  const result = await f.run({ steps: [{ repeat: 10, steps: [{ repeat: 10, steps: [
    { tool: 'computer_wait', args: { ms: 0 } },
  ] }] }] })
  assert.equal(result.isError, false)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.data.executed, 60)
  assert.equal(f.dispatched.length, 60)
  assert.match(result.value.result, /60/)
})

test('cancellation during child pre-policy stops all subsequent loop and branch actions', { timeout: 2000 }, async () => {
  const f = fixture()
  const controller = new AbortController()
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'computer_wait') controller.abort()
    return next()
  })
  const result = await f.run({ steps: [
    { repeat: 10, steps: [{ tool: 'computer_wait', args: { ms: 0 } }] },
    { tool: 'computer_wait', args: { ms: 5 } },
  ] }, controller.signal)
  assert.equal(result.isError, true)
  assert.deepEqual(f.dispatched, [])
})

test('elapsed-time budget is checked after the final leaf, even with no following step', async () => {
  let clock = 0
  let calls = 0
  const tools = new Map([['read', { execute: async () => {
    calls++
    clock = 101
    return { ok: true, result: 'read completed' }
  } }]])
  const value = await runSteps({ steps: [{ tool: 'read' }] }, {}, tools, undefined, { now: () => clock, maxDurationMs: 100 })
  assert.equal(value.ok, false)
  assert.equal(calls, 1)
  assert.match(value.result, /时间上限/)
})
