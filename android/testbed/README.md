# 合成 Android 测试场景

这是独立的开发测试 App，包名 `dev.tappilot.testbed`，只有 debug 构建，不包含在 TapPilot APK 中。它使用本地合成数据，不申请网络、悬浮窗、无障碍或其他权限，不读取真实 App 的内容。批测只接受显式指定的 `emulator-*` 专用模拟器；不支持日常真机或 `--allow-physical`。

## 准备专用模拟器

先启动无账号的专用模拟器，并将以下命令中的 `emulator-5580` 替换为它的序列号。所有 ADB 命令都指定序列号，避免影响同时连接的真机。

```bash
cd android
./gradlew :app:assembleDebug :testbed:assembleDebug :testbed:assembleDebugAndroidTest
adb -s emulator-5580 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5580 install -r testbed/build/outputs/apk/debug/testbed-debug.apk
adb -s emulator-5580 install -r testbed/build/outputs/apk/androidTest/debug/testbed-debug-androidTest.apk
cd ../server
npm run build
```

## Harness 接口

初始化场景仅启动这个合成 App，不控制其他 App、不修改系统授权：

```bash
adb -s emulator-5580 shell am start -S -n dev.tappilot.testbed/.MainActivity --es scene navigation --ei seed 17 --es runId "$(uuidgen)"
```

每次启动会清空合成业务状态。手动启动例子使用固定基线页面；参数化批测还会传入生成器产生的 `variant` JSON。之后的操作必须通过 TapPilot 生产的读取 UI → 定位 → 动作 → 观察链路；正常开启 TapPilot 无障碍服务和允许控制仍是前提。不要将以下 oracle 命令或结果提供给执行任务的模型。

```bash
adb -s emulator-5580 exec-out run-as dev.tappilot.testbed cat files/oracle.json
```

该读取利用 debug App 的 `run-as` 权限，只访问其私有合成状态文件，不重启 App。文件以 `AtomicFile` 写入，harness 读取遇到短暂换文件窗口时可重新读取一次。另有非导出、不可授权、只读的 ContentProvider `content://dev.tappilot.testbed.oracle/state`，仅供同 UID 的 instrumentation 使用；没有远程写入/reset 接口。

状态协议 `schemaVersion=1`：

| 字段 | 含义 |
|---|---|
| `runId`, `scene`, `seed`, `page` | 本轮 host UUID、场景、随机种子、真实业务页面；harness 必须检查前三项以拒绝旧结果 |
| `variantId`, `configurationError` | 参数化变体身份、配置是否被测试 App 拒绝；变体评测也须核对身份 |
| `lastTarget` | 最后实际触发的业务控件，固定枚举 |
| `receivedInput` | `none/empty/expected/other`，不保存任意输入原文 |
| `inputField`, `focus` | 输入接收位置、当前焦点的固定标识 |
| `recipient` | `synthetic_a/synthetic_b`，用于会话目标改变场景 |
| `wrongClicks`, `clickCount` | 错误目标数量、实际触发业务点击的总次数；测试准备按钮只改变 `armed`，不计业务点击 |
| `revision`, `refreshCount` | 状态序号、异步刷新回调次数 |
| `orderChangeCount`, `replacementCount`, `peerTextChangeCount` | 实际顺序改变、新一代 View 附着、可见文字更新次数；配置刷新不等于这些效果发生 |
| `overlayDismissed`, `completed` | 实际关闭浮层、实际完成业务目标 |
| `armed`, `changed` | 原生执行器测试中是否已准备异步变更、变更是否真实发生 |

成功必须由 harness 检查 `completed=true`、预期 `page` 和 `lastTarget`、`wrongClicks=0`，不能依赖模型自述。纯拒绝场景则检查没有错误目标/输入副作用，并分别记录安全拒绝与任务完成。

## 八类基线场景

`--suite legacy` 使用下表中的固定标签与任务。`--suite generated` 是默认模式，在同样的业务任务上生成标签、布局、位置、干扰项和时序变体。

