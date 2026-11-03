/**
 * Compatibility entry point for the real-driver source-plugin smoke check.
 * This performs background Calculator actions (7 × 8 = 56); it does not
 * reload DSH or exercise its real model, policy, or attachment services.
 * Optional first argument: evidence JSON output path.
 */
console.log('verify-runtime 将后台操作 macOS 计算器验证 7 × 8 = 56。使用真实插件源码和 cua-driver，宿主服务为桩；不代表 DSH 已重载或真实模型集成已验证。')
await import('./verify-desktop.mjs')
