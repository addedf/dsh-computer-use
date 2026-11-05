import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createPlaywrightController } from '../lib/browser-playwright.js'
import { verifyBrowserWrite } from '../lib/browser-write-verification.js'
import { createToolScope, getSessionState } from '../lib/session.js'

async function fixture(run) {
  let url = 'https://fixture.test/',
    writes = 0,
    reads = 0
  const page = new EventEmitter()
  Object.assign(page, {
    url: () => url,
    isClosed: () => false,
    viewportSize: () => ({ width: 1280, height: 800 }),
    screenshot: async () => Buffer.from('image'),
  })
  const frame = { url: () => url, isDetached: () => false }
  const handle = {
    ownerFrame: async () => frame,
    fill: async () => {
      writes++
    },
    type: async () => {
      writes++
    },
    selectOption: async () => {
      writes++
    },
    dispose: async () => {},
    evaluate: async (_fn, args) => {
      if (args?.kind) {
        reads++
        return { available: true, matches: true }
      }
      return { label: 'Ready', value: 'ready' }
    },
  }
  const entry = {
    ref: 'input',
    name: 'Name',
    role: 'textbox',
    protected: false,
    enabled: true,
    actions: ['type', 'select'],
    handle,
    frame,
    identity: { tag: 'input', type: '' },
  }
  const state = {
    owned: true,
    backend: 'playwright',
    context: {},
    pages: new Map([['tab', page]]),
    tabId: 'tab',
    dialogs: new Map(),
    continuations: new Map(),
    observed: { at: Date.now(), url, tabId: 'tab', refs: new Map([[entry.ref, entry]]) },
    screenshot: null,
  }
  const exec = { agent: { session: {} }, signal: new AbortController().signal }
  const attachments = {
    saveImage: async () => ({
      attachmentId: 'fixture',
      mediaType: 'image/png',
      bytes: 5,
      width: 1280,
      height: 800,
    }),
  }
  const ctx = {
    get: (name) => (name === 'attachments' ? attachments : undefined),
    approval: { request: async () => 'allowed-once' },
  }
  await createToolScope()(exec, async () => {
    getSessionState().browser = state
    const controller = createPlaywrightController(ctx, {})
    await run({
      controller,
      state,
      page,
      entry,
      handle,
      exec,
      attachments,
      ctx,
      writes: () => writes,
      reads: () => reads,
      navigate: (value) => {
        url = value
      },
    })
  })
}

test('replacement writes once and returns only a matched comparison', async () =>
  fixture(async (h) => {
    const text = ' 0015 e\u0301 中文 '
    const written = await h.controller.type({ ref: 'input', text, replace: true }, h.exec)
    assert.equal(written.ok, true, written.result)
    assert.equal(written.data.effect, 'verified')
    assert.equal(written.data.verification.status, 'matched')
    assert.equal(h.writes(), 1)
    assert.equal(h.reads(), 1)
    assert.equal(written.result.includes(text), false)
    assert.equal(h.state.observed, null)
  }))

test('inserted text is delivered without guessing a selection-dependent expected value', async () =>
  fixture(async (h) => {
    const written = await h.controller.type({ ref: 'input', text: 'inserted' }, h.exec)
    assert.equal(written.ok, true)
    assert.equal(written.data.effect, 'delivered')
    assert.equal(h.writes(), 1)
    assert.equal(h.reads(), 0)
  }))

test('a value mismatch reports uncertainty and never repeats the write', async () =>
  fixture(async (h) => {
    h.handle.evaluate = async () => ({ available: true, matches: false })
    const written = await h.controller.type(
      { ref: 'input', text: 'private expected content', replace: true },
      h.exec,
    )
    assert.equal(written.ok, false)
    assert.equal(written.data.effect, 'unverifiable')
    assert.equal(written.data.verification.status, 'mismatch')
    assert.equal(h.writes(), 1)
    assert.equal(written.result.includes('private expected content'), false)
  }))

test('navigation after delivery prevents verification against a different page', async () =>
  fixture(async (h) => {
    h.handle.fill = async () => h.navigate('https://fixture.test/after-write')
    const written = await h.controller.type(
      { ref: 'input', text: 'one write', replace: true },
      h.exec,
    )
    assert.equal(written.ok, true)
    assert.equal(written.data.effect, 'unverifiable')
    assert.equal(written.data.verification.status, 'target_changed')
    assert.equal(h.reads(), 0)
  }))