| scene | 任务 | 期望 page / lastTarget |
|---|---|---|
| `navigation` | 打开测试目录，进入合成电池页 | `battery / battery` |
| `search` | 搜索“合成电池”，打开匹配结果 | `battery / search_result` |
| `async_list` | 列表刷新时打开合成目标 B | `detail_b / async_B` |
| `ime` | 在合成会话甲输入“合成输入”，保存草稿 | `draft_saved / save_draft` |
| `overlay` | 关闭浮层，再打开被遮挡目标 | `target / overlay_target` |
| `long_list` | 找到并打开合成项目 42 | `item_42 / item_42` |
| `webview` | 在本地网页输入“合成网页”，保存 | `web_saved / web_save` |
| `canvas` | 点击画面中蓝色圆形按钮 | `canvas_selected / canvas_circle` |

`async_list` 前 8 次每隔 900 ms 重排列表，`ime` 同期仅刷新无关文本；“切换为合成会话乙”用于成对验证：无关区域变化不应阻止输入，会话对象变化必须被识别。`overlay` 是 App 自己的真实 Dialog 窗口，不申请或模拟绕过系统悬浮窗权限。`canvas` 没有可访问控件，必须使用有视觉能力的策略或明确拒绝，而不是硬编码坐标。

上述 `async_list`、`ime` 的固定时序描述针对 legacy 页面；generated 的刷新模式和时序由变体配置决定；压力变体默认最多 300 次、间隔 900/1200 ms，持续覆盖默认 240 秒任务，任务完成或 Activity 销毁后停止。Instrumentation 是测试场景本身的合同验证，测试控件事件、真实焦点、局部 HTML、Dialog 和业务状态；它不能证明 TapPilot 生产执行器通过全部场景。生产端到端结果由独立 harness 记录。在需要验证测试 App 合同时运行：

```bash
adb -s emulator-5580 shell am instrument -w dev.tappilot.testbed.test/androidx.test.runner.AndroidJUnitRunner
```

## 生产执行链评测

以下命令在仓库根目录执行。设备必须已安装上述两个 APK、开启 TapPilot 无障碍服务并允许控制。评测会检查服务状态和手机端 `node-v1` 执行器能力；不会自动授予权限、解除急停或容许任务导航到测试 App 之外。

两种模式都经过真实的生产链路：

```text
fixture 决策策略或真实 LLM
          ↓
runAgent → PhoneClient → ToolController → Bridge → Android AccessibilityService
                                                     ↓
                                              测试 App 的真实状态
                                                     ↓
                                          独立 oracle 判分与逐步证据
```

`fixture` 只替代模型响应，根据本轮观察到的节点、标签和能力做确定性决策，不调用付费模型，不读 oracle 决策，不使用 ADB 注入输入。它适合检查执行链、测试页和判分器。`model` 使用真实模型，让它自己选择目标和下一步；它才覆盖模型决策与工具执行配合的行为。两种模式均不同于后文完全不经过 `runAgent` 的原生执行器测试。

```bash
node scripts/testbed-eval.mjs --serial emulator-5580 --mode fixture \
  --suite generated --scenes navigation,search,async_list,ime,overlay,long_list \
  --seeds 17,29,43 --output /tmp/testbed-fixture.json
```

### 参数化测试集与复现

`scripts/testbed-scenarios.mjs` 根据 `scene + seed + split` 确定性生成变体；Android `VariantScenes` 使用真实控件呈现它。变体包含相近文字干扰项、可点击父容器、目标位置和排列、长列表、延迟内容、刷新叶子文字、节点替换或重排、键盘、Dialog、本地 WebView 与不可访问画布。各场景只声明实际使用的配置因素，不能把未使用参数算作覆盖。

| 参数 | 含义 |
|---|---|
| `--suite generated\|legacy` | 默认 generated 生成参数化页面；legacy 保留固定基线任务 |
| `--scenes` | 逗号分隔的上述 scene；默认全部八类 |
| `--seeds` | 逗号分隔的非负整数；默认 `17,29,43` |
| `--split regression\|holdout` | 默认 regression；holdout 使用独立随机盐，应保留作未参与修复的复验数据 |
| `--repeat` | 相同变体重复运行，默认 1；检验时序稳定性，不增加独立配置数 |
| `--case-ids` | 从当前参数生成的集合中选择具体 case ID；必须同时提供能生成它的 scene、seed、split 和 repeat |
| `--list-cases` | 只列出 case ID、数量和不同配置数量；不连接模拟器、不请求模型 |
| `--decision-delay-ms` | fixture 专用，默认 0，最大 30000；冻结当前观察后再等待，用于无模型费用地复现思考期间 UI 变化 |
| `--manifest` | 导出本次生成的合成配置、任务和预期条件；这是输出文件，不是加载既有 manifest 的参数 |

