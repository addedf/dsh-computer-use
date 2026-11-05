# dsh-computer-use

> **让 DeepSeek Harness 像人一样操作桌面。** 观察屏幕、定位界面元素、移动独立虚拟光标、点击、输入、滚动和拖拽。
>
> **Give DeepSeek Harness a safe, observable Computer Use layer.** Observe desktop applications, locate UI elements, and act through an isolated virtual cursor.

[![CI](https://github.com/988hj7tczd-oss/dsh-computer-use/actions/workflows/ci.yml/badge.svg)](https://github.com/988hj7tczd-oss/dsh-computer-use/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-computer-use)](https://www.npmjs.com/package/dsh-computer-use)
[![npm downloads](https://img.shields.io/npm/dw/dsh-computer-use)](https://www.npmjs.com/package/dsh-computer-use)
[![GitHub stars](https://img.shields.io/github/stars/988hj7tczd-oss/dsh-computer-use)](https://github.com/988hj7tczd-oss/dsh-computer-use)
[![License](https://img.shields.io/github/license/988hj7tczd-oss/dsh-computer-use)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18.0-339933)](https://nodejs.org/)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#platform-support--平台支持)

![dsh-computer-use verified desktop demo](assets/demo-verified.png)

> **真实演示 · Real demo:** a local, non-sensitive page was observed, filled, clicked, and verified through the Computer Use action loop.

**中文文档 · English documentation**

- [中文文档](#中文文档)
- [English Documentation](#english-documentation)

## 生态入口 · Ecosystem

| 入口 | 作用 | Link |
|---|---|---|
| **harness-desktop** | 开箱即用的 DeepSeek Harness 桌面客户端 · Ready-to-use desktop client | [下载 / Download](https://github.com/988hj7tczd-oss/harness-desktop/releases) |
| **AI House** | 发现 AI 工具、模型和 Agent · Discover AI tools and agents | [工具中心 / Tools](https://www.aibunkhouse.com/tools) |
| **npm** | 安装和查看包信息 · Install and inspect the package | [dsh-computer-use](https://www.npmjs.com/package/dsh-computer-use) |
| **awesome-dsh-plugin** | 发现更多 DeepSeek Harness 插件 · Discover more plugins | [Plugin list](https://github.com/988hj7tczd-oss/awesome-dsh-plugin) |
| **Gitee 镜像** | 国内访问入口 · China mirror | [Gitee](https://gitee.com/jerryweizhihao/dsh-computer-use) |

---

# 中文文档

## 这是什么？

`dsh-computer-use` 是 DeepSeek Harness 的跨平台 Computer Use 插件，为 AI Agent 增加一套可观察、可约束、可验证的桌面操作能力。

Agent 必须先观察目标窗口，再基于新鲜快照执行动作。桌面点击使用 cua-driver 的独立虚拟光标，不移动你的真实鼠标；网页优先通过后台 DOM 操作完成，减少对前台工作的打断。

适合用于：

- 让 DeepSeek Harness 操作原生 macOS、Windows 和 Linux 桌面应用；
- 操作 Electron、Canvas 或游戏等 Accessibility/AX 信息不完整的界面；
- 构建“打开应用 → 观察 → 点击 → 输入 → 再观察验证”的 Agent 闭环；
- 为桌面自动化、内部工具和个人工作流增加可审计的 Computer Use 执行层；
- 研究 Computer Use、视觉定位和安全护栏。

> 本项目是开源社区插件，不是 DeepSeek 官方产品，也不代表 DeepSeek 的官方立场。

## 为什么需要它？

普通文本 Agent 可以生成答案，但无法直接完成很多桌面任务。`dsh-computer-use` 把桌面交互拆成三个阶段：

```text
观察 Observation → 决策 Decision → 受约束执行 Guarded Action
```

```mermaid
flowchart LR
    A[DeepSeek Harness Agent] --> B[dsh-computer-use]
    B --> C[安全护栏 Guard]
    C --> D[AX / UIA 界面树]
    C --> E[虚拟光标与键盘]
    D --> F[cua-driver]
    E --> F
    F --> G[桌面应用 Desktop Apps]
```

核心原则：

1. **先观察，再操作**：没有新鲜观察快照时，动作会被拒绝；
2. **模型所见即所点**：元素编号和坐标来自同一窗口截图空间；
3. **语义优先**：优先使用 `element` 编号，坐标模式保留视觉操作自由度；
4. **失败关闭**：目标不明确、快照过期、应用不在白名单时不继续执行。

## 能力一览

| 能力 | 说明 |
|---|---|
| 屏幕观察 | 读取目标窗口元数据、Accessibility/AX/UIA 元素和坐标 |
| 三种观察模式 | `ax` 零视觉 Token、`native` 主模型直读图片、`vision` 视觉观察者 |
| 独立虚拟光标 | 桌面动作使用独立光标，不抢用户真实鼠标；空闲隐藏，任务结束清理 |
| 文本与快捷键 | 输入文本、发送 `return`、`cmd+c`、`ctrl+shift+p` 等按键 |
| 滚动与拖拽 | 支持上下左右滚动和窗口本地截图坐标拖拽 |
| 应用管理 | 列出运行中的应用，后台启动应用，按需前置窗口 |
| 安全护栏 | 快照 TTL、应用白名单、危险操作审批、密码框保护 |
| 跨平台 | macOS 已验证；Windows/Linux 需按真实环境完成平台验收 |

## 36 个模型工具

完整用法见 [技能、条件与浏览器指南](docs/usage.md)。包内两份 skill 会注册到 DSH；默认浏览器使用独立 headless Playwright Chrome，原生桌面仍用 cua-driver。现有 CUA 浏览器模式可显式配置保留。

开源机制的来源、固定版本、许可证和本轮落地范围见 [开源调研与复用记录](docs/open-source-reuse.md)。

需要复用当前 Chrome 登录态并可自行查看操作时，选择 `browserBackend: chrome-extension`，安装配套 **DSH Chrome Control** 扩展。它在当前 Chrome 的紫色专属分组中后台操作，不主动激活标签或前置窗口；工具栏图标提供授权状态入口，只控制本次新建并登记的标签。`browser_close` 或任务结束释放控制、清除活动标记，保留页面并取消本次标签的分组，空分组自动消失。自动上传/下载在此模式暂不支持，详情见[安装和权限说明](docs/usage.md#在当前-chrome-的可见分组中操作)。

新安装在接受 Chrome 扩展权限后自动连接本机 DSH；旧版升级只需在面板启用一次。授权保存在本机，之后 Chrome/DSH 重启或暂时离线会在后台重连，无需重复点击。面板仅显示连接授权状态及授权、重试和撤销入口，任务操作在 DSH 中进行；停止过的任务始终保持终止，重连只为新任务准备连接。DSH 尚未启动时显示等待状态，只有本机握手成功才显示已连接。

`desktopIndicator` 默认关闭，不显示常驻 DSH 浮层。虚拟光标空闲约一秒隐藏，任务完成、取消或异常时清理本会话光标与驱动。macOS 可显式启用带停止按钮的面板，需要本机已有 Swift/SDK；面板不持续录屏或模拟系统共享菜单。

当前 Chrome 的新窗口链接使用 `browser_tabs({action:"open_link",ref})`，按已核验的 HTTP(S) href 建立己方后台页，不执行链接点击脚本；普通同页控件仍使用 `browser_click`。这避免后台 Cmd/Meta 点击的新页被错误关联到用户当前活动标签。

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `screen_observe` | 获取窗口、AX/UIA 元素、坐标或截图 | `window`, `mode`, `query`, `maxElements` |
| `screen_zoom` | 截取并放大窗口局部区域 | `window_id`, `pid`, `x1`, `y1`, `x2`, `y2` |
| `computer_click` | 点击元素或截图坐标 | `element` 或 `x,y`，可选 `count` |
| `computer_double_click` | 双击元素或坐标 | `element` 或 `x,y` |
| `computer_right_click` | 右键点击元素或坐标 | `element` 或 `x,y` |
| `computer_type` | 向焦点或指定元素输入文本 | `text`, 可选 `element` |
| `computer_key` | 发送按键或快捷键 | `key`，例如 `return`、`cmd+c` |
| `computer_scroll` | 在目标窗口滚动 | `direction`, `amount`, 可选 `element` |
| `computer_drag` | 拖拽窗口中的区域 | `from_x`, `from_y`, `to_x`, `to_y` |
| `computer_wait` | 等待界面加载或动画完成 | `ms`，最大 60000 |
| `app_list` | 列出正在运行的应用 | 无 |
| `app_launch` | 启动应用 | `name` 或 `bundle_id`，可选 `bring_to_front` |

## 桌面与浏览器闭环改进

- 驱动每次调用重新发现，支持官方 installer / macOS App 路径，安装后再次调用即可。`computer_status` 或 `npm run doctor` 可只读检查服务与权限。
- AX 强制读取结构化 `elements`，优先使用 `screenshot_frame` 给出正确截图坐标。截图留在本地驱动上下文；正常 AX 不返回图片附件，仍消耗文字 Token。
- 桌面和网页快照按 Agent 会话隔离；同一插件串行执行。不同会话同时观察同一个窗口仍会使驱动旧 token 失效，需要重新观察。
- 新安装统一默认 `ttlMs: 120000`。旧 patch 的显式 15000/30000 不会自动覆盖。编号和坐标都检查 TTL，观察失败清除旧快照。
- `run_steps` 支持保存结果、唯一匹配、条件分支与有界循环；每组 1–20 步，最多 60 次工具调用。每步通过宿主权限流程和插件护栏，失败即停，不重放。
- 点击使用驱动自带虚拟光标动画，省去旧实现多次子进程滑行。已投递后仍需观察界面确认结果。

| 新工具 | 用法 |
|---|---|
| `computer_status` | 只读驱动、服务及权限诊断 |
| `run_steps` | `{steps:[{tool:"screen_observe",args:{window_id:123}},{tool:"computer_click",args:{element:5}},{tool:"screen_observe",args:{window_id:123}}]}` |
| `browser_open` | `{url:"https://example.com"}`，本会话独立临时 Chromium |
| `browser_observe` | 网页文字、语义 outline、当前 refs |
| `browser_navigate` | `{url:"https://example.com"}`，导航后自动观察 |
| `browser_click` | `{ref:"p2:1"}`，使用最新观察中的真实 ref |
| `browser_type` | `{ref:"p2:0",text:"示例",replace:true}`；空串可清空 |
| `browser_scroll` | `{ref:"p2:1",direction:"down",amount:500}`，CSS 像素 |

默认浏览器通过 playwright-core 启动本机 Chrome 的独立临时 profile，不依赖 cua-driver 的网页接口，不下载浏览器、不继承用户 Chrome 登录态。`browserBackend: cua` 保留驱动模式；先用 `browser_capabilities` 识别实际支持的功能。每次网页动作后 refs 失效，重新观察或使用条件工具返回的新 observation。敏感/不完整页面暂停自动输入，危险目标按本次审批处理。上传、下载需要宿主文件服务和策略，详见使用指南。

根据 `screen_zoom` 或 compact 图片内坐标点击时，使用 `computer_click(x=...,y=...,from_zoom=true)`，由驱动处理留白与缩放；整窗截图坐标不传此参数。元素编号始终直接用于 `element`。

源码更新需要宿主重新加载插件。是否已加载，以实际工具列表为准；验证源码通过不代表正在运行的 DSH 已更新。

`npm run verify:host` 可在独立 DSH_HOME 中通过常规插件入口进行真实模型、标准 skill、文件审批与上传下载的端到端验收，不影响既有会话。路由和只读凭据引用配置见 [使用指南](docs/usage.md)，本机实测及清理证据见 [验证报告](VERIFICATION.md)。

`npm run verify:web` 验收 UCI 公开真实网站的查找、跨页取数和下载；`npm run verify:approval-ui` 使用正式 DSH 审批页面，分别记录自动点击与真人确认。上传等待批准超过 TTL 时会只读复核原目标后继续，其他旧 ref 的过期规则保持不变。

## 快速开始

### 方式一：使用 harness-desktop

普通桌面用户建议先下载 [harness-desktop](https://github.com/988hj7tczd-oss/harness-desktop/releases)。它是一个开箱即用的 DeepSeek Harness 桌面客户端，支持 macOS、Windows 和 Linux。

```text
1. 下载并启动 harness-desktop
2. 完成首启配置
3. 安装本插件
4. 重启 harness-desktop
5. 在对话中让 Agent 操作桌面
```

### 方式二：从 GitHub 源码安装

```bash
git clone https://github.com/988hj7tczd-oss/dsh-computer-use.git
cd dsh-computer-use

# 先预演，不写入配置
./install.sh --dry-run

# 安装到用户级 patch 层
./install.sh

# 安装后重启 harness-desktop
```

安装脚本只做两件事：

1. 将插件链接到 `$DSH_HOME/profiles/web/node_modules/dsh-computer-use`；
2. 在 `$DSH_HOME/cordis.patch.yml` 注册插件。

脚本使用用户级 patch 层，不修改项目代码，也不修改其他 profile 的配置。

### Windows / Linux

`install.sh` 默认使用 macOS 的 `DSH_HOME` 路径。Windows 或 Linux 用户请先指定自己的 DSH home：

```bash
export DSH_HOME="/path/to/your/dsh-home"
./install.sh --dry-run
./install.sh
```

如果系统不支持符号链接，请使用宿主 DSH 的插件管理方式，或按照 `docs/store-evidence.md` 中的手动安装说明操作。

### 方式三：npm 包

```bash
npm install -g dsh-computer-use
```

安装后仍需要让 DSH profile 加载该 bundle，并确认 `cua-driver` 已经安装且在 `PATH` 中，或设置：

```bash
export CUA_DRIVER_BIN=/path/to/cua-driver
```

在 Windows 官方安装器布局中，插件还会自动探测
`%USERPROFILE%\\.cua-driver\\packages\\current\\cua-driver.exe`；GUI 宿主的 PATH 不完整时无需手工把目录加入 PATH。

驱动安装请按 [cua-driver 官方说明](https://cua.ai/docs/cua-driver/quickstart) 操作，macOS 运行 `cua-driver permissions grant` 后本人完成系统授权。插件不静默下载安装驱动，也不更改驱动遥测配置。

安装完成后重载宿主，再通过 `computer_status`、`app_list` 或 `screen_observe` 验证工具是否出现。

## 第一个完整任务

安装并授权后，可以让 Agent 执行下面的任务：

```text
请完成以下桌面任务：

1. 使用 app_list 列出正在运行的应用；
2. 使用 app_launch 打开一个普通桌面应用；
3. 使用 screen_observe 观察目标窗口；
4. 找到目标按钮，优先使用 element 编号点击；
5. 使用 computer_type 输入一段非敏感测试文本；
6. 再次使用 screen_observe 验证文本已经出现；
7. 如果界面发生变化，请重新观察，不要使用旧元素编号继续操作；
8. 如果动作被安全护栏拒绝，请报告拒绝原因，不要绕过护栏。
```

### 推荐的操作循环

```text
app_list / app_launch
        ↓
screen_observe
        ↓
computer_click / computer_type / computer_key
        ↓
computer_wait（如需等待）
        ↓
screen_observe 验证结果
```

每一次界面明显变化后，都应重新调用 `screen_observe`。元素编号属于某一次观察快照，不应跨页面、弹窗或长时间等待复用。

## 观察模式

`screen_observe` 的 `mode` 有三种选择：

| 模式 | 原理 | 成本 | 适用场景 |
|---|---|---|---|
| `ax`（默认） | 读取 AX/UIA 界面树并返回编号和坐标 | 不消耗视觉 Token | 原生应用、元素树完整的界面 |
| `native` | 将截图作为图片块交给当前对话模型 | 图片 Token；不额外调用视觉观察者 | Canvas、游戏、Electron 或 AX 树为空的界面 |
| `vision` | 通过 Harness 的 `ctx.llm` 调用视觉模型，返回结构化元素列表 | 额外一次视觉模型调用 | 当前主模型不支持图片输入时 |

### `native` 模式

当前对话模型必须声明支持 `image` 输入，例如视觉模型。插件通过 Harness attachments 传递图片，不额外发起独立视觉 API 请求。

```text
screen_observe(mode="native")
```

### `vision` 模式

默认观察模型为：

```text
provider: deepseek-official
model: deepseek-v4-flash-vision-exp
```

老版本 Harness 需要在模型配置中声明：

```yaml
models:
  - id: deepseek-v4-flash-vision-exp
    input: [text, image]
```

当 DeepSeek 视觉观察者不可用时，插件可以尝试 GLM 视觉兜底。GLM 兜底需要 `ZHIPU_API_KEY`，并可能受到免费模型访问量限制。

### 自动降级

当 AX/UIA 树为空时，插件会尝试：

```text
native（当前路由支持图片时）
  → vision（宿主存在可用视觉模型时）
  → ax（返回可用的界面树信息或明确错误）
```

## 坐标语义

从 v0.2.0 起，所有坐标均为：

> **窗口本地截图像素（window-local screenshot pixels）**

这意味着：

- 坐标原点在目标窗口左上角；
- `screen_observe` 输出的 `@(x,y)` 与 `computer_click(x=,y=)` 使用同一坐标系；
- 不需要乘以 2；
- 不需要加屏幕坐标或窗口偏移；
- 使用 zoom / compact 图片内坐标时传 `from_zoom=true`，由驱动换算为整窗坐标。

优先使用：

```text
computer_click(element=5)
```

只有在元素无法通过 AX/UIA 识别，或视觉模式给出坐标时，才使用：

```text
computer_click(x=640, y=420)
```

## 安全模型

### 已内置的安全机制

1. **无快照拒绝**：没有先调用 `screen_observe`，动作不会执行；
2. **观察快照 TTL**：快照过期后动作被拒绝，必须重新观察；
3. **应用白名单**：配置 `allowedApps` 后，只允许指定应用接受操作；
4. **危险操作审批**：元素标签命中删除、支付、购买、转账、退出登录等词时请求用户确认；
5. **密码框保护**：检测到 `AXSecureTextField` / `AXPasswordField` 时拒绝自动输入；
6. **键盘前台重试审批**：键盘/文本优先后台投递；只有驱动明确拒绝后台投递并建议前台模式、且当前工具/平台支持时，才请求用户对本次前台重试授权；未获 `allowed-once` 不切换焦点、不重试；
7. **固定 argv 调用**：通过宿主以非 shell 方式启动 `cua-driver`；
8. **权限边界声明**：核心桌面路径不读取业务文件或额外凭据；仅当用户配置视觉 GLM fallback 时，才读取指定 key 来源并向 GLM API 发起请求；没有 npm lifecycle 安装脚本。

### 重要限制

语义安全检测依赖观察到的元素标签，主要对 `element` 编号模式有效：

- `x/y` 坐标模式无法提前知道目标语义，主要依赖快照 TTL 和可见操作；
- `computer_type` 和 `computer_key` 作用于当前焦点时，无法预判最终目标内容；
- 驱动拒绝后台键盘/文本投递时，前台重试会先请求本次用户批准；授权后可能切换目标窗口焦点；
- `computer_key` 不会阻止 `cmd+q`、`ctrl+alt+delete` 等系统快捷键；
- 不要把本插件的操作权限授予不可信 Agent；
- 密码、API Key 和其他敏感信息必须由用户本人输入。

## 配置

插件配置位于 DSH 的用户级 patch 层：

```yaml
- id: dsh-computer-use
  config:
    ttlMs: 120000
    maxElements: 500
    allowedApps: []
    cursorTheme: com.dsh.computeruse.rainbow
    nativeImage: auto
    browserBackend: playwright
    browserHeadless: true
    visionProvider: deepseek-official
    visionModel: deepseek-v4-flash-vision-exp
```

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `ttlMs` | `120000` | 快照有效期，单位毫秒；允许 1000–600000，旧配置保留原值 |
| `maxElements` | `500` | 单次观察最多返回的编号元素数量 |
| `allowedApps` | `[]` | 空数组表示不限制；非空时只允许列表中的应用 |
| `cursorTheme` | `com.dsh.computeruse.rainbow` | 虚拟光标主题；空字符串使用引擎默认主题 |
| `nativeImage` | `auto` | `auto` 自动降级；`full` 原图；`compact` 始终使用小图 |
| `browserBackend` | `playwright` | `chrome-extension` 控制当前 Chrome 专属分组；`playwright` 独立浏览器；`cua` 兼容驱动 |
| `browserHeadless` | `true` | 只影响独立 Playwright；false 显示独立窗口 |
| `browserObservationMaxNodes` | `10000` | 浏览器输出遍历节点预算，100–100000；与 maxElements 分开 |
| `browserObservationSafetyMaxNodes` | `10000` | 全页安全扫描节点预算，100–100000；query/scope/续页不绕过 |
| `browserObservationTimeoutMs` | `5000` | 跨 frame 观察总时限，100–30000ms；超限返回不完整状态 |
| `desktopIndicator` | `false` | 可显式启用 macOS DSH 状态面板与停止按钮，需要本机 Swift/SDK |
| `chromeBridgeSocketPath` | 自动 | Chrome 配套桥接私有 socket；默认位于 DSH_HOME/computer-use |
| `visionProvider` | `deepseek-official` | `vision` 模式使用的 provider |
| `visionModel` | `deepseek-v4-flash-vision-exp` | `vision` 模式使用的视觉模型 |

> 安装脚本或 bundle patch 可能覆盖代码层默认值。请以实际生成的 `$DSH_HOME/cordis.patch.yml` 为准；多步任务建议显式写入 `ttlMs`，不要依赖隐式默认值。

## 平台支持 · Platform Support

| 平台 | 状态 | 说明 |
|---|---|---|
| macOS | ✅ 已验证 | 可能需要 Accessibility 和 Screen Recording 权限 |
| Windows | ⛔ BLOCKED | 当前无 Windows 10/11 真机；路径和按键逻辑已测试，真实 GUI 未验收 |
| Linux | ⛔ 未验证 | 桌面环境、Accessibility 栈和窗口管理器可能影响元素识别 |

测试通过不代表所有应用的界面树都完全一致。AX/UIA 不完整时，请使用 `native` 或 `vision` 模式，并在提交问题时附上操作系统、目标应用和 `screen_observe` 输出。

## 故障排查

| 现象 | 常见原因 | 处理方式 |
|---|---|---|
| `cua-driver not found` | 引擎不在 PATH 或官方安装器路径不可用 | 安装 cua-driver，确认 `~/.cua-driver/packages/current/cua-driver.exe` 存在，或设置 `CUA_DRIVER_BIN` |
| 没有可见窗口 | 图形会话或窗口权限不可用 | 确认目标应用正在运行并重新观察 |
| 快照已过期 | 超过 `ttlMs` | 重新调用 `screen_observe` |
| 元素编号点击失败 | 界面已经变化 | 重新观察后再使用新编号 |
| AX/UIA 树为空 | Canvas、游戏、Electron 或特殊窗口 | 使用 `native` 或 `vision` |
| native 被拒绝 | 当前主模型没有 image 输入能力 | 切换视觉模型或使用 `vision` |
| vision 模型不可用 | provider/model 未注册 image 输入 | 配置 `visionProvider` / `visionModel` |
| GLM fallback 不可用 | 没有 `ZHIPU_API_KEY` 或遇到限流 | 配置 Key，或使用 Harness 视觉模型 |
| 危险操作被拒绝 | 需要用户审批 | 检查审批提示，不要绕过安全护栏 |
| Windows 管理员窗口无法操作 | 目标窗口权限级别更高 | 使用普通用户窗口 |

## 开发与验证

项目使用隔离 profile 开发，避免污染真实 GUI 配置：

```bash
npm install
npm run check

# 运行时验证需要已安装 harness-desktop 和 cua-driver
node verify-runtime.mjs
```

`npm run check` 包含语法、全库 ESLint 和范围内的 Prettier 检查。`npm run format` 只整理 `tools/style-check.mjs` 指定的核心模块和测试；规范和上游取舍见 [开源复用记录](docs/open-source-reuse.md#代码风格与检查)。

macOS headless 验证示例：

```bash
DSH_HOME=$PWD/.dsh-p0 ELECTRON_RUN_AS_NODE=1 \
  /Applications/harness-desktop.app/Contents/MacOS/harness-desktop --expose-internals \
  /Applications/harness-desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile test "请调用 screen_observe 观察当前窗口并报告"
```

更多证据：

- [权限声明](PERMISSIONS.md)
- [验证报告](VERIFICATION.md)
- [Windows 测试指南](WINDOWS_TEST.md)
- [Store 安装证据](docs/store-evidence.md)
- [运行时验证脚本](verify-runtime.mjs)

## 相关项目

- [harness-desktop](https://github.com/988hj7tczd-oss/harness-desktop)：开箱即用的 DeepSeek Harness 桌面客户端；
- [awesome-dsh-plugin](https://github.com/988hj7tczd-oss/awesome-dsh-plugin)：DeepSeek Harness 插件精选列表；
- [AI House 工具中心](https://www.aibunkhouse.com/tools)：发现更多 AI 工具、模型和 Agent；
- [cua-driver](https://github.com/trycua/cua)：底层跨平台桌面驱动；
- [npm package](https://www.npmjs.com/package/dsh-computer-use)：安装包和版本信息；
- [Gitee mirror](https://gitee.com/jerryweizhihao/dsh-computer-use)：国内镜像。

## License

[MIT License](LICENSE)

---

# English Documentation

## What is dsh-computer-use?

`dsh-computer-use` is a cross-platform Computer Use plugin for DeepSeek Harness. It gives an AI agent an observable, guarded, and verifiable desktop action layer.

The plugin is designed around an explicit loop:

```text
Observe → Decide → Execute with Guardrails → Observe and Verify
```

It can inspect desktop windows, expose actionable AX/UIA elements, use a screenshot-based visual fallback, and operate through an isolated virtual cursor. It is useful for desktop automation, Computer Use research, internal workflows, and agentic applications that need bounded desktop actions.

> This is a community plugin, not an official DeepSeek product and not affiliated with DeepSeek.

## Current improvements

Thirty-six tools include bundled desktop/browser skills, declarative waits and assertions, and dynamic batches with references, branches and bounded loops. The default browser backend launches an isolated headless Chrome through playwright-core; CUA remains an explicit compatibility backend. Tabs, history, forms, dialogs, screenshots and host-authorized file transfers are available according to browser_capabilities. See the [usage guide](docs/usage.md) for contracts and boundaries. New installs default to a 120-second snapshot TTL; existing explicit settings remain. Reload the host to load updated source.

The opt-in `chrome-extension` backend uses DSH Chrome Control to work in an owned purple tab group in the user's logged-in Chrome. It creates background tabs without activating the tab or focusing Chrome. Task completion releases control, clears the activity badge, and ungroups its own tabs while preserving their pages. Empty groups disappear automatically; tabs the user added or moved elsewhere are left alone. Automatic file transfers are currently unsupported. The desktop status panel is off by default. Desktop cursors hide after a short idle and are cleared when the task finishes or is cancelled. macOS users may explicitly enable the optional panel and Stop button; it does not imitate the system's sharing indicator or start continuous recording.

## Highlights

- Observe native desktop windows and accessibility trees;
- Use `ax`, `native`, or `vision` observation modes;
- Click, double-click, right-click, type, press keys, scroll, and drag;
- Launch applications and list running applications;
- Bind actions to fresh observation snapshots;
- Restrict actions to an application allowlist;
- Request approval for risky semantic targets;
- Refuse automated typing into password fields;
- Fall back to screenshots when AX/UIA data is incomplete;
- macOS has been verified; Windows has logic/path coverage but real GUI validation is blocked; Linux has not been verified.

## Quick Start

### Recommended desktop experience

Download [harness-desktop](https://github.com/988hj7tczd-oss/harness-desktop/releases), the ready-to-use DeepSeek Harness desktop client. After the host is installed, install this plugin and restart the host.

### Install from source

```bash
git clone https://github.com/988hj7tczd-oss/dsh-computer-use.git
cd dsh-computer-use

./install.sh --dry-run
./install.sh
```

The installer creates a user-level plugin link and registers the bundle in the DSH home patch layer. It does not modify project source files or other profiles.

On Windows or Linux, set `DSH_HOME` to the actual DSH home directory before running the script:

```bash
export DSH_HOME="/path/to/your/dsh-home"
./install.sh
```

### Install the npm package

```bash
npm install -g dsh-computer-use
```

Make sure the host loads the bundle and that `cua-driver` is available in `PATH`, or set `CUA_DRIVER_BIN` to its absolute path.

On Windows, the official installer layout is also detected automatically at
`%USERPROFILE%\\.cua-driver\\packages\\current\\cua-driver.exe`, which covers GUI hosts whose PATH does not include the driver.

## Tools

| Tool | Purpose | Main parameters |
|---|---|---|
| `screen_observe` | Observe a window, AX/UIA elements, coordinates, or a screenshot | `window`, `mode`, `query`, `maxElements` |
| `screen_zoom` | Capture a smaller region for visual inspection | `window_id`, `pid`, `x1`, `y1`, `x2`, `y2` |
| `computer_click` | Click an element or screenshot coordinate | `element` or `x,y`; optional `count` |
| `computer_double_click` | Double-click an element or coordinate | `element` or `x,y` |
| `computer_right_click` | Right-click an element or coordinate | `element` or `x,y` |
| `computer_type` | Type into the focused or selected field | `text`, optional `element` |
| `computer_key` | Send a key or shortcut | `key`, e.g. `return`, `cmd+c` |
| `computer_scroll` | Scroll a target window | `direction`, `amount`, optional `element` |
| `computer_drag` | Drag between screenshot coordinates | `from_x`, `from_y`, `to_x`, `to_y` |
| `computer_wait` | Wait for a page load or animation | `ms`, max 60000 |
| `app_list` | List running applications | none |
| `app_launch` | Launch an application | `name` or `bundle_id`; optional `bring_to_front` |

## The standard action loop

```text
app_list / app_launch
        ↓
screen_observe
        ↓
computer_click / computer_type / computer_key
        ↓
computer_wait
        ↓
screen_observe to verify the result
```

A snapshot is observation-local. If the UI changes, observe again before using an element index or coordinate from the previous state.

## Observation modes

| Mode | How it works | Best for |
|---|---|---|
| `ax` | Returns a compact AX/UIA tree with indexed elements and coordinates | Native applications with usable accessibility data |
| `native` | Returns the screenshot as an image block for the current multimodal model | Canvas, games, Electron, or windows with incomplete AX/UIA data |
| `vision` | Uses a Harness `ctx.llm` vision model to describe the screenshot | Text-only main models that need a separate observer |

`native` requires the current route to declare image input support. `vision` uses the configured `visionProvider` and `visionModel`; the default model is `deepseek-v4-flash-vision-exp`. The optional GLM fallback requires `ZHIPU_API_KEY` and may be rate-limited.

When the accessibility tree is empty, the fallback order is:

```text
native → vision → ax
```

The plugin chooses a path that is available and returns an explicit error when no visual route can be used.

## Coordinate semantics

Since v0.2.0, all coordinates are **window-local screenshot pixels**:

- the origin is the top-left corner of the target window;
- coordinates returned by `screen_observe` and coordinates accepted by `computer_click` share the same space;
- do not multiply by two;
- do not add a screen or window offset;
- use `from_zoom=true` for coordinates read from a zoom or compact image; the driver maps them back to the full window.

Prefer semantic element actions:

```text
computer_click(element=5)
```

Use `x,y` when the target is not exposed through AX/UIA or when a visual observer provides coordinates.

## Security model

The plugin includes:

1. **Observe-before-act**: actions without a fresh observation are rejected;
2. **Snapshot TTL**: expired snapshots require a new observation;
3. **Application allowlists**: `allowedApps` can restrict the operation scope;
4. **Risky-action approval**: labels such as delete, pay, purchase, transfer, or sign out can require user approval;
5. **Password-field protection**: automated typing into password fields is refused;
6. **Keyboard foreground retry approval**: keyboard/text actions use background delivery first; after an explicit driver refusal and only where the driver supports the mode, foreground retry requires one-time user approval. Without approval, focus is not changed and no retry occurs;
7. **Fixed non-shell driver invocation**: the host starts `cua-driver` with fixed argv;
8. **Explicit permission boundaries**: the core desktop path does not read business files or extra credentials. The optional GLM fallback reads only its configured key source and sends an HTTPS request to the GLM vision API; there are no npm lifecycle scripts.

Semantic checks are strongest for `element`-based actions. Coordinate actions and unfocused `computer_type`/`computer_key` calls cannot predict the final semantic target. `computer_key` does not validate system shortcuts. Do not give this capability to an untrusted agent, and always type passwords and secrets yourself.

If the driver reports `background_unavailable`, the plugin asks for one-time approval before retrying in foreground mode where the current tool/platform supports it; that retry may bring the target window forward. Rejecting or lacking approval leaves the action refused.

## Configuration

```yaml
- id: dsh-computer-use
  config:
    ttlMs: 120000
    maxElements: 500
    allowedApps: []
    cursorTheme: com.dsh.computeruse.rainbow
    nativeImage: auto
    browserBackend: playwright
    browserHeadless: true
    visionProvider: deepseek-official
    visionModel: deepseek-v4-flash-vision-exp
```

| Option | Default | Description |
|---|---:|---|
| `ttlMs` | `120000` | Observation lifetime in milliseconds |
| `maxElements` | `500` | Maximum indexed elements returned by observation |
| `allowedApps` | `[]` | Empty means unrestricted; otherwise only listed apps are allowed |
| `cursorTheme` | `com.dsh.computeruse.rainbow` | Virtual cursor theme; empty uses the engine default |
| `nativeImage` | `auto` | `auto`, `full`, or `compact` screenshot strategy |
| `browserBackend` | `playwright` | `chrome-extension` for an owned group in existing Chrome; `playwright` for an isolated browser; `cua` for compatibility |
| `browserHeadless` | `true` | Standalone Playwright only; false makes the target tab visible |
| `browserObservationMaxNodes` | `10000` | Output traversal budget, 100–100000 nodes across frames |
| `browserObservationSafetyMaxNodes` | `10000` | Independent whole-page safety budget, including queries/scoped reads |
| `browserObservationTimeoutMs` | `5000` | Shared observation deadline, 100–30000ms; exhaustion remains incomplete |
| `desktopIndicator` | `false` | Optional macOS DSH status and Stop panel; requires installed Swift/SDK |
| `chromeBridgeSocketPath` | automatic | Private companion socket under DSH_HOME/computer-use |
| `visionProvider` | `deepseek-official` | Provider used by `vision` mode |
| `visionModel` | `deepseek-v4-flash-vision-exp` | Image-capable observer model |

If an installer or bundle patch overrides the code-level default, the generated `$DSH_HOME/cordis.patch.yml` is authoritative. For multi-step tasks, set `ttlMs` explicitly instead of relying on an implicit default.

## Platform support

| Platform | Status | Notes |
|---|---|---|
| macOS | ✅ Verified | Accessibility and Screen Recording permissions may be required |
| Windows | ⛔ Blocked | Logic/path coverage exists; real GUI validation requires a Windows 10/11 regular-user desktop session |
| Linux | ⛔ Not verified | Desktop environment, accessibility stack, and window manager can affect element discovery |

The macOS path has been verified in the project evidence. Windows and Linux still require a real platform run before they can be advertised as fully tested. This does not mean every application exposes an identical accessibility tree. For incomplete AX/UIA data, use `native` or `vision` and include the OS, target application, and observation output in bug reports.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `cua-driver not found` | Driver is not in `PATH` or the official installer path is unavailable | Install it, confirm `~/.cua-driver/packages/current/cua-driver.exe` exists, or set `CUA_DRIVER_BIN` |
| No visible windows | Missing graphical session or permission | Confirm the target app is visible and observe again |
| Snapshot expired | `ttlMs` elapsed | Call `screen_observe` again |
| Element click failed | The UI changed | Observe again and use the new index |
| Empty AX/UIA tree | Canvas, game, Electron, or special window | Use `native` or `vision` |
| `native` rejected | Main route is not image-capable | Switch to an image-capable model or use `vision` |
| Vision model unavailable | Provider/model lacks image input declaration | Configure `visionProvider` / `visionModel` |
| GLM fallback unavailable | Missing `ZHIPU_API_KEY` or rate limit | Configure the key or use a Harness vision model |
| `background_unavailable` | Driver cannot deliver keyboard/text in the background | Approve the one-time foreground retry if changing window focus is acceptable |
| Risky action rejected | User approval was not granted | Follow the approval result; do not bypass the guard |
| Windows elevated window rejected | Target has a higher privilege level | Use a regular-user window |

## Development and verification

```bash
npm install
npm run check
npm test
node verify-runtime.mjs
```

`npm run check` runs syntax validation, repository-wide ESLint, and scoped Prettier checks. `npm run format` formats only the core modules and tests listed in `tools/style-check.mjs`.

The runtime verification requires a working `harness-desktop` installation and `cua-driver`. Additional evidence is available in:

- [PERMISSIONS.md](PERMISSIONS.md)
- [VERIFICATION.md](VERIFICATION.md)
- [WINDOWS_TEST.md](WINDOWS_TEST.md)
- [docs/store-evidence.md](docs/store-evidence.md)
- [verify-runtime.mjs](verify-runtime.mjs)

## Ecosystem

- [harness-desktop](https://github.com/988hj7tczd-oss/harness-desktop) — a ready-to-use DeepSeek Harness desktop client;
- [awesome-dsh-plugin](https://github.com/988hj7tczd-oss/awesome-dsh-plugin) — a curated list of DeepSeek Harness plugins;
- [AI House Tools](https://www.aibunkhouse.com/tools) — discover AI tools, models, and agents;
- [cua-driver](https://github.com/trycua/cua) — the underlying cross-platform desktop driver;
- [npm package](https://www.npmjs.com/package/dsh-computer-use) — package versions and downloads;
- [Gitee mirror](https://gitee.com/jerryweizhihao/dsh-computer-use) — China mirror.

## License

[MIT License](LICENSE)

---

Not affiliated with DeepSeek. DeepSeek Harness is an open-source project by [DeepSeek AI](https://deepseek.com).