test('a ref observed before a same-tab URL change cannot authorize a new write', async () =>
  fixture(async (h) => {
    h.navigate('https://fixture.test/different')
    const written = await h.controller.type(
      { ref: 'input', text: 'blocked', replace: true },
      h.exec,
    )
    assert.equal(written.ok, false)
    assert.match(written.result, /BROWSER_TARGET_CHANGED/)
    assert.equal(h.writes(), 0)
  }))

test('selection is verified after the one native selection', async () =>
  fixture(async (h) => {
    h.entry.role = 'combobox'
    h.entry.identity = { tag: 'select', type: '' }
    const selected = await h.controller.select({ ref: 'input', label: 'Ready' }, h.exec)
    assert.equal(selected.ok, true, selected.result)
    assert.equal(selected.data.effect, 'verified')
    assert.equal(h.writes(), 1)
    assert.equal(h.reads(), 1)
  }))

test('a stalled read and cancellation have bounded outcomes', async () => {
  const stalled = await verifyBrowserWrite({
    validate: async () => true,
    read: () => new Promise(() => {}),
    budgetMs: 25,
  })
  assert.equal(stalled.status, 'timeout')
  const abort = new AbortController()
  const running = verifyBrowserWrite({
    validate: async () => true,
    read: () => new Promise(() => {}),
    signal: abort.signal,
  })
  abort.abort()
  await assert.rejects(running, { code: 'ABORTED' })
})