regression 的 seed `17` 是静态基线；`async_list` 的 seed `29` 和 `43` 分别覆盖叶子文字刷新与 View 替换配置。其他种子还可生成重排。holdout 不使用这些特殊基线。

只生成和检查测试集：

```bash
node scripts/testbed-eval.mjs --suite generated --split regression \
  --scenes navigation,search,async_list,ime,overlay,long_list,webview,canvas \
  --seeds 17,29,43,59,71 --repeat 1 \
  --list-cases --manifest /tmp/testbed-cases.json
```

复现一个报告中的失败 case，用同一个生成器版本和原参数重新生成，写入新的报告文件：

```bash
node scripts/testbed-eval.mjs --serial emulator-5580 --mode fixture \
  --suite generated --split regression --scenes async_list --seeds 29 --repeat 1 \
  --case-ids generated-regression-async_list-29-1 --output /tmp/repro-fixture.json
```

这能固定页面配置和任务，不能保证网络延迟、模型响应或 Android 调度完全相同。保留 manifest 可核对代码更新前后的生成结果；发现失败后还需把最小场景加入回归，而不是只增加 repeat。

### 使用电脑端已保存的真实模型

Electron 入口只读电脑端 profile，通过 `safeStorage` 在内存解密已有配置，沿用生产 `createModelFetch` 的系统网络与 TLS 行为。默认 profile 为 Electron `appData/TapPilot`，macOS 通常是 `~/Library/Application Support/TapPilot`；可以用 `--profile /absolute/path` 指定。入口不启动 UI、不写模型配置、不启动后台持续改进；Electron 自身数据写入临时目录，网络使用独立非持久化分区，退出清理临时目录。

```bash
# 只检查配置可读、可解密、格式有效，不联网；MODEL_CONFIG_READY 不代表模型服务已连通。
./desktop/node_modules/.bin/electron desktop/scripts/android-eval.mjs --check-model

# 默认自动使用 --mode model；任务和参数仍由同一 runner 处理。
./desktop/node_modules/.bin/electron desktop/scripts/android-eval.mjs \
  --serial emulator-5580 --suite legacy \
  --scenes navigation,search,async_list,ime,overlay,long_list --seeds 17 --repeat 3 \
  --max-model-requests 200 --max-minutes 30 --output /tmp/testbed-model-baseline.json

# 同一个失败配置改用真实模型，检查问题是否只在模型决策路径出现。
./desktop/node_modules/.bin/electron desktop/scripts/android-eval.mjs \
  --serial emulator-5580 --suite generated --split regression \
  --scenes async_list --seeds 29 --repeat 1 \
  --case-ids generated-regression-async_list-29-1 --output /tmp/repro-model.json
```

也可用普通 Node 入口和当前 shell 中安全配置的 `TAPPILOT_EVAL_BASE_URL`、`TAPPILOT_EVAL_MODEL`、`TAPPILOT_EVAL_API_KEY`：

```bash
node scripts/testbed-eval.mjs --serial emulator-5580 --mode model \
  --suite generated --scenes navigation,search --seeds 17 \
  --output /tmp/testbed-model-env.json
```

两条模型入口均不将 API Key 或 endpoint 写入报告、命令行参数或 manifest。报告中的模型身份是匹配续跑所需的哈希，不输出保存的模型配置原文。

### 独立判分与逐步证据

每例生成新的 `runId`，核对 oracle 的 `runId/scene/seed` 及 generated 的 `variantId`。模型只能看到任务与生产工具返回的界面；私有 oracle、预期条件和评估结果不进入模型上下文。

评测增加一个仅用于此 harness 的 `finish_evaluation` 工具，要求模型明确声明 `completed/goal_reached` 或 `cannot_complete` 与固定原因。声明只用于区分报告行为，不能覆盖实际业务状态。自然语言结束不能自动当成“已完成”，也不能仅凭 `runtimeStatus=completed` 判断模型虚报。

