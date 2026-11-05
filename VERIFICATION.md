# dsh-computer-use 验证报告（VERIFICATION）

## 2026-11-05：宿主重启后的真实后台任务验收

用户确认重启 DeepSeek Harness 后，通过实际宿主的两个原生模型会话分别完成网页和软件操作。测试对象为 loopback 虚构表单和 macOS Calculator；业务动作只由模型调用本插件工具执行，未用测试脚本、HTTP API、shell、AppleScript 或真实键鼠替代输入。外部协调器仅准备 fixture、读取独立证据并采样系统元数据。以下结论对应交付版本 `a5e0868`，不把后续本地诊断补丁当作宿主已经加载。

| 验收项 | 本轮实测与边界 |
| --- | --- |
| 重启与连接 | 首次检查发现 CUA daemon 未运行且默认 socket 遗留；确认无服务、socket 拒绝连接后保留备份，以官方 `serve --embedded` 标准模式启动。没有重新授权或打开截图提示。首个 Web 请求在建页前因 `CHROME_EXTENSION_REQUIRED` 拒绝；用户手动点击“连接本机 DSH”后才继续。本轮不证明宿主重启可自动恢复这两项连接。 |
| 实际 Web 流程 | 当前 Chrome 扩展后端在本轮登记页读取异步说明、填写姓名/代码、选择服务并生成一次预览。独立 fixture 的9项检查全部通过：表单、说明及异步说明各读取1次，有效预览请求恰好1次，结果与全部字段匹配；预览按钮的5类指针/点击事件各1次且 trusted。下拉语义选择的 input/change 不要求 trusted，不能把所有页面事件都称为可信。工具轨迹另有5项页面断言满足，两个输入与一次选择均读回 `effect:verified`。 |
| 后台链接与释放 | 模型首次直接点击新窗口链接时，被 `BROWSER_BACKGROUND_LINK_REQUIRES_OPEN` 拒绝，随后用同一观察的 ref 经 `browser_tabs(open_link)` 登记新页；无前台降级。自然结束后的只读 `browser_verify` 返回 `NO_BROWSER`，证明本会话控制状态释放。本轮未独立读取 Chrome 分组状态，不能仅凭 `NO_BROWSER` 断言页面保留/取消分组已复验；其隔离 Chrome 回归与历史现场证据单独保留。 |
| 实际软件流程 | 用 `app_launch(bring_to_front:false)` 后台启动 Calculator，驱动返回 `self_activation_suppressed:true`。7次 AX 按钮输入完成 `37×19`，均为 `delivery.mode:background`、`route:accessibility`；驱动的 `effect:unverifiable` 仅证明投递。实际 AX 文本断言分别读回37、19及703，703重复两次满足，故结果依据为界面树而非心算。不存在的704断言为 unknown，未作为严格反例或成功。未使用坐标、前台键盘或激活窗口。 |
| 真实指针与焦点 | 前台/真实指针/窗口的独立只读采样目标周期为40ms，UI焦点约每200ms异步探测并可能携带缓存；Web主区间10:30:13.239–10:31:45.111（北京时间）2296个样本，桌面10:35:25.388–10:39:09.344为5596个样本；最大采样间隙分别113.310ms、118.317ms。Web期间没有采到Chrome成为前台，桌面期间没有采到Calculator成为前台/AX焦点目标。但同期存在其他应用切换和真实指针移动，来源未确认，不把它们归因模型，也不据此宣称全系统前台、真实指针或输入焦点全程不变。AX系统级focusedApplication读取失败，UI焦点采用前台PID查询兜底且有unknown样本、缺少稳定元素标识，故严格“零焦点丢失”仍未证实。页面 focus/visibility 值不作OS证据。 |
| 桌面动作窄窗口 | 按实际工具call/result时间及两侧200ms分别复核：后台启动和3次独立点击均未见前台、真实指针或AX焦点候选PID/role变化，上述窗口读数及UI兜底探针无unknown（不含始终失败的系统级focusedApplication）；不扩大为全程证明。包含另外3次点击的同一批次前台稳定，但真实指针有20次位置变化、AX UI候选role变动2次及1个窗口unknown；最后等号批次前台/指针/UI候选稳定，精确call→result区间有3个窗口unknown，两侧各扩展200ms后为4个。批次内缺少独立leaf时间，不为其编造逐次点击窗口；全部动作的扩展窗口都未见Calculator成为前台或激活目标。 |
| agent虚拟光标 | 最后一次等号输入及状态读取在同一批次：立即 `enabled:true`、`cursor_visible:true`；等待2000ms后 `enabled:true`、`cursor_visible:false`。自然结束时同一owner的历史释放记录：02:39:09.387Z禁用确认false，.418Z读回enabled/visible均false，.442Z结束ACK active=false。`lastRelease.startedAt` .352Z是清理开始时间，不是会话创建时间。结束后实时getter为 `DRIVER_EXIT`，仍报告未知，不重新创建会话伪造实时证明。 |
| 截图权限边界 | 两次模型native观察仅得到空截图；独立只读检查确认实际 `screenshot_error.code=px_capture_unavailable`，原因为 `direct_capture_consent_required`。驱动主动跳过首次截屏，避免macOS授权框抢走键盘焦点；本轮未执行 `permissions grant`、设置绕过变量或弹出系统提示。AX操作不受影响。健康预检的录屏pass与此次直接截图授权是不同检查，不能以预检pass宣称图像路径可用；bundle身份检查fail及producer unverified也不当作此次失败的已证实原因。 |

