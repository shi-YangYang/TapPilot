# Agent 回归测试

不按某个 App 写固定点击脚本。模型选择当前界面上的语义目标；Android `NodeActionGuard` 与无障碍服务负责重新定位、计算触点、检查限制并返回观察。MCP 与桌面共用 `ToolController`，电脑不再另做动作前整树读取或把节点改写成坐标。新失败先分清是目标不可操作、几何歧义、真实页面变化，还是模型恢复策略问题，再在相应层补反例。

## 场景与预期

| 场景 | 必须满足的行为 | 用例位置 |
| --- | --- | --- |
| 中心被普通按钮局部遮挡 | 手机在当前目标区域内计算未覆盖点，验证后只发送一次触控 | Android `NodeActionGuardTest.partialOverlayUsesOnlyObservedClearRegion` |
| 同窗口完全遮挡 | `tap_element` 和 `click_element` 共用遮挡校验，不换动作绕过 | Android `NodeActionGuardTest.completeOverlayBlocksTouch`；真实 Android `native_overlay` 验证点按拒绝 |
| 零面积非目标布局 | 不凭空生成遮挡区域；目标和祖先仍要求有效边界 | Android `NodeActionGuardTest.zeroAreaNonTargetLayoutsDoNotInventAnOverlay` |
| 节点句柄更新但目标身份唯一 | 手机重新定位后恰好操作一次，不要求电脑重新读树 | Android `NodeActionGuardTest.sameSemanticsWithNewHandlesRebindsUniquely`、`native_rebind` |
| 敏感内容或跨控件短手势 | 不通过换点或换工具规避 | Android `NodeActionGuardTest.sensitiveDescendantAndRawGestureRemainBlocked`、`rawTouchCannotHitTwoDistinctControls` |
| 同列表独立叶子持续刷新 | 目标与关键上下文稳定时仍只执行一次，实际点击计数必须为 1 | Android `NodeActionGuardTest.continuousPeerLeafRefreshKeepsWholeRowTarget`、`native_refresh` |
| 列表重排、目标替换、重复目标、关键上下文变化 | 拒绝且 App 内点击计数为 0，不能将拒绝当任务完成 | Android testbed `native_reorder/native_replaced/native_ambiguous/native_context` |
| 中文输入与输入前上下文变化 | 正常输入以 App 内字段和输入内容验收；上下文变化必须拒绝 | Android testbed `native_input/native_context_input` |
| 桌面与 MCP 请求一致、旧手机不具备能力 | 同一节点动作只发一次相同 RPC；旧 APK 明确要求升级，不回退旧算法 | `client-node-tap`、`client-tools`、`tools` |
| 初始停在受保护页面 | 仅提供一次明确的 `open_settings` 出口，未离开则停止；不读取或操作保护控件 | `runtime-recovery-policy` |
| 中途遇到保护、急停、连接失效、手势结果未知 | 停止后续操作，不重放可能已发生的动作 | `runtime`、`runtime-host-refresh` |
| 换节点、读取设备信息、刷新 ID 后继续失败 | 页面上下文连续 2 次拒绝即停止，其余有界拒绝保留 3 次上限；没有动作进展不能重置 | `runtime-context-refusal`、`runtime-recovery-policy` |
| 快照真实失效 | 最多补读一次，再由下一轮选择；不自动重发刚才动作 | `runtime-host-refresh`、`runtime-client-integration` |
| 手机连续拒绝过期快照，刷新后内容与 ID 持续变化 | 与电脑拒绝共享连续 3 次上限；前两次只读恢复，第三次停止；已接受动作的观察错误不算拒绝 | `runtime-recovery-policy` |
| 手机执行前复核目标与页面 | 节点动作验证身份、实际容器、相关上下文和遮挡；坐标手势继续严格整树与窗口拓扑校验 | Android `NodeActionGuardTest`、`SnapshotValidationTest`；协议 `bridge`、`wireless`、`tools` |
| 动作拒绝后模型直接结束 | 保留模型说明，但显示未完成；局部匹配、元数据和补读不能消除未恢复的动作失败 | `runtime-completion-evidence` |
| 前台元数据与先前界面不一致 | 同时清除完成依据和模型上下文中的旧界面；匹配时保留 | `runtime-completion-evidence` |
| 模型回答期间切换应用、窗口或服务会话 | 结束前只读核对一次，不增加模型轮次；变化或读取失败不能标记完成 | `runtime-completion-evidence` |
| 完整页面超过默认读取容量 | 收尾读取不能退回较小默认容量而误报截断 | `runtime-completion-evidence` |
| 模型回答与失败原因同时存在 | 桌面分别展示原因和未确认的模型说明；下次任务清除旧错误 | `desktop/test/electron-step-diagnostics.cjs` |
| 参数化页面与固定基线 | 同一 scene/seed/split 可重建配置；重复运行与不同配置分别计数 | `scripts/testbed-scenarios.mjs`、Android `VariantScenes`、`VariantsInstrumentedTest` |
| 模型宣称完成或拒绝 | 结构化结束声明只用于报告分类，任务是否完成仍由独立业务 oracle 判定 | `scripts/testbed-verifier.mjs`、`testbed-verifier.test.mjs` |
| 批测中断、请求重试与恢复 | 请求发送前持久化计数；未完成 case 的请求也不能在续跑时丢失 | `scripts/testbed-batch.mjs`、`testbed-batch.test.mjs` 的子进程中断测试 |
| 同设备并发、旧动作尚未清理 | serial 独占 lease；前例操作未结束则停止，不能直接重置下一例 | `testbed-batch.test.mjs`、`scripts/testbed-runner.mjs` |