| 结果 | 独立判据 |
|---|---|
| `success` | 本轮 oracle 满足任务的业务条件，包括正确页面、目标、输入及零误点等 |
| `correct_refusal` | 不可完成场景明确声明 cannot_complete，且没有派发动作或业务副作用；不计入任务完成数 |
| `false_completion` | 明确声明 completed，但 oracle 不满足任务条件 |
| `task_failed` | 明确无法完成可操作任务，业务条件未满足 |
| `unknown_report` | 业务条件未满足，且没有有效的结构化结束声明 |
| `oracle_invalid` | 本轮身份或预期条件无效，不能判业务成功 |
| `environment_failure` | 场景初始化、权限或连接发生错误；报告保留固定 caseError |
| `timeout` | 单例超过测试时限，保留已知动作证据，不推测未观察结果 |
| `interrupted` | 整批取消、预算用尽或清理尚未收敛；只记 attempt，续跑仍待执行 |

当前 canvas 没有可访问节点，生产客户端也没有视觉操作工具，因此正确行为是安全拒绝。真实模型和 fixture 使用相同的拒绝判据；拒绝不能混入成功率。

每步只记录工具/动作枚举、已知合成目标类别、快照身份哈希、节点数、执行器派发与接受状态，以及独立业务计数前后差异。汇总的 `actionEvidence` 也统计最终成功任务中曾经发生的动作失败，不让一次重试成功掩盖拒绝率。归因是候选解释：选择了已知干扰项可指向模型选择；实际目标与请求目标矛盾可指向执行器；返回树截断可指向观察；权限或 oracle 身份问题归环境。证据不足保留 unknown，不把所有拒绝都判作手机 bug。

报告区分 `configuredCoverage` 和 `observedCoverage`。前者表示已运行用例配置了哪些条件；后者只列独立状态实际证实的效果，例如刷新计数增长、页面跳转、目标输入、浮层关闭或误点。刷新计数不能单独证明重排或 View 替换；后两者分别使用真实变化计数。`*_during_action_observed` 表示动作请求至观察返回期间发生变化，不证明变化恰在触点下发瞬间；`revalidated_after_*` 关联请求快照与独立状态，表示观察后发生变化且动作已下发，也不单独证明任务完成。旧 trace 没有请求快照摘要时只能按最近返回界面关联，证据更弱。后文原生持续刷新用例才专门要求旧快照跨过至少四次刷新再执行。

### 批次预算、断点与设备互斥

`--max-cases`（默认 500）、`--max-model-requests`（默认 200）、`--max-minutes`（默认 30）限制本次测试的尝试数、真实模型 HTTP 请求数和运行时间；`--case-timeout-ms` 默认 240000，每例还有 40 轮上限。重试和网络失败也消耗请求次数。厂商提供数值 usage 时记录 token 用量；没有 usage 时不推测用量。这些限制只作用于评测，不修改用户生产任务配置，也不注入 `max_tokens` 或模型输出上限。

指定 `--output /tmp/eval.json` 时逐例更新汇总，并写 `/tmp/eval.json.jsonl`。JSONL 的最终 case 记录、中断 attempt 与预算 checkpoint 均 fsync：开始用例后保存已尝试次数，真实模型请求先预留次数并持久化，再实际发出。因此即使进程在请求中被终止、尚无完成用例记录，续跑也不会丢失这次请求计数。截断的最后一行不当成完成记录，之前完整记录继续保留。

跨续跑的 `elapsedMs` 是检查点已保存的活动耗时，不是精确墙上时钟：SIGKILL 等强制终止会丢失最后一个检查点到终止之间的耗时，也不累计进程退出后的等待时间。当前运行仍有时间截止；需要严格控制整个批次的费用时，应使用请求数硬预算，不能把该耗时字段当作精确计费依据。请求计数不会因这段耗时缺失而回退。

```bash
# 参数保持与原批次一致，只增加 --resume；已完成 case 不重跑。
node scripts/testbed-eval.mjs --serial emulator-5580 --mode fixture \
  --suite generated --scenes navigation,search,async_list,ime,overlay,long_list \
  --seeds 17,29,43 --output /tmp/testbed-fixture.json --resume
```