本轮证明上述网页与Calculator任务可以经后台链路完成；严格的真实指针连续不变、零输入焦点丢失、任意网站/软件兼容性仍未通过验收。未操作真实账户、发送消息、上传下载或提交外部业务。原始工具轨迹、fixture和只含系统元数据的采样日志保存在本机私有测试目录，不纳入提交；计算器及任务页面未由测试关闭。

现场发现的空截图诊断另作最小补丁（`e88acc8`）：native、vision及两种zoom路径对首次直接截图授权返回固定说明，驱动原始reason/suggestion不透传；已有AX元素仍可用，但不发布像素坐标或图片尺寸，明确截图错误不再触发重复采集。新增9项针对性测试后，默认 **485项：484通过、0失败、1跳过**；观察相关定向测试 **53/53**、91 JS+2 Shell语法、全库ESLint、范围内Prettier及diff检查通过。补丁只做了本地回归，未把它记为实际宿主复验通过。收尾仅停止本轮loopback服务和采样器，保留任务页面、Calculator及已恢复的驱动服务；未修改宿主配置或截图授权。

## 2026-11-05：代码交付与重启后验收准备

代码已按桥接基础、控制运行时和开发检查分别提交，开源复用记录另作独立文档提交。下方历史段落中的“未提交/未推送”是各轮验证当时的状态；当前交付以 Git 提交和远程记录为准。提交前重新运行：默认476项（475通过、1项真实浏览器默认跳过），91 JS+2 Shell语法、全库ESLint、范围内Prettier和diff检查均通过。新增81个公共依赖的下载地址已逐项核对官方精确版本与integrity后规范化；候选未含真实凭据、本地配置或运行数据。

用户将重启 DeepSeek Harness，随后在实际宿主的新会话验收，以下仍是待执行项目，不能当作本轮已通过：

- Web：仅在本轮登记页面完成虚构表单任务，独立核对读取、填写、选择和唯一一次预览结果；自然结束后页面保留、控制释放与取消分组。
- 软件：经实际 DSH 模型观察目标应用并执行简单可逆操作，核对真实结果；只允许后台投递，不批准前台、真实键鼠替代输入。
- 不打扰：独立采样操作系统前台应用、活动窗口、输入焦点与真实系统指针位置；页面内部 focus/visibility 模拟值不充当操作系统证据。焦点采样不读取用户输入内容。
- 光标：分别核对真实指针保持与所属 agent 虚拟光标的活动、空闲隐藏和结束释放；实时 getter 失败仍报告未知，不重建会话伪造清理成功。

## 2026-11-05：第二轮采集预算、驱动握手与代码规范

本轮在上一节开源调研结果上继续实现两项功能：浏览器遍历预算与实际驱动能力握手，并补充静态检查及范围内的统一格式。上游固定源码、采用方式与规范取舍见 [开源复用记录](docs/open-source-reuse.md)，配置和诊断说明见 [使用指南](docs/usage.md)。

