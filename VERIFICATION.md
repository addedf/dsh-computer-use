# dsh-computer-use 验证报告（VERIFICATION）

## 2026-11-03 第四轮：真人审批、公开真实网站与长等待修复

本节是最新验收结论。原用户 DSH 未重载或重启；验收时源码尚未提交、推送或发布。

| 验收层次 | 结果与范围 |
|---|---|
| 真实审批 UI | 独立安装版 DSH web、正式 ui-approval/Remote/ApprovalService，未挂测试 answerer。浏览器自动点“拒绝”时读取0次；自动点“允许一次”后才读取76字节并回显文件名。7项完整 UI 后端检查通过。 |
| 真人点击 | 用户明确回复“已点击”，对应单独测试会话的真实 allowed-once decision ID；人工等待137679ms，批准前累计读取仍为1，批准后增加1次76字节且文件框正确回显。`uiEvidence.humanConfirmed=true`。该人工运行显式 TTL300000，不能表述为默认120000验收。 |
| 真实网站任务 | UCI 官方公开网站，无账号。真实模型单 turn **96363ms、16次原生工具调用**，首次标准 skill；站内查找 Iris/Wine、跨页读取 Instances/Features/DOI、下载 Iris 官方 ZIP。无模型 HTTP/fs/shell 绕过，无外部业务提交。 |
| 网站独立检查 | **8/8**：实际页面目标事实、最终表格及两 DOI、普通下载文件、3738字节 ZIP 与控制器另取官方源逐字节一致、ZIP内150行/4项测量及类别、最终保存文件名。额外历史背景叙述不在核验范围；新5项测试防止篡改数据、无关数字或缺 DOI 被判通过。 |
| 长等待修复前 | 真实 UI、TTL10000，等待63836ms后 allowed-once，旧逻辑因快照过期拒绝、文件读取0次。`expectedRegression.ok=true` 表示成功复现这项体验问题，不表示上传成功。 |
| 长等待修复后 | 真实 UI、TTL10000，等待101792ms后仅一次批准、一次上传及一次76字节读取，文件名回显正确；`postFixRegression.ok=true` 的8项场景检查通过。这两个定向运行省略完整 UI 套件的拒绝阶段，通用套件 status=incomplete 与定向场景结论分别保留。 |
| 回归 | **240/240**，含21项上传等待安全测试；check29个JS/MJS及2个shell、diff通过；打包预演41个白名单文件，无本地验收数据或凭据。 |