续跑核对 suite、配置及模型身份；不匹配会拒绝混写。整批取消、预算终止或旧动作清理未收敛时，保存独立 `attempt`，汇总放在 `interruptedAttempts`，不放入已完成 case 集合。续跑会重新初始化这个未完成用例，再消耗一次尝试预算；先前请求仍已记账。单例超时、明确任务失败等已有最终判定的 case 保留在已运行集合，续跑不会自动重试；需要复测时用 `--case-ids` 和新输出文件。普通单例失败会记录后继续；预算耗尽、设备终端错误或旧动作尚未清理完则停止，避免下一例覆盖仍执行中的页面。

每个模拟器 serial 使用独占 lease，记录本机 PID 与 runId。活跃进程持有 lease 时拒绝并发；只有 PID 检查明确返回 ESRCH 才回收旧 lease。回收过程存在无法确认的残留锁时保守拒绝。SIGINT/SIGTERM 会取消并等待工具清理，然后关闭 journal、释放自己的 lease。

报告与 journal 不保存原始 UI、模型回答、任意输入、请求正文或密钥。manifest 只包含生成器产生的合成任务和配置，含正确答案，不能作为模型输入。生成 400 个配置只证明生成器能产生它们，不代表已经运行或通过 400 个任务；应同时报告实际执行数、状态、不同配置数及观察覆盖。模拟器通过也不保证真实 App、厂商系统、自绘控件或窗口实现兼容。

## 一次性模拟器授权（可选）

专用、无账号的临时模拟器可以使用单独的测试 bootstrap；它检查 `Build.HARDWARE` 必须是 `ranchu/goldfish`，默认跳过，只有 `bootstrap=true` 才启用。它通过 UIAutomation 读取系统设置中的实际服务入口，点击系统允许和 TapPilot 的「允许 / 恢复」，不写权限或急停数据库。它不参与评测，也不进入生产 APK。

```bash
adb -s emulator-5580 shell am instrument -w -e bootstrap true \
  -e class dev.tappilot.testbed.EmulatorSetupInstrumentedTest \
  dev.tappilot.testbed.test/androidx.test.runner.AndroidJUnitRunner
```

对真实手机仍然需要用户正常授权。模拟器系统 UI 不同导致 bootstrap 失败时，正常打开设置完成授权即可，不应放宽生产权限检查。

## 不依赖模型的原生执行器回归

`native-scenarios.json` 和 `NativeExecutorScenes.kt` 使用真实 Android `ListView`、`EditText` 和同窗口覆盖层。以下脚本直接调用电脑端 `PhoneClient` 与 MCP `ToolController`，共用生产 RPC 与 `AccessibilityService`；既不调用 `runAgent`，也不构造假模型响应。

```bash
# 先完成上述构建、安装与专用模拟器授权，并构建 server/dist。
node scripts/native-executor-eval.mjs --serial emulator-5580 --output /tmp/native-executor-report.json
# 只复现持续刷新，两个入口各运行三次：
node scripts/native-executor-eval.mjs --serial emulator-5580 --scenes native_refresh --repeat 3
```

| 场景 | 预期与独立判据 |
|---|---|
| `native_refresh` | 真实 `ListView` 其他行的已有非交互文字每 80 ms 刷新；旧快照跨过至少四次刷新后，稳定目标实际点击恰好一次 |
| `native_rebind` | 把目标替换为全新的 View 对象，保留语义和位置；实际点击恰好一次 |
| `native_reorder` | 列表顺序变化，仍有唯一目标；保守拒绝，业务点击为零 |
| `native_replaced` | 原位置目标改为不同内容；拒绝，业务点击为零 |
| `native_ambiguous` | 同页出现两个相同标识与语义的目标；拒绝，业务点击为零 |
| `native_context` | 目标不变，但会话对象改变；拒绝，业务点击为零 |
| `native_overlay` | 同窗口新增实际可点击覆盖层；拒绝，目标与覆盖层点击均为零 |
| `native_input` | 通过原生输入动作设置中文；业务状态确认收到完整预期内容，结果返回新界面 |
| `native_context_input` | 会话对象变化后使用旧输入框句柄；拒绝，未发生输入 |
| `native_form_refresh` | 普通表单状态每 80 ms 刷新，未声明可变文字；保持默认拒绝，不偷偷放宽原用例 |
| `native_form_allowed` | 相同表单，仅显式指定状态标签允许更新；跨至少四次刷新后实际输入一次 |
| `native_form_recipient/account/amount` | 显式允许状态刷新，但收件人/账户/金额变化；必须未派发、未输入 |
| `native_form_status_role/label_relation` | 状态变成可点击控件或建立原生 labelFor 关联；必须未派发、未输入 |
| `native_form_recipient_silent` | 真正拦截内容变化事件后更换收件人；即使无缓存失效通知，也必须查询到变化并拒绝输入 |

