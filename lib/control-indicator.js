/** A truthful, transient DSH control panel. This does not start screen capture
 * or imitate the macOS screen-sharing indicator. The host remains responsible
 * for cancelling its agent and ending only its own driver session on Stop.
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const SOURCE = fileURLToPath(new URL('../tools/control-indicator.swift', import.meta.url))
const LABELS = Object.freeze({ preparing: 'DSH 准备操作', observing: 'DSH 正在观察', acting: 'DSH 正在操作', waiting: 'DSH 等待确认', idle: 'DSH 等待下一步', paused: 'DSH 已暂停' })
const MAX_LINE = 8192
const FALLBACK = {}
export const CONTROL_INDICATOR_BUNDLE_ID = 'com.dsh.computer-use.indicator'
const EXECUTABLE = 'DSHControlIndicator'
const BUNDLE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${CONTROL_INDICATOR_BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
<key>CFBundleName</key><string>DSH Control</string>
<key>CFBundleDisplayName</key><string>DSH Control</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`

async function validateBundle(bundle) {
  for (const directory of [bundle, join(bundle, 'Contents'), join(bundle, 'Contents', 'MacOS')]) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022)
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      throw Object.assign(new Error('Invalid indicator application directory.'), { code: 'UNSAFE_INDICATOR_CACHE' })
    }
  }
  const metadata = join(bundle, 'Contents', 'Info.plist')
  const metadataInfo = await lstat(metadata)
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || (metadataInfo.mode & 0o022)
    || (typeof process.getuid === 'function' && metadataInfo.uid !== process.getuid())
    || await readFile(metadata, 'utf8') !== BUNDLE_INFO) {
    throw Object.assign(new Error('Invalid indicator application metadata.'), { code: 'UNSAFE_INDICATOR_CACHE' })
  }
  const binary = join(bundle, 'Contents', 'MacOS', EXECUTABLE)
  const info = await lstat(binary)
  if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o100) || (info.mode & 0o022)
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw Object.assign(new Error('Invalid indicator executable.'), { code: 'UNSAFE_INDICATOR_CACHE' })
  }
  return binary
}

function ownerOf(exec) {
  const value = exec?.agent?.session || exec?.agent
  return value && (typeof value === 'object' || typeof value === 'function') ? value : FALLBACK
}

function windowBounds(value) {
  if (!value) return undefined
  const { x, y, width, height } = value
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0
    || [x, y, width, height].some((number) => Math.abs(number) > 1000000)) return undefined
  return { x, y, width, height }
}

/** Compile only our shipped source, into a private per-user cache. No shell or
 * downloaded executable is involved, and no compiler-install UI is launched.
 */
