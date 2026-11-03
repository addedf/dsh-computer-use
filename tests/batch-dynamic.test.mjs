import test from 'node:test'
import assert from 'node:assert/strict'
import { runSteps, resolveBindings } from '../lib/batch.js'

const fixture = () => {
  const calls = []
  const tools = new Map(['observe', 'click', 'check', 'fail'].map((tool) => [tool, { execute: async (args) => {
    calls.push({ tool, args })
    if (tool === 'observe') return { ok: true, result: 'fresh page', data: { refs: [{ ref: 'p2:1', name: 'Confirm', role: 'button' }] } }
    if (tool === 'check') return { ok: true, result: 'read', data: { matched: calls.filter((c) => c.tool === 'check').length >= 2 } }
    return { ok: tool !== 'fail', result: tool }
  } }]))
  return { calls, tools, run: (args, options) => runSteps(args, {}, tools, undefined, options) }
}

test('fresh observation drives a uniquely selected ref in the next tool', async () => {
  const f = fixture()
  const value = await f.run({ steps: [
    { tool: 'observe', save_as: 'page' },
    { tool: 'click', args: { ref: { $ref: 'page.data.refs', where: { name: 'Confirm', role: 'button' }, pick: 'ref' } } },
  ], return_vars: ['page'] })
  assert.equal(value.ok, true)
  assert.equal(f.calls[1].args.ref, 'p2:1')
  assert.equal(value.data.variables.page.data.refs[0].ref, 'p2:1')
})

test('zero or ambiguous matches stop before clicking', async () => {
  for (const refs of [[], [{ name: 'X' }, { name: 'X' }]]) {
    const f = fixture()
    const value = await f.run({ variables: { refs }, steps: [{ tool: 'click', args: { ref: { $ref: 'refs', where: { name: 'X' }, pick: 'ref' } } }] })
    assert.equal(value.ok, false)
    assert.equal(f.calls.length, 0)
  }
})

test('bounded loop exits on a verified result and branches use that result', async () => {
  const f = fixture()
  const value = await f.run({ steps: [
    { repeat: 3, steps: [{ tool: 'check', save_as: 'check' }], until: { ref: 'check.data.matched', equals: true } },
    { tool: 'click', args: { ref: 'yes' }, when: { ref: 'check.data.matched' } },
    { tool: 'fail', when: { ref: 'check.data.matched', not: true } },
  ] })
  assert.equal(value.ok, true)
  assert.deepEqual(f.calls.map((entry) => entry.tool), ['check', 'check', 'click'])
  assert.equal(value.data.skipped, 1)
})

test('foreach variables are scoped and all mutations go through supplied dispatcher', async () => {
  const f = fixture(), seen = []
  const value = await runSteps({ variables: { item: 'prior' }, steps: [{ for_each: ['a', 'b'], as: 'item', steps: [{ tool: 'click', args: { ref: { $ref: 'item' } } }] }], return_vars: ['item'] }, {}, f.tools,
    async (step) => { seen.push(step.args.ref); return { ok: true, result: 'policy checked' } })
  assert.equal(value.ok, true)
  assert.deepEqual(seen, ['a', 'b'])
  assert.equal(value.data.variables.item, 'prior')
  assert.equal(f.calls.length, 0)
})

test('failed actions are not retried by loops or alternate branches', async () => {
  for (const step of [
    { repeat: 3, steps: [{ tool: 'fail' }, { tool: 'click' }] },
    { when: { ref: 'flag' }, steps: [{ tool: 'click' }], otherwise: [{ tool: 'fail' }] },
  ]) {
    const f = fixture()
    const value = await f.run({ variables: { flag: false }, steps: [step, { tool: 'click' }] })
    assert.equal(value.ok, false)
    assert.deepEqual(f.calls.map((entry) => entry.tool), ['fail'])
  }
})

test('tool call and time budgets stop a dynamic plan', async () => {
  const f = fixture()
  const value = await f.run({ steps: [{ repeat: 10, steps: [{ tool: 'click' }] }] }, { maxCalls: 2 })
  assert.equal(value.ok, false)
  assert.equal(f.calls.length, 2)
  const time = await fixture().run({ steps: [{ tool: 'click' }] }, { now: (() => { let at = 0; return () => at += 1000 })(), maxDurationMs: 100 })
  assert.equal(time.ok, false)
})

test('prototype paths and arbitrary reference expressions are rejected', () => {
  for (const value of [{ $ref: 'x.constructor' }, { $ref: 'x', eval: 'process.exit()' }]) {
    assert.throws(() => resolveBindings(value, { x: {} }))
  }
})

test('deadline reaches the child signal and the child settles before batch returns', async () => {
  const f = fixture()
  let settled = false, calls = 0
  const value = await runSteps({ steps: [{ tool: 'click' }, { tool: 'click' }] }, {}, f.tools, async (_step, _index, child) => {
    calls++
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 100)
      child.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    settled = true
    return { ok: false, result: 'child cancelled at deadline' }
  }, { maxDurationMs: 5 })
  assert.equal(value.ok, false)
  assert.equal(settled, true)
  assert.equal(calls, 1)
})
