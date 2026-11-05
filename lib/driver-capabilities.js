import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'

const TOOL_NAMES = ['get_window_state', 'click', 'drag', 'zoom']
const CACHE_TTL_MS = 60000
const PROBE_TIMEOUT_MS = 3000
const METADATA_LIMIT_BYTES = 128 * 1024
const MAX_BINARY_BYTES = 512 * 1024 * 1024
const MAX_CACHE_ENTRIES = 8
const hashCache = new Map()
const ENUM_VALUE_TYPES = {
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: Number.isSafeInteger,
  null: (value) => value === null,
  array: Array.isArray,
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = (value) => createHash('sha256').update(value).digest('hex')
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
const compatibilityError = (code, message) => Object.assign(new Error(message), { code })
const cancelled = () => compatibilityError('CANCELLED', '驱动能力检查已取消，未投递桌面操作。')

function assertActive(signal) {
  if (signal?.aborted) throw cancelled()
}

function fingerprint(path, info) {
  if (!info.isFile() || info.size <= 0 || info.size > MAX_BINARY_BYTES) {
    throw compatibilityError('DRIVER_IDENTITY_UNAVAILABLE', '无法确认驱动可执行文件身份。')
  }
  return JSON.stringify([path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
}

export function readDriverFingerprint(binary) {
  const path = realpathSync(binary)
  return fingerprint(path, statSync(path))
}

/** Bind metadata to the actual file, including symlink targets and replacement. */
export async function readDriverIdentity(binary, { signal } = {}) {
  assertActive(signal)
  const path = await realpath(binary)
  const info = await stat(path)
  const before = fingerprint(path, info)
  let hash = hashCache.get(before)
  if (!hash) {
    const hasher = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal })) hasher.update(chunk)
    hash = hasher.digest('hex')
    assertActive(signal)
    if (fingerprint(path, await stat(path)) !== before || (await realpath(binary)) !== path) {
      throw compatibilityError(
        'DRIVER_IDENTITY_CHANGED',
        '能力检查期间驱动文件已变化，请重新检查。',
      )
    }
    if (hashCache.size >= MAX_CACHE_ENTRIES) hashCache.delete(hashCache.keys().next().value)
    hashCache.set(before, hash)
  }
  assertActive(signal)
  return {
    binaryPath: binary,
    realPath: path,
    fingerprint: before,
    sha256: hash,
    key: digest(`${before}\n${hash}`),
  }
}

/** This entry point admits only finite, read-only CLI metadata commands. */
export async function inspectDriverMetadata(
  binary,
  argv,
  { signal, timeoutMs = PROBE_TIMEOUT_MS } = {},
) {
  const allowed =
    (argv.length === 1 && argv[0] === 'manifest') ||
    (argv.length === 2 && argv[0] === 'describe' && TOOL_NAMES.includes(argv[1]))
  if (!allowed)
    return Promise.reject(
      compatibilityError('DRIVER_METADATA_COMMAND_INVALID', '不支持的驱动元数据命令。'),
    )
  assertActive(signal)
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      argv,
      {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: METADATA_LIMIT_BYTES,
        signal,
      },
      (error, stdout) => {
        if (signal?.aborted) return reject(cancelled())
        if (error) {
          const code =
            error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'DRIVER_METADATA_OUTPUT_LIMIT'
              : error.killed
                ? 'DRIVER_METADATA_TIMEOUT'
                : 'DRIVER_METADATA_UNAVAILABLE'
          reject(compatibilityError(code, '驱动元数据读取失败；未据此推断能力。'))
        } else resolve(stdout)
      },
    )
  })
}

/** Parse the official describe format without treating its prose as a schema. */
export function parseDriverDescription(text, expectedName) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > METADATA_LIMIT_BYTES)
    throw new Error('invalid metadata')
  const header = /^name: ([a-z_]+)\r?\n/.exec(text)
  const boundary = /\r?\ninput_schema:\r?\n/.exec(text)
  if (header?.[1] !== expectedName || !boundary) throw new Error('invalid description')
  const schema = JSON.parse(text.slice(boundary.index + boundary[0].length))
  if (
    !object(schema) ||
    schema.type !== 'object' ||
    !object(schema.properties) ||
    Object.values(schema.properties).some((property) => !validPropertyEnum(property)) ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string')))
  ) {
    throw new Error('invalid input schema')
  }
  return schema
}