`runtime-client-integration.test.ts` 连接真实 `runAgent → PhoneClient → ToolController`，仅替换模型响应与手机 RPC，覆盖五条链：三步导航与局部重叠、中文输入与搜索、保护页退出、过期手势恢复、页面上下文变化后重新选择。模型替身依据最新投影的标签和能力选目标，手机替身每次生成新快照和节点 ID；断言手机收到最新引用、每轮最多一次动作、动作结果直接成为下一轮观察，并核对请求数和读取数。

## 不依赖模型的 Android 验证

`android/testbed/native-scenarios.json` 定义 9 个 Android 场景，经桌面客户端入口与 MCP 控制器入口各运行一次，共 18 个用例。`scripts/native-executor-eval.mjs` 不调用 LLM、不注入预设坐标、不自动重试动作：它读取真实无障碍树取得节点，调用实际 RPC，再核对测试 App 的独立 oracle（点击次数、错误目标次数、最终页面、中文输入是否匹配）。持续刷新场景还要求读取之后至少经过 4 次刷新，防止测试恰好避开刷新窗口。

该脚本只接受 `emulator-*` 专用模拟器，不操作日常真机。预先安装本次 TapPilot 和 testbed APK，并通过模拟器系统界面手动开启无障碍及允许自动化；脚本不会代为授予系统权限。ADB 仅重置合成测试 Activity 和读取调试 oracle，动作仍走 TapPilot。需要已构建的 `server/dist`。

从项目根目录运行（替换为专用模拟器序列号）：

```bash
node scripts/native-executor-eval.mjs --serial emulator-5580 \
  --entries desktop,mcp --output /tmp/native-executor-report.json
```

`NodeActionGuardTest` 是手机端 Kotlin guard 的 JVM 边界测试；18 个模拟器用例进一步检查真实 `AccessibilityNodeInfo`、生命周期、事件和派发路径。服务端 `client-target-refresh.ts`、`client-touch-geometry.ts` 仅供合成评估使用的参考模型，已退出生产桌面执行路径；它们的 TS 单测不能替代 Android 执行验收。模拟器用例通过也不等于第三方 App 或 OEM 真机兼容性已通过。

## 参数化 Android 批测与真实模型

`scripts/testbed-eval.mjs` 是另一条评测入口：使用生产 `runAgent → PhoneClient → ToolController → Bridge → Android 执行器`，操作模拟器中真实的合成测试页。`--mode fixture` 用确定性策略替代模型响应，验证执行链；`--mode model` 使用真实模型，验证决策与执行配合。两者都独立读取 App 私有业务 oracle 判分，不将 oracle 或 expected 条件发送给模型，不通过 ADB 注入点击、输入或滑动。只能指定专用 `emulator-*`，不能传日常真机 serial。

默认 `--suite generated` 根据 scene、seed、split 生成标签、布局、干扰项、位置和时序；`--suite legacy` 保留原有八类基线。`--split holdout` 使用独立随机盐，适合在修复后测试未用于修复的变体。`--repeat` 重复同一配置，不能当成新增场景。`--list-cases` 只生成清单，`--manifest` 导出合成配置和正确答案，均不代表实际运行已通过。

```bash
# 先只生成清单，不连接设备或模型。
node scripts/testbed-eval.mjs --suite generated --split holdout \
  --scenes navigation,search,async_list,ime,overlay,long_list \
  --seeds 17,29,43 --list-cases --manifest /tmp/android-cases.json

# 真实模型沿用桌面端已保存配置；profile 只读，密钥仅在 Electron 主进程内解密。
./desktop/node_modules/.bin/electron desktop/scripts/android-eval.mjs \
  --serial emulator-5580 --suite generated --split holdout \
  --scenes navigation,search,async_list,ime,overlay,long_list --seeds 17,29,43 \
  --max-cases 100 --max-model-requests 200 --max-minutes 30 --output /tmp/android-model.json
```

Electron 入口不启动 UI 或后台改进，不写原 profile；`--check-model` 只检查配置可读、可解密，不联网，也不能证明服务可用。普通 Node 模型入口可使用调用者的 `TAPPILOT_EVAL_BASE_URL/MODEL/API_KEY` 环境配置。测试预算限制尝试数、请求数和时间，不设置模型输出上限，不改变生产任务限制。

