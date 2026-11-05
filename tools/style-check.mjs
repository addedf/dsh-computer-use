import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Formatting intentionally covers this integration's changed modules. Expand
// the list when another existing module receives a substantive change; avoid
// rewriting unrelated legacy files just to introduce the formatter.
const files = [
  '.prettierrc.json',
  'eslint.config.js',
  'package.json',
  'index.js',
  'lib/browser-playwright.js',
  'lib/browser-observation.js',
  'lib/browser-write-verification.js',
  'lib/cua.js',
  'lib/driver-capabilities.js',
  'lib/driver-capture.js',
  'lib/observe.js',
  'lib/human.js',
  'lib/actions.js',
  'lib/control-status.js',
  'lib/session.js',
  'tools/check.mjs',
  'tools/style-check.mjs',
  'tools/doctor.mjs',
  'tests/browser-write-verification.test.mjs',
  'tests/cua-cancellation.test.mjs',
  'tests/driver-capabilities.test.mjs',
  'tests/driver-capture.test.mjs',
  'tests/driver-handshake.test.mjs',
  'tests/driver-handshake.integration.test.mjs',
  'tests/browser-observation-budget.test.mjs',
  'tests/browser-observation-budget.integration.mjs',
  'tests/observe-coordinate-space.test.mjs',
  'tests/session-signal.test.mjs',
  'tests/tool-cancellation-result.test.mjs',
]

const root = fileURLToPath(new URL('../', import.meta.url))
const prettier = fileURLToPath(
  new URL('../node_modules/prettier/bin/prettier.cjs', import.meta.url),
)
const args = process.argv.slice(2)
if (args.some((arg) => !['--check', '--write'].includes(arg)) || args.length > 1) {
  console.error('Usage: node tools/style-check.mjs [--check|--write]')
  process.exit(1)
}
const result = spawnSync(process.execPath, [prettier, args[0] || '--check', ...files], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
})
if (result.error) console.error(result.error.message)
process.exitCode = result.error ? 1 : (result.status ?? 1)
