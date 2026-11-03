import { cuaCall, resolveBin } from '../lib/cua.js'

console.log(`Driver: ${resolveBin()}`)
try {
  const report = await cuaCall('health_report')
  console.log(JSON.stringify(report, null, 2))
} catch (err) {
  console.error(`[${err.code || 'DRIVER_ERROR'}] ${err.message}`)
  console.error('安装与授权说明：https://cua.ai/docs/cua-driver/quickstart')
  console.error('macOS 授权：cua-driver permissions grant（需要本人完成系统授权）。')
  process.exitCode = 1
}
