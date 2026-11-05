# 技能、条件等待与浏览器操作

## 加载技能

插件包含原创 `dsh-desktop` 和 `dsh-browser` 技能。加载时通过宿主 `ctx.skills.register` 注册，标准 `skill({name:"dsh-browser"})` 可按需读取正文。系统提示提供精简路由；没有标准消费者时可用 `computer_skill`，相关工具调用后也会为该会话加载对应指导。仅放 README 不等于技能加载。

缺少宿主 systemPrompt 服务时会记录自动入口不可用；显式 computer_skill 仍可读取。技能指导不会替代运行时权限、快照和取消检查。

## 条件等待与断言

`computer_verify` / `computer_wait_for` 检查已观察的精确窗口；`browser_verify` / `browser_wait_for` 刷新本会话网页后检查条件。仅 `status:satisfied`、`matched:true` 才通过；unknown、截断、隐藏值和歧义不当作成功。

等待参数为 `timeout_ms`（0–10000，默认5000）、`interval_ms`（50–1000，默认200）、`stable_samples`（1–5，默认2）。桌面 CUA 调用接收当前步骤的取消信号，取消会终止正在执行的 CLI；其它适配器仍可能等待其有界读取结束。已投递的动作不会因取消而自动撤销。

```json
{"expect":[{"kind":"value","role":"textbox","name":"姓名","value":"示例用户"}],"timeout_ms":5000}
```

浏览器支持 exists/text/value/url/title/checked/enabled。条件使用精确 role/name；URL 只比较 origin+pathname，不含 query/hash。等待会生成新 ref，后续操作使用返回的 `data.observation.refs`。

```json
{"expect":[{"window":{"exists":true}},{"element":{"selector":{"role":"AXButton","label_contains":"7"},"exists":true}}]}
```

桌面验证可能替换驱动快照，执行后清除旧元素编号；继续操作前重新 screen_observe。AX 不完整时不能证明元素不存在。

## 动态编排

```json
{
  "steps": [
    {"tool":"browser_observe","args":{},"save_as":"page"},
    {"tool":"browser_type","args":{
      "ref":{"$ref":"page.data.refs","where":{"name":"姓名","role":"textbox"},"pick":"ref"},
      "text":"示例用户","replace":true
    }},
    {"tool":"browser_wait_for","args":{
      "expect":[{"kind":"value","role":"textbox","name":"姓名","value":"示例用户"}]
    },"save_as":"verified"}
  ],
  "return_vars":["verified"]
}
```

引用必须唯一匹配，零个或多个目标都停止。`when:{ref:"verified.data.matched",equals:true}` 控制执行。控制组可使用：

- `{repeat:3,steps:[...],until:{ref:"check.data.matched",equals:true}}`：有上限的重复，until 未满足则失败。
- `{for_each:[...],as:"item",steps:[...]}`：最多20项，当前项可用 `{$ref:"item"}`。
- `{when:{ref:"flag",equals:true},steps:[...],otherwise:[...]}`：条件分支。

每组1–20步，嵌套最多3层，整个流程最多60次工具调用、120秒预算。取消信号传给子工具和 CUA 执行进程，再完成所属资源清理。任一步失败立即停止，不重放已有动作。不执行任意 JavaScript。宿主启用 PTC 时，也可使用其工具 SDK 处理结构化 `data`。

## 浏览器后端

```yaml
config:
  browserBackend: playwright
  browserHeadless: true
  ttlMs: 120000
```

默认 Playwright 后端通过 playwright-core 和本机 Chrome 创建独立临时浏览器，不下载浏览器、不接管用户已有 Chrome。默认 headless，不操作真实鼠标或前台窗口。截图用 browser_screenshot。配置 browserHeadless:false 后会显示独立窗口；这不继承用户登录态。

### 大页面采集预算

Playwright 与 Chrome 扩展后端按节点遍历页面，只为当前返回的目标创建元素句柄。输出遍历与全页安全检查分别限额，所有 frame 共用总时限：

| 配置 | 默认值 | 范围与含义 |
| --- | --- | --- |
| `browserObservationMaxNodes` | `10000` | 输出遍历节点数，100–100000；独立于返回条数 `maxElements` |
| `browserObservationSafetyMaxNodes` | `10000` | 全页安全扫描节点数，100–100000；query、scope 和续页仍须执行 |
| `browserObservationTimeoutMs` | `5000` | 整次观察时限，100–30000ms；包含跨 frame 采集、标题和句柄处理 |

