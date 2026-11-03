# PERMISSIONS — dsh-computer-use

本文件声明 `dsh-computer-use` 插件在运行时实际使用的权限面（DSH STORE 审查依据）。

## 总览（运行时行为）

- 通过**宿主 `child_process.spawn` 以非 shell 固定 argv** 调用 `cua-driver` 原生驱动（跨平台：macOS / Windows / Linux），驱动本地桌面：
  - 屏幕观测：`screen_observe` / `screen_zoom`（读取被观测应用的 Accessibility/AX 树与窗口快照）
  - 虚拟鼠标键盘模拟：`computer_click` / `computer_double_click` / `computer_right_click` / `computer_type` / `computer_key` / `computer_scroll` / `computer_drag` / `computer_wait`
  - 应用枚举与启动：`app_list` / `app_launch`
  - 只读诊断：`computer_status`
  - 独立临时 Chromium：`browser_open` / `browser_observe` / `browser_navigate` / `browser_click` / `browser_type` / `browser_scroll`；读取网页 DOM/语义状态，以最新 ref 后台操作
  - 批量执行：`run_steps` 每一步都通过宿主 `tools.execute` 权限流程和插件护栏；失败即停
- 默认网页后端使用 `playwright-core` 启动本机 Chrome 独立临时上下文；不下载浏览器、不连接现有用户 profile。支持本会话标签页/导航/表单/指针/页面弹窗/截图；headless 默认开启。
- `computer_verify` / `computer_wait_for` / `browser_verify` / `browser_wait_for` 只读检查声明式条件；unknown 不通过。包内技能注册到宿主，`computer_skill` 只返回指导正文。
- `cua-driver` 可执行文件来源：环境变量 `CUA_DRIVER_BIN` 显式指定，或 `PATH` 查找；缺失时返回结构化错误（含自救指引），不静默。
- 内置安全护栏（所有工具统一走 `guard()` 包装）：**危险词审批**（敏感目标操作先请求用户确认）、**密码框保护**（检测到密码输入目标时拒绝）、**过期状态拒绝**（观测快照过期后拒绝执行）、**作用域权限**（仅授权应用/窗口内操作）。
- 键盘/文本动作优先使用后台投递；仅当驱动明确拒绝后台投递并建议前台模式，且当前工具/平台支持该模式时，才通过宿主 `approval` 服务请求本次授权。未获 `allowed-once` 时不切换焦点、不重试。

## 明确不做

- ⚠️ browser_upload 先针对安全页面地址和完整文件路径申请本次上传审批，获准后才经宿主 fs 映射/大小检查读取普通文件；拒绝时不读取文件字节。可选 GLM fallback 读取用户配置的 key 来源用于本次视觉请求，不写入或输出 key。
- ⚠️ 上传等待本次审批可超过快照 TTL，但批准后须在读前/发前重新核对同一页面、frame和原文件控件；批准的文件列表固定。目标变化不交付文件，不延长或复活旧 ref，其他动作过期规则不变。
- ⚠️ 浏览器访问用户指定的 http/https 网页，网页自身可以发起网络请求；GLM fallback 被选中且已配置 key 时，通过 HTTPS 请求 Z.AI GLM 视觉 API
- ❌ 不访问 DSH/Hermes 凭据或任意业务凭据（`CUA_DRIVER_BIN` 只用于定位可执行文件；上述 GLM key 是可选的用户显式配置）
- ⚠️ browser_download 受宿主 sandboxPolicy 限制写入明确目录，只创建新文件、禁止覆盖/符号链接、总量最多10MiB；缺服务或 read-only 时拒绝。浏览器使用临时 profile，会话关闭/插件卸载时清理；截图由宿主 attachments 服务保存。
- ❌ 无 npm 生命周期脚本（install / postinstall 等一律没有；安装包内的 `install.sh` / `uninstall.sh` 是给用户手动执行的安装辅助脚本，非 npm lifecycle）
- ⚠️ 点击使用独立虚拟光标，不移动用户真实鼠标；但经用户逐次批准的前台键盘/文本重试可能将目标窗口置于前台。未获批准时不进行前台重试。

## 宿主依赖（仅两个，均为官方/DSH 生态）

这两个包只声明为 `peerDependencies`，由 DSH 宿主提供并解析；插件不会把它们作为独立 runtime 副本打包进 profile。开发测试所需版本仅放在 `devDependencies` 中。

额外运行依赖 `playwright-core` 提供受支持的独立浏览器后端，不带浏览器下载 lifecycle。`dsh-skill` 只作为开发依赖验证原生技能注册契约；运行时按宿主实际提供的 skills/systemPrompt 服务注册与降级。

| 宿主依赖 | 用途 |
|---|---|
| `@deepseek-ai/dsh-tools` | 注册 dsh 原生工具（`ctx.tools.register(defineTool(...))`） |
| `@deepseek-ai/schemastery` | 工具参数 schema 定义 |

## 权限信号对照（STORE 五信号）

| 信号 | 状态 | 说明 |
|---|---|---|
| 文件权限 | ⚠️ 命中 | `spawn` 子进程（cua-driver）是核心能力，属真实插件必备，提交人工审查 |
| 命令权限 | ⚠️ 命中 | 固定 argv 调用 cua-driver，或由 Playwright 启动独立 Chrome；不暴露 shell / 任意页面 JavaScript 工具 |
| 网络权限 | ⚠️ 条件命中 | 独立浏览器访问指定网页；配置并触发 GLM fallback 时向 Z.AI GLM 视觉 API 发 HTTPS 请求 |
| 凭据权限 | ⚠️ 条件命中 | 仅读取用户显式配置的 GLM key 来源；不读取 DSH/Hermes 凭据，不写入或输出 key |
| 生命周期脚本 | ✅ 无 | npm 元数据中无 install/postinstall/prepare |

完整安装/启动/卸载证据见 `docs/store-evidence.md`。

`verify-host.mjs` 是单独运行的验收程序，不会随正常插件加载。它只在显式提供路由、凭据引用名和既有凭据存储路径后，创建独立 DSH_HOME，使用官方凭据 provider 的只读子类供真实模型调用；不复制密钥，禁止所有写入/迁移入口，并校验原存储前后未变。验收 answerer 只批准本次临时网页与指定测试文件，保留真实 ApprovalService 的审计及沙箱限制；不代表已验证真人审批界面。

`verify-web.mjs` 仅测试 UCI 公开阅读和下载；`verify-approval-ui.mjs` 使用真实 web 审批界面，不挂测试 answerer。后者把默认工作区明确设在测试根内；官方浏览器认证只允许既有 signing grant 的严格只读 no-op，其他凭据更新仍拒绝。带认证信息的启动地址仅在0600临时文件中供受控浏览器兑换，随即删除；证据只含纯 origin、测试数据和状态，人工点击必须与本人确认及具体审批 ID 配对。