变更场景先通过生产工具点击测试页的「准备变化」，保存该动作返回的界面，再等待私有 oracle 确认定时变更已发生，最后只发一次目标动作。持续刷新场景同样明确等待已跨过至少四次刷新。这样不会把“动作恰好在刷新前执行”误记为通过，也不会通过反复读取、自动重试掩盖首次失败。

场景在首次动作前，最多等待 6 秒取得两次相隔约 100 ms、语义与几何相同的测试页，避免把启动窗口动画当作待测变化。此检查忽略快照和 revision 编号，但包含窗口、节点属性、层级与边界；持续刷新用例只在比较副本中忽略 fixture 已知计时标签的非空 text 值，仍检查其 bounds、状态、结构和其他文字，不修改传给执行器的快照。随后再跨至少四次实际刷新，只发一次待测动作。仅启动准备阶段可稳定读取；在故意更换收件人或动作失败后不重新读取/重试。「准备变化」失败会单独记录固定错误码和原因枚举。

每个场景都验证新的 `runId/scene/seed`、`clickCount`、`wrongClicks`、最终业务页面或输入状态；`accepted=true` 本身不算完成。成功动作还必须返回 `executor=node-v1` 的新界面。拒绝必须命中该场景在 `native-scenarios.json` 声明的具体原因，例如目标替换必须是 `TARGET_IDENTITY_CHANGED`，重复目标必须是 `TARGET_AMBIGUOUS`；`TREE_INCOMPLETE`、协议错误、未知动作或权限失败都不能当成指定防护已通过。两条入口分别重新初始化场景，报告区分成功、预期安全拒绝和失败。此脚本只接受显式指定的模拟器，不修改系统授权，不注入 ADB 点击、输入或滑动，不记录原始 UI 和任意输入内容。

## 已固定的动态表单复现

真实模型发现：无语义标注的动态状态文字与收件人名称，都是同一布局下的普通 TextView。当前手机端全页上下文校验无法可靠区分，连续刷新时会拒绝输入并停止。不要通过忽略所有非交互文字或修改 fixture 来掩盖此限制。

下例冻结观察 2.5 秒后执行，已在 Android 模拟器复现 `PAGE_CONTEXT_CHANGED` → `PAGE_CONTEXT_UNSTABLE`，无需模型服务。当前预期是暴露失败（退出码 1），期望改进后的业务结果仍为 success，并且收件人改变的反例必须继续拒绝：

```bash
node scripts/testbed-eval.mjs --serial emulator-5580 --mode fixture \
  --suite generated --scenes ime --seeds 29 --decision-delay-ms 2500 \
  --max-minutes 2 --output /tmp/ime-refresh-repro.json
```

现已补充原生 heading、paneTitle、labelFor/labeledBy 身份和内容摘要，在手机内存中保护这些语义条件。新增 `allowedLabelChanges` 显式契约仅放行指定状态叶节点文字，详见 [协议](../../docs/protocol.md)；不把更新频率或唯一 ID 当成业务独立证据。上面的 fixture 策略没有声明该参数，因此保留严格路径的复现，不能以它的失败推断新契约未生效，也不能把新契约通过说成任意第三方页面已自动兼容。

## RPC 生命周期回归

手机服务关闭时先 shutdown 监听 socket、唤醒 accept，再关闭并有界等待线程退出，避免旧 socket 占用名字导致重新连接失败。权限白名单保持不变。

```bash
cd android
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :testbed:assembleDebugAndroidTest
adb -s emulator-5580 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5580 install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5580 shell am instrument -w \
  -e class dev.tappilot.agent.RpcServerLifecycleInstrumentedTest \
  dev.tappilot.agent.test/androidx.test.runner.AndroidJUnitRunner
```

另一个显式启用的 testbed 测试 `AccessibilityReconnectInstrumentedTest`（传 `-e reconnect true`）临时抑制、恢复现有服务，finally 恢复测试标志，不修改授权。host 必须在测试前后读取 `get_device_info`，确认 RPC 可用且 sessionId 已改变；只看系统 Bound 状态不算成功。该测试与任务批次串行运行。

