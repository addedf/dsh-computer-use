import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'

import { registerSkills, loadBundledSkill } from '../lib/skills.js'

const output = {
  schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
  render: () => [],
}
function createHost({ nativeSkills = true, standardConsumer = false } = {}) {
  const ctx = new Context()
  const prompt = new SystemPrompt(ctx, {})
  const runtime = new ToolRuntime(ctx)
  const skills = nativeSkills ? new SkillRegistry(ctx, {}) : undefined
  for (const name of ['browser_observe', 'screen_observe']) {
    runtime.register(defineTool({ name, description: 'read-only fixture', parameters: {}, output, execute: async () => ({ ok: true }) }))
  }
  // Consumer presence is an explicit fixture; catalog/get behavior below uses
  // the real SkillRegistry, not a fabricated service or an LLM invocation.
  if (standardConsumer) runtime.register(defineTool({ name: 'skill', description: 'consumer fixture', parameters: {}, output, execute: async () => ({ ok: true }) }))
  const registered = []
  const dispose = registerSkills(ctx, { registerTool(definition) {
    registered.push(definition.name)
    return runtime.register(definition)
  } })
  return { ctx, prompt, runtime, skills, registered, dispose }
}

const actor = () => ({ session: {} })
const assemble = async (host, agent) => renderPrompt(await host.prompt.assemble({ scope: agent, agent }))
const run = (host, agent, name, args = {}) => host.runtime.execute({
  name, arguments: args, agent, callId: `skill-test:${name}`, signal: new AbortController().signal,
})

test('bundled skills register into the real native registry and expose loadable bodies', async () => {
  const host = createHost()
  const agent = actor()
  const summaries = await host.skills.list({ scope: agent })
  assert.deepEqual(summaries.map((skill) => skill.name), ['dsh-browser', 'dsh-desktop'])
  assert.ok(summaries.every((skill) => skill.invocation.modelInvocable && skill.invocation.userInvocable))
  for (const summary of summaries) {
    const loaded = await host.skills.get(summary.name, { scope: agent })
    const packaged = loadBundledSkill(summary.name)
    assert.equal(loaded.content, packaged.content)
    assert.equal(loaded.path, packaged.path)
    assert.equal(loaded.resourceBase.path, packaged.resourceBase.path)
  }
  assert.deepEqual(host.registered, ['computer_skill'])
  assert.throws(() => loadBundledSkill('../private'), /未知/)
})

test('model prompt contains the routing catalog before any desktop interaction', async () => {
  const host = createHost()
  const text = await assemble(host, actor())
  assert.ok(text.includes(loadBundledSkill('dsh-browser').description))
  assert.ok(text.includes(loadBundledSkill('dsh-desktop').description))
  assert.ok(text.includes('computer_skill({name})'))
  assert.ok(!text.includes('<skill_content'))
})

test('without the standard consumer, relevant tool results automatically load only the owning session skill', async () => {
  const host = createHost()
  const agent = actor()
  const result = await run(host, agent, 'browser_observe')
  assert.equal(result.isError, false)
  const text = await assemble(host, agent)
  assert.ok(text.includes(loadBundledSkill('dsh-browser').content))
  assert.ok(!text.includes(loadBundledSkill('dsh-desktop').content))
  const other = await assemble(host, actor())
  assert.ok(!other.includes('<skill_content'))
})

test('a host-denied feature call does not activate an automatic skill body', async () => {
  const host = createHost()
  const agent = actor()
  host.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'browser_observe'
    ? { kind: 'deny', reason: 'browser unavailable in this session' } : next())
  assert.equal((await run(host, agent, 'browser_observe')).isError, true)
  assert.ok(!(await assemble(host, agent)).includes('<skill_content'))
})