| 验证层次 | 本轮结果与边界 |
| --- | --- |
| 默认回归 | 基线434项（433通过、1跳过）；最终 `npm test` **476项：475通过、0失败、1跳过**。跳过的真实 Chrome 写入测试在下方已显式启用，未计入默认通过数。 |
| 实际浏览器综合回归 | `DSH_VERIFY_BROWSER_WRITES=1 node --test --test-concurrency=2 tests/browser-write-verification.test.mjs tests/browser-observation-budget.integration.mjs tests/browser-companion-background.integration.mjs tests/chrome-bridge-popup.integration.mjs` **51/51通过**，包含真实 Chrome 场景、父测试及配套合成测试，不把51项全部称为独立真实业务场景。 |
| 大页面实际采集 | 13个隔离 Chrome 子场景覆盖5000按钮页面、输出/全页安全节点额度、精确续页、query跨预算与跨16000字符边界、scope及其续页、跨frame累计、open shadow root、导航与游标节点移除。返回 `visitedNodes` 未超过对应额度，安全扫描不足时输入和下拉均零写入。editable自身、祖先及aria-labelledby直接引用的内容不会因控件名称回显；测试只使用合成marker。 |
| 取消、超时与句柄 | 单元测试覆盖标题/ownerFrame/采集/句柄清理的共用deadline，取消与晚到结果不发布新refs或续页，过期游标释放。deadline停止宿主等待并约束协作式遍历，不能强制中断浏览器内部已经开始的单个原生DOM API；晚到RPC仅释放结果，不继续采集。 |
| 握手与实际CLI进程 | 受控可执行脚本验证固定argv、runtime SHA匹配、同版本不同schema、畸形enum、输出上限、取消、缓存过期、探测中替换文件及迟到回包。插件包装闭环验证先握手后创建控制会话、一次性capture只投递一次、AX不混capture、前台审批期间替换二进制后零前台重试。审批为fixture模拟，未使用真实桌面。 |
| 真实本机只读驱动检查 | 本机 **0.38.0**：`transport:ok`、`readiness:degraded`，运行SHA与实际文件匹配；structuredElements、captureClick、zoom、fromZoomClick声明可用，captureDrag未支持，capture生产端仍 `unverified`。AX/录屏权限检查pass，bundle_identity fail、screen_capture_capability skip；未据此宣称截图或输入实际可用。本轮未读取用户窗口或执行原生输入。 |
| 代码风格与静态检查 | `npm run check` 通过：**91 JS + 2 Shell**语法检查、全库ESLint零错误/警告，以及29个明确列出的核心模块、配置与测试的Prettier检查。保留单引号、无分号、2空格和100列；Node、页面回调、Chrome globals分开声明。低影响lint清理保留安全正则含义及业务行为。 |
| 打包与文档 | `git diff --check` 通过；`npm pack --dry-run --json` 中67个文件包含新增3个运行模块和调研记录，路径筛查无凭据或本地运行数据文件名；27个本地文档链接目标均存在。未产生发布包或发布npm。 |

浏览器验收均使用新建headless Chrome与本机fixture，结束后关闭。既有后台指针门禁、MV3/debugger/Native framing、两页登记、一次可信预览、保留页面并取消分组、用户标签保持等回归通过。本轮未主动重载实际DSH、未操作日常Chrome或真实账户；原生模型与真实桌面动作尚未复验。改动保留在原工作区，未提交、推送或发布。

## 2026-11-05：开源机制复用与执行边界优化

对照 OpenAI CUA sample / Agents SDK、Cua、Anthropic computer-use-demo、browser-use 与 iFurySt/open-computer-use 的固定源码提交，完成取消传递、网页写后回验、弹窗事件处理和截图坐标契约优化。来源、许可和采用方式见 [开源复用记录](docs/open-source-reuse.md)；代码独立实现，未增加运行依赖。原有工作区改动保留。

