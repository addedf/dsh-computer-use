import test from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserController, browserTools, observeBrowser } from '../lib/browser.js'
import { createToolScope, getSessionState } from '../lib/session.js'

function fixture(options = {}) {
  const calls = []
  const approvals = []
  let clock = 1000
  let serial = 0
  const scope = createToolScope()
  const owner = { agent: {} }
  const ctx = { approval: { request: async (request) => {
    approvals.push(request)
    if (options.approvalDelay) clock += options.approvalDelay
    return options.approval || 'allowed-once'
  } } }
  const call = async (tool, args) => {
    calls.push({ tool, args })
    if (options.onCall) {
      const override = await options.onCall(tool, args)
      if (override !== undefined) return override
    }
    switch (tool) {
      case 'browser_prepare': return { status: 'ok', prepared: true, action: 'launched_isolated_browser', prepared_pid: 42 }
      case 'list_windows': return { windows: [{ pid: 42, window_id: 7, app_name: 'Google Chrome' }] }
      case 'browser_navigate': return { status: 'ok', refs_invalidated: true }
      case 'get_browser_state': {
        if (args.pid) return { status: 'ok', target_id: 'target-owned', binding_quality: 'exact', mutation_allowed: true, endpoint_access_class: 'driver_owned', tabs: [{ tab_id: 'tab-owned', active: true }] }
        const id = `p${++serial}`
        if (args.snapshot_format === 'dom_refs_v1') return { status: 'ok', snapshot_id: id, truncated: options.truncated || false, refs: [{ node: 'input', label: options.password ? 'aria-label=Login type=password' : 'aria-label=Name', ref: `${id}:0` }] }
        return {
          status: 'ok', target_id: 'target-owned', tab_id: 'tab-owned',
          snapshot: { format: 'semantic_v2', id, complete: true },
          page: { title: 'Fixture', url: 'https://example.test/form?token=private-value' },
          outline: 'textbox Name; button Confirm',
          browserDebug: { endpoint: 'ws://private:secret@127.0.0.1:9222/devtools' },
          refs: [
            { ref: `${id}:0`, role: 'textbox', name: 'Name', actions: ['type', 'pointer'], states: { editable: 'plaintext' } },
            { ref: `${id}:1`, role: 'button', name: options.buttonName === undefined ? 'Confirm' : options.buttonName, actions: ['click', 'pointer'] },
          ],
        }
      }
      case 'browser_click': case 'browser_type': case 'browser_pointer': return { status: 'ok' }
      default: throw new Error(`unexpected call ${tool}`)
    }
  }
  const controller = createBrowserController(ctx, { ttlMs: 100, ...options.cfg }, { call, now: () => clock, pause: options.pause || (async () => {}) })
  const run = (method, args = {}) => scope(owner, () => controller[method](args, owner))
  return { calls, approvals, run, ctx, controller, scope, owner, call,
    advance: (ms) => { clock += ms },
    open: async () => {
      const result = await run('open', { url: 'https://example.test/form' })
      assert.equal(result.ok, true, result.result)
      return JSON.parse(result.result)
    },
  }
}

test('tool definitions expose concrete small contracts and common output schema', () => {
  const definitions = browserTools({}, {})
  assert.ok(['browser_open', 'browser_observe', 'browser_navigate', 'browser_click', 'browser_type', 'browser_scroll'].every((name)=>definitions.some((definition)=>definition.name===name)))
  for (const definition of definitions) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.parameters.strategy, undefined)
    assert.equal(definition.parameters.delivery_mode, undefined)
  }
})

test('open launches a separate throwaway browser with fixed background parameters', async () => {
  const f = fixture()
  const output = await f.open()
  const prepared = f.calls.find((entry) => entry.tool === 'browser_prepare')
  assert.deepEqual(prepared.args.profile, { mode: 'isolated_new' })
  assert.equal(prepared.args.allow_launch, true)
  assert.equal(prepared.args.delivery_mode, 'background')
  assert.equal(prepared.args.strategy, undefined)
  assert.ok(prepared.args.session.startsWith('dsh-cu-'))
  assert.equal(output.origin, 'https://example.test')
  assert.ok(!JSON.stringify(output).includes('private-value'))
  assert.ok(!JSON.stringify(output).includes('devtools'))
  assert.ok(!JSON.stringify(output).includes('secret'))
})

test('invalid navigation schemes and credentials are rejected before any launch', async () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/secret', 'https://user:password@example.test', 'not a URL']) {
    const f = fixture()
    assert.equal((await f.run('open', { url })).ok, false)
    assert.equal(f.calls.length, 0)
  }
})

