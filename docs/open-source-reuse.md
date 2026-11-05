# 开源实现调研与复用记录

核对日期：2026-11-05。以下链接固定到本轮实际读取的源码提交，避免把上游后续变化当成本插件已支持的能力。

## 来源与采用方式

| 项目 / 固定提交 | 阅读的实现 | 本插件的采用方式 |
| --- | --- | --- |
| [OpenAI CUA sample app](https://github.com/openai/openai-cua-sample-app/tree/6dd34b40acc1d002696ccd41aaf0a1f2f2be290c) | [执行进程的取消、超时与清理](https://github.com/openai/openai-cua-sample-app/blob/6dd34b40acc1d002696ccd41aaf0a1f2f2be290c/javascript-app/src/browser/javascript-process.ts)、[模型循环](https://github.com/openai/openai-cua-sample-app/blob/6dd34b40acc1d002696ccd41aaf0a1f2f2be290c/javascript-app/src/responses-loop.ts) | 取消信号传到底层执行进程，执行结束再次检查取消；未知结果不重放。保留 DSH 自己的工具注册、宿主审批与会话管理。 |
| [OpenAI Agents SDK Python](https://github.com/openai/openai-agents-python/tree/814de8b1cfdaf6c70212dca9ca23563dd0b789ac) | [Computer / AsyncComputer 接口](https://github.com/openai/openai-agents-python/blob/814de8b1cfdaf6c70212dca9ca23563dd0b789ac/src/agents/computer.py)、[顺序执行与安全检查回调](https://github.com/openai/openai-agents-python/blob/814de8b1cfdaf6c70212dca9ca23563dd0b789ac/src/agents/run_internal/tool_execution.py#L2532) | 用来核对模型编排与执行层的边界。DSH 已提供 agent loop，本轮不再嵌套一个 SDK 循环，也不把 OpenAI API 设为插件运行依赖。 |
| [Cua / cua-driver](https://github.com/trycua/cua/tree/effe7a5ab279cc6d02404cebd42806a7bc81c699) | [驱动集成入口](https://github.com/trycua/cua/blob/effe7a5ab279cc6d02404cebd42806a7bc81c699/libs/cua-driver/README.md)、[能力声明](https://github.com/trycua/cua/blob/effe7a5ab279cc6d02404cebd42806a7bc81c699/libs/cua-driver/rust/crates/cua-driver-core/src/tool.rs#L306) | 复用原生后台输入、AX、截图和会话能力；新增实际 schema/运行身份握手。只在确证消费能力且本次 PNG 返回 capture_id 时绑定一次性点击。安装、升级、系统授权仍由用户按官方说明操作。 |
| [Anthropic computer-use-demo](https://github.com/anthropics/claude-quickstarts/tree/8ef47d719eba5379ff8f38133f5defcc499e856f/computer-use-demo) | [截图尺寸与坐标转换](https://github.com/anthropics/claude-quickstarts/blob/8ef47d719eba5379ff8f38133f5defcc499e856f/computer-use-demo/computer_use_demo/tools/computer.py#L228) | 明确图片尺寸与动作坐标的对应关系；附件服务改变图片尺寸时拒绝创建点击授权。CUA zoom 自带缩放/留白，继续使用 `from_zoom`，不照搬 Linux 桌面坐标公式。 |
| [browser-use](https://github.com/browser-use/browser-use/tree/b49a68e4060acb226da8f784194fef301c53a6d7) | [弹窗 watchdog](https://github.com/browser-use/browser-use/blob/b49a68e4060acb226da8f784194fef301c53a6d7/browser_use/browser/watchdogs/popups_watchdog.py#L72)、[DOM 采集预算](https://github.com/browser-use/browser-use/blob/b49a68e4060acb226da8f784194fef301c53a6d7/browser_use/browser/watchdogs/dom_watchdog.py#L354) | 吸收事件处理、分阶段采集和共享 deadline；本插件使用受预算约束的 DOM 遍历、独立全页安全扫描和精确续页位置。弹窗保留 DSH 显式处理和审批。 |
| [open-computer-use（iFurySt）](https://github.com/iFurySt/open-computer-use/tree/7657d49b641db367ec4b5d9c8d41e638501c82cd) | [SetValueReadBack](https://github.com/iFurySt/open-computer-use/blob/7657d49b641db367ec4b5d9c8d41e638501c82cd/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/SetValueReadBack.swift#L62)、[定向查询](https://github.com/iFurySt/open-computer-use/blob/7657d49b641db367ec4b5d9c8d41e638501c82cd/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/TargetedQuery.swift#L79) | 将“只写一次、有限时间只读回验”用于普通网页字段替换和原生下拉框。读回不一致不自动补写，不用其它输入路径重试。 |

本轮复用的是机制，新增代码由本插件独立实现；未复制上游实现文件、打包其二进制或安装模型权重。执行层使用 `playwright-core` 与外部 `cua-driver`，当前 Chrome 桥接使用 `ws`。ESLint、Prettier 及其配置依赖仅用于开发检查。

## 许可证与产品边界

- 以上固定提交中，OpenAI sample app、Agents SDK、Anthropic quickstarts、browser-use 和 iFurySt/open-computer-use 的根许可证均为 MIT，详见各仓库对应提交的 `LICENSE`。未来若直接复制代码或随包分发组件，应保留实际组件要求的版权与许可证。
- Cua 当前固定提交的 [LICENSE.md](https://github.com/trycua/cua/blob/effe7a5ab279cc6d02404cebd42806a7bc81c699/LICENSE.md) 为 MIT；驱动 [Cargo.toml](https://github.com/trycua/cua/blob/effe7a5ab279cc6d02404cebd42806a7bc81c699/libs/cua-driver/rust/Cargo.toml) 也声明 MIT。不能继续按旧 FSL 描述概括这个版本，也不能据此推断本机任意旧驱动或所有附属组件的许可。
- 同一仓库仍有 FSL-1.1-MIT 组件；Spaces 等模块的范围见 [分组件许可清单](https://github.com/trycua/cua/blob/effe7a5ab279cc6d02404cebd42806a7bc81c699/legal/LICENSING.md)。应按实际使用的子组件核对，不能把整个仓库统称 MIT。
- 可选 `cua-perception` 的 OmniParser 图标检测器单独标注 AGPL-3.0-only；[上游 notices](https://github.com/trycua/cua/blob/effe7a5ab279cc6d02404cebd42806a7bc81c699/libs/cua-driver/docs/perception-third-party-notices.md) 明确要求区分驱动、扩展和模型。本轮未引入该扩展。
- 开源示例与 SDK 不能证明 OpenAI 产品内部插件、扩展或模型权重已开源。插件继续使用 DSH 提供的模型，不需要新增 OpenAI 账户或 API key。
- `open-computer-use` 有同名项目，本轮具体研究的是上表 iFurySt 仓库；不把其它项目的跨平台宣传合并到它的能力里。浏览器登录态复用也以本插件已实现的 Chrome 扩展协议和实测范围为准。

## 本轮行为与验证入口

1. 原生驱动取消：调用前已取消不启动进程；调用中取消终止 CLI 并返回 `CANCELLED`。清理所属驱动会话仍可执行。终止客户端不能证明已经投递的原生动作被撤销，结果不明时必须重新观察。
2. 网页写入回验：普通字段 `replace:true` 和原生下拉框只执行一次写入，再有界读取当前值；返回验证状态而不复制字段实际值。写入异常使用固定诊断，不回传可能包含输入值的 Playwright call log。追加输入保持“已投递”语义。`verified` 仅确认该字段读回，不等于服务端保存或整个业务完成。
3. 图像坐标：核对驱动/viewport 的输出尺寸和附件报告的尺寸；非法或不一致时拒绝坐标授权，附件未报告尺寸时沿用已验证的驱动尺寸。浏览器截图还绑定原页面和文档代次，截图期间、点击前及审批后复核，包含同 URL 重载。驱动 zoom 仍由驱动转换。

针对性测试位于 `tests/cua-cancellation.test.mjs`、`tests/session-signal.test.mjs`、`tests/tool-cancellation-result.test.mjs`、`tests/browser-write-verification.test.mjs` 与 `tests/observe-coordinate-space.test.mjs`。本轮实际运行结果和真实环境边界见 [VERIFICATION](../VERIFICATION.md)。

```sh
npm test
npm run check
DSH_VERIFY_BROWSER_WRITES=1 node --test tests/browser-write-verification.test.mjs
node --test tests/browser-companion-background.integration.mjs tests/chrome-bridge-popup.integration.mjs
```

真实浏览器测试启动新的 headless Chrome 和本机 fixture，结束后关闭；不连接用户日常 Chrome。默认单元测试不启动浏览器，因此真实写入场景需要显式启用。

## 第二轮：采集预算与驱动能力握手

- `lib/browser-observation.js` 把输出遍历和全页安全扫描拆为两类节点额度，跨 frame 共用一次观察的 deadline；按当前输出创建句柄，保留页面/文档绑定的遍历位置以便续页。query、scope 和 continuation 不跳过安全扫描，预算未完成时阻止文本、按键和下拉框自动输入。未标注可编辑值不作为控件名称返回。
- `lib/driver-capabilities.js` 使用只读 `manifest`、`describe`、`health_report`，核对 schema 与运行中二进制 SHA256，并在探测前后、动作前及审批后检查文件身份。缓存60秒，总探测预算3秒；未知与畸形 schema 不被推断为支持。工具声明与截图生产端分开，不能凭版本号或单个 capture_id 字段认定全链路可用。
- `lib/driver-capture.js` 保存原观察的私有绑定，普通像素点击只消费一次；结束会话、超时或拒绝都不重放该 capture。AX 与 zoom 保留独立协议，未声明 capture 支持的拖拽不添加该字段。真实本机只读检查仍是 `degraded`，不把传输成功当作桌面完全就绪。

新增验证入口：

```sh
node --test tests/browser-observation-budget.integration.mjs
node --test tests/driver-capabilities.test.mjs tests/driver-capture.test.mjs tests/driver-handshake.test.mjs tests/driver-handshake.integration.test.mjs
```

## 代码风格与检查

参考 OpenAI sample 的 [ESLint 配置](https://github.com/openai/openai-cua-sample-app/blob/6dd34b40acc1d002696ccd41aaf0a1f2f2be290c/eslint.config.mjs) 和 lint/typecheck/test 分层门禁，以及 browser-use 的 [Ruff lint/format 分工](https://github.com/browser-use/browser-use/blob/b49a68e4060acb226da8f784194fef301c53a6d7/pyproject.toml#L121)。所读 OpenAI sample 版本没有 Prettier 配置；本库使用 Prettier 是按 JavaScript 项目的现有风格补上的本地选择，不声称复制了上游格式。

- ESLint 覆盖源码、工具、扩展和测试，启用推荐静态错误规则及零警告门禁；按实际执行环境声明 Node、页面回调与 Chrome globals。
- Prettier 保留2空格、单引号、无分号，100列。`tools/style-check.mjs` 列出本轮核心模块和新增测试的检查范围，拆开原先一行多个 await/分支的代码，未整体改写无关文件。
- `npm run check` 串联语法、lint 与范围内的格式检查；`npm run lint`、`npm run format:check` 可单独执行。测试验证行为，不以格式检查代替运行结果。

当前 Chrome 后台不抢焦点、只控制己方登记页面、结束保留页面并取消分组的行为继续由现有测试约束。更高版本驱动或新的 capture 生产方式仍须重新核验实际协议。