返回的 `data.observationBudget` 给出两类 `visitedNodes`、配置限额及 `stopReason/stopReasons`。预算用尽时 `complete:false`、`truncated:true`；全页安全检查未完成时还会设置 `safetyComplete:false`、`inputBlocked:true`，隐藏字段值与可能含输入值的摘要，不将局部查询当作整页已安全。

有 `continuation` 时原样传回下一次观察，保留 query/scope；续页从原页面绑定的遍历位置继续，每次重新进行安全扫描，不能把前后多次扫描拼成输入授权。页面导航、frame 变化、超时或取消会使旧遍历位置失效。总时限能停止宿主等待，已经发出的只读浏览器 RPC 可能稍后结束；晚到结果仅释放句柄，不替换当前观察或启动后续采集。

Playwright 与 Chrome 扩展后端的普通 `browser_type({replace:true})`、`browser_select` 在一次写入后有界读回验证，不自动补写。检查 `data.effect` 和 `data.verification.status`：`verified/matched` 表示当前控件值匹配；`unverifiable/mismatch` 返回失败，表示已投递但值未匹配；读回不可用或目标变化也保持 `unverifiable`，不能当作业务完成。追加输入只返回 `delivered`。回验不返回字段实际值；服务端保存等结果仍需 `browser_verify` 或独立页面证据。输入触发 `dialogPending:true` 时先用 `browser_dialog` 处理，不重放输入。

截图附件必须保留驱动图片或浏览器 viewport 的原始宽高；尺寸不一致时明确拒绝坐标授权。浏览器截图采集、保存或审批期间页面变化也会拒绝，原文档重载后须重新截图。原生紧凑图仍通过驱动 `from_zoom:true` 转换，不能自行按比例猜测。开源机制来源与未接入的后续方向见 [调研记录](open-source-reuse.md)。

### 在当前 Chrome 的可见分组中操作

`browserBackend: chrome-extension` 使用配套的 **DSH Chrome Control** 扩展，复用当前 Chrome 登录状态。每个 DSH 会话只拥有自己新建的紫色标签分组及登记的标签；用户已有页面不自动加入，不导出 Cookie 或读取 profile 数据库。新标签在后台建立，选择操作目标只改变 DSH 内部目标，不激活标签或把 Chrome 窗口切到前台。你可以自行展开分组查看。

安装与启用：

1. 审阅 `chrome-extension/manifest.json` 和本项目 `PERMISSIONS.md`。扩展申请 debugger、tabs、tabGroups、nativeMessaging、storage、alarms；alarms 只负责重连唤醒，Chrome 会显示调试控制提示。
2. `npm run browser:setup -- --dry-run` 查看本机 Native Messaging 安装计划；确认后执行 `npm run browser:setup -- --install`。它只写本用户的 DSH 桥接启动器和 Chrome NativeMessagingHosts 清单，清单只允许这一扩展 ID。
3. 在 Chrome 扩展管理器中加载本仓库的 `chrome-extension` 目录。此步骤需要用户明确批准扩展权限，不自动安装扩展或重启 Chrome；新安装随后自动启用本机连接，不打开额外页面或弹窗。
4. 把宿主中本插件的 `browserBackend` 设为 `chrome-extension` 并正式重载。插件准备私有本机桥接后，扩展在后台完成握手。旧版升级且尚未保存连接偏好时，只需在面板点一次“授权并连接”。面板显示已连接后即可发起浏览器任务。

连接偏好保存在当前 Chrome profile 的扩展本机存储中。之后启动 Chrome、扩展后台重新加载或 DSH 重启，均自动建立连接；DSH 尚未启动时面板显示等待，启动后自行接通。连接异常会退避重试，只有本机桥接确认握手后才显示已连接。面板“撤销授权”先保存关闭偏好，再停止任务并断开；重新打开 Chrome 或更新扩展不会自动重新授权。

扩展工具栏图标显示活动会话数量；弹窗只保留页头、连接授权状态和授权／重试／撤销入口。任务操作在 DSH 中进行，弹窗不显示当前任务、已停止记录或权限详情。停止会撤销该会话的控制并取消当前 DSH Agent，旧 ref 和已结束的驱动会话不能恢复它。用户把标签移出专属分组、关闭标签或调试连接中断，也会停止控制。停止为终止本次控制；请在 DSH 新建会话开始下一任务。停止任务不撤销本机连接授权，自动重连也不恢复旧任务。