| 验证层次 | 结果及边界 |
| --- | --- |
| 默认回归 | 初始基线 **394/394**；最终 `npm test` **434 项：433 通过、0 失败、1 跳过**。跳过的是显式启用的真实 Chrome 写入测试，不将其计入默认通过数。 |
| CUA 取消与生命周期 | 进程 fixture 验证调用前取消不启动、调用中终止、晚到回包不恢复或重放；清理仍能结束己方会话。执行信号独立于 owner 状态，嵌套批量和排队清理互不污染。公共 ToolRuntime 取消回执为 `ABORTED`，底层驱动包装为 `CANCELLED`。使用受控子进程，未对真实桌面动作做中断实测，不能证明已投递原生动作会被撤销。 |
| 写入与真实浏览器 | 显式运行写入测试及既有浏览器边界回归，**59/59** 通过，包含 **8 个真实 Chrome 子场景**：空白/组合 Unicode、延迟值更新、应用 trim、下拉选择、应用忽略选择、输入触发 alert、只读框超时诊断及同 URL reload。只写一次，不匹配不补写；`verified` 仅证明当前字段值读回。所有页面由新 headless Chrome 和 loopback fixture 提供，无真实账户。 |
| 诊断、回验与截图边界 | 合成测试验证 fill/type/selectOption 异常不会把输入参数或 Playwright call log 作为公开诊断；回验最多600ms，超时后晚到校验不再开启读取；已有不匹配证据在期限边缘保留。桌面/浏览器附件报告尺寸变化则拒绝坐标授权；浏览器在采集、保存、点击及审批边界核对页面、URL与文档代次。尺寸转换使用合成附件元数据，本轮未对真实 DSH attachments 做重采样验收。 |
| 既有 Chrome 扩展集成 | `browser-companion-background.integration.mjs` 与 `chrome-bridge-popup.integration.mjs` **10/10** 通过。使用新建隔离 Chrome、真实 MV3/debugger/Native framing；后台指针门禁、2页登记、一次可信预览、保留2页并取消分组、原选中标签保持等回归通过。不是用户当前 Chrome 的现场验证。 |
| 静态与打包 | `npm run check`：**39 JS + 2 shell**；`git diff --check` 通过。`npm pack --dry-run --json` 确认新模块和调研文档包含在包中；本轮修改文档的22个本地链接目标均存在。未生成发布包或发布 npm。 |

本轮未主动重载实际 DSH，未重新做原生模型、真实桌面输入或用户日常 Chrome 验收；历史现场结论仍按各自日期保留。源码改动尚未提交、推送或发布。后续接手应先读取本节及复用记录，不把上游最新源码能力当作本机已安装驱动的能力。

## 2026-11-04：DSH 原生桌面后台操作与光标释放实测

本节补验上一轮尚未实测的原生桌面光标。使用安装版 DeepSeek Harness，经 dshmcp 原生模型操作已有 Calculator；没有用浏览器或 shell 代替输入，也没有批准前台重试。

| 验收项 | 真实结果与证据 |
|---|---|
| 桌面运算 | 首轮5次输入（4次AX、1次事先选定的观察坐标）完成 `9×6=54`；补测3次AX输入完成 `54−0=54`。两轮只截取本次计算器窗口，实际图像核对表达式及54；不能仅凭投递成功判定运算完成。 |
| 后台与前台样本 | 8次实际输入均返回 `delivery.mode:background`，计算器在各次前后采样中均inactive。补测将 `app_list→click→app_list` 连在同一批次，3次前后台应用比较均相同；初始化观察前后也相同。首轮有一次Chrome切至其它应用，未切到计算器，来源未确认，保留这一边界，不宣称全系统前台连续不变或所有应用均已验收。补测主回合及结束后探针期间，外部没有插入窗口读取或UI操作。 |
| 点击与空闲光标 | 两轮实际点击后，驱动 `get_session` 返回 `cursor_visible:true`；等待2000ms后为false，此时 `enabled:true`，证实空闲隐藏而非提前关闭。可见性来自驱动实际字段，不使用不存在的 `cursor.visible`，也不以截图没有箭头判断。 |
| 自然结束释放 | 补测自然结束后，下一回合只调用一次 `computer_status({scope:"control"})`。同一owner的历史释放记录：08:32:15.521Z禁用确认 `enabled:false`；08:32:15.559Z实际读取 `enabled:false`、`cursor_visible:false`；08:32:15.598Z结束确认 `active:false`。记录带来源、时间及会话绑定，未再次HMR或恢复会话。 |
| 已结束会话读取边界 | 驱动的两个实时getter在结束后仍返回 `DRIVER_EXIT`，保留为读取失败/可见性未知。上述结论来自释放时的实际读数及结束确认，不冒充结束后实时查询成功，也不宣称直接查看了桌面光标叠层像素。首轮未记录释放确认时的结束后未知结果独立保留。 |
| 护栏与回归 | 补测的窗口歧义与快照不匹配各拒绝一次，均未投递输入；模型重新观察后恢复，无前台、键盘、文本或坐标替代。**394/394** 默认回归、38 JS+2 shell语法及diff通过；新增只读状态与释放证据测试包含owner隔离、查询不复活、读取失败仍结束、Stop立即结束及健康检查不覆盖历史。 |

