import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPlaywrightController } from '../lib/browser-playwright.js'
import { createToolScope, getSessionState } from '../lib/session.js'

const secretMarker = 'SYNTHETIC_PASSWORD_NEVER_RETURN_8341'
const buttons = (count) =>
  Array.from(
    { length: count },
    (_, index) => `<button aria-label="Item ${index}">${index}</button>`,
  ).join('')

test('bounded collection in an isolated real Chrome context', { timeout: 60000 }, async (t) => {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.test').pathname
    let body
    const select =
      '<select aria-label="Stage"><option value="draft">Draft</option><option value="ready">Ready</option></select>'
    if (path === '/large')
      body = `<input aria-label="Early field" value="Public">${select}${buttons(5000)}<input type="password" value="${secretMarker}">`
    else if (path === '/scope')
      body = `<section role="region" aria-label="Panel"><input aria-label="Name" value="Public">${select}</section><input type="password" value="${secretMarker}">`
    else if (path === '/frames') body = '<input aria-label="Parent"><iframe src="/child"></iframe>'
    else if (path === '/child') body = buttons(20)
    else if (path === '/query') body = buttons(70)
    else if (path === '/query-boundary')
      body = `<p>${'x'.repeat(15998)}needle${'x'.repeat(100)}</p>`
    else if (path === '/editable')
      body = `<div contenteditable="true">${secretMarker}</div>${buttons(300)}`
    else if (path === '/editable-ancestor')
      body = `<div role="group"><div id="editable-label" contenteditable="true">${secretMarker}</div></div><button aria-labelledby="editable-label"></button><textarea id="textarea-label">${secretMarker}</textarea><button aria-labelledby="textarea-label"></button>${buttons(300)}`
    else if (path === '/shadow')
      body = `<div id="host"></div><input aria-label="Public"><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<input type="password" value="${secretMarker}">'</script>`
    else body = buttons(20)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Bounded fixture</title>${body}<script>window.mutationCount=0;document.addEventListener('input',()=>window.mutationCount++);document.addEventListener('change',()=>window.mutationCount++)</script>`,
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const run = async (path, config, check) => {
    const exec = { agent: { session: {} }, signal: new AbortController().signal }
    await createToolScope()(exec, async () => {
      const controller = createPlaywrightController({}, { browserBackend: 'playwright', ...config })
      try {
        const opened = await controller.open({ url: base + path }, exec)
        assert.ok(opened.ok || /BROWSER_OBSERVATION_SUPERSEDED/.test(opened.result), opened.result)
        const state = getSessionState().browser
        const page = state.pages.get(state.tabId)
        await page.waitForLoadState('load')
        const observed = await controller.observe({}, exec)
        assert.equal(observed.ok, true, observed.result)
        await check({ controller, exec, state, page, observed })
      } finally {
        await controller.close({}, exec)
      }
    })
  }
  try {
    await t.test(
      'a large page stops actual scans and hides values when security inspection is incomplete',
      async () =>
        run(
          '/large',
          { maxElements: 5, browserObservationMaxNodes: 100, browserObservationSafetyMaxNodes: 80 },
          async ({ observed, controller, exec, page }) => {
            const data = observed.data
            assert.equal(data.complete, false)
            assert.equal(data.truncated, true)
            assert.equal(data.safetyComplete, false)
            assert.equal(data.inputBlocked, true)
            assert.ok(data.refs.length <= 5)
            assert.ok(data.observationBudget.visitedNodes.output <= 100)
            assert.ok(data.observationBudget.visitedNodes.safety <= 80)
            assert.ok(data.observationBudget.stopReasons.includes('safety_nodes'))
            assert.equal(observed.result.includes(secretMarker), false)
            assert.equal(
              data.refs.some((entry) => Object.hasOwn(entry, 'value')),
              false,
            )
            const target = data.refs.find((entry) => entry.name === 'Early field')
            const typed = await controller.type(
              { ref: target.ref, text: 'Must be blocked', replace: true },
              exec,
            )
            assert.equal(typed.ok, false)
            const stage = data.refs.find((entry) => entry.name === 'Stage')
            assert.equal(
              (await controller.select({ ref: stage.ref, value: 'ready' }, exec)).ok,
              false,
            )
            assert.equal(await page.evaluate(() => globalThis.mutationCount), 0)
          },
        ),
    )
    await t.test('precise cursor pages advance without revisiting earlier element refs', async () =>
      run('/pages', { maxElements: 3 }, async ({ observed, controller, exec }) => {
        const names = []
        let current = observed
        for (let page = 0; page < 20; page++) {
          assert.equal(current.data.safetyComplete, true)
          assert.equal(current.data.inputBlocked, false)
          names.push(...current.data.refs.map((entry) => entry.name))
          if (!current.data.continuation) break
          current = await controller.observe({ continuation: current.data.continuation }, exec)
          assert.equal(current.ok, true, current.result)
        }
        assert.deepEqual(
          names,
          Array.from({ length: 20 }, (_, index) => `Item ${index}`),
        )
      }),
    )
    await t.test(
      'a query can resume beyond its first scan allowance while every call repeats full-page safety inspection',
      async () =>
        run(
          '/query',
          { maxElements: 3, browserObservationMaxNodes: 40, browserObservationSafetyMaxNodes: 30 },
          async ({ controller, exec }) => {
            let current = await controller.observe({ query: 'Item 69' }, exec)
            let found = false,
              pages = 0
            for (; pages < 30; pages++) {
              assert.equal(current.ok, true, current.result)
              assert.equal(current.data.inputBlocked, true)
              assert.ok(current.data.observationBudget.visitedNodes.output <= 40)
              assert.ok(current.data.observationBudget.visitedNodes.safety <= 30)
              if (current.data.refs.some((entry) => entry.name === 'Item 69')) {
                found = true
                break
              }
              assert.ok(current.data.continuation, current.result)
              current = await controller.observe({ continuation: current.data.continuation }, exec)
            }
            assert.equal(found, true)
            assert.ok(pages > 0)
          },
        ),
    )
    await t.test('bounded text-query windows preserve a match crossing their boundary', async () =>
      run('/query-boundary', {}, async ({ controller, exec }) => {
        const queried = await controller.observe({ query: 'needle' }, exec)
        assert.equal(queried.ok, true, queried.result)
        assert.equal(queried.data.inputBlocked, false)
        assert.ok(queried.data.outline.includes('needle'))
        assert.equal(queried.data.outline.match(/needle/g).length, 1)
        assert.equal(queried.data.continuation, null)
        assert.ok(queried.data.outline.length <= 16000)
      }),
    )
    await t.test('subtree output does not bypass a password field outside that subtree', async () =>
      run('/scope', {}, async ({ observed, controller, exec }) => {
        const panel = observed.data.refs.find((entry) => entry.name === 'Panel')
        const scoped = await controller.observe({ scope_ref: panel.ref }, exec)
        assert.equal(scoped.ok, true, scoped.result)
        assert.equal(scoped.data.scope, 'subtree')
        assert.equal(scoped.data.safetyComplete, true)
        assert.equal(scoped.data.inputBlocked, true)
        assert.equal(scoped.result.includes(secretMarker), false)
        assert.ok(scoped.data.refs.some((entry) => entry.name === 'Name'))
      }),
    )
    await t.test(
      'a password page prevents selectOption change delivery even with a complete safety scan',
      async () =>
        run('/scope', {}, async ({ observed, controller, exec, page }) => {
          assert.equal(observed.data.safetyComplete, true)
          assert.equal(observed.data.inputBlocked, true)
          const stage = observed.data.refs.find((entry) => entry.name === 'Stage')
          assert.equal(
            (await controller.select({ ref: stage.ref, value: 'ready' }, exec)).ok,
            false,
          )
          assert.equal(await page.evaluate(() => globalThis.mutationCount), 0)
        }),
    )
    await t.test(
      'unlabelled editable contents never leak through a control name when safety is incomplete',
      async () =>
        run(
          '/editable',
          { browserObservationMaxNodes: 100, browserObservationSafetyMaxNodes: 100 },
          async ({ observed }) => {
            assert.equal(observed.data.inputBlocked, true)
            assert.equal(observed.result.includes(secretMarker), false)
            assert.ok(
              observed.data.refs.some((entry) => entry.role === 'textbox' && entry.name === ''),
            )
          },
        ),
    )
    await t.test('editable descendant values never become an ancestor group name', async () =>
      run(
        '/editable-ancestor',
        { browserObservationMaxNodes: 100, browserObservationSafetyMaxNodes: 100 },
        async ({ observed }) => {
          assert.equal(observed.data.inputBlocked, true)
          assert.equal(observed.result.includes(secretMarker), false)
          assert.ok(observed.data.refs.some((entry) => entry.role === 'group' && entry.name === ''))
          assert.ok(
            observed.data.refs.some((entry) => entry.role === 'textbox' && entry.name === ''),
          )
          assert.equal(
            observed.data.refs.filter((entry) => entry.role === 'button' && entry.name === '')
              .length,
            2,
          )
        },
      ),
    )
    await t.test(
      'a subtree cursor preserves its exact scope and still repeats outside safety inspection',
      async () =>
        run('/scope', { maxElements: 1 }, async ({ observed, controller, exec }) => {
          const panel = observed.data.refs.find((entry) => entry.name === 'Panel')
          const scoped = await controller.observe({ scope_ref: panel.ref }, exec)
          assert.equal(scoped.ok, true, scoped.result)
          assert.ok(scoped.data.continuation)
          const next = await controller.observe({ continuation: scoped.data.continuation }, exec)
          assert.equal(next.ok, true, next.result)
          assert.equal(next.data.scope, 'subtree')
          assert.equal(next.data.inputBlocked, true)
          assert.ok(next.data.refs.some((entry) => entry.name === 'Name'))
        }),
    )
    await t.test('frame scans deduct from one shared page allowance', async () =>
      run(
        '/frames',
        { browserObservationMaxNodes: 100, browserObservationSafetyMaxNodes: 12 },
        async ({ observed, page }) => {
          assert.equal(page.frames().length, 2)
          assert.equal(observed.data.safetyComplete, false)
          assert.equal(observed.data.inputBlocked, true)
          assert.ok(observed.data.observationBudget.visitedNodes.safety <= 12)
        },
      ),
    )
    await t.test('open shadow-root password fields participate in the safety scan', async () =>
      run('/shadow', {}, async ({ observed }) => {
        assert.equal(observed.data.safetyComplete, true)
        assert.equal(observed.data.inputBlocked, true)
        assert.equal(observed.result.includes(secretMarker), false)
      }),
    )
    await t.test('navigation destroys a continuation rather than rebinding its cursor', async () =>
      run('/pages', { maxElements: 3 }, async ({ observed, controller, exec, page }) => {
        const continuation = observed.data.continuation
        assert.ok(continuation)
        await page.reload({ waitUntil: 'load' })
        const stale = await controller.observe({ continuation }, exec)
        assert.equal(stale.ok, false)
        assert.equal(getSessionState().browser.continuations.size, 0)
      }),
    )
    await t.test(
      'a removed cursor node is rejected rather than restarting at an unrelated node',
      async () =>
        run('/pages', { maxElements: 3 }, async ({ observed, controller, exec, page }) => {
          assert.ok(observed.data.continuation)
          await page.locator('button[aria-label="Item 2"]').evaluate((element) => element.remove())
          const stale = await controller.observe({ continuation: observed.data.continuation }, exec)
          assert.equal(stale.ok, false)
          assert.match(stale.result, /BROWSER_TARGET_CHANGED/)
        }),
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