test('the fallback still automatically loads guidance when the native registry is absent', async () => {
  const host = createHost({ nativeSkills: false })
  const agent = actor()
  await run(host, agent, 'screen_observe')
  const text = await assemble(host, agent)
  assert.ok(text.includes(loadBundledSkill('dsh-desktop').content))
  assert.ok(!text.includes(loadBundledSkill('dsh-browser').content))
})

test('a standard skill consumer keeps full bodies out of automatic prompt injection', async () => {
  const host = createHost({ standardConsumer: true })
  const agent = actor()
  await run(host, agent, 'browser_observe')
  const text = await assemble(host, agent)
  assert.ok(text.includes('skill({name})'))
  assert.ok(!text.includes('<skill_content'))
  assert.ok(!text.includes(loadBundledSkill('dsh-browser').content))
})

test('the policy-visible fallback loader returns the full skill and avoids adding a second body to the prompt', async () => {
  const host = createHost()
  const agent = actor()
  const loaded = await run(host, agent, 'computer_skill', { name: 'dsh-browser' })
  assert.equal(loaded.isError, false)
  assert.ok(loaded.value.result.includes(loadBundledSkill('dsh-browser').content))
  await run(host, agent, 'browser_observe')
  assert.ok(!(await assemble(host, agent)).includes('<skill_content'))
  host.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'computer_skill'
    ? { kind: 'deny', reason: 'loader denied by host policy' } : next())
  const denied = await run(host, agent, 'computer_skill', { name: 'dsh-desktop' })
  assert.equal(denied.isError, true)
  assert.match(denied.error.message, /loader denied/)
})

test('scoped model invocation restrictions affect both the prompt and fallback loader', async () => {
  const host = createHost()
  const agent = actor()
  const scoped = createScope(host.ctx, agent)
  scoped.ctx.skills.register({ ...loadBundledSkill('dsh-browser'), invocation: { modelInvocable: false, userInvocable: true } })
  await run(host, agent, 'browser_observe')
  const text = await assemble(host, agent)
  assert.ok(!text.includes(loadBundledSkill('dsh-browser').description))
  assert.ok(!text.includes(loadBundledSkill('dsh-browser').content))
  const loaded = await run(host, agent, 'computer_skill', { name: 'dsh-browser' })
  assert.equal(loaded.isError, true)
  assert.match(loaded.error.message, /不可由模型调用/)
  await scoped.dispose()
})

test('skill template examples remain literal and never become prompt variable expressions', async () => {
  const host = createHost()
  const agent = actor()
  const scoped = createScope(host.ctx, agent)
  const content = 'Keep {{customer_name}} literal in an application template.'
  scoped.ctx.skills.register({ ...loadBundledSkill('dsh-browser'), content })
  await run(host, agent, 'browser_observe')
  assert.ok((await assemble(host, agent)).includes(content))
  await scoped.dispose()
})

test('disposal removes the loader, native skills, and prompt contribution without touching other tools', async () => {
  const host = createHost()
  host.dispose()
  host.dispose()
  assert.deepEqual(await host.skills.list(), [])
  assert.equal(host.runtime.get('computer_skill'), undefined)
  assert.ok(host.runtime.get('browser_observe'))
  assert.ok(!(await assemble(host, actor())).includes('dsh-browser'))
})

test('a real Cordis plugin mounts with core injection and reads optional skill services through ctx.get', async () => {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  const runtime = new ToolRuntime(ctx)
  const skills = new SkillRegistry(ctx, {})
  ctx.provide('approval', {})
  let mounted = false
  const fiber = ctx.plugin({
    name: 'computer-skills-loading-fixture', inject: ['tools', 'approval'],
    apply(pluginCtx) { registerSkills(pluginCtx); mounted = true },
  }, {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(mounted, true)
  assert.ok(runtime.get('computer_skill'))
  assert.deepEqual((await skills.list()).map((skill) => skill.name), ['dsh-browser', 'dsh-desktop'])
  await fiber.dispose()
  assert.equal(runtime.get('computer_skill'), undefined)
  assert.deepEqual(await skills.list(), [])
})