为完成该验收，现有 `computer_status` 增加可选 `scope:control`，只读取本owner的原生会话；默认健康诊断保留。两种诊断均不创建、恢复会话或刷新光标活动。正常清理在既有禁用动作确认后读取状态并记录历史，再执行结束；读取每项最多等待1秒，失败仍结束。Stop/取消立即结束的路径保持独立，不等待该诊断。新启动清除旧释放证据，实时错误与历史确认分别呈现，缺失回包不当作成功。

最后仅插件HMR于16:28:26完成；原Chrome705、DSH12381与用户页面保留，profile恢复原内容，常驻桌面面板关闭。热更新后的Chrome扩展重连遇到用户正在操作而中止，此后没有继续点击Chrome，Native连接尚未恢复；桥接服务仍准备就绪，后续浏览器任务前需重连。此项与桌面后台操作及驱动释放的验收分开记录。

最终证据位于本机临时目录 `dsh-desktop-release.ji3qyquv`，首轮部分通过与未知记录在 `dsh-desktop-quiet.7otvbred`；均不加入仓库。源码已本地生效，尚未提交、推送或发布。下方保留此前浏览器及其它阶段记录。

---

## 2026-11-04：当前 Chrome 后台完整任务与自动取消分组实测

用户已关闭再打开扩展并连接，四项后台能力实际一致。最终仅热重载本插件宿主，桥接于15:53:15重建；没有再次要求用户刷新扩展，没有增加权限，原 Chrome 与 DeepSeek Harness 进程保留。以下为最新结果，下方保留此前失败与中间阶段记录。

| 验收层次 | 结果与范围 |
|---|---|
| 实际 DSH 完整任务 | 经 dshmcp 驱动安装版 DSH 原生模型，主回合19次工具调用。使用 `open_link` 打开并登记说明页，列举两页、返回原表单，填写 Quiet Test、Express、从说明读取的调度码；仅一次语义按钮点击生成唯一有效预览，`browser_verify` 返回 satisfied。没有坐标、桌面点击、HTTP/shell 绕过、追加点击或显式 `browser_close`。成功后仅截取己方测试页，并等待30000ms正常结束。 |
| 独立业务与原生输入 | 本地合成站收到表单1次、说明页1次、有效预览恰1条；捕获到目标按钮的 pointerdown、mousedown、pointerup、mouseup、click，均 `isTrusted:true`。此前最小真机诊断为0事件、0预览；新版最小诊断单击和完整任务均成功，不用“投递成功”代替业务效果。 |
| 后台与自然结束 | 成功后的等待期间，两个测试标签均 `Value:off`。自然结束后两页仍保留且未选中，分组、保存的分组入口、DSH调试提示均为0，工具栏回到空闲；没有人工停止或取消分组。前台三样本中 Chrome 从 active 变为 inactive并保持；不能据此声称活动应用全程固定。页面内 focus/visibility 已模拟，不能作为操作系统前台证据。 |
| 取消自动清理 | 另建会话仅打开说明页并等待60000ms，期间由 dshmcp 取消；记录 aborted而非等待自然完成。开页前后活动应用相同、Chrome均inactive。取消后累计3个测试页面全部保留且未选中，分组、保存的分组入口和调试提示均为0；预览数仍为1，没有点扩展停止按钮兜底。 |
| 后续回合隔离 | 同一主会话下一回合仅调用一次 `browser_verify`，精确返回 `NO_BROWSER`，未重建目标；期间没有再次HMR。修复前缺失目标曾误报 `READ_FAILED`，现修正 null检查并强化原测试。 |
| 自动化回归 | **371/371** 默认回归、**10/10** 真实隔离 Chrome 集成通过；后者含原后台无rAF的9项及真实MV3扩展/Native framing/宿主桥接/controller的1项。语法37 JS+2 shell、diff检查通过。 |

本轮同时修正两个不同层次的问题：后台 Cmd/Meta 新窗口链接可能把来源标成用户活动标签，故改用已核验 href 的显式登记导航；宿主对同一控制连接的 `Input.*` 顺序等待确认，避免并行校验造成按下、抬起倒序，其它读取、会话与清理仍独立。输入失败撤销本次控制并丢弃排队输入。宿主还在既有、已登记的主页面会话初始化逻辑焦点，不新增调试会话、不前置窗口；停止、脱离或释放后不再投递等待命令，原调试连接释放时取消模拟。

