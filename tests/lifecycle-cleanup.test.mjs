import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import sourcePlugin from '../index.js'
import { createPlaywrightController } from '../lib/browser-playwright.js'
import { createToolScope } from '../lib/session.js'
import { registerCleanup } from '../lib/lifecycle.js'

test('real Cordis fiber disposal awaits owned browser cleanup and unloads bundled skills', async () => {
  const root = new Context()
  new SystemPrompt(root, {})
  const tools = new ToolRuntime(root)
  const skills = new SkillRegistry(root, {})
  root.provide('approval', {})
  tools.register(defineTool({ name: 'unrelated', description: 'outside plugin', parameters: {}, output: {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [],
  }, execute: async () => ({ ok: true }) }))

  let opened, cleanupStarted, releaseCleanup
  const started = new Promise((resolve) => { cleanupStarted = resolve })
  const release = new Promise((resolve) => { releaseCleanup = resolve })
  let contextCloses = 0, browserCloses = 0
  const page = new EventEmitter()
  page.isClosed = () => false
  page.url = () => 'http://fixture.test/'
  page.title = async () => 'Lifecycle fixture'
  page.frames = () => []
  page.goto = async () => {}
  const browserContext = new EventEmitter()
  browserContext.newPage = async () => page
  browserContext.close = async () => { contextCloses++; cleanupStarted(); await release }
  const browser = { newContext: async () => browserContext, close: async () => { browserCloses++ } }
  const fiber = root.plugin({
    name: 'actual-plugin-lifecycle-test', inject: ['tools', 'approval'],
    apply(ctx) {
      sourcePlugin.apply(ctx, { cursorTheme: '', browserBackend: 'playwright' })
      opened = createPlaywrightController(ctx, {}, { playwright: { chromium: { launch: async () => browser } } })
    },
  }, {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(typeof opened?.open, 'function')
  assert.deepEqual((await skills.list()).map((entry) => entry.name), ['dsh-browser', 'dsh-desktop'])
  const actor = { agent: { session: {} }, signal: new AbortController().signal }
  await createToolScope()(actor, async () => assert.equal((await opened.open({ url: 'http://fixture.test/' }, actor)).ok, true))

  let disposed = false
  const disposing = Promise.resolve(fiber.dispose()).then(() => { disposed = true })
  await started
  assert.equal(disposed, false)
  assert.equal(contextCloses, 1)
  assert.equal(browserCloses, 0)
  releaseCleanup()
  await disposing
  assert.equal(browserCloses, 1)
  assert.equal(tools.get('computer_skill'), undefined)
  assert.deepEqual(await skills.list(), [])
  assert.ok(tools.get('unrelated'))
  await fiber.dispose()
  assert.equal(contextCloses, 1)
  assert.equal(browserCloses, 1)
})

test('minimal-host dispose fallback remains awaitable and idempotent', async () => {
  const listeners = []
  let calls = 0
  const ctx = { on(name, callback) { assert.equal(name, 'dispose'); listeners.push(callback) } }
  registerCleanup(ctx, async () => { calls++; await new Promise((resolve) => setImmediate(resolve)) })
  await Promise.all([listeners[0](), listeners[0]()])
  assert.equal(calls, 1)
})

test('explicit browser_close untracks resources before real fiber disposal', async () => {
  const root = new Context()
  let controller, contextCloses = 0, browserCloses = 0
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'http://fixture.test/', title: async () => '', frames: () => [], goto: async () => {} })
  const context = Object.assign(new EventEmitter(), { newPage: async () => page, close: async () => { contextCloses++ } })
  const browser = { newContext: async () => context, close: async () => { browserCloses++ } }
  const fiber = root.plugin({
    name: 'explicit-browser-close-lifecycle-test',
    apply(ctx) { controller = createPlaywrightController(ctx, {}, { playwright: { chromium: { launch: async () => browser } } }) },
  }, {})
  await new Promise((resolve) => setImmediate(resolve))
  const actor = { agent: { session: {} }, signal: new AbortController().signal }
  await createToolScope()(actor, async () => {
    assert.equal((await controller.open({ url: 'http://fixture.test/' }, actor)).ok, true)
    assert.equal((await controller.close({}, actor)).ok, true)
  })
  await fiber.dispose()
  assert.equal(contextCloses, 1)
  assert.equal(browserCloses, 1)
})