export async function ensureControlIndicatorBinary(options = {}) {
  const source = options.sourcePath || SOURCE
  const bytes = await readFile(source)
  const key = createHash('sha256').update(bytes).update(process.arch).update(BUNDLE_INFO).digest('hex').slice(0, 24)
  const directory = options.cacheRoot || join(homedir(), 'Library', 'Caches', 'dsh-computer-use', 'control-indicator')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const parent = await lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022)
    || (typeof process.getuid === 'function' && parent.uid !== process.getuid())) {
    throw Object.assign(new Error('Control indicator cache is not private.'), { code: 'UNSAFE_INDICATOR_CACHE' })
  }
  const bundle = join(directory, `control-indicator-${key}.app`)
  try {
    return await validateBundle(bundle)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  let compiler
  for (const candidate of options.compilerPaths || [
    '/Library/Developer/CommandLineTools/usr/bin/swiftc',
    '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc',
  ]) {
    try { await access(candidate, constants.X_OK); compiler = candidate; break } catch {}
  }
  if (!compiler) throw Object.assign(new Error('No installed Swift compiler is available.'), { code: 'SWIFT_COMPILER_UNAVAILABLE' })
  let sdk
  for (const candidate of options.sdkPaths || [
    resolve(dirname(compiler), '../../SDKs/MacOSX.sdk'),
    '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk',
  ]) {
    try { await access(candidate, constants.R_OK); sdk = candidate; break } catch {}
  }
  if (!sdk) throw Object.assign(new Error('No installed macOS SDK is available.'), { code: 'SWIFT_SDK_UNAVAILABLE' })
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : undefined
  if (!architecture) throw Object.assign(new Error('Unsupported indicator architecture.'), { code: 'UNSUPPORTED_ARCHITECTURE' })
  const temporary = join(directory, `.control-indicator-build-${randomUUID()}.app`)
  try {
    const executable = join(temporary, 'Contents', 'MacOS', EXECUTABLE)
    await mkdir(dirname(executable), { recursive: true, mode: 0o700 })
    await writeFile(join(temporary, 'Contents', 'Info.plist'), BUNDLE_INFO, { flag: 'wx', mode: 0o600 })
    await (options.compile || execute)(compiler, ['-sdk', sdk, '-target', `${architecture}-apple-macosx13.0`, '-O', source, '-o', executable], { shell: false, timeout: 60000, maxBuffer: 64 * 1024 })
    await chmod(executable, 0o700)
    try { await rename(temporary, bundle) }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error }
    return await validateBundle(bundle)
  } finally {
    // This is the exact fresh UUID directory created above, never a user path.
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** One helper serves all session-local panels. An explicit Stop is latched for
 * that owner until a new DSH session is created. It is never reset by hide().
 * Options are injectable solely for deterministic lifecycle tests.
 */
export function createControlIndicator(_ctx, cfg = {}, options = {}) {
  const platform = options.platform || process.platform
  const enabled = cfg.enabled !== false && cfg.desktopIndicator !== false
  const launch = options.spawn || spawn
  const prepare = options.ensureBinary || (() => ensureControlIndicatorBinary(options))
  const timeoutMs = options.timeoutMs ?? 5000
  const idleMs = options.idleMs ?? 30000
  const owners = new WeakMap()
  const visible = new Map()
  const pending = new Map()
  let helper, starting, disposed = false, idleTimer, lastReason

  const report = (reason) => { lastReason = reason; try { Promise.resolve(cfg.onError?.({ reason })).catch(() => undefined) } catch {} }
  const recordFor = (exec) => {
    const owner = ownerOf(exec)
    let record = owners.get(owner)
    if (!record) {
      record = { id: randomUUID(), owner, revision: 0, stopped: false, visible: false }
      owners.set(owner, record)
    }
    return record
  }
  const settle = (record, value) => {
    const waiter = pending.get(record.id)
    if (!waiter) return
    pending.delete(record.id)
    clearTimeout(waiter.timer)
    waiter.resolve(value)
  }
  const write = (value) => {
    if (!helper?.ready || helper.child.stdin.destroyed || !helper.child.stdin.writable) return false
    try { helper.child.stdin.write(`${JSON.stringify(value)}\n`); return true } catch { return false }
  }
  const detachAbort = (record) => {
    if (record.signal && record.abort) record.signal.removeEventListener('abort', record.abort)
    record.signal = undefined; record.abort = undefined
  }
  const scheduleIdle = () => {
    if (!visible.size && helper && !idleTimer) {
      idleTimer = setTimeout(() => { idleTimer = undefined; void shutdown() }, idleMs)
      idleTimer.unref?.()
    }
  }
  const remove = (record, reason = 'HIDDEN', available = true) => {
    record.revision++
    write({ op: 'hide', owner: record.id })
    visible.delete(record.id)
    record.visible = false
    detachAbort(record)
    settle(record, { available, visible: false, reason })
    record.exec = undefined
    record.onStop = undefined
    scheduleIdle()
  }
  const invokeStop = (record, reason = 'USER_STOPPED') => {
    if (record.stopped) return false
    // This synchronous latch precedes any async cancellation/driver cleanup.
    record.stopped = true
    const exec = record.exec
    const callback = record.onStop || cfg.onStop
    remove(record, 'CONTROL_STOPPED')
    try { Promise.resolve(callback?.({ exec, owner: record.owner, reason })).catch(() => report('STOP_CALLBACK_FAILED')) }
    catch { report('STOP_CALLBACK_FAILED') }
    return true
  }
  const failHelper = (current, reason) => {
    if (helper !== current) return
    current.ready = false
    helper = undefined
    clearTimeout(idleTimer); idleTimer = undefined
    // Loss of the required visible indicator also stops in-flight operations,
    // not merely the next tool call. Host cancellation runs via the same latch.
    for (const record of [...visible.values()]) invokeStop(record, reason)
    current.finishReady?.(false)
    report(reason)
    try { current.child.kill('SIGTERM') } catch {}
  }
  const shutdown = async () => {
    clearTimeout(idleTimer); idleTimer = undefined
    const current = helper
    if (!current) return
    write({ op: 'shutdown' })
    current.ready = false
    helper = undefined
    try { current.child.stdin.end() } catch {}
    await new Promise((resolve) => {
      if (current.child.exitCode !== null && current.child.exitCode !== undefined) return resolve()
      const timer = setTimeout(() => { try { current.child.kill('SIGTERM') } catch {}; resolve() }, 1000)
      timer.unref?.()
      current.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  const getHelper = async () => {
    if (helper?.ready) return helper
    if (starting) return starting
    starting = (async () => {
      let child
      try {
        const binary = await prepare()
        if (disposed) return undefined
        child = launch(binary, [], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      } catch (error) {
        report(['SWIFT_COMPILER_UNAVAILABLE', 'SWIFT_SDK_UNAVAILABLE', 'UNSAFE_INDICATOR_CACHE'].includes(error.code) ? error.code : 'INDICATOR_START_FAILED')
        return undefined
      }
      const current = { child, ready: false, buffer: '' }
      helper = current
      const ready = new Promise((resolve) => {
        const timer = setTimeout(() => { failHelper(current, 'INDICATOR_START_TIMEOUT'); resolve(false) }, timeoutMs)
        timer.unref?.()
        current.finishReady = (value) => { clearTimeout(timer); resolve(value) }
      })
      child.on('error', () => failHelper(current, 'INDICATOR_PROCESS_FAILED'))
      child.on('exit', () => failHelper(current, 'INDICATOR_PROCESS_EXITED'))
      child.stdin.on('error', () => failHelper(current, 'INDICATOR_PIPE_FAILED'))
      child.stdout.on('data', (chunk) => {
        if (helper !== current) return
        current.buffer += chunk.toString('utf8')
        if (current.buffer.length > MAX_LINE && !current.buffer.includes('\n')) return failHelper(current, 'INDICATOR_PROTOCOL_ERROR')
        let newline
        while ((newline = current.buffer.indexOf('\n')) >= 0) {
          const line = current.buffer.slice(0, newline)
          current.buffer = current.buffer.slice(newline + 1)
          if (line.length > MAX_LINE) return failHelper(current, 'INDICATOR_PROTOCOL_ERROR')
          let event
          try { event = JSON.parse(line) } catch { continue }
          if (event?.event === 'ready') { current.ready = true; lastReason = undefined; current.finishReady(true); scheduleIdle(); continue }
          const record = visible.get(event?.owner)
          if (!record) continue
          if (event.event === 'stop') invokeStop(record)
          else if (event.event === 'visible' && event.revision === record.revision) {
            record.visible = true
            settle(record, { available: true, visible: true })
          }
        }
      })
      return await ready ? current : undefined
    })().finally(() => { starting = undefined })
    return starting
  }

  return {
    availability() { return { available: enabled && platform === 'darwin' && !disposed && !lastReason, ready: Boolean(helper?.ready), visiblePanels: visible.size, ...(lastReason ? { reason: lastReason } : {}) } },
    isStopped(exec) { return recordFor(exec).stopped },
    async update(exec, update = {}) {
      if (disposed) return { available: false, visible: false, reason: 'DISPOSED' }
      if (!enabled || platform !== 'darwin') return { available: false, visible: false, reason: enabled ? 'UNSUPPORTED_PLATFORM' : 'DISABLED' }
      if (!Object.hasOwn(LABELS, update.phase)) return { available: false, visible: false, reason: 'INVALID_PHASE' }
      const record = recordFor(exec)
      if (record.stopped) return { available: true, visible: false, reason: 'CONTROL_STOPPED' }
      if (exec?.signal?.aborted) { remove(record, 'CANCELLED'); return { available: true, visible: false, reason: 'CANCELLED' } }
      settle(record, { available: true, visible: false, reason: 'SUPERSEDED' })
      const revision = ++record.revision
      record.exec = exec
      if (typeof update.onStop === 'function') record.onStop = update.onStop
      detachAbort(record)
      if (exec?.signal) {
        record.signal = exec.signal
        record.abort = () => remove(record, 'CANCELLED')
        exec.signal.addEventListener('abort', record.abort, { once: true })
      }
      const current = await getHelper()
      if (record.revision !== revision) { scheduleIdle(); return { available: true, visible: false, reason: 'SUPERSEDED' } }
      if (record.stopped || exec?.signal?.aborted || disposed) {
        remove(record, record.stopped ? 'CONTROL_STOPPED' : 'CANCELLED')
        return { available: true, visible: false, reason: record.stopped ? 'CONTROL_STOPPED' : 'CANCELLED' }
      }
      if (!current) { const reason = lastReason || 'INDICATOR_UNAVAILABLE'; remove(record, reason, false); return { available: false, visible: false, reason } }
      clearTimeout(idleTimer); idleTimer = undefined
      visible.set(record.id, record)
      const result = new Promise((resolve) => {
        const timer = setTimeout(() => { remove(record, 'INDICATOR_ACK_TIMEOUT', false); report('INDICATOR_ACK_TIMEOUT') }, timeoutMs)
        timer.unref?.()
        pending.set(record.id, { revision, resolve, timer })
      })
      if (!write({ op: 'update', owner: record.id, revision, status: update.phase, label: LABELS[update.phase], ...(windowBounds(update.window) ? { window: windowBounds(update.window) } : {}) })) {
        remove(record, 'INDICATOR_PIPE_FAILED', false)
      }
      return result
    },
    hide(exec) { remove(recordFor(exec)); return { visible: false } },
    stop(exec, reason = 'HOST_STOPPED') { return invokeStop(recordFor(exec), reason) },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const record of [...visible.values()]) remove(record, 'DISPOSED')
      await starting
      await shutdown()
    },
  }
}