function validPropertyEnum(property) {
  if (!object(property)) return false
  if (!Object.hasOwn(property, 'enum')) return true
  if (!Array.isArray(property.enum) || property.enum.length === 0) return false
  const matchesType = ENUM_VALUE_TYPES[property.type]
  return !matchesType || property.enum.every(matchesType)
}

function summarizeSchema(schema) {
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([key, value]) => [
      key,
      {
        ...(typeof value?.type === 'string' ? { type: value.type } : {}),
        ...(Array.isArray(value?.enum) ? { enum: value.enum } : {}),
      },
    ]),
  )
  return {
    type: 'object',
    properties,
    required: schema.required || [],
    ...(typeof schema.additionalProperties === 'boolean'
      ? { additionalProperties: schema.additionalProperties }
      : {}),
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const entry of Object.values(value)) deepFreeze(entry)
  }
  return value
}

function hasType(schema, name, type) {
  return schema?.properties?.[name]?.type === type
}

function featureStatus(schema, checks, verified) {
  if (!schema || !verified) return 'unknown'
  return checks(schema) ? 'supported' : 'unsupported'
}

function describeFeatures(schemas, verified) {
  const window = schemas.get_window_state
  const click = schemas.click
  const drag = schemas.drag
  const zoom = schemas.zoom
  const sessionTarget = (schema) =>
    hasType(schema, 'session', 'string') &&
    hasType(schema, 'pid', 'integer') &&
    hasType(schema, 'window_id', 'integer')
  const coordinates = (schema, names) =>
    names.every((name) => hasType(schema, name, 'number') || hasType(schema, name, 'integer'))
  return {
    structuredElements: featureStatus(
      window,
      (schema) =>
        sessionTarget(schema) &&
        hasType(schema, 'tree_format', 'string') &&
        Array.isArray(schema.properties.tree_format.enum) &&
        schema.properties.tree_format.enum.every((value) => typeof value === 'string') &&
        schema.properties.tree_format.enum.includes('elements'),
      verified,
    ),
    captureClick: featureStatus(
      click,
      (schema) =>
        sessionTarget(schema) &&
        coordinates(schema, ['x', 'y']) &&
        hasType(schema, 'capture_id', 'string'),
      verified,
    ),
    captureDrag: featureStatus(
      drag,
      (schema) =>
        sessionTarget(schema) &&
        coordinates(schema, ['from_x', 'from_y', 'to_x', 'to_y']) &&
        hasType(schema, 'capture_id', 'string'),
      verified,
    ),
    zoom: featureStatus(
      zoom,
      (schema) => sessionTarget(schema) && coordinates(schema, ['x1', 'y1', 'x2', 'y2']),
      verified,
    ),
    fromZoomClick: featureStatus(
      click,
      (schema) =>
        sessionTarget(schema) &&
        coordinates(schema, ['x', 'y']) &&
        hasType(schema, 'from_zoom', 'boolean'),
      verified,
    ),
  }
}

/** Health readiness is the driver's own stable report, independent of transport. */
export function summarizeDriverHealth(report) {
  const valid =
    object(report) &&
    report.schema_version === '1' &&
    typeof report.driver_version === 'string' &&
    report.driver_version.length > 0 &&
    typeof report.platform === 'string' &&
    report.platform.length > 0 &&
    ['ok', 'degraded', 'failed'].includes(report.overall) &&
    Array.isArray(report.checks) &&
    report.checks.every(
      (check) =>
        object(check) &&
        typeof check.name === 'string' &&
        ['pass', 'fail', 'skip'].includes(check.status),
    )
  const readiness = valid ? (report.overall === 'ok' ? 'ready' : report.overall) : 'unknown'
  return {
    readiness,
    schemaVersion: typeof report?.schema_version === 'string' ? report.schema_version : null,
    driverVersion: typeof report?.driver_version === 'string' ? report.driver_version : null,
    platform: typeof report?.platform === 'string' ? report.platform : null,
    checks: valid
      ? report.checks.map(({ name, status, message, hint }) => ({
          name,
          status,
          ...(typeof message === 'string' ? { message: message.slice(0, 1000) } : {}),
          ...(typeof hint === 'string' ? { hint: hint.slice(0, 1000) } : {}),
        }))
      : [],
  }
}

