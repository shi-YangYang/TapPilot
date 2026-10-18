# 多 App 执行器测试

最新实际运行结果见 [2026-10-18 真实 App 与真实模型验证](real-app-validation-2026-10-18.md)，包含失败和准备受阻记录。

这组测试用不同真实 App 的局部流程检查共同执行器和真实模型决策，补充[拼多多搜索测试](real-app-testing.md)。固定流程和选择器属于测试代码，生产手机执行器、桌面 PhoneClient 和 MCP ToolController 没有为这些测试任务增加包名适配分支。测试通过只说明记录的版本、设备和流程得到验证，不代表整个 App 或所有 App 都可操作。

## 安装与准备

测试使用独立模拟器 `emulator-5580`，Android 14 / API 34 / arm64。下面三个 APK 是历史首次安装记录，来自官方或官方认可的发布渠道，通过 APK 签名检查；每次新运行的版本与包名仍从实际安装包读取。

| App | 版本 / versionCode | 来源 | 历史 APK 路径 |
| --- | --- | --- | --- |
| AntennaPod | 3.12.3 / 3120395 | [F-Droid](https://f-droid.org/en/packages/de.danoeh.antennapod/)，[官方认可的发布渠道](https://antennapod.org/download/) | `/tmp/tappilot-apps/antennapod.apk` |
| Wikipedia | 50611-r-2026-10-07 / 50611 | [Wikimedia 官方 stable 发布](https://releases.wikimedia.org/mobile/android/wikipedia/stable/wikipedia-50611-r-2026-10-07.apk) | `/tmp/tappilot-apps/wikipedia.apk` |
| Markor | 2.16.1 / 163 | [官方 GitHub release](https://github.com/gsantner/markor/releases/tag/v2.16.1) | `/tmp/tappilot-apps/markor.apk` |

下载记录位于本机 `/tmp/tappilot-apps/sources.json`，包括来源、包名、启动组件、SDK、SHA256 与签名证书指纹。对应历史文件 SHA256 为：

```text
AntennaPod  6e79f28f69cef1a8b2e4f5f88c9c3cf3c3d7c51356f01394ac23b0dc5d56a00b
Wikipedia  bb95806f913f6b377c9453e92d4345006a9dff6a051b9380c46cf2f9d7fa4a19
Markor     e88cdcced7aa3dca25e6b9c7a9bdcfad3e3988ee545be951f42bf9441b5e46bf
```

Markor 的文件哈希还与官方 release asset 公布值一致。其他两项记录的是实际下载文件哈希，不声称与发布方另行公布的校验值比对过。

安装 TapPilot debug APK、`testbed-debug.apk`、`testbed-debug-androidTest.apk`，通过正常系统界面开启无障碍服务并允许控制。构建和安装路径见 [testbed README](../android/testbed/README.md)。各 App 的首次引导、通知提示和必要授权也通过正常 UI 完成，不使用 ADB 修改授权状态或跳过系统保护。

- AntennaPod：完成初始提示，回到主页面；本用例不需要账号、订阅、播放或下载。
- Wikipedia：完成首次引导，回到主页面。当前在线百科内容请求可能超时，因此本轮只验证本地设置中的 App theme 面板。网络错误不算搜索或文章阅读通过。
- Markor：通过 App 的正常流程完成存储位置和系统存储授权，回到主页面。QuickNote 是专用模拟器中的测试便签，允许覆盖其内容，不使用个人笔记。

本轮另安装了四个真实 App，分别属于工具、媒体和文件管理类别。准备阶段与模型验收分开记录：

| App | 包名 | 当前测试入口 / 准备范围 |
| --- | --- | --- |
| Fossify Clock | `org.fossify.clock` | `clock-stopwatch`，秒表保持未启动；运行前回到其他页签，避免初态已满足 |
| Fossify Calculator | `org.fossify.math` | `calculator-product`，模型实际输入 12 × 13；运行前清空旧结果，避免残留 156 假通过 |
| NewPipe | `org.schabi.newpipe` | 本轮准备阶段受阻，未进入真实模型验收，不计为模型成功 |
| Fossify File Manager | `org.fossify.filemanager` | 本轮准备阶段受阻，未进入真实模型验收，不计为模型成功 |

安装和白名单只是测试准备，不说明 App 能稳定返回 UI 或完成任务。NewPipe 尚未跑通不能记为媒体页面覆盖；这些原生用例也不证明动态视频页面的视觉兜底可用。

固定选择器记录自测试时的英文 UI；切换语言或升级 App 后，需要先核对测试预期，不能直接把选择器不匹配算作执行器故障。测试期间不要手动操作模拟器，也不要并行启动另一条设备测试。脚本检查 `emulator-*`、`ro.kernel.qemu=1` 并持有共享设备锁。

## 真实 App 用例

| Case ID | 不依赖模型的流程 | 真实模型的目标 | 终态独立证据 |
| --- | --- | --- | --- |
| `clock-stopwatch` | 打开 Stopwatch 页签，不启动计时 | 自主打开秒表并读取当前值 | 选中的秒表页签、未开始的 0.0、播放控件 |
| `calculator-product` | 没有注册确定性步骤，仅模型用例 | 实际操作计算器计算 12 × 13 | 原生结果控件显示 156，计算器等号键存在 |
| `antennapod-playback` | More → Settings → Playback → 滚动 → Smart mark as played 对话框 | 自主找到同一对话框，读取后保持打开 | 对话框标题、选中的 30 seconds、Cancel 按钮 |
| `wikipedia-theme` | More → Settings → App theme | 自主打开面板，只读取选项 | 字号 100% (Default)、阅读专注关闭、跟随系统主题开启 |
| `markor-quicknote` | QuickNote → 写入不同初值 → 中文输入 → View Mode → Edit Mode | 写入另一段公开中文测试文字，核对后停在编辑页 | 对应测试文本位于可编辑控件，且出现 View Mode 入口 |
| `markor-local-search` | QuickNote → 设置合成便签 → 局部搜索无匹配 → 搜索一个匹配 → 关闭搜索栏 | 设置合成便签并搜索一个匹配，保持搜索栏打开 | 确定性流程逐步核对匹配数，末尾确认搜索栏消失且便签未变；模型终态核对查询、一个匹配及便签值 |

Markor 的确定性测试先写 `TapPilot 测试准备`，再要求发生变化并写入 `TapPilot 通用执行器测试`，避免上一轮残留相同文字让输入步骤假通过。预览阶段另验 `Edit Mode` 和便签正文，返回编辑后再次验证输入值和模式。模型任务只要求输入 `TapPilot 真实模型中文测试` 并停在编辑页；它的通过结果不能用于证明执行过预览往返。

`markor-local-search` 单独覆盖同一 App 的另一类场景：搜索值已读回时，匹配计数仍可能处于旧值，因此用结果条件等待 `1/1`，再由独立 UI Automator 核对。关闭步骤要求搜索栏原本存在，并用明确的 `minCount:0,maxCount:0` 检查它已经消失，不能仅凭底下编辑器仍存在就宣布关闭成功。模型任务以搜索结果为终态，不把最后关闭的确定性覆盖计入模型覆盖。

## 执行命令

以下命令均在仓库根目录运行。`clock-stopwatch`、`antennapod-playback`、`wikipedia-theme`、`markor-quicknote` 和 `markor-local-search` 已注册确定性步骤，可运行下方三种入口。`calculator-product` 只运行最后一条真实模型命令，不传给 `multi-app-executor.mjs`；NewPipe 和 File Manager 尚没有可验收的固定模型用例。

真实模型脚本读取 `server/dist`，修改运行时代码后先运行一次 `npm --prefix server run build`。仅运行已有构建对应的用例不需要再次构建。

```bash
case_id=antennapod-playback

node scripts/multi-app-executor.mjs \
  --serial emulator-5580 \
  --case "$case_id" \
  --entry desktop \
  --decision-delay-ms 0 \
  --output "/tmp/tappilot-${case_id}-desktop.json"

node scripts/multi-app-executor.mjs \
  --serial emulator-5580 \
  --case "$case_id" \
  --entry mcp \
  --decision-delay-ms 3000 \
  --output "/tmp/tappilot-${case_id}-mcp-delay.json"

desktop/node_modules/.bin/electron \
  desktop/scripts/evaluate-real-app-saved-model.mjs \
  --use-saved-model \
  --serial emulator-5580 \
  --case "$case_id" \
  --output "/tmp/tappilot-${case_id}-model.json"
```

桌面入口使用生产 PhoneClient，MCP 入口使用生产 ToolController；模型通过生产 `runAgent` 自主选择工具。测试用例的 `steps`、独立 oracle 和 `visibleNavigationTargets` 只用于 host 验证，不作为模型的动作路线或提示。模型使用生产 `finish_task` 或正常最终回答收尾，测试不增加专用结束工具，也不在检测到目标时自动中止模型。模型命令读取电脑端已保存配置，不把密钥或 API 地址写入脚本、命令行或报告。模型测试会产生正常 API 调用费用。

模型工具当前开放指定 App 内的原生点按、输入、滚动、滑动、返回和 `navigate_until`，运行时显式开启 `allowBatchedNavigation`。连续导航保持生产控制器逐步检查 App / 窗口范围的行为，越界后不再发送后续步骤；模型结束后仍独立检查终态。报告的 `toolScope.nativeBatchedNavigation: true` 只表示已开放工具，实际覆盖还须看到 `steps` 中的 `navigate_until` 请求和 `navigation.completedSteps` / `stopReason`。此前未开放该工具的报告不能作为连续导航验证。`tap_visual`、`swipe_visual` 仍未开放，本通道通过不等于视觉操作或动态视频页面已经通过。

启动只使用允许的 App 组件，通过 `am start -S -W` 建立起点，再由生产客户端确认前台 App。没有 ADB 坐标点击；每个动作都从实际 UI 定位、经过手机端校验、执行并返回观察。`decision-delay-ms=3000` 在选中控件后等待，模拟模型思考期间 UI 变化。失败不自动重放动作。

## 如何判断通过

确定性流程每一步完成后运行独立 AndroidX UI Automator 只读观察器，检查目标 App、可见控件及该步骤的精确属性。下一步重新读取生产 UI，避免独立观察器的生命周期造成测试自身的旧引用。滚动要求新目标在滚动前尚未满足；输入除了文本相等，还要求生产观察 `showingHintText:false`。独立观察器排除 EditText 的 text 与 hint 相同的情况，不把提示文字当作已输入值。

最终还要重新采样终态，不能拿早先某一步成功的缓存作为任务完成证据。真实模型用例只有同时满足下面三层条件，且没有运行错误，才输出 `status: success`：

1. **生产任务完成。** `runtimeStatus: completed`；`finish_task` 或普通最终回答正常收尾，保留对应的生产校验和最后一次界面连续性检查，测试没有提前 abort。
2. **独立终态正确。** 等手机调用结束后，由 AndroidX UIAutomator 独立读取并满足全部断言，`completionVerified: true`。运行时完成不代替业务终态验证。
3. **行为符合要求。** host 旁路记录 `behavior.status: passed`。固定导航目标已经可见时，`swipeRequestsWhileTargetVisible` 必须为 0；完整目标首次满足后，`modelToolCallsAfterGoal` 必须为 0。生产运行时的最后一次界面检查由 `hostCompletionReadsAfterGoal` 单列，不计为模型额外调用。

检测器只消费观察，不改变工具返回、不向模型透露判定、不替模型停止。被拒绝的滚动 / 滑动 / `navigate_until` 请求同样算请求；不能因为未派发或后来到达目标就抹去行为失败。局部目标如打开便签入口不等于任务完成，必须同时满足正文、查询和匹配数等本用例全部条件。

`goalStopStatus` / `visibleTargetStatus` 的 `not_evaluated` 表示没有对应判定，不等于通过；`not_observed` 表示生产观察未取得完整终态。`MODEL_BEHAVIOR_FAILED` 与执行器错误、准备阻塞、独立终态未验证分开报告。目标可见判定只覆盖用例登记的导航目标，不声称识别所有 App 的任意目标。

Markor `markor-quicknote` 模型用例只覆盖中文输入终态，预览往返属于确定性流程；`markor-local-search` 另外覆盖搜索结果。单纯 `accepted:true`、停留在旧页面或只有模型声称完成都不足以证明要求的结果。

连续导航步骤仅保留有界的 `completedSteps`、枚举 `stopReason`、`targetFound` 和可选 `uncertainStep`，不保存目标选择器、候选节点 ID 或原始错误文本。`max_steps`、`scope_changed` 或页面变化不代表任务完成。

报告只保留固定步骤名、错误码、耗时、节点数量和断言布尔值/计数，不记录完整 UI 树、截图、个人文件、模型提示词/回答、密钥、密码或验证码。测试使用的公开标记定义在代码中；App 可能在模拟器内保留测试便签，报告不导出其他文件内容。

## 历史发现的共同问题

以下修复和成绩保留当时的范围与失败记录。历史模型报告未按上面的生产结束链路和行为指标重评，不能直接算作本轮验收通过。

Markor 首次引导中，背景 ViewPager 的矩形覆盖底部 Next 按钮，原有几何重叠判断把实际可点击的前景按钮误拒。修复使用手机端私有的 native path 和 `drawingOrder`，仅在证明来自同一原生无障碍父节点、背景顺序严格低于目标分支时，排除无文字、不可点击、不可编辑且不受保护的被动滚动容器。它不是 Markor 专用规则。

不能用裁剪后 JSON 的 `parentId` 代替原生父级证据。顺序为 0、缺失、相等、不同父节点或处于前景时仍保持拒绝；容器的重叠子控件继续分别检查，敏感控件和可点击遮挡不会被忽略。原生 fingerprint 包含绘制顺序，层级变化不能伪装成允许忽略的标签变化。跨窗口遮挡校验保持不变。

对应夹具使用真实 ScrollView 和浮动 Button，分别验证背景可点、原生 ACTION_CLICK 及前景遮挡拒绝。前景负例显式设置真实 elevation；仅改变插入顺序不能证明覆盖关系，因为系统按钮主题也可能提供 elevation。

## 验证记录

已完成的定向检查：25 项执行器脚本测试、57 项 NodeActionGuard 测试、8 项模型脚本测试；Android APK 和测试 APK 构建通过。只验证相关模块，不把这些数量当作真实 App 流程的通过数量。

| 真实流程 | 桌面 / 延迟 0ms | MCP / 延迟 3000ms | 保存的真实模型 |
| --- | --- | --- | --- |
| AntennaPod / `antennapod-playback` | 通过，5 次动作，8.7 秒 | 通过，5 次动作，23.7 秒 | 通过，7 次请求，34.7 秒；1 次执行前拒绝 |
| Wikipedia / `wikipedia-theme` | 通过，3 次动作，9.3 秒 | 通过，3 次动作，18.9 秒 | 通过，5 次请求，30.3 秒；无工具失败 |
| Markor / `markor-quicknote` | 通过，5 次动作，7.4 秒 | 通过，5 次动作，22.4 秒 | 通过，4 次请求，18.4 秒；1 次执行前拒绝 |

确定性流程合计 **6/6 通过、26 次动作、0 次动作重放**，每步和最终独立检查均通过。三个真实模型任务的终态也均验证通过，但不等于过程零错误：AntennaPod 有一次 `NOT_SCROLLABLE`，所选节点的 `scrollable` 为 false；Markor 有一次 `TARGET_CHANGED / TARGET_IDENTITY_CHANGED`。两次均为 `not_sent`，随后模型使用新观察完成任务，没有把拒绝算成已经执行。不能为了消除这些错误码而放宽目标校验。

表中的确定性耗时包含逐步独立检查，MCP 还包含每步人为等待 3 秒；模型耗时为 runtime 记录，不含启动与末尾独立检查。因此这些单次结果只用于功能验收，不能直接比较入口速度或估算成功率。

原生层级回归在两个入口共验证 **6/6 契约**：4 次背景容器场景实际点击成功，2 次前景遮挡拒绝且点击计数为 0。第一次前景负例由于 Button 默认 elevation 高于覆盖层，夹具并未真正遮挡按钮；这两个失败记录保留，修正夹具后只重跑两条负例，没有为满足测试而放宽生产校验。

本机完整结果与来源记录保存在 [`multi-app-validation.json`](../android/testbed/build/reports/multi-app-validation.json)，属于忽略的构建产物。Wikipedia 在线请求仍因连接超时而阻塞，文章阅读和在线搜索不算通过；本次没有重测物理手机。这一轮证明三个不同 App 的这些局部流程复用了同一执行器，不能据此保证任意 App、页面或模型调用均成功。

## 同窗口动作后过渡：后续定位与修复

对上述两次模型拒绝进一步做无模型时序对照，确认手机端存在过早返回：`ActionObservationWaiter` 只要求可读，而 `WindowReadinessWaiter` 对已经见过的窗口直接使用 `known_window`。同 Activity 内切换标签页或加载列表不会改变窗口 ID，因此过渡帧也被标为 ready。目标定位校验拒绝旧目标是正确保护，但提供给模型的上一帧就绪状态不准确。

| 相同操作，默认 waitMs，不传 waitFor | 修复前第一次动作返回 | 修复后第一次动作返回 |
| --- | --- | --- |
| AntennaPod 打开 Playback | 412ms，7 节点，无可滚动列表；下一次读取才出现 | 991ms，37 节点，列表可滚动；6 次稳定采样 |
| Markor 打开 QuickNote | 412ms，15 节点，仍含旧入口且无编辑器；约半秒后才出现 | 1124ms，29 节点，已含编辑器；6 次稳定采样 |

修复在原生派发前撤销旧窗口的 ready，手势完成或取消时再次撤销；普通只读请求仍保留已就绪窗口的一次新读快路径。默认动作在一次共享预算内重新取得至少跨越 240ms 的匹配采样，最多 2500ms。旧代次的并发采样不能重新发布 ready；未真正尝试派发的预检拒绝不触发失效。持续刷新集合内部的行不阻塞外围结构稳定，完整目标/上下文校验保持不变。没有 App 包名分支或模型提示修改。

`waitMs:0` 不再把立即读取当作新的稳定证据；没有其他已完成的稳定采样时返回 settling。原有 armed 反例脚本因此改为先取得 ready 的准备快照，同时仍检查夹具变化尚未发生；若准备过慢则明确失败，不能用已变化的新快照冒充旧目标。

修复后真实模型复测结果：

| 任务 | 模型请求 | 运行耗时 | 工具失败 | 独立终态 |
| --- | --- | --- | --- | --- |
| AntennaPod | 7 → 6 | 34.7 → 27.9 秒 | 1 → 0 | 通过 |
| Markor | 4 → 3 | 18.4 → 24.4 秒 | 1 → 0 | 通过 |

Markor 模型复测前将专用测试便签设为不同初值，防止已有目标文字造成假通过。准备中的一次 Save 请求被 `NODE_NOT_ACTIONABLE` 拒绝，刷新观察确认按钮可用后保存成功；该次原因未归类，未计入模型运行，也不据此声称所有拒绝都已解决。模型耗时受服务响应波动影响：本轮少一次调用不代表每次都更快。

新增回归为五种同窗口场景 × 桌面/MCP，共 **10/10**：多阶段编辑器、延迟可滚列表、加载后持续刷新、永久变化超时、无变化动作。只检查首次动作返回，动作后零补读、零重放；超时场景约 2500ms 返回 settling。另有 **2/2** 中文输入验证、**4/4** 旧目标重绑定/上下文变化兼容用例、**53** 项相关 Android 单元测试及 **9** 项模型诊断脚本测试通过。运行入口见 [testbed README](../android/testbed/README.md) 的动作后稳定性部分。

新报告 [`post-action-readiness-validation.json`](../android/testbed/build/reports/post-action-readiness-validation.json) 保留前后结果、时序和失败记录。旧模型日志未校验请求快照与目标属性的归属，不能完整还原当时模型选中的具体节点；新的诊断只在快照匹配时记录目标类别，并记录就绪状态和可操作控件数量，不保存界面文字。当前证据证明上述过早就绪行为已修复，仍不能保证后续异步业务数据永不变化；明确的业务目标继续用 selector 或结果断言验证。

## 按行为划分的覆盖与边界

以下区分已存在的回归场景、实际运行报告和未验证的边界。历史报告只证明记录的代码、设备与运行，不代表本轮重新执行了全部场景；生成器能生成某种配置也不等于该配置已经通过。三个真实 App 提供了不同控件的局部样本，不等于覆盖三个完整 App。

| 行为 | 已有场景与运行证据 | 尚未证明的边界 |
| --- | --- | --- |
| 冷启动与加载 | `startup-scenarios.json` 覆盖空白、进入动画、延迟控件、持续刷新及永久空白；[`cold-start-validation.json`](../android/testbed/build/reports/cold-start-validation.json) 记录运行。持续刷新项为安全拒绝契约通过，永久空白为超时后不派发，不算业务成功。 | 无明显加载信号、先稳定超过采样窗口再继续加载的页面；超出等待预算的业务加载。Wikipedia 在线搜索和文章仍因网络超时未验证。 |
| 同窗口动作后过渡 | `action-readiness-scenarios.json` 验证默认动作首次返回即包含最终编辑器或可滚列表，以及永久变化和 no-op；`post-action-readiness-validation.json` 同时记录真实页面前后对照。 | 当前正常加载夹具各阶段间隔小于稳定窗口；不能据此预测长静默间隔后的异步内容。明确业务目标仍需结果条件。 |
| 持续刷新与事件噪声 | `native_refresh`、`native_reorder_refresh`、`semantic_event_noise`、`semantic_large_noise`、`action_refreshing_collection` 有报告验证；[`executor-comparison.json`](../android/testbed/build/reports/executor-comparison.json) 保存成熟工具对照。 | 任意动态表单不能自动忽略变化；未声明的上下文变化仍拒绝。集合噪声通过不等于收件人、金额等上下文变化可放行。 |
| 列表重排、重建与复用 | `native_rebind`、`native_reorder` 验证唯一目标重绑定；`native_replaced` 验证身份替换时拒绝。原生夹具使用真实 ListView。 | 当前 adapter 新建行 View，尚无实际 RecyclerView 同一 View 被复用为另一业务项的验证；分页、插入和删除与滚动组合也不能据此算通过。 |
| 重复标签 | `native_ambiguous` 在独立观察到重复身份时安全拒绝，点击计数为零。 | 拒绝歧义是负例保护；“相同按钮文字、不同卡片上下文”成功定位的正例仍需专门验证。 |
| 键盘与遮挡 | 历史 `ime`、`overlay` 与 `native_overlay` 记录输入及遮挡；本轮背景/前景 ScrollView 回归验证了同原生父级绘制顺序规则。 | 未系统覆盖键盘打开/关闭、窗口缩放、弹层与列表加载叠加；背景容器可忽略的证据不能推广到系统弹窗、敏感区域或任意透明覆盖层。 |
| 无变化、延迟与输入结果 | `semantic_noop`、`reliability_noop` 区分接受与可见效果；延迟/静默输入、转换输入有对照报告；Markor 验证异值输入及 hint 排除。 | 延迟输入对照使用显式 `waitFor`，不能代替默认等待的证据；异步业务无可见反馈时的完成判定和重复提交防护尚无完整链路验证。 |
| 窗口与 App 切换 | `semantic_window` 验证真实 Dialog 的窗口变化；真实 App 各自通过前台包名与终态检查。新增 `late-transition-readiness-scenarios.json` 验证同一窗口先稳定、再延迟变更的三种情况，详见下节结果。 | 当前模型用例限制在指定单包，未证明 App A → B → A 的恢复链路。不会将同窗口延迟变化测试当作跨 App 测试。 |

上述 semantic、IME 和遮挡的部分证据来自本机 `/tmp/tappilot-semantic-final.json`、`/tmp/tappilot-testbed-baseline.json`、`/tmp/tappilot-native-contract-regression.json`，属于历史运行产物，可能随临时目录清理而消失。场景定义和执行入口保存在 [testbed README](../android/testbed/README.md)，复现时应生成新的报告。所有真实 App 结果目前仍限于 Android 14 / API 34 模拟器；没有据此验证其他系统版本或厂商真机。

## 通用链路的分层准入

新问题按行为归类后依次验证，不因换了 App 就直接加入包名补丁：

1. **原生场景判因。** 用最小真实控件夹具复现，记录目标身份、派发与独立业务计数，区分观察过早、定位错误、执行未接受和结果未确认。正例要求正确目标实际执行一次；身份不明或遮挡负例要求零派发。动作后过渡必须检查首次返回，不能补读后把第一次错误掩盖。
2. **真实 App 确定性迁移。** 选相同行为的实际控件，使用桌面和 MCP 共用执行器，加入决策延迟并逐步检查 UI Automator oracle。初态须与目标终态不同，最终再次独立观察；网络、权限和准备失败单列，不归入执行器通过。
3. **真实模型任务。** 使用保存的模型自主调用工具，独立验证完整目标。模型声明、工具接受和业务完成分别记录；仅输入完成不能算预览、搜索或整条流程完成。单次通过只算功能样本，不推算成功率。

报告分别统计：实际派发次数及误点数、模型声称完成但 oracle 不满足的假成功数、执行前拒绝、结果未确认、环境阻塞和动作重放。安全拒绝符合负例契约时可算该契约通过，不能混入业务成功；最终成功也不抹去中途拒绝。缺少独立证据时保留未知，不按猜测归因。

优先补齐有风险的组合：复用行与重复标签的正反例；键盘 → 输入 → 同窗口加载 → 刷新列表 → 弹层的连续链路；长静默加载与已知窗口外部变化。随后再验证 App 间往返。每个新增组合先通过原生判因和真实 App 确定性检查，再投入模型测试；不要求每次修改重跑全部历史用例。

## 后续通用性验证：外部变化与局部证据

这轮发现 `known_window` 只记窗口 ID、不比较新结构的通用缺陷。原生按钮先安排 1400ms 后更新，首次动作回包确实已 ready，独立 oracle 确认异步更新尚未开始。等 oracle 确认更新开始后只读取一次：修复前 76ms 返回 `known_window`，最终编辑器不存在，oracle 也未完成；修复后约 0.9 秒返回最终编辑器。加载后编辑器及永不稳定两个场景也分别验证，三场景 × 两入口 **6/6** 符合契约。永久变化约 2500ms 返回 settling，不算业务完成。

手机现在在原生 capture 顺序中绑定交互签名，内容变化撤销原稳定代次；旧 worker 不得确认新代次。复核同时发现，直接以全页签名阻止动作会使已有 `allowedLabelChanges` 退化。新增回归先得到 ready 表单，再启动每 80ms 更新的无关状态文字：第一版修复确实误拒，记录保留。最终修复让严格校验通过的显式标签声明仅继承一次目标操作证据；它与全页稳定代次分开，不伪造 ready，也不跨越新派发、窗口或结构变更。三种情况 × 两入口 **6/6**：仅声明状态的正例实际点击一次；未声明或收件人同时变化的四条负例均零派发。正例全页仍 settling，执行结果 unverified，与独立 oracle 的业务完成事实分别记录。

两次修复过程中还检查唯一目标重绑定/上下文变化 **4/4**、集合持续刷新 **2/2**；最后的授权证据调整后，仅复跑直接受影响的延迟变更和集合刷新各一条，均通过。最终相关 Android 单测为 **49/49**，真实 App 脚本检查 **11/11**，模型诊断脚本检查 **11/11**。APK 已安装至测试模拟器，没有更新物理手机。

真实 App 的本轮确定性检查如下；没有新增包名分支到生产执行器：

| 流程 | 入口 / 决策延迟 | 结果 |
| --- | --- | --- |
| AntennaPod / Playback | 桌面 / 0ms | 5 次动作，9.5 秒；每步与终态独立检查通过 |
| Wikipedia / App theme | 桌面 / 0ms | 3 次动作，10.3 秒；每步与终态独立检查通过 |
| Markor / 局部搜索往返 | 桌面 / 0ms | 6 次动作，12.5 秒；包含无匹配、一个匹配、关闭栏的消失断言 |
| Markor / 局部搜索往返 | MCP / 3000ms | 6 次动作，29.6 秒；相同断言通过 |

四条合计 20 次动作、无动作重放，不能据此推算总体成功率。Markor 局部搜索的真实模型终态也验证通过，用了 8 次请求、55.9 秒；过程仍有两次 `PAGE_CONTEXT_CHANGED / not_sent`，分别记录为外围状态变化和外围混合变化，目标本身匹配。旧诊断不能还原它们对应的具体按钮，因此没有归因为 Save 或 Search，也没有宣称修好这两次拒绝。新增诊断只记录固定公共控件角色及变化属性名，不存界面值；一次同值输入后等待 9 秒再打开搜索的确定性探针未复现，不能据此否定原失败。真实流程在外部变化修复后执行，后续显式标签兼容调整没有重复整套真实流程；该窄路径由独立原生正反例和单元测试验证。

本轮完整证据与中间失败保存在 [`generalization-validation.json`](../android/testbed/build/reports/generalization-validation.json)。现阶段通用链路仍需改进的重点是无关外围控件状态引起的保守拒绝，以及表中未覆盖的组合场景；有限的稳定采样无法预知未来网络返回。结果条件、目标校验和拒绝原因必须继续分别保留。

## 输入后过早返回的定向排查

针对上面真实模型的两次拒绝，先增加只含固定控件角色和变化字段的诊断。第一轮模型重跑终态通过、6 次请求且无工具失败，但走了文件列表打开便签的新窗口路径（编辑器 22 节点），与原 QuickNote 页签路径（29 节点）不同，不能据此宣称原问题消失。

随后使用 `scripts/markor-input-settling-eval.mjs` 固定走实际 QuickNote 页签，测量异值正文输入后点 Search、异值查询输入后点 Close。两者均保留输入回包，等待 3 秒模拟决策耗时，中途不读取界面、不重放动作。旧执行器的查询流程复现 `TARGET_CHANGED / PAGE_CONTEXT_CHANGED / not_sent`：`close_search` 自身匹配，只有 `search_result` 的 `text` 和 `bounds` 改变。输入回包过早，目标定位未发现错误。正文流程这次未复现，历史那次外围状态拒绝仍缺精确控件归属，不能把候选解释写成确定归因。

官方 Markor v2.16.1 在 [正文变化后防抖 500ms](https://github.com/gsantner/markor/blob/v2.16.1/app/src/main/java/net/gsantner/markor/activity/DocumentEditAndViewFragment.java#L206-L210) 才更新 Save/Undo/Redo 状态；[查询变化后防抖 800ms](https://github.com/gsantner/markor/blob/v2.16.1/app/src/main/java/net/gsantner/markor/frontend/textsearch/TextSearchFragment.java#L122-L141) 才更新搜索结果。查询的搜索与结果回调是同步调用，没有第二层 800ms 搜索 worker。旧查询输入 RPC 总耗时 1820ms 仍出现过早观察；总耗时不等于 App 派发后的等待，也没有记录每个节点采集及 App 回调的时间，不能据此另行断言是缓存或双层延迟。

修复位于手机执行器：仅 `input_text && waitMs>0` 增加从派发完成起 1000ms 的最早就绪时间，期间持续采样，最后的交互结构仍需稳定 240ms。已知窗口和已匹配 selector 不得提前跳过；原 2500ms 稳定预算与 9 秒操作期限保持不变。未放宽 Guard，没有修改模型策略，也没有新增 App 包名分支。普通点击、滑动和零等待不增加该输入窗口。代价是静态输入也会多等待，原生成功用例的完整输入调用约 1.3–1.5 秒；这不是对任意未来业务更新的保证。

验证分开记录真实成功、安全拒绝和准备失败：

- 新增原生 500ms 按钮状态、800ms 结果文字/几何、80ms 持续刷新三场景。旧版确实复现前两种过早返回及随后的拒绝；首轮按钮场景受首次布局影响，输入未派发，保留为准备干扰。仅修正夹具启动准备后重跑该例，实际复现输入过早返回。副作用计时始终从真实 TextWatcher 开始。
- 修复后三场景 × 桌面/MCP **6/6** 符合契约：四条成功流程输入一次、正确点击一次；两条持续刷新约 2500ms 后 settling/unverified，随后零派发、零误点。没有用补读修复首次回包。
- 零等待双入口 **2/2**：一次即时捕获，settling/unverified，无后续点击。
- 真实 Markor 两段流程 **2/2**，各保留回包 3 秒再点按，测量动作零重放、零工具失败；独立 UI Automator 验证合成正文、搜索栏关闭和编辑模式。
- 修复后真实模型走原 QuickNote 页签路径（29 节点编辑器、42 节点搜索栏），**6 次请求、0 次工具失败**；独立观察确认目标正文、查询词和一个匹配均满足。与原 8 次请求、2 次拒绝相比，这次无需失败后补读；单次结果不能当作总体成功率。
- `WindowReadinessTest` **32/32**、`ActionObservationWaiterTest` **14/14**，相关 APK 构建通过。仅安装到专用模拟器，未修改版本或提交。

运行与修复前失败证据保存在 [`input-settling-validation.json`](../android/testbed/build/reports/input-settling-validation.json)。超过观察窗口的业务更新仍须通过明确结果条件验证；持续变化不能靠加长等待或无限重试冒充稳定。