修复前真实完整任务虽成功登记两页并填完字段，按钮仍无业务效果；自然结束的两页取消分组当时已通过。该失败与最小0事件诊断单独保留。联合修复后的成功不用于断言某一个改动是旧真机失败的唯一原因。

临时测试HTTP服务均已确认所属PID后停止并退出0，原Chrome/DSH及桥接保留，profile与热重载前内容一致；常驻桌面面板进程为0。虚拟光标的空闲及结束清理由驱动契约与生命周期回归覆盖，本轮纯浏览器任务不作为桌面光标直接视觉验收。新窗口链接的 `open_link` 只导航URL、不执行原链接点击脚本；当前Chrome自动文件传输、任意站点脚本弹窗、实际账户业务、跨平台及GPT同任务A/B仍不扩大宣称。

证据在本机临时目录 `dsh-verified-background.q5jbdzsq`，包含独立站点状态、过滤后的工具轨迹、正常结束/取消前后AX摘要和仅测试页的结果截图；不加入仓库。源码已本地生效，仍未提交、推送或发布。

---

## 2026-11-04：实际后台点击与取消阻塞修复

用户关闭再打开扩展后，本地与运行后台的三项原有能力已实际一致，真实 DSH 能建立后台页面；不是继续沿用前轮版本未更新的推断。实际模型成功填入姓名，但普通 Playwright 链接点击在 `visible, enabled and stable` 等待阶段超时。独立站点说明读取及预览均为0；一次旧 ref 拒绝由输入使快照失效导致，模型已自行重新观察，不计作点击超时原因。

取消该测试后，DSH 记录 user-aborted，界面上的分组和控制标记仍残留。现定位到两层阻塞：Playwright 稳定检查依赖页面 rAF；扩展全局串行等待会让未返回的 CDP 调用挡住清理。正常工具队列也不能作为取消时唯一的资源释放通道。单独点击扩展停止按钮后，实际 Chrome 的分组消失、原测试页面保留且未选中；这只证明停止按钮兜底，不冒充自动完成/取消已通过。

- **352/352** 默认回归通过，语法37 JS+2 shell及diff通过；包含持久挂起 CDP 下关闭/停止/其它 owner 不被饿死、旧端口隔离，以及真实 ToolRuntime 取消时立即关闭己方连接、最后统一清状态。
- **9/9** 独立真实 headless Chrome 回归通过，入口 `node --test tests/browser-companion-background.integration.mjs`。暂停虚拟时间可复现普通点击卡稳定性等待；修复后的 controller 产生 `isTrusted:true` 原生点击，隐藏、禁用、遮挡、身份/链接变化及无法安全验证的 iframe 均拒绝。这是隔离浏览器回归，不是用户 Chrome 实测。
- Chrome companion 指针路径保留原 ref、审批、TTL、owner/revision 和 Stop 校验，投递前验证同一目标与命中点，并间隔50ms两次宿主取样拒绝移动。Standalone 路径不改。iframe 后台指针明确不支持，屏外目标需先滚动并重新观察。
- Native RPC 改为按 id 独立响应；只有新 dispatcher 在状态及 `session.open` 回包声明 `transportConcurrency:parallel-rpc`，旧串行 worker 即使读取新版 broker 也不能伪装已更新。宿主要求该能力；关闭立即撤销本 owner CDP 客户端，取消/停止立即幂等 dispose，最终再串行 untrack/清状态，不解除 Stop。
- 已仅热重载本插件，socket 于13:55:30重建，原 Chrome/DSH 保留。新增 worker 代码仍需用户重新加载后，在实际 DSH 补验后台表单与自然 turn 结束取消分组；当前不能宣称这一轮真实完整流程已通过。

以上为当轮状态，下方保留旧阶段记录。源码仍未提交、推送或发布。

---

## 2026-11-04：保留页面并自动取消分组

用户最新要求是保留标签页、任务结束后删除分组，取代下节的折叠方案。结束、停止或主动关闭控制时，逐个核对仍登记的己方标签、原 group/window 及 generation，再执行 `tabs.ungroup`；空组随最后一个成员移出自动消失，不关闭页面或主动切换活动标签。用户自行加入组内的标签、已移到其它组的页面及其它会话的页面保持原样，因此含用户自行加入页面的非空组不会被强删。