/** Injectable read-only handshake. No action, session start, installation or grant. */
export function createDriverCapabilitiesProbe({
  resolveBinary,
  callHealth,
  inspect = inspectDriverMetadata,
  identify = readDriverIdentity,
  currentFingerprint = readDriverFingerprint,
  now = Date.now,
  ttlMs = CACHE_TTL_MS,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof resolveBinary !== 'function' || typeof callHealth !== 'function')
    throw new TypeError('driver probe requires binary and health adapters')
  const cache = new Map()
  let latest = null

  function peek() {
    if (!latest || now() >= latest.expiresAt) return null
    try {
      const binary = resolveBinary()
      if (
        binary !== latest.identity.binaryPath ||
        currentFingerprint(binary) !== latest.identity.fingerprint
      )
        return null
      return latest
    } catch {
      return null
    }
  }

  async function get({ signal, refresh = false } = {}) {
    assertActive(signal)
    const binary = resolveBinary()
    const controller = new AbortController()
    let timedOut = false
    let identity = null
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const diagnostics = []
    try {
      const work = async () => {
        identity = await identify(binary, { signal: controller.signal })
        assertActive(controller.signal)
        const cached = cache.get(identity.key)
        if (!refresh && cached && now() < cached.expiresAt) {
          assertActive(controller.signal)
          latest = cached
          return cached
        }
        const probes = await Promise.allSettled([
          inspect(binary, ['manifest'], { signal: controller.signal, timeoutMs }),
          ...TOOL_NAMES.map((tool) =>
            inspect(binary, ['describe', tool], { signal: controller.signal, timeoutMs }),
          ),
          callHealth(binary, { signal: controller.signal, timeoutMs }),
        ])
        assertActive(controller.signal)
        const finalIdentity = await identify(binary, { signal: controller.signal })
        assertActive(controller.signal)
        if (finalIdentity.key !== identity.key) {
          throw compatibilityError(
            'DRIVER_IDENTITY_CHANGED',
            '能力探测期间驱动文件已变化，未缓存本次结果。',
          )
        }
        const healthProbe = probes.at(-1)
        const healthReport = healthProbe.status === 'fulfilled' ? healthProbe.value : null
        const health = summarizeDriverHealth(healthReport)
        const runtimeHash = sha256(healthReport?.build?.exe_sha256)
          ? healthReport.build.exe_sha256.toLowerCase()
          : null
        const matched =
          health.readiness !== 'unknown' && runtimeHash !== null && runtimeHash === identity.sha256
        if (!runtimeHash || health.readiness === 'unknown')
          diagnostics.push('DRIVER_RUNTIME_IDENTITY_UNKNOWN')
        else if (runtimeHash !== identity.sha256)
          diagnostics.push('DRIVER_RUNTIME_IDENTITY_MISMATCH')
        if (health.readiness === 'unknown') diagnostics.push('DRIVER_HEALTH_SCHEMA_UNKNOWN')
        if (healthProbe.status === 'rejected')
          diagnostics.push(healthProbe.reason?.code || 'DRIVER_HEALTH_UNAVAILABLE')
        let manifest = null
        try {
          if (probes[0].status === 'fulfilled') {
            const parsed = JSON.parse(probes[0].value)
            if (parsed?.schema_version === '1' && Array.isArray(parsed.subcommands))
              manifest = parsed
          }
        } catch {
          /* Unknown CLI manifests do not authorize features. */
        }
        if (!manifest) diagnostics.push('DRIVER_MANIFEST_UNKNOWN')
        const schemas = {}
        const toolSchemas = {}
        TOOL_NAMES.forEach((tool, index) => {
          const probe = probes[index + 1]
          try {
            if (probe.status !== 'fulfilled') throw probe.reason
            schemas[tool] = parseDriverDescription(probe.value, tool)
            toolSchemas[tool] = {
              status: matched ? 'verified' : 'unverified',
              inputSchema: summarizeSchema(schemas[tool]),
            }
          } catch {
            toolSchemas[tool] = { status: 'unknown', inputSchema: null }
            diagnostics.push(`DRIVER_SCHEMA_UNKNOWN:${tool}`)
          }
        })
        const checkedAt = now()
        const report = deepFreeze({
          source: 'cua-driver-read-only-handshake',
          checkedAt,
          expiresAt: checkedAt + ttlMs,
          transport: healthProbe.status === 'fulfilled' ? 'ok' : 'error',
          readiness: health.readiness,
          identity: { ...identity, runtimeSHA256: runtimeHash, matched },
          cliVersion: typeof manifest?.binary_version === 'string' ? manifest.binary_version : null,
          health,
          features: describeFeatures(schemas, matched),
          captureProducer: {
            status: 'unverified',
            reason:
              'get_window_state has no output schema; require an actual session-owned PNG capture_id before binding an action.',
          },
          toolSchemas,
          diagnostics,
        })
        assertActive(controller.signal)
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value)
        cache.set(identity.key, report)
        latest = report
        return report
      }
      let onAbort
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(cancelled())
        controller.signal.addEventListener('abort', onAbort, { once: true })
        if (controller.signal.aborted) onAbort()
      })
      try {
        return await Promise.race([work(), interrupted])
      } finally {
        controller.signal.removeEventListener('abort', onAbort)
      }
    } catch (error) {
      if (signal?.aborted) throw cancelled()
      const code = timedOut
        ? 'DRIVER_CAPABILITIES_TIMEOUT'
        : error.code || 'DRIVER_CAPABILITIES_UNAVAILABLE'
      return deepFreeze({
        source: 'cua-driver-read-only-handshake',
        checkedAt: now(),
        expiresAt: now(),
        transport: 'error',
        readiness: 'unknown',
        identity: identity ? { ...identity, runtimeSHA256: null, matched: false } : null,
        cliVersion: null,
        health: summarizeDriverHealth(null),
        features: describeFeatures({}, false),
        captureProducer: { status: 'unverified' },
        toolSchemas: Object.fromEntries(
          TOOL_NAMES.map((tool) => [tool, { status: 'unknown', inputSchema: null }]),
        ),
        diagnostics: [code],
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  async function assertCompatibility(identityKey, { feature, allowUnknown = false, signal } = {}) {
    assertActive(signal)
    let identity
    try {
      identity = await identify(resolveBinary(), { signal })
    } catch {
      assertActive(signal)
      throw compatibilityError(
        'DRIVER_IDENTITY_CHANGED',
        '无法复核原驱动文件，请重新观察；本次操作未投递。',
      )
    }
    if (identity.key !== identityKey)
      throw compatibilityError(
        'DRIVER_IDENTITY_CHANGED',
        '驱动文件已变化，请重新观察；本次操作未投递。',
      )
    const report = cache.get(identityKey)
    if (!report || now() >= report.expiresAt)
      throw compatibilityError(
        'DRIVER_CAPABILITIES_EXPIRED',
        '驱动能力握手已失效，请重新观察；本次操作未投递。',
      )
    if (feature !== undefined) {
      if (!Object.hasOwn(report.features, feature))
        throw compatibilityError('DRIVER_FEATURE_UNKNOWN', '未定义的驱动能力，已拒绝本次操作。')
      const status = report.features[feature]
      const legacyAllowed = status === 'unknown' && allowUnknown && !feature.startsWith('capture')
      if (status !== 'supported' && !legacyAllowed) {
        throw compatibilityError(
          status === 'unsupported' ? 'DRIVER_FEATURE_UNSUPPORTED' : 'DRIVER_FEATURE_UNKNOWN',
          `驱动能力 ${feature} 未获确认，请重新检查；本次操作未投递。`,
        )
      }
    }
    return report
  }

  return { get, peek, assertCompatibility }
}