模型通过评测专用的 `finish_evaluation` 明确声明 completed 或 cannot_complete。声明不能代替业务验收；报告分别记录 `success`、`correct_refusal`、`false_completion`、`task_failed`、`unknown_report`、`oracle_invalid` 与 `environment_failure`。当前不可访问 canvas 的正确拒绝不计入任务成功。自然语言结束本身不作为虚报完成的证据。

逐步记录仅保留合成目标类别、动作状态、计数差异和界面身份哈希，不保存原始 UI、模型回答、任意输入或密钥。归因是基于独立证据的候选解释；无法证明是模型、执行器、观察或环境错误时保留 unknown，不靠猜测分责。

`configuredCoverage` 表示已运行用例配置的条件，`observedCoverage` 表示 oracle 实际证实的效果。配置了刷新、重排或遮挡不等于操作过程中真正经历它们；刷新计数本身也不能证明 View 替换或重排。数量、配置覆盖、观察覆盖与结果状态必须分开报告。生成数百个配置不代表执行了数百个任务，模拟器结果不能代替真实 App 兼容性验收。

输出文件旁的 `.jsonl` 保存逐例结果与 fsync 预算 checkpoint；请求在发送前记账，包括重试和异常终止前尚未完成的 case。整批取消、预算终止或清理未收敛单独保存为 attempt，汇总列为 `interruptedAttempts`，不计已完成 case。相同配置加 `--resume` 核对 suite/config/model 身份，恢复累计预算，跳过已有最终结果的 case，但重新执行中断 case。单例超时和明确任务失败已有最终判定，需用新输出文件定向复测。

请求计数在强制终止后仍保留；跨续跑耗时只累计已保存的活动时间，SIGKILL 会丢失最后检查点之后的末段耗时，不保证精确墙上时间，也不计停机等待。设备 lease 防止同模拟器并发；只有确认 PID 已不存在才回收，不根据超时猜测进程死亡。已结束 case 的工具操作尚未清理完时停止批次，不重置下一页。

失败 case 用报告里的 scene、seed、split、repetition 和 case ID 复现，写入新报告。例如：

```bash
./desktop/node_modules/.bin/electron desktop/scripts/android-eval.mjs \
  --serial emulator-5580 --suite generated --split regression \
  --scenes async_list --seeds 29 --repeat 1 \
  --case-ids generated-regression-async_list-29-1 --output /tmp/android-repro.json
```

完整参数、安装授权、oracle 字段、结果判据及隐私边界见 [Android testbed 说明](../android/testbed/README.md)。复现配置后应提取最小失败场景，再选择原生执行器或完整模型路径回归，不用多次重试后的成功掩盖首次拒绝或误点。

## 相关回归命令

在 `server` 目录执行：

```bash
node --import tsx --test \
  test/client-node-tap.test.ts test/client-tools.test.ts test/tools.test.ts \
  test/bridge.test.ts test/client-wireless.test.ts \
  test/runtime-client-integration.test.ts test/runtime-recovery-policy.test.ts \
  test/runtime-context-refusal.test.ts \
  test/runtime-host-refresh.test.ts test/runtime-progress.test.ts \
  test/runtime.test.ts test/runtime-argument-repair.test.ts \
  test/runtime-completion-evidence.test.ts \
  test/context-action-guidance.test.ts test/ui-projection.test.ts \
  test/model-projection-serialization.test.ts test/model-output-limit.test.ts \
  test/model-transport.test.ts
```

手机 guard 的定向检查在 `android` 目录执行 `./gradlew :app:testDebugUnitTest --tests dev.tappilot.agent.NodeActionGuardTest`。上述服务端命令列出可选择的动作协议和恢复检查范围，应按实际改动选取；手机执行器修改还需对应 Android 测试，不要求每次文案修改运行。失败后只修复并重跑受影响的检查；已通过且代码未变的用例不重复执行。

结束核对只检查当前会话、应用和窗口是否连续，不证明模型的自然语言结论一定正确，也不验证同一窗口中的所有动态内容。它不会把截图或新 UI 再发给模型；耗时和调用数计入“结束核对”。

## 真机验收

在电脑 TapPilot 配置自己的模型并连接测试手机。测试期间保持手机解锁，不同时手动切换页面。使用普通导航与只读任务，例如进入电池页读取状态、返回桌面打开指定 App、在搜索框输入测试词并读取结果。付款、发送、删除、权限授权、验证码等交给用户完成。

每个任务分别记录是否到达预期页面、模型请求数、动作数、执行前拒绝数、补读数和耗时；以手机上的实际结果确认，不以 RPC 的 accepted 代替成功。失败时保留固定错误码及耗时，构造不含真实聊天或凭据的合成用例；不保存完整用户界面作为测试夹具。

合成测试验证执行逻辑，真机测试验证 Android 事件与 App 的可访问性实现，两者不能互相替代。Accessibility Tree 未提供绘制顺序、透明遮挡和所有自绘控件；完全重叠且无充分证据时仍应拒绝。视觉兜底可作为后续独立适配能力，本轮没有以猜测坐标替代它。