- **339/339** 全量测试通过，37 JS + 2 shell 语法及 diff 检查通过。覆盖 active 页保留、外来/移出标签隔离、Stop 打断 close 的 get/detach/ungroup、重复清理和失败不误报成功，以及 popup 本地文件与运行后台能力的可见诊断。
- 清理返回 `groupCleanup` 摘要，失败返回固定 warning，仍撤销控制权限；宿主透传结果且不把失败报成全部取消成功。断线时明确无法确认清理结果，不创建新控制通路重试。
- 扩展握手必须声明 `releasePolicy:ungroup-preserve-tabs`；旧前置版及旧折叠版在 CDP 目标创建前均拒绝，避免误测旧版本。
- 已通过正式 watched profile 单项停用/启用热重载，确认 socket 移除并于本地 11:44:35 重建；原 Chrome 与 DSH PID 保留，未操作前台 GUI。配置保持 `desktopIndicator:false`。
- 实际 Chrome 原连接断开，已从现有扩展菜单恢复连接，未进入扩展管理页。两次真实 DSH 模型均在 4 次调用后由 `browser_open` 返回 **CHROME_EXTENSION_UPDATE_REQUIRED**，独立站点表单/说明读取与预览均为 0；第二次发生在用户确认刷新连接之后，保留此状态差异，不推断用户没有操作。
- 新 popup 的真实可见诊断确认：本地 broker 已声明 background、focusPolicy、releasePolicy 三项新版能力，运行后台三项均缺失。因此当前是本地文件已更新、后台服务仍旧版；需在扩展卡片关闭再打开并连接后继续。旧版在目标创建前被拒绝的检查已验，新版后台表单及结束取消分组仍未实际通过，不能拿组件结果代替。

源码仍未提交、推送或发布。下方各节保留历史验证及边界。

---

## 2026-11-04：后台操作与任务结束清理

本节保留当轮后台/清理验证；折叠方案已由上节取消分组取代。用户明确要求工作时不被切换到 Chrome，不显示常驻 DSH 浮层，当时选择任务完成后**自动收起分组、保留结果页面**。上一轮验证了动作与停止链路，未覆盖前台保持及结束清理，不能据其结果宣称这两项已正确。

| 验收层次 | 结果与范围 |
|---|---|
| Chrome 后台组件 | 新标签 `active:false`；根及子 CDP 会话的 activation/bringToFront 只验证所有权，不切换标签或聚焦窗口。普通 `_blank` 链接使用后台开链接手势；DOM 输入不再前置页面。扩展计数在控制结束/停止/断开时清空。 |
| 分组收尾 | 完成后对仍登记的己方分组保留页面，缩短标题并灰显；全部成员均为己方非活动页时收起。用户正在查看该组或手工加入自己的标签时保持展开，避免 Chrome 为折叠活动组而切换用户页面。旧版已经释放且未保留所有权记录的组不按标题接管。 |
| 真实宿主生命周期 | 原 `session/event(session,event)` 及 `agent/disposed({agent})` 参数正确；缺失的是资源收尾。现按 owner 串行释放浏览器、清快照、禁用光标并结束确切驱动会话，覆盖正常结束、取消、异常、Agent 释放和插件卸载。Stop/取消先立即结束驱动，再排队幂等清理；禁止结束响应触发自动复活/重放。 |
| 浮层与光标 | `desktopIndicator` 默认 false；实际 desktop profile 已改 false，保留配置备份。配置自动 HMR 后桥接重建，原 DSH/Chrome PID 保留，本机面板进程数为 0。驱动光标动作期间可见，空闲约 1 秒隐藏；任务结束显式清理，面板与光标配置解耦。 |
| 实际 DSH 清理 | 原生模型只读 Calculator：`app_list → screen_observe(ax) → screen_zoom → app_list`。下一回合仅 `computer_verify` 返回 **NO_SNAPSHOT**，期间桥接创建时间未变，没有再次 HMR，证实前轮结束清空快照。Calculator 前后均未成为活动应用；前后活动应用不同、来源未决，不能将此运行记为“全程前台不变”。没有精确驱动 session ID，不全局枚举或匹配结束其它会话；光标关闭本身以组件测试和驱动契约为证据。 |
| 自动化回归 | **324/324** 通过。包含真实 Cordis/ToolRuntime 事件与受控驱动子进程的多 owner 隔离、后续回合重新初始化、取消在途动作立即撤销及最终清理、旧 Stop 锁定、完整 broker/Playwright 链路。未声明后台能力的旧扩展在暴露 CDP 端点或创建标签前被拒绝并释放空会话，防止升级期间继续前置页面。语法 **37 JS + 2 shell**、diff 检查通过。 |