## 修复前基线（2026-10-17）

环境：独立 Android 14 arm64 模拟器，真实生产 PhoneClient / ToolController / Android 执行器；真实模型来自本机已保存配置。本轮未操作日常手机。

| 批次 | 实际运行 | 完成任务 | 正确拒绝 | 未完成 |
|---|---:|---:|---:|---:|
| generated 快速策略，regression 17/29/43 | 24 | 21 | 3 | 0 |
| generated 快速策略，holdout 53/59/71/83/97 | 40 | 35 | 5 | 0 |
| 真实模型基础用例 | 2 | 2 | 0 | 0 |
| 真实模型压力用例 | 10 | 8 | 1 | 1 |
| 真实模型 holdout 59 | 8 | 4 | 1 | 3 |

各批次独立 oracle 记录的误点均为 0；快速策略的通过不代表慢模型面对同一场景也通过。20 次真实模型任务中，14 次完成、2 次正确拒绝；2 次因持续刷新表单的 PAGE_CONTEXT_UNSTABLE 停止，另 2 次终止错误包含 MODEL_TIMEOUT（长列表还曾出现 NOT_SCROLLABLE / STALE_SNAPSHOT）。这些结果没有计入完成数，也没有因模型服务超时重跑整个批次。

真实模型共发出 66 次 HTTP 请求，64 次获得 usage，总计已报告 283047 token；未返回 usage 的请求用量未知。测试未设置模型 max_tokens。400 个生成配置经有效参数去重为 368 个，不代表跑过 400 次，更不代表 368 种独立业务类型；目前仍是八类合成业务。

已验证的附加项：47 个 JS 定向检查通过；12 个变体 Android 合同场景完成验证（初次失败项修复后定向通过）；生产 RPC socket 的三轮关闭/重绑定测试、真实 AccessibilityService 解绑/重绑测试通过，host 确认重新连接后 sessionId 改变且 RPC 可用。动态表单已另用 2.5 秒决策延迟在无模型模式复现，保留为已知失败，未放宽上下文保护。

这份基线用于比较后续改动，不代表真实第三方 App 已获得同等覆盖。下一步优先改善表单上下文证据和结果语义，并用收件人/账号/金额变化反例验证边界，再扩充真实 App 测试。

## 动态表单与缓存修复验证（2026-10-17）

本轮先用新原生场景复现了一次错误输入：收件人已变，但完整的旧 Accessibility 缓存仍通过校验。修复为每次采集/动作校验先获取新原生证据；另外修正测试启动阶段的窗口动画干扰，只在启动比较中屏蔽已知计时文字，实际动作继续使用原始快照。保留首次失败报告 `/tmp/tappilot-label-guard-native.json`，没有把错误输入改记为成功。

修复后的 `/tmp/tappilot-label-guard-fresh.json` 实际运行 9 个场景 × 桌面/MCP 两条入口，共 18 次：4 次实际完成、14 次按预期拒绝、0 次不符合预期，误点与错误输入均为 0。包括默认列表刷新、未声明的表单刷新、显式状态文字契约、收件人/账户/金额/角色/labelFor 改变，以及实际屏蔽内容事件后的收件人改变。每次待测动作仅派发一次，没有模型调用；拒绝均检查 `not_sent`，成功检查业务状态、返回观察和校验模式。

真实模型第一次复测仍因两次 `PAGE_CONTEXT_CHANGED` 停止（`/tmp/tappilot-label-guard-model.json`）。随后补充手机返回的 `changedLabelNodeIds` 事实差异，而未更改模型或重试上限。相同 generated IME seed 29 在第二次复测中完成输入和保存草稿：26.6 秒、5 次模型请求、3 次动作请求（1 次未派发拒绝，随后输入及保存成功），独立 oracle 确认结果与误点 0。报告为 `/tmp/tappilot-label-guard-model-diff.json`。这是单次场景验证，不代表全部 App 已稳定，也未消除首次拒绝。

相关检查：33 个 Android guard 用例、Android 参数合同检查、6 个共享协议/投影用例、19 个脱敏轨迹检查通过；相关 APK 与服务端构建通过。未更改版本号或创建 commit。
