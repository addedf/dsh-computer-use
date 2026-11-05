/** Bind optional capture-aware clicks to the exact observed driver and image. */
import { assertDriverCompatibility } from './cua.js'
import { clearSnapshot } from './snapshot.js'

const CAPTURE_ID_LIMIT = 512

function captureError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function observedDriverBinding(observation, capabilities) {
  const identityKey = capabilities?.identity?.key
  if (typeof identityKey !== 'string' || !identityKey) return null

  const supported = capabilities.features?.captureClick === 'supported'
  const captureId = observation?.capture_id
  const validCapture =
    supported &&
    typeof captureId === 'string' &&
    captureId.length > 0 &&
    captureId.length <= CAPTURE_ID_LIMIT
  const required =
    supported &&
    capabilities.toolSchemas?.click?.inputSchema?.required?.includes('capture_id') === true
  let captureMode = required ? 'required-unavailable' : 'legacy'
  if (supported && captureId != null) captureMode = validCapture ? 'bound' : 'invalid'

  return {
    identityKey,
    captureMode,
    captureId: validCapture ? captureId : null,
    consumed: false,
  }
}

/** A new binary must not receive refs or screenshot coordinates from its predecessor. */
export async function verifyObservedDriver(
  snapshot,
  { check = assertDriverCompatibility, feature, allowUnknown = true } = {},
) {
  const binding = snapshot?.driverBinding
  if (!binding) return
  try {
    await check(binding.identityKey, { feature, allowUnknown })
  } catch (error) {
    clearSnapshot()
    throw error
  }
}

/** Consume before dispatch. Refusals and transport failures cannot safely restore it. */
export async function takeClickCapture(snapshot, { token, fromZoom = false, check } = {}) {
  const binding = snapshot?.driverBinding
  const boundClick = !token && !fromZoom && binding?.captureMode === 'bound'
  await verifyObservedDriver(snapshot, {
    check,
    feature: boundClick ? 'captureClick' : fromZoom ? 'fromZoomClick' : undefined,
    allowUnknown: !boundClick,
  })
  // AX tokens and the driver's padded zoom use their own existing contracts.
  if (token || fromZoom || !binding) return undefined
  if (binding.captureMode === 'invalid') {
    throw captureError(
      'DRIVER_CAPTURE_INVALID',
      '驱动返回无效的 capture_id；请重新观察，未投递像素点击。',
    )
  }
  if (binding.captureMode === 'required-unavailable') {
    throw captureError(
      'DRIVER_CAPTURE_REQUIRED',
      '驱动要求绑定截图，但本次观察未提供 capture_id；请重新观察。',
    )
  }
  if (binding.captureMode !== 'bound') return undefined
  if (binding.consumed) {
    throw captureError(
      'DRIVER_CAPTURE_CONSUMED',
      '本次截图的像素点击授权已使用；请重新观察，勿重放之前的动作。',
    )
  }
  binding.consumed = true
  return binding.captureId
}