后台组件测试不等于当前 Chrome 已刷新到新扩展代码。实际 Chrome 的本轮后台跨标签/表单及结束折叠验收仍需用户刷新扩展后执行；不得沿用上一轮前置模式的成功轨迹冒充本轮验证。任意网站脚本 `window.open` 仍由 Chrome 原生行为决定，插件不改写站点脚本或恢复用户旧焦点，不能把“插件不主动激活”扩大为任意站点都不会弹窗。

本轮源码仍未提交、推送或发布；实现与配置以仓库及当前 profile 为准。

---

## 2026-11-04：当前 Chrome 可见分组与桌面控制提示

本节保留当轮现场结论；默认前置与常驻提示已由上方后台清理修复替代。使用用户正在运行的 DeepSeek Harness、`desktop` profile 与原有 Chrome；经用户明确授权安装本机桥接和扩展，并只热重载插件，未重启整个宿主。源码为本地未提交改动，未推送、发布。

| 验收层次 | 结果与范围 |
|---|---|
| 真实宿主与可见 Chrome | 由 dshmcp 创建隔离测试会话并驱动真实模型；在当前 Chrome 创建紫色专属分组，DOM 观察、跨标签读取、选择 Express、填入测试姓名及调度码、生成预览和结果断言完成。Chrome 界面可见调试提示、对应标签及工具栏控制入口；最终分组标题为 `DSH · 浏览器操作`。未接管已有业务标签。 |
| 独立表单结果 | 本机合成测试站只收到 **1 条有效预览**，姓名、服务、调度码均匹配；不涉及真实业务提交。服务端确认该 POST 携带测试 profile 的合成会话，`profileReused=true`。首次表单 GET 的会话标记仍为 false，保留这一差异；不据此宣称全部网站均可免登录或全部导航均已验证。没有读取、导出 Cookie 值或真实账户凭据。 |
| 浏览器停止与清理 | 在扩展真实按钮停止后，等待被取消，后续观察返回 `CONTROL_STOPPED`，原页面保留。最终版本在同一会话明确停止后，再次验证观察被拒绝、`browser_close` 成功释放且保留 Chrome 和标签。停止为终止本次任务；新任务使用新 DSH 会话，popup 不再提供无法恢复原会话的“恢复”按钮。 |
| 原生桌面 | 真实模型操作 Calculator 得到 **8×9=72**。目标窗口附近显示本机 DSH 状态面板与停止按钮，并可见虚拟光标；另一个会话点击面板停止后，中止等待并拒绝后续观察。此面板是插件自己的提示，不冒充 macOS 系统屏幕共享菜单。 |
| 回归与包装 | **306/306** 测试通过；语法检查覆盖 **37 个 JavaScript 文件及 2 个 shell 脚本**，diff 检查通过。随后停止提示文案调整的 9 项定向测试通过。打包预演 **60 个白名单文件**，包含扩展、本机桥接和 Swift 面板源码，不包含本机验收数据或凭据。 |

真实 Chrome 集成曾暴露 service worker 顶层 await 无法启动、虚拟 context 缺标识导致 Playwright 新标签失败、popup 轮询替换停止按钮，以及停止后的清理被第二道 guard 拒绝；均已修复并加入对应回归。保留先前失败记录，不将它们计作成功运行。当前 profile 显式采用 `chrome-extension`；通用代码默认仍为 `playwright`，保留原有使用方式。

此模式的自动上传、下载接口明确返回不支持；普通网站下载仍由用户 Chrome 自身处理。实际账户业务、跨站登录变体、Windows/Linux 桌面、GPT 同任务 A/B 和总体任务成功率仍未验收。CUA 健康诊断仍有 bundle identity 的 degraded 项；本机 AX、实际截图及桌面操作通过，不把诊断结果表述为全面正常。

现场证据保存在本机临时验收目录，包含独立服务端结果、过滤后的原生工具轨迹和控制面板截图；未把用户 Chrome 截图或原始会话日志加入仓库。收尾已关闭临时 HTTP 服务及控制器自己的准备标签，保留 DSH 测试分组供查看；原 Chrome、DSH 进程和本机桥接连接保留。

---

## 2026-11-03 第四轮：真人审批、公开真实网站与长等待修复

本节保留当轮验收结论。原用户 DSH 在该轮未重载或重启；验收时源码尚未提交、推送或发布。

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
