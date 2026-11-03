# 技能、条件等待与浏览器操作

## 加载技能

插件包含原创 `dsh-desktop` 和 `dsh-browser` 技能。加载时通过宿主 `ctx.skills.register` 注册，标准 `skill({name:"dsh-browser"})` 可按需读取正文。系统提示提供精简路由；没有标准消费者时可用 `computer_skill`，相关工具调用后也会为该会话加载对应指导。仅放 README 不等于技能加载。

缺少宿主 systemPrompt 服务时会记录自动入口不可用；显式 computer_skill 仍可读取。技能指导不会替代运行时权限、快照和取消检查。

## 条件等待与断言

`computer_verify` / `computer_wait_for` 检查已观察的精确窗口；`browser_verify` / `browser_wait_for` 刷新本会话网页后检查条件。仅 `status:satisfied`、`matched:true` 才通过；unknown、截断、隐藏值和歧义不当作成功。

等待参数为 `timeout_ms`（0–10000，默认5000）、`interval_ms`（50–1000，默认200）、`stable_samples`（1–5，默认2）。正在进行的读取会等待其有界超时后处理取消，避免后台悬挂读取使后续引用失效。

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

每组1–20步，嵌套最多3层，整个流程最多60次工具调用、120秒预算。取消信号传给子工具，并等待已开始工作结束。任一步失败立即停止，不重放已有动作。不执行任意 JavaScript。宿主启用 PTC 时，也可使用其工具 SDK 处理结构化 `data`。

## 浏览器后端

```yaml
config:
  browserBackend: playwright
  browserHeadless: true
  ttlMs: 120000
```

默认 Playwright 后端通过 playwright-core 和本机 Chrome 创建独立临时浏览器，不下载浏览器、不接管用户已有 Chrome。默认 headless，不操作真实鼠标或前台窗口。截图用 browser_screenshot。需要可见浏览器时配置 browserHeadless:false，窗口可能显示，应在适合的桌面会话使用。

`browserBackend:cua` 保留原有驱动后台浏览器。先用 browser_capabilities 查看实际能力；不能把已注册的工具名当作两个后端全部支持。CUA 0.38 未可靠打通的路径会明确返回不支持。

| 工具 | 作用 |
|---|---|
| browser_open / observe / navigate | 建立会话、观察、导航；query/scope_ref/continuation 分段读取 |
| browser_click / type / scroll | 最新 ref 操作，replace 输入及空串清空 |
| browser_select | 按 label/value 选择原生下拉选项 |
| browser_pointer / key | hover、右键、双击、拖拽与网页按键 |
| browser_tabs / history | 列出、新建、选择、关闭本会话标签页；后退、前进、刷新 |
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

`npm test`、`npm run check` 检查组件；`npm run verify:desktop` 操作本机 Calculator；`BROWSER_BACKEND=playwright npm run verify:browser` 验证完整浏览器，省略变量可验证 CUA 兼容模式。模型自主任务验收与脚本指定 ref 的验收分别记录。

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
