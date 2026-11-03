import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const files = ['index.js', ...readdirSync(new URL('../lib/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`), ...readdirSync(new URL('../tools/', import.meta.url)).filter((f) => f.endsWith('.mjs')).map((f) => `tools/${f}`), ...readdirSync(root).filter((f) => /^verify-.*\.mjs$/.test(f))]
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit', shell: false })
  if (result.error || result.status !== 0) process.exit(1)
}
for (const file of ['install.sh', 'uninstall.sh']) {
  const result = spawnSync('bash', ['-n', file], { cwd: root, stdio: 'inherit', shell: false })
  if (result.error || result.status !== 0) process.exit(1)
}
console.log(`Syntax OK: ${files.length} JavaScript files and 2 shell scripts`)