网站来源：[UCI Iris](https://archive.ics.uci.edu/dataset/53/iris)、[UCI Wine](https://archive.ics.uci.edu/dataset/109/wine)、[官方 Iris ZIP](https://archive.ics.uci.edu/static/public/53/iris.zip)。

本轮修复的是上传请求等待审批时 TTL 被耗尽造成的重复授权。调用开始仍需新鲜 ref；本次批准后，读取前和交给页面前各只读复核原 state/快照/ref/标签/page/frame/完整URL、原 ElementHandle 的连接/document/真实file类型/可见启用状态/name/role，并固定批准的文件列表。目标未变可继续，不更新时间戳、不复活旧 refs、不重放动作、不再次审批；其他动作的 TTL 保护不变。目标变化返回 `UPLOAD_TARGET_CHANGED`，明确已经批准但文件未交页面，避免误报没有弹出审批。不同 iframe 接收页在审批中以脱敏 URL 呈现。

验收脚本另修正了工作区隔离假设：初次真人 UI 及旧逻辑复现的 session cwd 仍指向 DSH 既有默认工作区，不能以进程 cwd 推断会话隔离；当轮只放行指定浏览器测试工具，测试文件和持久化均在临时目录。后续通过正式 `workspace-controller.documentsDirectory` 把默认工作区设进本次根目录，并在真实 header 和每次工具调用中核对 canonical cwd，修复后场景现场检查通过。

三个 UI 实例及 UCI headless 实例均已关闭：所属测试 Chrome 全部消失、兜底强杀0次、临时服务与私有启动地址文件已清理；原凭据存储前后未变，既有 DSH/Chrome 进程保留。正式 web 认证仅允许既有 browser-session grant 的严格只读 no-op；认证 Cookie 按 host:port 隔离，不复制旧 Cookie，带认证信息的启动地址不进入聊天、日志或截图。

复现入口为 `npm run verify:web` 和 `npm run verify:approval-ui`，路由、只读凭据引用与交互记录要求见 [使用指南](docs/usage.md)。网站样本是 UCI 公开阅读/下载任务；登录态业务、外部真实提交、Windows/Linux 和 GPT 同任务 A/B 仍未验收。真实 UI 的真人允许、自动拒绝/允许与短 TTL 场景各有独立证据，不推广为全部审批变体或任意网站成功率。

---

## 2026-11-03 第三轮：独立 DSH 原生端到端

本节为最新结论，后续各节保留历史证据。本轮使用安装版 DSH CLI、全新临时 DSH_HOME 和独立 workspace；通过普通 profile 插件条目直接加载 `index.js`，真实 loader/Config 生效。审计插件只观察和执行验收，不调用源码 apply、不注册替代工具、不提供 fs/approval/sandbox 桩。既有用户 DSH 未重载、未重启。

| 验收层次 | 最终结果 |
|---|---|
| 常规加载与技能 | 36 个插件工具经真实宿主注册；自动技能目录、systemPrompt 路由及正文加载均通过。业务提示未点名 skill、未给 ref/调度码/工具序列；模型第一项原生调用为标准 `skill(dsh-browser)`。 |
| 真实宿主检查 | **12/12**：生产 `SandboxedFileSystem`、`ApprovalService`、`SandboxPolicyService`；原生条件断言、稳定两样本等待、新 refs、动态 run_steps、审批拒绝、never、符号链接、read-only、越界下载及 EEXIST 保护。 |
| 模型完整任务 | **单 turn 108626ms，24 次原生工具调用**。模型跨标签页读取异步说明、选择 Express、填写姓名和码、上传指定测试文件、勾选并提交、下载收据、browser_verify 返回 satisfied；使用本机既有 opencode-go/deepseek-v4.1-flash 路由。没有 shell 工具桥。 |
| 独立业务结果 | **7/7**：服务器仅接受一条有效提交；上传76字节的 SHA256 与指定文件一致；160字节收据落盘内容与服务器源字节一致；最终确认编号从模型 final 事件核验，不从工具输出冒充最终汇报。 |
| 文件审批 | 真实 session 中 **4 组 asked/decided 配对**；模型上传先获 allowed-once，再调用真实 fs.readBytes。never/显式拒绝均没有读取文件字节；批准符号链接后仍被普通文件检查拒绝。 |
| 隔离与清理 | 正式 launcher 卸载时等待 effect 清理；两个测试专属 Chrome PID/profile 均消失，兜底强杀次数0，HTTP fixture 已关。既有 DSH/Chrome PID 均保留，原凭据存储前后未变；独立进程退出码0。 |
| 回归与包装 | **214/214** 测试通过；check 覆盖24个JS/MJS和2个shell，diff检查通过；打包预演仅36个白名单文件，无本地验收数据或凭据。 |

本轮修复两个真实集成缺陷：上传原先在审批前读取文件，现先以安全页面地址和完整路径申请本次授权，拒绝不读字节；Cordis 不自动触发普通 dispose 事件，现用正式 effect 挂载可等待、幂等的驱动/技能/浏览器清理，新增真实 fiber 卸载测试。

成功前的两次原生模型验收分别在0次、8次工具调用后遇到 TRANSPORT/ECONNRESET，保留失败记录。恢复正式宿主的模型请求重试后完成任务；最终常规入口运行发生6次传输重试，只重试模型请求，没有重放工具动作或重复提交。较早源码直接 apply 的原生运行也完成25次调用及业务闭环；最新结论以本节常规插件入口结果为准。

文件授权使用真实服务与只限本次测试站点/指定文件的验收 answerer，验证授权机制，**未验证真人审批界面**。模型认证由官方凭据 provider 的只读子类读取既有引用，禁止写入/迁移，不复制密钥。远程业务站点、用户 Chrome 登录态、Windows/Linux 与 GPT 同任务 A/B 仍未验收。

重复入口：`npm run verify:host`，所需路由/凭据引用环境变量见 [使用指南](docs/usage.md)。终端打印完整 evidence.json 及 native-trace.jsonl 路径；证据仅保存安全路由、测试数据和结果，不保存密钥、请求头或原始模型请求。原用户实例尚未加载本轮源码；验收时尚未提交、推送或发布。

---

## 2026-11-03 第二轮：技能、条件、动态编排与完整浏览器

本轮接续以下第一轮记录；验收时仍为本地未提交源码，未发布。公开工具共36个，默认浏览器切为独立 headless Playwright Chrome，CUA 可显式保留。

| 层次 | 本轮结果与证据边界 |
|---|---|
| 单元/组件/权限集成 | **209/209**；显式指定不存在的 CUA_DRIVER_BIN 仍全通过。包含真实 Cordis/SystemPrompt/SkillRegistry/ToolRuntime、技能注册与自动路由、条件状态、动态分支循环、pre/post policy、取消/超时/文件与资源边界。 |
| 技能 | 两份原创 SKILL 校验通过；真实宿主组件可列出并加载正文，fallback 按会话注入；真实插件生命周期挂载/卸载通过。不是只检查文件存在。 |
| 原生桌面 | **24步通过**：真实 cua-driver + 桩宿主服务，computer_verify 与稳定2样本等待通过，缺失按钮返回 unknown/ok:false；重新观察后完成7×8=56，截图及本机OCR读回。本轮前台应用前后相同；脚本会话已清理。 |
| Playwright 浏览器 | **41/41**：真实 Chrome + ToolRuntime + 本地HTTP fixture，覆盖表单/条件、tabs/history、select、键鼠、dialogPending及处理、截图、查询/子树/分页、上传下载、拒绝覆盖；零控件、超过32000字的文章至少3段读到末端标记，每段≤16000字。 |
| CUA 浏览器 | **13/13**基础兼容验收；其他路径按 browser_capabilities 实际声明，不把注册工具等同于后端完全支持。CUA modal click曾等待到驱动超时，对话框流程未宣称可靠；默认Playwright覆盖此功能。 |
| 文件传输 | Chrome/HTTP/文件结果真实，宿主fs/sandboxPolicy为受控fixture；未声称运行中DSH的生产文件授权端到端已验。取消停滞流、监听器清理、无覆盖、无残留文件已独立复测。 |
| 构建/包装 | npm run check、git diff --check通过；npm pack --dry-run仅32个白名单源码/文档/技能/验收文件。新增依赖固定版本，lock使用官方公开registry地址与校验值；无浏览器下载安装脚本。 |

### 模型自主任务

- 独立 headless DSH 已真实挂载本轮源码，但其默认 deepseek-official/deepseek-flash 路由缺凭据，0次工具调用即停止。保留失败结论，不据此宣称模型验收通过。
- 随后使用已连接 DSH 的新隔离会话，模型通过受限 shell 桥调用本轮源码工具。用户目标只提供业务要求和输入数据，没有给 ref 或调用序列；只允许本地fixture，不访问用户业务数据、不复制凭据。
- 模型自主打开异步表单、读取新标签页说明、选择Express、填写测试姓名与调度码、勾选并提交。独立服务器只收到**一条有效记录**。第一轮执行约118秒触及验收预算，在最终报告前取消；随后17秒只读收尾，自主观察/断言并报告确认结果，**未重复提交**。
- 两次桥接执行合计29次DSH工具调用：1次标准skill(dsh-browser)，28次bash均调用指定工具桥；审计无curl/HTTP/读取fixture源码绕过。它证明模型自主完成该复合任务，不能折算为任意任务成功率，也不代表当前用户DSH已原生热加载36个新工具。成功桥接通路的公开响应未提供provider/model ID，保留未知，不借用失败headless通路的route填充。
- 收尾已等待插件dispose回调，关闭测试专属浏览器、HTTP/IPC并删除socket；桥进程退出码0。原有DSH会话和用户浏览器未被停止。

尚未完成官方GPT的同任务A/B对比、远程业务站点/用户登录态、Windows/Linux真机和运行中DSH生产文件服务验收。没有重启原有DSH或改变全局provider；使用指南见 [docs/usage.md](docs/usage.md)，可重复验收入口为verify-desktop、verify-browser和verify-agent。

---

## 2026-11-03 本地改进验收

本节对应本轮源码改动（验收时尚未提交）；以下旧日期记录属于历史证据。

- 单元与集成：117/117 通过。显式将 `CUA_DRIVER_BIN` 设为不存在路径后仍全通过，证明无需本机驱动；包含真实 Cordis ToolRuntime 的批量 pre-policy 拒绝、post-policy 阻断及调用身份传递。
- 语法：`npm run check` 逐文件检查全部 JS 和安装/卸载脚本；`git diff --check` 通过。
- 桌面：`npm run verify:desktop`，当前插件源码 + 真实 cua-driver 0.38.0 + 桩宿主服务，共 18 步。AX 不向模型返回图片；整窗坐标、放大图 `from_zoom`、AX token 三种点击完成 `7×8=56`，截图与本机 Apple Vision OCR 独立读回。6 次点击全部 `delivery.mode=background`；驱动每步 `effect=unverifiable`，最终结果由截图证实。脚本只结束自己的 driver session，保留 Calculator 与 daemon。
- 浏览器：`npm run verify:browser` 13/13 通过，使用真实 Cordis ToolRuntime、真实驱动及临时本地 HTTP fixture；浏览器为独立临时 profile。验收包括中文输入、替换清空、ref 点击后页面/服务器双读回、滚动事件、危险标签拒绝、会话隔离及嵌套批量。重复验收捕获首次 CDP 关联就绪竞态，现仅对明确的 `no CDP target correlates` 只读绑定/观察最多尝试 4 次；不重放任何启动、导航或输入动作，授权/歧义拒绝不重试。最终版本验收通过；此前加入诊断阶段标记后连续 3 轮也全部通过。
- 诊断：真实 `health_report` 显示 AX 与 Screen Recording 已授权；总体为 `degraded`，其中 bundle identity 检查失败、直接 capture readiness 探针为 skip。实际窗口截图成功；不把只读诊断标记当作全面系统验收。

当轮尚未验收：正在运行的 DSH 进程重新加载本轮源码、真实远程网站/用户登录态、真实视觉模型调用、Windows/Linux 桌面。该轮没有重启用户 DSH；验收时尚未提交、推送或发布。

已知边界：不同 session 观察同一原生窗口仍会使驱动旧 token 失效；网页包含密码/密钥字段或 DOM 检查不完整时整页暂停自动输入；启动/绑定遭驱动拒绝时报告原因，不自动接管用户 profile 或升级前台模式。安装/系统授权仍由用户按官方流程完成。`verify-runtime.mjs` 现在是桌面验收兼容入口，会操作 Calculator，已在脚本开头注明。

---

> 环境：macOS 15.6 (arm64) · harness-desktop（dsh 0.1.1-rc.2）· cua-driver 0.19.3
> 方法：隔离 profile（.dsh-p0）headless 实测，未改动真实 GUI 配置
> 日期：2026-08-15

## 此前维护验收（历史 release candidate）

以下记录针对当前 main，而不是上方的历史 0.1.1-rc.2 报告：

| 项 | 结果 |
|---|---|
| DSH 0.1.2-rc.1 隔离宿主 | ✅ 在 `/tmp` 临时 DSH_HOME 中安装 DSH 0.1.2-rc.1 与插件 0.3.0（历史验证记录）；`--dump-config` 成功解析 `dsh-computer-use`，web profile 随机端口启动并返回 HTTP 响应，无 CallId/ToolCallId 模块链接错误 |
| 插件 runtime 脚本 | ✅ 真实 cua-driver 0.23.2，`node verify-runtime.mjs` 15/15 通过；覆盖工具注册、AX/native/zoom、图片块和结构化拒绝 |
| macOS GUI 闭环 | ✅ 当前插件代码 + cua-driver 0.23.2 操作系统 Calculator：AX 观察 135 个元素，点击 `1 + 2 =` 后截图确认显示 `3`，重新观察成功；`cmd+c` 路由也实际调用 |
| Windows 真实 GUI | ⛔ 本机无 Windows 10/11 测试环境，未将逻辑测试冒充 GUI 验收 |
| Linux 真实 GUI | ⛔ 本次未验证 |

Windows/Linux 在获得对应真实桌面环境并完成 `WINDOWS_TEST.md` / 等价验收前，不得标记为 fully tested。

## P0 — 引擎与桥接验证 ✅

| 项 | 结果 |
|---|---|
| cua-driver headless call | `get_screen_size`→1710×1112@1x；`get_cursor_position`；`list_apps`；`health_report` 全 pass |
| MCP stdio 链路 | `cua-driver mcp` 初始化 + `tools/list` 返回 **54 个工具** + `tools/call` 正常 |
| dsh-mcp-client 桥接 | 端到端：headless agent 真实调用 `mcp__cua__get_screen_size` 并正确报告 |

## P1 — 插件骨架与工具注册 ✅

| 项 | 结果 |
|---|---|
| 插件结构 | `cordis.patch.yml`（dsh.bundle.patch）+ `index.js` + `package.json`，bundle 机制加载成功 |
| 工具注册 | **11 个工具**全部注册（screen_observe / computer_click / double / right / type / key / scroll / drag / wait / app_list / app_launch） |
| screen_observe | harness-desktop 窗口：325 个编号元素，`[N] 角色 "标签" @(x,y)` 格式 |
| app_list | 返回 11 个运行中应用（含 pid/活动态） |

## P2 — 双模闭环 ✅（AX 模式实测通过）

备忘录完整 demo（"打开应用 → 点击 → 输入"验收项）：

| 步骤 | 工具 | 结果 |
|---|---|---|
| 打开 | `app_launch(bundle_id=com.apple.Notes, bring_to_front)` | ✅ 启动前置 |
| 观察 | `screen_observe(window=41812)` | ✅ 183 元素，锁定"新建备忘录"[46] |
| 点击 | `computer_click(element=46)` | ✅ 新建笔记成功 |
| 输入 | `computer_type(element=38, text=…)` | ✅ delivered=28，回读确认 |
| 验证 | `screen_observe(query=…)` | ✅ element 38 值=输入文本 |

视觉兜底（模式 B）：代码就绪（GLM-4V-Flash）；无 key 时优雅降级验证通过（AX 树照常返回 + 清晰提示），真实调用待 ZHIPU_API_KEY。

## P3 — 安全护栏 ✅

| 护栏 | 验证方式 | 结果 |
|---|---|---|
| 快照 TTL（历史会话） | 观察后等 16s 再点击 | ✅ 当时临时 patch 为 15 秒，拒绝："快照已过期"；当前代码与 bundle patch 默认 30 秒 |
| 无快照拒绝 | 直接动作 | ✅ 拒绝："请先调用 screen_observe" |
| 区域限制 | allowedApps=['备忘录']，操作 harness-desktop | ✅ 拒绝："不在允许操作列表"，fail closed |
| 放行路径 | allowedApps 含 harness-desktop | ✅ "收起侧边栏"点击成功 |
| 危险词检测 | 单元 12/12 | ✅ 删除/支付/转账/退出登录命中；保存/新建不误报 |
| 密码框保护 | 逻辑（AXSecureTextField 拒绝 type） | ✅ 代码验证，真实密码框待集成后补测 |

## 开发中发现并修复的真实 Bug

1. dsh-tools schema 不支持 `type:[x,'null']` 联合 → `oneOf`
2. output 多余字段被 `additionalProperties:false` 拒绝 → 精简 schema
3. object schema 缺 `additionalProperties` → 显式声明
4. **Safari AX 树序列化崩溃**（NaN 坐标 + 孤立代理项）→ `safeStr` + `centerOf` 有限性校验
5. `query` 参数声明未透传 → 修复
6. `app_launch` 的 `creates_new_instance` 未入 schema → 补全
7. **试用实测（真实 GUI 会话）**：`computer_key` 未传 pid/scope（press_key 报 Missing pid）→ 修复（有快照传 pid，否则 desktop scope）
8. **试用实测**：`computer_click` 坐标模式未传 window_id（多窗口应用报 ambiguous_window_target）→ 修复（坐标模式带 window_id）
9. **试用实测**：`computer_key` 传 pid 仍多窗口歧义 → 修复（补传 window_id；引擎验证通过 global_input/confirmed）
10. **试用实测（历史会话）**：TTL 15 秒对多步 UI 操作太短（计算器 19 次点击断链）→ 会话临时调 60 秒；当前代码层与 bundle patch 默认均为 30 秒，多步操作仍可显式调大 `ttlMs`。

## 🕹 真人操作模式（2026-08-15 核心改造）

**核心初衷落实**：AX 树只用于"看"（定位坐标），操作走像素级虚拟光标（滑行+点击，看得见过程）。

| 项 | 结果 |
|---|---|
| `lib/human.js` | 光标分段弧线滑行（模拟人手轨迹）+ 像素级点击 |
| `lib/actions.js` | click/双击/右键 全部改为真人操作（不再 AX 瞬发）|
| 快照增强 | 元素坐标 + 窗口位置（滑行定位）|
| 演示 | 彩虹光标弧线滑行到计算器（引擎直连验证滑行可见）；坐标校准为近似，待真实会话验证 |
| 光标主题 | 彩虹渐变（用户确认满意）|

## P4 — 真实环境集成 ✅（已热生效）

| 项 | 结果 |
|---|---|
| 集成方式 | home 级用户 patch 层（`$DSH_HOME/cordis.patch.yml`）注入，不修改任何 profile 配置 |
| install.sh | 执行成功：symlink 插件包 + 追加 home patch（幂等） |
| 合成验证 | `dsh --profile web --dump-config` 确认 `dsh-computer-use` 在合成树中 |
| **热生效** | **HMR 热加载确认：当前真实 GUI 会话可直接调用插件工具，screen_observe 返回格式与实现逐字段一致（含快照 ID 与提示语），无需重启** |
| 内置冲突排查 | 全 app 范围 grep：harness-desktop **无内置** computer_click/screen_observe 同名工具，纯新增无覆盖 |
| 卸载 | uninstall.sh |

## 🎨 虚拟光标主题（2026-08-15 新增）

| 项 | 结果 |
|---|---|
| 需求 | 彩色 + 渐变 + 动态渐变光标 |
| 生成器 | `tools/make_theme.py`：4 条纯色带拼渐变箭头（gf 渐变不被 bounded vector 支持 → 纯色带方案）+ 颜色关键帧动画（彩虹流动）|
| 主题 | `com.dsh.computeruse.rainbow`（128×128, 30fps, 12 动作动画）|
| 编译 | validate/build 通过（CuaDriver.app 内 cua-cursor-theme；CLI sidecar 缺失已绕过）|
| 安装/切换 | 已入库；会话 demo 实测 **用户确认满意** |
| 插件固化 | 动作绑定统一会话 `dsh-computer-use` + 启动自动 `set_agent_cursor_theme`（`cursorTheme` 配置项）|
| 踩坑 | Lottie 层变换必须是标准动画属性格式（`{"a":0,"k":...}`）；形状不能包 `gr` group；渐变 `gf` 不支持 |

## 已知边界（非缺陷）

- Safari 网页 DOM 不在 AX 树展开（引擎特性）→ 视觉兜底场景（native / vision 模式）
- 管理员权限窗口（UAC 等）Windows 上不可操作（引擎结构化拒绝）
- Windows/Linux 平台待真机实测（官方支持矩阵：Windows Supported）

## 📸 原生视觉模型接入（v0.2.0，2026-08-25 验证）

### harness 侧（dsh-src，已通过类型检查 + 154 项单测）

| 项 | 结果 |
|---|---|
| `llm-deepseek` 目录模型 `input` 字段 | `DeepSeekCatalogModel.input?: ['text'] \| ['text','image']`；`modelInfo()` 与 `resolveModel` 据此声明 `inputModalities` |
| 注册 `deepseek-v4-flash-vision-exp` | `DEFAULT_MODELS` 新增该模型（input: [text, image]），Web 模型选择器直接可见 |
| 图片块序列化 | `serialize.ts`：user 消息图片块 → OpenAI 兼容 `[{type:text},{type:image_url,url:data:...}]`（经 attachments 读回字节）；assistant/其他角色图片仍拒绝（UNSUPPORTED_CONTENT） |
| 附件字节解析 | adapter 注入 `resolveImageBytes`（`ctx.attachments.readImage`），无 attachment 服务时副作用明确报错 |
| 单测 | `serialize.spec` / `adapter.spec` / `dynamic-config.spec` 全部更新并通过（含图片块用例、3 模型默认目录断言）|

### 插件侧（dsh-computer-use，真实引擎闭环 12/12 ✅）

运行 `node verify-runtime.mjs`（隔离验证脚本，真实 cua-driver 0.21.0 daemon + 注入 attachments/llm 桩）：

| 项 | 结果 |
|---|---|
| 工具注册 | 12 个（新增 `screen_zoom`），`screen_observe` mode enum = ax/vision/native |
| `screen_observe(ax)` | 真实引擎：终端窗口树 + 坐标（截图像素标注）|
| native 拒绝 | text-only route（deepseek-v4-flash）→ 优雅提示切视觉模型 |
| **native 直读** | image-capable route（deepseek-v4-flash-vision-exp）→ 截图 PNG（1.06MB）经 attachments 落盘 + **render 产出 `{type:"image"}` 内容块（主模型直接看图）** |
| `screen_zoom` | 真实引擎 zoom：区域 JPEG（≤500px）落盘 + 图片块 |
| vision 降级链 | DeepSeek 观察者（无 key → MISSING_CREDENTIAL）→ GLM（无 key → 网络失败）→ 错误文本优雅返回，不崩溃 |
| 坐标语义 | 0.21.0 "窗口本地截图像素" 统一：移除旧 ×2 / 窗口偏移换算；输出标注"坐标=窗口本地截图像素" |
| 安全回归 | 无快照拒绝仍生效 |
| 引擎拒绝透传 | `{code, effect:"refused"}` 结构化拒绝 → `ok:false`（不再误报成功）|

### 说明

- native 直读的"模型真正看到图"依赖 harness 运行时（附带的 app 内嵌 dsh 需含上述 harness 改动；用 dsh-src 源码构建的 dsh CLI 直接具备）
- vision 观察者真实调用需 DEEPSEEK_API_KEY + 端点提供 `deepseek-v4-flash-vision-exp`
- 截图超附件限额（5MB）时自动用引擎 `zoom` 降级 ≤500px JPEG（`nativeImage: auto/full/compact` 可调）
