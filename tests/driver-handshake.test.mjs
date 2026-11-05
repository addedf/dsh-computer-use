import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import plugin from '../index.js'

// Runs the real CLI transport and plugin wrapper against a process we own.
// Approval is simulated; no desktop driver, native window or real input is used.
test(
  'plugin observation handshakes with the exact CLI and admits each bound capture only once',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-handshake-flow-'))
    const binary = join(root, 'driver.mjs'),
      log = join(root, 'calls.jsonl')
    const code = `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const [verb, tool, encoded] = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const target = { session: { type: 'string' }, pid: { type: 'integer' }, window_id: { type: 'integer' } };
const fields = {
  get_window_state: { ...target, tree_format: { type: 'string', enum: ['elements'] } },
  click: { ...target, x: { type: 'number' }, y: { type: 'number' }, capture_id: { type: 'string' }, from_zoom: { type: 'boolean' } },
  drag: { ...target, from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } },
  zoom: { ...target, x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } },
};
appendFileSync(log, JSON.stringify({ verb, tool }) + '\\n');
if (verb === 'manifest') console.log(JSON.stringify({ schema_version: '1', binary_version: 'fixture', subcommands: [{ name: 'describe' }] }));
else if (verb === 'describe') console.log('name: ' + tool + '\\ndescription: controlled fixture\\ninput_schema:\\n' + JSON.stringify({ type: 'object', properties: fields[tool], required: [] }));
else if (verb === 'call') {
  const args = JSON.parse(encoded);
  let value = { ok: true };
  if (tool === 'health_report') value = { schema_version: '1', driver_version: 'fixture', platform: 'darwin', overall: 'ok', checks: [], build: { exe_sha256: createHash('sha256').update(readFileSync(process.argv[1])).digest('hex') } };
  if (tool === 'list_windows') value = { windows: [{ pid: 42, window_id: 7, title: 'Controlled fixture', app_name: 'Fixture' }] };
  if (tool === 'get_window_state') value = { snapshot_id: 'fixture-snapshot', capture_id: randomUUID(), screenshot_width: 100, screenshot_height: 100, elements: [{ element_index: 1, element_token: 'fixture-token', role: 'AXButton', label: 'Continue', screenshot_frame: { x: 1, y: 1, w: 20, h: 20 } }] };
  if (tool === 'click') { appendFileSync(log, JSON.stringify({ delivered: true, args }) + '\\n'); value = { effect: 'confirmed' }; }
  if (tool === 'type_text') { appendFileSync(log, JSON.stringify({ textDeliveryMode: args.delivery_mode }) + '\\n'); value = args.delivery_mode === 'background' ? { code: 'background_unavailable', effect: 'refused' } : { effect: 'confirmed' }; }
  console.log(JSON.stringify(value));
} else process.exitCode = 2;
`
    await writeFile(log, '')
    await writeFile(binary, code)
    await chmod(binary, 0o700)
    const original = process.env.CUA_DRIVER_BIN
    process.env.CUA_DRIVER_BIN = binary
    t.after(async () => {
      if (original === undefined) delete process.env.CUA_DRIVER_BIN
      else process.env.CUA_DRIVER_BIN = original
      await rm(root, { recursive: true, force: true })
    })

    const tools = new Map()
    let replaceDuringApproval = false
    plugin.apply(
      {
        tools: {
          register(tool) {
            tools.set(tool.name, tool)
            return () => {}
          },
        },
        approval: {
          request: async () => {
            if (replaceDuringApproval) {
              replaceDuringApproval = false
              await writeFile(binary, `${code}\n// controlled driver replacement\n`)
            }
            return 'allowed-once'
          },
        },
        on: () => () => {},
        logger: { info() {}, warn() {} },
      },
      { desktopIndicator: false, cursorTheme: '', ttlMs: 120000 },
    )
    const exec = { agent: { session: {} }, signal: new AbortController().signal }
    const run = (name, args = {}) => tools.get(name).execute(args, exec)

    const observed = await run('screen_observe')
    assert.equal(observed.ok, true, observed.result)
    const diagnostic = await run('computer_status', { scope: 'capabilities' })
    assert.equal(diagnostic.data.features.captureClick, 'supported', diagnostic.result)
    const clicked = await run('computer_click', { x: 10, y: 10 })
    assert.equal(clicked.ok, true, clicked.result)
    const repeated = await run('computer_click', { x: 10, y: 10 })
    assert.equal(repeated.ok, false)
    assert.equal(repeated.errorCode, 'DRIVER_CAPTURE_CONSUMED')
    const refreshed = await run('screen_observe')
    assert.equal(refreshed.ok, true, refreshed.result)
    assert.equal((await run('computer_click', { element: 1 })).ok, true)
    replaceDuringApproval = true
    const changed = await run('computer_type', { text: 'ordinary fixture text' })
    assert.equal(changed.ok, false)
    assert.equal(changed.errorCode, 'DRIVER_IDENTITY_CHANGED')

    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const delivered = calls.filter((call) => call.delivered)
    assert.equal(delivered.length, 2)
    assert.equal(typeof delivered[0].args.capture_id, 'string')
    assert.equal(delivered[1].args.capture_id, undefined)
    assert.equal(delivered[1].args.element_token, 'fixture-token')
    assert.equal(calls.filter((call) => call.verb === 'manifest').length, 1)
    assert.equal(calls.filter((call) => call.verb === 'describe').length, 4)
    assert.ok(
      calls.findIndex((call) => call.tool === 'health_report') <
        calls.findIndex((call) => call.tool === 'start_session'),
    )
    assert.deepEqual(
      calls.filter((call) => call.textDeliveryMode).map((call) => call.textDeliveryMode),
      ['background'],
    )
  },
)
