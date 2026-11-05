import { getDriverCapabilities, resolveBin } from '../lib/cua.js'

console.log(`Driver: ${resolveBin()}`)
try {
  const report = await getDriverCapabilities({ refresh: true })
  console.log(`Transport: ${report.transport}; readiness: ${report.readiness}`)
  console.log(JSON.stringify(report, null, 2))
  if (report.transport !== 'ok' || report.readiness === 'failed' || report.readiness === 'unknown')
    process.exitCode = 1
  if (report.readiness === 'degraded')
    console.error(
      '驱动报告 degraded；部分检查失败或能力有限，请按 health.checks 与 diagnostics 排查。',
    )
  if (report.health.checks.some((check) => check.status === 'skip'))
    console.error('跳过的健康检查仍未验证；transport 成功不证明截图或输入可用。')
} catch (err) {
  console.error(`[${err.code || 'DRIVER_ERROR'}] ${err.message}`)
  console.error('安装与授权说明：https://cua.ai/docs/cua-driver/quickstart')
  console.error('macOS 授权：cua-driver permissions grant（需要本人完成系统授权）。')
  process.exitCode = 1
}