test('setup refusals do not trigger profile attachment or a policy change', async () => {
  const f = fixture({ onCall: (tool) => tool === 'browser_prepare' ? { status: 'refused', code: 'browser_consent_required', message: 'setup needed' } : undefined })
  const result = await f.run('open')
  assert.equal(result.ok, false)
  assert.match(result.result, /browser_consent_required/)
  assert.deepEqual(f.calls.map((entry) => entry.tool), ['browser_prepare'])
})

test('the allowlist uses the exact actual process/window app name', async () => {
  const f = fixture({ cfg: { allowedApps: ['Chrome'] } })
  const result = await f.run('open')
  assert.equal(result.ok, false)
  assert.match(result.result, /allowedApps/)
  assert.ok(!f.calls.some((entry) => entry.tool === 'browser_navigate'))
})

test('an unmapped native browser window cannot be used', async () => {
  const f = fixture({ cfg: { allowedApps: ['Google Chrome'] }, onCall: (tool) => tool === 'list_windows' ? { windows: [] } : undefined })
  assert.equal((await f.run('open')).ok, false)
  assert.ok(!f.calls.some((entry) => entry.tool === 'get_browser_state'))
})

test('existing-profile or heuristic target bindings are refused', async () => {
  const f = fixture({ onCall: (tool, args) => tool === 'get_browser_state' && args.pid ? { status: 'ok', target_id: 'wrong', mutation_allowed: true, binding_quality: 'exact', endpoint_access_class: 'existing_profile', tabs: [{ tab_id: 'wrong' }] } : undefined })
  assert.equal((await f.run('open')).ok, false)
  assert.ok(!f.calls.some((entry) => entry.tool === 'browser_navigate'))
})

test('DOM safety inspection precedes the final semantic action snapshot with no images', async () => {
  const f = fixture()
  const page = await f.open()
  const observations = f.calls.filter((entry) => entry.tool === 'get_browser_state' && !entry.args.pid)
  assert.deepEqual(observations.map((entry) => entry.args.snapshot_format), ['dom_refs_v1', 'semantic_v2'])
  assert.ok(observations.every((entry) => entry.args.include_screenshot === false))
  assert.deepEqual(page.refs.map((entry) => entry.ref), ['p2:0', 'p2:1'])
})

test('old refs cannot be used after a newer observation', async () => {
  const f = fixture()
  const old = await f.open()
  await f.run('observe')
  const result = await f.run('click', { ref: old.refs[1].ref })
  assert.equal(result.ok, false)
  assert.ok(!f.calls.some((entry) => entry.tool === 'browser_click'))
})

test('expired webpage refs are refused without driver actions', async () => {
  const f = fixture()
  const page = await f.open()
  f.advance(101)
  const result = await f.run('click', { ref: page.refs[1].ref })
  assert.equal(result.ok, false)
  assert.match(result.result, /过期/)
  assert.ok(!f.calls.some((entry) => entry.tool === 'browser_click'))
})