test('late validation cannot start another read after its budget was retired', async () => {
  let completeValidation,
    reads = 0,
    validations = 0
  const validating = new Promise((resolve) => {
    completeValidation = resolve
  })
  const result = await verifyBrowserWrite({
    validate: async () => {
      validations++
      return validating
    },
    read: async () => {
      reads++
      return { available: true, matches: true }
    },
    budgetMs: 20,
  })
  assert.equal(result.status, 'timeout')
  completeValidation(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(reads, 0)
  assert.equal(validations, 1)
})

test(
  'a later sample timeout preserves an already observed mismatch',
  { timeout: 2000 },
  async () => {
    let validations = 0,
      reads = 0,
      releaseValidation,
      markPending
    const lateValidation = new Promise((resolve) => {
      releaseValidation = resolve
    })
    const pending = new Promise((resolve) => {
      markPending = resolve
    })
    const running = verifyBrowserWrite({
      validate: async () => {
        validations++
        if (validations === 3) {
          markPending()
          return lateValidation
        }
        return true
      },
      read: async () => {
        reads++
        return { available: true, matches: false }
      },
      budgetMs: 150,
      intervalMs: 1,
    })
    await pending
    const result = await running
    assert.equal(result.status, 'mismatch')
    assert.equal(reads, 1)
    releaseValidation(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(reads, 1)
  },
)

for (const method of ['fill', 'type', 'selectOption'])
  test(`${method} failures omit supplied content and use a fixed uncertainty diagnostic`, async () =>
    fixture(async (h) => {
      const marker = 'SYNTHETIC_PRIVATE_VALUE_2984'
      let deliveries = 0
      h.handle[method] = async () => {
        deliveries++
        throw new Error(
          `Timeout: ${method}(${JSON.stringify(marker)}) Call log: private field contents`,
        )
      }
      const failed =
        method === 'selectOption'
          ? await h.controller.select({ ref: 'input', label: 'Ready' }, h.exec)
          : await h.controller.type(
              { ref: 'input', text: marker, replace: method === 'fill' },
              h.exec,
            )
      assert.equal(failed.ok, false)
      assert.equal(JSON.parse(failed.result).code, 'BROWSER_WRITE_UNCONFIRMED')
      assert.equal(failed.result.includes(marker), false)
      assert.equal(failed.result.includes('Call log'), false)
      assert.equal(deliveries, 1)
    }))

test('known cancellation is preserved without exposing a mutation call log', async () =>
  fixture(async (h) => {
    h.handle.fill = async () => {
      throw Object.assign(new Error('fill synthetic private content'), { code: 'ABORTED' })
    }
    const failed = await h.controller.type(
      { ref: 'input', text: 'synthetic private content', replace: true },
      h.exec,
    )
    assert.equal(JSON.parse(failed.result).code, 'ABORTED')
    assert.equal(failed.result.includes('synthetic private content'), false)
  }))

test('resized browser screenshots clear coordinate authorization', async () =>
  fixture(async (h) => {
    h.state.screenshot = { at: Date.now(), tabId: 'tab', width: 1280, height: 800 }
    h.attachments.saveImage = async () => ({
      attachmentId: 'resized',
      mediaType: 'image/png',
      bytes: 5,
      width: 640,
      height: 400,
    })
    const shot = await h.controller.screenshot({}, h.exec)
    assert.equal(shot.ok, false)
    assert.match(shot.result, /BROWSER_SCREENSHOT_DIMENSIONS_CHANGED/)
    assert.equal(h.state.screenshot, null)
    assert.equal(shot.image, undefined)
  }))

test('unchanged browser screenshot dimensions retain the CSS coordinate contract', async () =>
  fixture(async (h) => {
    const shot = await h.controller.screenshot({}, h.exec)
    assert.equal(shot.ok, true)
    assert.equal(shot.data.coordinateSpace, 'viewport_css_pixels')
    assert.equal(shot.image.width, h.state.screenshot.width)
    assert.equal(shot.image.height, h.state.screenshot.height)
  }))

for (const phase of ['capture', 'save'])
  test(`navigation during screenshot ${phase} cannot authorize coordinates on a different page`, async () =>
    fixture(async (h) => {
      if (phase === 'capture')
        h.page.screenshot = async () => {
          h.navigate('https://fixture.test/after')
          return Buffer.from('old image')
        }
      else
        h.attachments.saveImage = async () => {
          h.navigate('https://fixture.test/after')
          return { attachmentId: 'old', width: 1280, height: 800 }
        }
      const shot = await h.controller.screenshot({}, h.exec)
      assert.equal(shot.ok, false)
      assert.match(shot.result, /BROWSER_SCREENSHOT_TARGET_CHANGED/)
      assert.equal(h.state.screenshot, null)
      assert.equal(shot.image, undefined)
    }))

test('a screenshot cannot authorize a click after navigation or navigation during approval', async () => {
  for (const duringApproval of [false, true])
    await fixture(async (h) => {
      let clicks = 0
      h.page.mouse = {
        click: async () => {
          clicks++
        },
      }
      assert.equal((await h.controller.screenshot({}, h.exec)).ok, true)
      if (duringApproval)
        h.ctx.approval.request = async () => {
          h.navigate('https://fixture.test/after')
          return 'allowed-once'
        }
      else h.navigate('https://fixture.test/after')
      const clicked = await h.controller.click({ x: 10, y: 10 }, h.exec)
      assert.equal(clicked.ok, false)
      assert.match(clicked.result, /BROWSER_SCREENSHOT_TARGET_CHANGED/)
      assert.equal(h.state.screenshot, null)
      assert.equal(clicks, 0)
    })
})

// Explicit opt-in uses only a fresh, headless Chrome context and a loopback page.
// It never connects to the user's Chrome/profile or touches desktop applications.
test(
  'isolated real Chrome verifies literal, delayed and rejected writes and input dialogs',
  { skip: process.env.DSH_VERIFY_BROWSER_WRITES !== '1', timeout: 30000 },
  async (t) => {
    const html = `<!doctype html><meta charset="utf-8"><input aria-label="Name"><select aria-label="Stage"><option value="draft">Draft</option><option value="ready">Ready</option></select><script>
    const input=document.querySelector('input'),select=document.querySelector('select');window.writes=0;
    window.coordinateClicks=0;document.addEventListener('click',()=>window.coordinateClicks++);
    if(location.search==='?readonly')input.readOnly=true;
    input.addEventListener('input',()=>{window.writes++;if(location.search==='?normalize')input.value=input.value.trim();if(location.search==='?delay'){const wanted=input.value;input.value='';setTimeout(()=>input.value=wanted,150)}if(location.search==='?dialog')alert('Fixture needs review')});
    select.addEventListener('change',()=>{window.writes++;if(location.search==='?select-ignore')select.value='draft'});
  </script>`
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/`
    const exec = { agent: { session: {} }, signal: new AbortController().signal }
    try {
      await createToolScope()(exec, async () => {
        const controller = createPlaywrightController(
          {
            get: (name) =>
              name === 'attachments'
                ? {
                    saveImage: async () => ({
                      attachmentId: 'isolated-fixture',
                      mediaType: 'image/png',
                      bytes: 1,
                      width: 1280,
                      height: 800,
                    }),
                  }
                : undefined,
          },
          { browserBackend: 'playwright' },
        )
        try {
          const load = async (query = '') => {
            const r = await controller.open({ url: base + query }, exec)
            assert.equal(r.ok, true, r.result)
            return r.data.refs
          }
          const field = (refs, name) => refs.find((row) => row.name === name).ref
          await t.test('literal whitespace and Unicode are preserved', async () => {
            const refs = await load(),
              text = ' 0015 e\u0301 中文 '
            const written = await controller.type(
              { ref: field(refs, 'Name'), text, replace: true },
              exec,
            )
            assert.equal(written.data.effect, 'verified', written.result)
            const page = getSessionState().browser.pages.get(getSessionState().browser.tabId)
            assert.equal(await page.locator('input').inputValue(), text)
            assert.equal(await page.evaluate(() => window.writes), 1)
          })
          await t.test('delayed application state settles by reads without replay', async () => {
            const refs = await load('?delay')
            const written = await controller.type(
              { ref: field(refs, 'Name'), text: 'delayed value', replace: true },
              exec,
            )
            assert.equal(written.data.effect, 'verified', written.result)
            const page = getSessionState().browser.pages.get(getSessionState().browser.tabId)
            assert.equal(await page.evaluate(() => window.writes), 1)
            assert.ok(written.data.verification.attempts > 1)
          })
          await t.test(
            'application normalization fails literal verification without replay',
            async () => {
              const refs = await load('?normalize')
              const written = await controller.type(
                { ref: field(refs, 'Name'), text: ' 0015 ', replace: true },
                exec,
              )
              assert.equal(written.ok, false, written.result)
              assert.equal(written.data.verification.status, 'mismatch')
              const page = getSessionState().browser.pages.get(getSessionState().browser.tabId)
              assert.equal(await page.evaluate(() => window.writes), 1)
            },
          )
          await t.test('native selection confirms current selected value', async () => {
            const refs = await load()
            const selected = await controller.select(
              { ref: field(refs, 'Stage'), label: 'Ready' },
              exec,
            )
            assert.equal(selected.data.effect, 'verified', selected.result)
          })
          await t.test('ignored selection reports mismatch without selecting twice', async () => {
            const refs = await load('?select-ignore')
            const selected = await controller.select(
              { ref: field(refs, 'Stage'), label: 'Ready' },
              exec,
            )
            assert.equal(selected.ok, false, selected.result)
            assert.equal(selected.data.verification.status, 'mismatch')
            const page = getSessionState().browser.pages.get(getSessionState().browser.tabId)
            assert.equal(await page.evaluate(() => window.writes), 1)
          })
          await t.test(
            'input-triggered alert returns control for explicit dialog handling',
            async () => {
              const refs = await load('?dialog')
              const written = await controller.type(
                { ref: field(refs, 'Name'), text: 'review me', replace: true },
                exec,
              )
              assert.equal(written.data.dialogPending, true, written.result)
              const dialog = await controller.dialog({ action: 'inspect' }, exec)
              assert.equal(dialog.data.dialog.type, 'alert')
              const dismissed = await controller.dialog(
                { action: 'dismiss', dialog_id: dialog.data.dialog.dialogId },
                exec,
              )
              assert.equal(dismissed.ok, true, dismissed.result)
              assert.equal(getSessionState().browser.pendingInteraction, null)
            },
          )
          await t.test(
            'a readonly field returns a fixed error without exposing Playwright fill arguments',
            async () => {
              const refs = await load('?readonly'),
                text = 'SYNTHETIC_PRIVATE_READONLY_7823'
              const written = await controller.type(
                { ref: field(refs, 'Name'), text, replace: true },
                exec,
              )
              assert.equal(written.ok, false)
              assert.equal(JSON.parse(written.result).code, 'BROWSER_WRITE_UNCONFIRMED')
              assert.equal(written.result.includes(text), false)
              assert.equal(written.result.includes('Call log'), false)
              const page = getSessionState().browser.pages.get(getSessionState().browser.tabId)
              assert.equal(await page.evaluate(() => window.writes), 0)
            },
          )
          await t.test(
            'same-URL document reload invalidates screenshot coordinate authorization',
            async () => {
              await load()
              assert.equal((await controller.screenshot({}, exec)).ok, true)
              const state = getSessionState().browser,
                page = state.pages.get(state.tabId),
                url = page.url()
              const generation = state.screenshot.documentRevision
              await page.reload({ waitUntil: 'domcontentloaded' })
              assert.equal(page.url(), url)
              assert.ok(state.pageRevisions.get(state.tabId) > generation)
              assert.equal(state.screenshot, null)
              const clicked = await controller.click({ x: 10, y: 10 }, exec)
              assert.equal(clicked.ok, false)
              assert.equal(await page.evaluate(() => window.coordinateClicks), 0)
            },
          )
        } finally {
          await controller.close({}, exec)
        }
      })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  },
)