升级后若提示 `CHROME_EXTENSION_UPDATE_REQUIRED`，先核对加载的扩展目录，再在 `chrome://extensions` 中重新加载 **DSH Chrome Control**，并重载 DSH 插件；已有授权会自动连接，旧版首次迁移需点一次“授权并连接”。宿主仍在建立控制端点或新建标签前校验后台操作、取消分组和并行传输能力，弹窗不显示这些技术详情。

此次自动连接升级增加了本机握手确认，需同时重新加载扩展与 DSH 插件。只更新扩展而宿主仍运行旧桥接时会保持等待状态；无需反复授权，应先完成宿主重载。

本轮参考 [OpenAI 官方浏览器扩展说明](https://learn.chatgpt.com/docs/chrome-extension) 中的后台标签操作、Native Messaging 和可管理授权体验。DSH 当前只控制新建登记页；现有页面引用、侧边聊天、网站允许/阻止列表及自动文件传输尚未接入，不因记住本机连接而宣称支持这些能力。Chrome 自身显示的调试控制提示仍然保留。

`browser_close`、任务完成、取消或退出都会释放本次控制，清除活动标记，保留页面并取消本次己方标签的分组。最后一个成员被移出后，空分组自动消失；用户自行加入的标签、移到其它分组的页面均保持原样。取消分组不激活或选择标签。绝不关闭用户整个 Chrome。自动上传和受宿主管理的下载暂不支持，`browser_capabilities.files` 两项均为 false；需要文件操作时请用户在可见页面手动完成，不能改用其它工具绕过宿主策略。网页仍遵循当前 Chrome 的常规网络、权限及原生下载行为。独立 Playwright 模式的文件授权和传输规则不变。

后台指针操作在投递前重新核对可见、启用、未遮挡和目标身份，并用宿主计时两次取样检查位置；不依赖后台页面可能暂停的动画帧。屏外、移动或已变化的目标需滚动后重新观察。当前 Chrome 的 iframe 指针目标因无法完整验证外层命中而明确返回 `BROWSER_BACKGROUND_FRAME_UNSUPPORTED`；不要改用桌面点击绕过。独立 Playwright 行为保持原样。

Native 请求独立响应，挂起的页面求值不会挡住关闭或其它会话；同一控制连接的输入命令按顺序确认，避免鼠标抬起先于按下。输入失败会撤销本次控制，排队输入不再投递。取消会立即释放本次 CDP 连接，再完成所属资源清理。扩展实际后台需声明 `transportConcurrency:parallel-rpc`，缺失时拒绝创建新控制目标。

桥接只对已登记页面启用 Chrome 的页面焦点模拟，使后台页面能处理渲染和输入；不选择标签、不激活窗口，释放调试连接时取消模拟。页面内的 `document.hasFocus()` 或可见性值可能受模拟影响，不能用来证明电脑前台是否切换；前台保持应核对操作系统与实际活动标签。

当前 Chrome 的声明式新窗口链接应使用 `browser_tabs({action:"open_link",ref})`。Chrome 后台 Meta/Cmd 点击可能把新页来源标成用户当前活动标签，因此无法据此安全认领新页；本模式在任何此类点击前明确拒绝并给出打开链接的提示。`open_link` 是读取已核验 href 后在正式登记的新页导航，不执行页面点击脚本；下载链接、非 HTTP(S) 和 URL 内凭据均拒绝。普通同页控件仍走原生点击。

Native Messaging 安装器目前支持 macOS/Linux；未完成安装、连接或平台不支持时明确失败，不回退到用户看不到的浏览器。它不需要给现有 Chrome 开启全局远程调试端口。

### 原生桌面状态与任务清理

`desktopIndicator` 默认关闭，不显示常驻 DSH 浮层。桌面动作期间可显示驱动虚拟光标，空闲约一秒隐藏；任务完成、取消、异常或插件卸载时，禁用本会话光标并结束己方驱动会话，不影响其它会话。

`computer_status()` 保留健康诊断；`computer_status({scope:"control"})` 通过驱动只读查询本任务的生命周期和虚拟光标状态，并提供带来源和时间的最近释放记录。工具固定查询本会话，不接受其它会话编号，不会创建、恢复会话或刷新光标活动。已结束会话的实时读取可能被驱动拒绝，错误会如实保留；释放记录与实时状态分别呈现。光标可见性以驱动实际返回为准，读取错误或缺失字段保持未知；窗口截图不保证包含独立光标叠层，不能仅凭截图中没有箭头判断清理成功。

`computer_status({scope:"capabilities"})` 或 `npm run doctor` 进行只读驱动握手：核对实际可执行文件、工具 schema 和运行中驱动的 SHA256。`transport:ok` 只表示诊断请求成功，桌面是否就绪看 `readiness` 与健康检查；`degraded`、跳过检查或未知能力不能当作全部可用。握手使用3秒总预算，缓存60秒并绑定实际文件身份，文件替换或缓存失效后旧观察须重新获取；版本号不作为功能支持依据。

`screen_observe` 自动完成缓存握手。明确不支持的功能提前拒绝；元数据缺失或整体探测超时保留原有 AX 兼容路径，并将新协议能力保持未知。普通像素点击只有在消费 schema 已核对、实际 PNG 观察返回 `capture_id` 时才使用一次性绑定，尝试投递后即消耗，失败也不重放。AX token、`from_zoom` 及当前未声明 capture 支持的拖拽维持各自协议，不混用 `capture_id`。插件不安装、升级驱动或代替用户授权。

健康预检显示录屏权限通过，也不代表首次直接截图已经获准。若驱动返回 `px_capture_unavailable` / `direct_capture_consent_required`，它是在避免 macOS 首次截图授权框抢走焦点；请在方便时本人运行 `cua-driver permissions grant` 并完成系统确认，再重新观察。插件不会静默授权或绕过该保护，也不应反复尝试截图；可继续使用 `mode:"ax"` 操作有无障碍元素的应用，缺少实际图片时不能使用像素坐标。

macOS 可显式设 `desktopIndicator:true` 启用带停止按钮的面板。面板由随包的 Swift/AppKit 源码在本用户私有缓存编译，需要已有 Swift 编译器和 macOS SDK；缺少工具链时返回 `CONTROL_INDICATOR_UNAVAILABLE`，不启动安装器。停止首先锁定会话并取消 Agent，再结束己方驱动；启用面板后若它异常退出或通信失败，也会停止对应控制。它是 DSH 自己的提示，不启动持续录屏或模拟系统共享菜单。

`browserBackend:cua` 保留原有驱动后台浏览器。先用 browser_capabilities 查看实际能力；不能把已注册的工具名当作两个后端全部支持。CUA 0.38 未可靠打通的路径会明确返回不支持。

| 工具 | 作用 |
|---|---|
| browser_open / observe / navigate | 建立会话、观察、导航；query/scope_ref/continuation 分段读取 |
| browser_click / type / scroll | 最新 ref 操作，replace 输入及空串清空 |
| browser_select | 按 label/value 选择原生下拉选项 |
| browser_pointer / key | hover、右键、双击、拖拽与网页按键 |
| browser_tabs / history | 列出、新建、选择、关闭本会话标签页，或按 ref 显式后台打开链接；后退、前进、刷新 |
| browser_dialog | inspect 后凭最新 dialog_id 接受或取消网页 JS 弹窗 |
| browser_screenshot | 当前标签页截图与对应坐标语义 |
| browser_upload / download | 指定普通文件上传、下载保存为新文件 |
| browser_capabilities / close | 能力发现和关闭本会话独立浏览器 |

动作后重新观察。截断或局部观察不能证明目标不存在。系统弹窗与网页 JS 弹窗不同，不混用 dialog 工具。截图坐标以返回说明为准，CUA 的图片像素与 CSS 像素可能存在比例。

没有用户现有登录态接管能力；需要登录时由用户在适合的独立可见浏览器操作，然后重新观察。页面含密码/密钥字段或安全检查不完整时，自动输入可能整页暂停，不能换输入路线绕过保护。

## 文件传输

上传先针对安全页面地址和完整文件路径申请本次授权，获准后才通过宿主 fs 映射、检查并读取普通文件；拒绝时不读取文件字节。宿主 fs 可能允许工作目录外读取，不能把读取能力等同于用户授权。下载需要宿主 sandboxPolicy：read-only 拒绝写；workspace-write 限制工作目录或临时目录；只创建新文件，禁止覆盖或符号链接。每次传输总量最多10MiB。

上传调用开始仍要求有效 ref；等待本次审批超过 TTL 时，获准后只读核对原页/标签/frame/完整 URL、原文件框身份与状态及固定文件列表，读取前后各一次。目标未变可继续，不更新时间戳、不复活旧 refs；目标变化返回 `UPLOAD_TARGET_CHANGED`，明确已经获批但文件未交页面。其他动作仍按原 TTL 拒绝过期观察。

缺少必要宿主服务时明确拒绝。验收使用受控文件服务 fixture 的部分会单独记录，不据此声称运行中 DSH 的文件策略已验收。

## 验收入口

`npm test` 检查组件；`npm run check` 依次执行语法、全库 ESLint 和本轮范围的 Prettier 检查。`npm run lint`、`npm run format:check` 可分别运行，`npm run format` 只格式化 `tools/style-check.mjs` 明确列出的模块及测试。`npm run verify:desktop` 操作本机 Calculator；`BROWSER_BACKEND=playwright npm run verify:browser` 验证完整浏览器，省略变量可验证 CUA 兼容模式。模型自主任务验收与脚本指定 ref 的验收分别记录。

`npm run verify:host` 启动安装版 DSH 的独立 headless 实例，原生加载本轮源码、标准技能和真实文件/审批/沙箱服务；不使用 shell 工具桥。需要显式指定以下环境变量：

```sh
DSH_VERIFY_PROVIDER=your-configured-provider \
DSH_VERIFY_MODEL=your-configured-model \
DSH_VERIFY_API_KEY_REF=YOUR_STORED_CREDENTIAL_REF \
DSH_VERIFY_CREDENTIALS=/absolute/path/to/existing/credentials.yaml \
npm run verify:host
```

这里传入的是既有凭据的引用名和存储路径，不是密钥值；官方凭据 provider 以禁止写入的子类只读加载。自定义路由可另设 `DSH_VERIFY_BASE_URL` / `DSH_VERIFY_API`；默认安装位置不同可设 `DSH_VERIFY_CLI` / `DSH_VERIFY_CREDENTIAL_MODULE`。`--prepare` 仅检查配置组合；正常运行在临时工作目录完成带上传下载的本地任务，并独立验证服务器提交与文件字节。模型只收到业务要求，不收到 ref、调度码或操作序列。验收保留正式模型请求重试，仅重试 TRANSPORT 错误；不重放工具动作。`DSH_VERIFY_DEADLINE_MS` 默认为480000，允许30000–900000。

文件正反检查调用真实宿主工具和审批服务；验收 answerer 只对指定 fixture 目标提供本次授权。该检查覆盖授权机制，不覆盖真人点击审批界面。结果写入打印的 `evidence.json` 与同目录 `native-trace.jsonl`，不保存密钥、HTTP headers 或原始模型请求。收尾检查凭据存储未变、既有 DSH/Chrome 仍在，以及测试浏览器进程消失。

相同路由/凭据引用环境下，`npm run verify:web` 在 UCI 官方公开站点完成模型自主站内查找、跨页取数和 ZIP 下载，独立核对目标事实与官方文件字节；不登录、不上传或提交业务数据。`npm run verify:approval-ui` 则启动真实 DSH web 审批界面，没有测试 answerer。按 `status.json` 中的两条测试任务在 UI 中触发拒绝/允许，使用真实按钮并记录回显；人工点击与浏览器自动点击分开记录，人工结论还需本人确认与具体 decision ID 配对。

UI 验收把默认工作区通过正式 `workspace-controller.documentsDirectory` 设在本次临时目录，并核对真实 session.header.cwd；只设置进程 cwd 不足以隔离网页端默认工作区。官方启动地址含一次性认证信息，验收程序仅保存到0600的临时 `launch-url.json` 供本地浏览器兑换，兑换后删除；不要把其内容复制到聊天、日志或截图。纯 origin 与状态路径可公开。可用 `DSH_VERIFY_UI_TTL_MS`（默认120000）复测审批等待，`DSH_VERIFY_UI_DEADLINE_MS`（默认900000）限制实例存活时间；完成后向本次 runner 发 SIGTERM，等待凭据未变、原实例保留、所属浏览器退出和临时服务关闭的检查结果。

源码更新需宿主重新加载；独立进程和组件通过不代表当前用户 DSH 已加载。验收不重启其他会话。