for (const options of [{ password: true }, { truncated: true }]) {
  test(`password presence or incomplete DOM blocks whole-page typing: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options)
    const page = await f.open()
    assert.equal(page.inputBlocked, true)
    const result = await f.run('type', { ref: page.refs[0].ref, text: 'non-sensitive' })
    assert.equal(result.ok, false)
    assert.match(result.result, /敏感输入保护/)
    assert.ok(!f.calls.some((entry) => entry.tool === 'browser_type'))
  })
}

for (const buttonName of ['Delete account', '付款', '']) {
  test(`dangerous or unknown semantic click label requires approval: ${buttonName || '(unnamed)'}`, async () => {
    const f = fixture({ buttonName })
    const page = await f.open()
    const result = await f.run('click', { ref: page.refs[1].ref, input_route: 'dom_event', delivery_mode: 'foreground' })
    assert.equal(result.ok, true, result.result)
    assert.equal(f.approvals.length, 1)
    const action = f.calls.find((entry) => entry.tool === 'browser_click')
    assert.equal(action.args.input_route, 'trusted')
    assert.equal(action.args.delivery_mode, 'background')
    assert.equal(action.args.x, undefined)
  })
}

test('safe named buttons do not ask for an extra approval', async () => {
  const f = fixture()
  const page = await f.open()
  assert.equal((await f.run('click', { ref: page.refs[1].ref })).ok, true)
  assert.equal(f.approvals.length, 0)
})

test('denied dangerous clicks never reach the driver', async () => {
  const f = fixture({ buttonName: 'Delete item', approval: 'denied' })
  const page = await f.open()
  assert.equal((await f.run('click', { ref: page.refs[1].ref })).ok, false)
  assert.ok(!f.calls.some((entry) => entry.tool === 'browser_click'))
})

test('approval cannot revive an expired snapshot', async () => {
  const f = fixture({ buttonName: 'Delete item', approvalDelay: 101 })
  const page = await f.open()
  assert.equal((await f.run('click', { ref: page.refs[1].ref })).ok, false)
  assert.ok(!f.calls.some((entry) => entry.tool === 'browser_click'))
})

test('cancellation during browser approval prevents the mutation', async () => {
  const f = fixture({ buttonName: 'Delete account' })
  const page = await f.open()
  const controller = new AbortController()
  f.owner.signal = controller.signal
  f.ctx.approval.request = async ({ signal }) => {
    assert.equal(signal, controller.signal)
    controller.abort()
    return 'allowed-once'
  }
  const result = await f.run('click', { ref: page.refs.find((entry) => entry.actions.includes('click')).ref })
  assert.equal(result.ok, false)
  assert.match(result.result, /取消/)
  assert.equal(f.calls.some((entry) => entry.tool === 'browser_click'), false)
})

test('cancellation while resolving a browser window stops subsequent navigation', async () => {
  const controller = new AbortController()
  let stop = false
  const f = fixture({ onCall: (tool) => { if (stop && tool === 'list_windows') controller.abort() } })
  await f.open()
  f.owner.signal = controller.signal
  stop = true
  const callsBefore = f.calls.length
  const result = await f.run('navigate', { url: 'https://example.test/next' })
  assert.equal(result.ok, false)
  assert.equal(f.calls.slice(callsBefore).some((entry) => entry.tool === 'browser_navigate'), false)
})

test('typing sends only whitelisted arguments and requires observation before the next action', async () => {
  const f = fixture()
  const page = await f.open()
  const result = await f.run('type', { ref: page.refs[0].ref, text: '测试 plain', replace: true, delivery_mode: 'foreground', mode: 'keystrokes' })
  assert.equal(result.ok, true)
  assert.ok(!result.result.includes('测试 plain'))
  const action = f.calls.find((entry) => entry.tool === 'browser_type')
  assert.equal(action.args.mode, 'insert_text')
  assert.equal(action.args.replace, true)
  assert.equal(action.args.delivery_mode, undefined)
  assert.equal((await f.run('click', { ref: page.refs[1].ref })).ok, false)
})

test('driver background refusal is returned without foreground or DOM-event replay', async () => {
  const f = fixture({ onCall: (tool) => tool === 'browser_click' ? { status: 'refused', code: 'background_unavailable', message: 'ws://private-user:secret@localhost:9222/endpoint' } : undefined })
  const page = await f.open()
  const result = await f.run('click', { ref: page.refs[1].ref })
  assert.equal(result.ok, false)
  assert.match(result.result, /background_unavailable/)
  assert.ok(!result.result.includes('secret'))
  assert.equal(f.calls.filter((entry) => entry.tool === 'browser_click').length, 1)
  assert.equal((await f.run('click', { ref: page.refs[1].ref })).ok, false)
})

test('scroll uses a current ref and bounded CSS-pixel deltas', async () => {
  const f = fixture()
  const page = await f.open()
  assert.equal((await f.run('scroll', { ref: page.refs[0].ref, direction: 'up', amount: 200 })).ok, true)
  const action = f.calls.find((entry) => entry.tool === 'browser_pointer')
  assert.equal(action.args.delta_y, -200)
  assert.equal(action.args.delta_x, 0)
  assert.equal(action.args.input_route, 'trusted')
})

test('a different agent cannot act on another agent browser state', async () => {
  const f = fixture()
  const page = await f.open()
  const other = { agent: {} }
  const result = await f.scope(other, () => f.controller.click({ ref: page.refs[1].ref }, other))
  assert.equal(result.ok, false)
  await f.scope(f.owner, () => assert.equal(getSessionState().browser.owned, true))
})

test('web observations cap output while retaining full cached labels for approval', async () => {
  const f = fixture({ cfg: { maxElements: 1000 }, onCall: (tool, args) => {
    if (tool !== 'get_browser_state' || args.snapshot_format !== 'semantic_v2') return undefined
    return {
      status: 'ok', target_id: 'target-owned', tab_id: 'tab-owned', snapshot: { format: 'semantic_v2', id: 'p-final', complete: true },
      page: { title: 'x'.repeat(500), url: 'https://example.test' }, outline: 'x'.repeat(20000),
      refs: Array.from({ length: 600 }, (_, index) => ({ ref: `p-final:${index}`, role: 'button', name: index ? 'Confirm' : `${'x'.repeat(210)} Delete item`, actions: ['click'], value: 'v'.repeat(2000) })),
    }
  } })
  const page = await f.open()
  assert.equal(page.refs.length, 500)
  assert.equal(page.outline.length, 16000)
  assert.equal(page.title.length, 200)
  assert.equal(page.refs[0].name.length, 200)
  assert.equal(page.refs[0].value.length, 1000)
  assert.equal(page.truncated, true)
  assert.equal((await f.run('click', { ref: page.refs[0].ref })).ok, true)
  assert.equal(f.approvals.length, 1)
})

test('nested browser errors keep a stable code and redact access-bearing endpoints', async () => {
  const f = fixture({ onCall: (tool, args) => tool === 'get_browser_state' && args.pid ? {
    status: 'refused', error: { code: 'binding_denied', message: 'cannot bind ws://user:private-secret@localhost:9222/devtools/browser/token' },
  } : undefined })
  const result = await f.run('open')
  assert.equal(result.ok, false)
  const diagnostic = JSON.parse(result.result)
  assert.equal(diagnostic.code, 'binding_denied')
  assert.match(diagnostic.message, /cannot bind/)
  assert.ok(!diagnostic.message.includes('private-secret'))
  assert.ok(!diagnostic.message.includes('devtools'))
})

test('new isolated browser retries only its exact read-only CDP binding while the target becomes ready', async () => {
  let attempts = 0
  const pauses = []
  const f = fixture({ pause: async (ms) => pauses.push(ms), onCall: (tool, args) => {
    if (tool === 'get_browser_state' && args.pid && ++attempts < 3) return {
      status: 'refused', error: { code: 'browser_wrong_target_refused', message: 'no CDP target correlates with native window 7 of pid 42 — refusing rather than guessing' },
    }
  } })
  await f.open()
  assert.equal(attempts, 3)
  assert.deepEqual(pauses, [150, 300])
  assert.equal(f.calls.filter((entry) => entry.tool === 'browser_prepare').length, 1)
  assert.equal(f.calls.filter((entry) => entry.tool === 'browser_navigate').length, 1)
  const bindings = f.calls.filter((entry) => entry.tool === 'get_browser_state' && entry.args.pid)
  assert.ok(bindings.every((entry) => entry.args.pid === 42 && entry.args.window_id === 7))
})

test('CDP readiness retries are bounded and never replay a mutation', async () => {
  const f = fixture({ onCall: (tool, args) => tool === 'get_browser_state' && args.pid ? {
    status: 'refused', refusal: { code: 'browser_wrong_target_refused', message: 'no CDP target correlates with native window 7 of pid 42' },
  } : undefined })
  const result = await f.run('open')
  assert.equal(result.ok, false)
  assert.equal(JSON.parse(result.result).code, 'browser_wrong_target_refused')
  assert.equal(f.calls.filter((entry) => entry.tool === 'get_browser_state').length, 4)
  assert.equal(f.calls.filter((entry) => entry.tool === 'browser_prepare').length, 1)
  assert.equal(f.calls.filter((entry) => entry.tool === 'browser_navigate').length, 0)
})

test('authorization refusals and ambiguous bindings are never retried', async () => {
  for (const error of [
    { code: 'authorization_host_failed', message: 'confirmation provider failed' },
    { code: 'browser_wrong_target_refused', message: 'ambiguous targets — refusing rather than guessing' },
  ]) {
    const f = fixture({ onCall: (tool, args) => tool === 'get_browser_state' && args.pid ? { status: 'refused', error } : undefined })
    assert.equal((await f.run('open')).ok, false)
    assert.equal(f.calls.filter((entry) => entry.tool === 'get_browser_state').length, 1)
  }
})

test('sensitive-page outlines and values are withheld even if the driver mixes in private text', async () => {
  const sentinel = 'pre-filled-sensitive-sentinel'
  const f = fixture({ password: true, onCall: (tool, args) => {
    if (tool !== 'get_browser_state' || args.snapshot_format !== 'semantic_v2') return undefined
    return {
      status: 'ok', target_id: 'target-owned', tab_id: 'tab-owned', snapshot: { format: 'semantic_v2', id: 'p-protected', complete: true },
      page: { title: 'Form', url: 'https://example.test' }, outline: `textbox Login: ${sentinel}`,
      refs: [{ ref: 'p-protected:0', role: 'textbox', name: 'Login', actions: ['type'], value: sentinel }],
    }
  } })
  const result = await f.run('open')
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(result.result).inputBlocked, true)
  assert.ok(!result.result.includes(sentinel))
  assert.equal(JSON.parse(result.result).refs[0].name, 'Login')
})

test('post-navigation read-only snapshot retries never repeat navigation', async () => {
  let snapshots = 0
  const f = fixture({ onCall: (tool, args) => {
    if (tool === 'get_browser_state' && args.snapshot_format === 'dom_refs_v1' && ++snapshots < 3) return {
      status: 'refused', error: { code: 'browser_wrong_target_refused', message: 'no CDP target correlates with native window 7 of pid 42' },
    }
  } })
  await f.open()
  assert.equal(snapshots, 3)
  assert.equal(f.calls.filter((entry) => entry.tool === 'browser_navigate').length, 1)
  assert.equal(f.calls.filter((entry) => entry.tool === 'browser_prepare').length, 1)
})

test('successful browser tools expose structured data without breaking result compatibility', async () => {
  const f = fixture()
  const result = await f.run('open', { url: 'https://example.test/form' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, JSON.parse(result.result))
  assert.equal(result.data.url, 'https://example.test/form')
  assert.ok(!result.result.includes('private-value'))
})

test('structured observeBrowser adapter refreshes refs and exposes explicit safe states only', async () => {
  const f = fixture({ onCall: (tool, args) => {
    if (tool !== 'get_browser_state' || args.snapshot_format !== 'semantic_v2') return undefined
    return {
      status: 'ok', target_id: 'target-owned', tab_id: 'tab-owned', snapshot: { format: 'semantic_v2', id: 'p-state', complete: true },
      page: { title: 'Form', url: 'https://user:private@example.test/form?token=private-value#private-fragment' }, outline: 'checkbox Accept',
      refs: [
        { ref: 'p-state:0', role: 'checkbox', name: 'Accept', actions: ['click'], states: { checked: false, disabled: false } },
        { ref: 'p-state:1', role: 'button', name: 'Unknown', actions: ['click'], states: {} },
      ],
    }
  } })
  await f.open()
  const before = f.calls.length
  const result = await f.scope(f.owner, () => observeBrowser(f.ctx, {}, { ttlMs: 100 }, f.owner, { call: f.call }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.observation, result.data)
  assert.equal(result.facts.url, 'https://example.test/form')
  assert.ok(!JSON.stringify(result).includes('private'))
  assert.equal(result.observation.refs[0].checked, false)
  assert.equal(result.observation.refs[0].enabled, true)
  assert.equal(result.observation.refs[1].checked, undefined)
  assert.equal(result.observation.refs[1].enabled, undefined)
  assert.equal(result.facts.complete, true)
  assert.ok(f.calls.slice(before).some((entry) => entry.args.snapshot_format === 'semantic_v2'))
})

test('cua screenshot coordinate clicks map image pixels to viewport CSS pixels exactly',async()=>{
  const f=fixture({onCall:(tool,args)=>tool==='get_browser_state'&&args.include_screenshot?{
    status:'ok',screenshot_png_b64:Buffer.from('fixture').toString('base64'),screenshot:{coordinate_space:'viewport_css_px',width:200,height:100,viewport_css_width:100,viewport_css_height:50,pixel_to_css_scale_x:0.5,pixel_to_css_scale_y:0.5},
  }:undefined})
  f.ctx.get=(name)=>name==='attachments'?{saveImage:async({data,mediaType})=>({attachmentId:'fixture-image',mediaType,bytes:data.length})}:undefined
  await f.open()
  const screenshot=await f.run('screenshot')
  assert.equal(screenshot.ok,true)
  assert.equal(screenshot.image.width,200)
  const clicked=await f.run('click',{x:80,y:40})
  assert.equal(clicked.ok,true,clicked.result)
  const action=f.calls.find(entry=>entry.tool==='browser_click')
  assert.equal(action.args.x,40)
  assert.equal(action.args.y,20)
  assert.equal(f.approvals.length,1)
})

test('ref and screenshot coordinate targets cannot be mixed',async()=>{
  const f=fixture();const page=await f.open()
  const result=await f.run('click',{ref:page.refs[1].ref,x:1,y:1})
  assert.equal(result.ok,false)
  assert.ok(!f.calls.some(entry=>entry.tool==='browser_click'))
})

test('cua capabilities report typed backend restrictions without claiming Playwright-only methods',async()=>{
  const f=fixture();const result=await f.run('capabilities')
  assert.equal(result.data.backend,'cua')
  assert.deepEqual(result.data.tabs,['list','select'])
  assert.deepEqual(result.data.history,[])
  assert.equal(result.data.files.upload,false)
  assert.equal(result.data.files.download,false)
})
