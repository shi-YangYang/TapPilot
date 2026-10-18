# 真实 App 模拟器回归

这条测试通道与 `dev.tappilot.testbed` 合成测试相互独立。合成测试的包名限制不变，不能把真实 App 的界面当成合成夹具。当前真实 App 白名单包含拼多多、Wikipedia、AntennaPod、Markor，以及 Fossify Clock、Fossify Calculator、Fossify File Manager 和 NewPipe；包名以 `scripts/real-app-support.mjs` 的 `REAL_APP_PACKAGES` 为准。进入白名单或安装成功不等于已通过任务测试。本页记录拼多多公开商品搜索；其他 App 的固定局部流程、准备和命令见[多 App 执行器测试](multi-app-testing.md)。测试不登录、不付款、不下单、不自动处理验证码。

## 准备

使用独立 Android 模拟器，安装官方来源的拼多多、TapPilot debug APK，以及 `testbed-debug.apk` 和 `testbed-debug-androidTest.apk`。启用 TapPilot 无障碍服务和允许控制，完成 App 首次使用的必要提示，停在拼多多首页或搜索输入页。

历史首次安装记录为拼多多 **8.27.0**，模拟器为 **Android 14 / API 34 / arm64**。APK 入口为[拼多多官方下载页](https://www.yangkeduo.com/home/download/)，其官方下载接口为 `https://home-api.pinduoduo.com/homesite/download-app-v2?rs=0&arch=arm64`。版本会变化，报告记录实际安装版本，不以下载链接推断版本。登录如有需要只能由用户完成；测试报告不保存登录凭据、验证码或搜索历史。App 自身可能保留本机登录及搜索记录，测试脚本不会导出它们。

测试脚本同时检查 `emulator-*` 设备名和 `ro.kernel.qemu=1`，并使用共享设备锁。不要在测试期间操作模拟器，也不要同时启动第二条测试通道。构建和安装路径与 `android/testbed/README.md` 相同；新增的独立观察器位于 testbed 的 androidTest APK，不会进入手机端正式 APK。

## 不依赖模型的执行器测试

在仓库根目录运行：

```bash
node scripts/real-app-executor.mjs \
  --serial emulator-5580 \
  --entry desktop \
  --query 机械键盘 \
  --decision-delay-ms 3000 \
  --launch-component com.xunmeng.pinduoduo/.ui.activity.MainFrameActivity \
  --output /tmp/tappilot-real-app-executor.json
```

`--entry mcp` 使用同一个生产 ToolController 的 MCP 入口；`desktop` 使用生产 PhoneClient。`--decision-delay-ms` 在选中控件后、执行前等待，用来复现模型思考期间界面更新；建议分别比较 0 和 3000 毫秒。

可选的 `--launch-component` 仅接受当前白名单 App 的 Activity，先通过 `am start -S -W` 重启 App，再用生产客户端有界等候其回到前台。它不清空 App 数据，不操作登录或权限页面，不使用 ADB 注入点按。如果省略，则从当前已准备好的首页/输入页开始；报告通过 `setup` 区分两种起点。一次失败不会自动重放动作或重启重试，下一轮须显式重新运行。

脚本读取真实 UI 树，按当前观察到的文本或属性找搜索入口、唯一可编辑输入框、搜索提交按钮。默认搜索入口匹配“搜索”等明确语义；如果 App 的入口显示其他文字，可在实际观察后传入 `--entry-text`、`--entry-description` 或 `--entry-resource`，这些条件按 AND 匹配，重复目标会直接报错。不能填写猜测坐标或猜测控件 ID。

每次操作使用手机返回的新观察；必要时只做一次有上限的只读等待。输入值未在新观察中验证一致时，不会提交搜索。末尾调用独立 AndroidX UI Automator 观察器，判断当前 App、查询词、结果筛选栏或无结果状态。没有足够证据就是 `unverified`，不会因为工具返回 accepted 就报成功。

输入还必须带有原生 `showingHintText:false`；提示文字恰好等于查询词不能算输入成功。独立观察器使用 UI Automator 的公开 text/hint 属性，二者相同则保守返回输入未验证；最终结果页仍须同时具备查询词和结果标识。读取时遇到 `StaleObjectException` 会丢弃整次采样，在原截止时间内重新观察，不重放操作。

## 真实模型测试

先确认 App 已完成必要准备并能返回 UI，再使用电脑端已保存模型配置。脚本读取 `server/dist` 中的生产运行时；修改运行时代码后先运行一次 `npm --prefix server run build`，已有对应构建产物时不必重复构建。

```bash
desktop/node_modules/.bin/electron \
  desktop/scripts/evaluate-real-app-saved-model.mjs \
  --use-saved-model \
  --serial emulator-5580 \
  --case pdd-search \
  --query 机械键盘 \
  --output /tmp/tappilot-real-app-model.json \
  --launch-component com.xunmeng.pinduoduo/.ui.activity.MainFrameActivity
```

模型通过生产 `runAgent` 与 PhoneClient 自主选择工具，使用生产 `finish_task` 或正常最终回答结束。测试不注入专用结束工具，不根据私有判定中断模型，也不向模型提供 oracle、目标选择器或固定动作路线。生产运行时照常完成最后一次界面连续性检查，之后等待全部手机调用结束，再运行独立 UIAutomator 观察器。

报告的 `status: success` 必须同时满足：生产 `runtimeStatus: completed`、独立终态 `completionVerified: true`、行为报告 `behavior.status: passed`，并且没有运行错误。模型返回“完成”、手机接受动作或当前画面恰好到达目标，单独都不足以通过。

拼多多的 host 旁路终态判定与独立观察器使用相同公开条件：查询词可见，且“综合 / 销量 / 价格 / 筛选 / 品牌”至少出现两项，或出现明确无结果提示；加载、登录、验证和网络阻塞时不能判完成。host 仅用当前完整、可用的观察记录何时到达目标，不代替最后一次独立采样。

当前模型通道开放指定 App 内的原生点按、输入、滚动、滑动、返回和生产 `navigate_until`，并开启 `allowBatchedNavigation`。连续导航每一步保持生产 App / 窗口范围检查，跨 App 后停止后续步骤。报告增加 `toolScope.nativeBatchedNavigation: true`，实际是否覆盖连续导航要看 `steps` 中的请求及 `navigation.completedSteps` / `stopReason`；此前未开放该工具的历史报告不算连续导航验证。视觉点按 / 视觉滑动仍未开放，截图读取入口的存在也不能算视频页面视觉兜底已经通过。测试调用实际配置的模型服务并产生正常调用费用；不把密钥或 API 地址复制到脚本、命令行和报告。

## 结果解释

- `TARGET_CHANGED`、`STALE_SNAPSHOT` 且 `dispatch=not_sent`：定位或校验阶段拒绝，动作没有送出。
- `dispatch=sent` 但结果未验证：手机接受动作，仍需检查实际页面；不能按成功处理，也不能盲目重放。
- `REAL_APP_TARGET_MISSING` / `REAL_APP_TARGET_AMBIGUOUS`：测试流程当前没有足够的语义定位条件，不代表已经证明执行器出错。
- `REAL_APP_SCOPE_CHANGED`：当前 App 超出该案例范围，立即停止后续操作。
- 独立观察为 `blocked` / `unverified`：记录必要的人工步骤或未验证结果，不绕过 App 安全机制。
- `behavior.swipeRequestsWhileTargetVisible > 0`：测试登记的导航目标已经可见，模型仍请求滚动、滑动或 `navigate_until`；即使手机拒绝、未派发，也算行为失败。
- `behavior.modelToolCallsAfterGoal > 0`：完整目标首次满足后又调用了手机工具，算行为失败。`hostCompletionReadsAfterGoal` 单列生产运行时最后一次检查，不计为额外模型调用。
- `behavior.goalStopStatus` 或 `visibleTargetStatus` 为 `not_evaluated`：测试缺少对应判定，不能当作行为通过；`not_observed` 表示尚未在生产观察中取得完整目标证据。
- `MODEL_BEHAVIOR_FAILED`：终态即使正确，本次仍不通过。权限、网络或 UI 不可用导致的准备阻塞也要单列，不能算模型成功。

报告只保留动作类别、耗时、固定错误码、执行证据与独立检查的布尔值/数量；`sinceObservationMs` 表示派发前距离上次观察的时间，`contextChange` 保留变化区域/类型/数量及目标匹配状态，帮助判断是思考间页面变化还是定位失效。报告不保存完整 UI 树、截图、查询文本、模型提示词和回答。真实 App 的验证码、登录和服务端状态不会被合成 oracle 代替。模拟器通过也不能替代 vivo 等实际设备的系统兼容性测试。

## 2026-10-18 历史实测记录

以下结果来自当时的测试脚本，只说明相应终态及执行记录。它们没有按上述新增行为指标重评，不能作为生产结束链路和“目标可见不再滑动”的新验收成绩。

本轮从官方拼多多首页开始，用户手动完成登录。操作经过生产 PhoneClient / MCP ToolController，使用当前 UI 中的明确搜索入口、输入框和搜索按钮；没有 ADB 坐标点击。完整成功和失败记录保存在本机构建产物 `android/testbed/build/reports/real-app-search.json`，不纳入版本库。

已复现并修复：长文本被传输裁剪却误判为树不完整；搜索栏未变化时，被下方推荐列表加载和滚动状态变化误拒绝；入场动画中完全在屏幕外的节点被报告为可用；输入提示与真实值混淆。搜索栏修复保留目标唯一性、完整工具栏内容与几何位置校验，不放宽任意输入框、收款人、金额、受保护上下文或重叠目标。

| 实测 | 结果 |
| --- | --- |
| 不使用模型：桌面 / MCP × 立即执行 / 延迟 3 秒 | 4/4 搜索通过，12 次动作无重放，独立结果验证通过 |
| 最终提示文字校验及桌面字段保留修复 | 1/1 搜索通过，输入值与结果页均验证 |
| 针对单次 ANDROID_ERROR 的有界冷启动复现 | 5/5 搜索通过，未取得异常堆栈；不据此认定旧异常已修复 |
| 修复前真实模型 | 完成；8 次模型请求，约 50.4 秒，3 次执行前拒绝 |
| 搜索校验修复后的真实模型 | 完成；6 次模型请求，约 24.7 秒，1 次执行前拒绝 |
| 原生提示文字校验补齐后的真实模型 | 完成；6 次模型请求，约 36.3 秒，1 次执行前拒绝 |

两次修复后的模型运行仍有一次合理的 `TARGET_IDENTITY_CHANGED`：模型选中尚无明确搜索语义、且包含拍照搜索按钮的宽容器，思考期间其子控件文字、描述和位置改变。手机未派发旧目标，并返回新观察。确定性测试等候明确搜索入口后执行，因此没有这次拒绝。此处没有为了消除报错而放松校验，耗时也只是单次对照，不是统计性能结论。

仍未定位的单次 `ANDROID_ERROR` 保留在报告中。debug APK 现在只记录异常类型及最多 16 个代码位置，不记录异常消息、cause 或界面值。复现时可查看：

```bash
adb -s emulator-5580 logcat -d -s TapPilot.Executor:W '*:S'
```

本轮结论是已消除有证据的误拒绝并建立可重复测试通道，不能声称所有 App 或所有点按问题已经解决。

## 冷启动通用等待跟进

手机端现在单独判断新前台窗口的交互结构是否就绪，桌面和 MCP 共用该结果。采样在 worker 上运行，不阻塞主线程等待；新窗口最多采样 2500ms，要求匹配的独立采样跨越至少 240ms，已经就绪的当前窗口只读取一次。返回的 `readiness` 与信息完整性、动作派发及业务完成分别表达。未就绪的节点快照不能授权动作，电脑端最多补一次只读恢复，不重放操作。

生产实现没有拼多多包名分支，也没有把“搜索”设成所有 App 的启动条件。合成测试按界面行为组织，覆盖空白首帧、屏外入场、延迟挂载、持续刷新的原生列表和永久空白窗口；不同业务标签使用同一套等待逻辑。详细运行命令见 `android/testbed/README.md` 的启动观察契约部分。

本次 Android 14 模拟器验证结果保存于 `android/testbed/build/reports/cold-start-validation.json`，旧失败报告保留：

| 验证 | 结果 |
| --- | --- |
| 五种启动场景 × 桌面 / MCP | 10/10 契约通过；其中 6 次实际动作完成、2 次上下文变化安全拒绝、2 次空白超时未派发 |
| 等待时间零边界修复后的永久空白复测 | 2501ms 返回 settling，零动作 |
| 真实拼多多冷启动，不依赖模型 | 搜索结果独立验证通过，3 次动作，无重放；仍有一次 795ms 的目标条件等待 |
| 真实拼多多冷启动，电脑端保存的真实模型 | 结果独立验证通过，6 次模型请求、4 次动作、0 次工具失败，约 38.8 秒 |
| 额外的只读启动时间线 | 首次返回经过 4 次采样，已包含明确搜索描述；之后单次新读，无重复启动等待 |

这解决了把空白首帧、入场动画或已观察到的初始化变化直接交给模型的问题，但不能证明未来的异步加载已经全部结束。本次确定性搜索仍需一次目标条件等待，不能据此声称首次树已保证出现任何任务所需的控件。已有 `wait_for_ui_change.selector` 和 `act_and_observe.waitFor` 用于等待明确目标；选择器来自任务与当前界面，而不是生产执行器内的 App 专用流程。模型测试耗时是单次实测，约 33.1 秒在模型请求中，不能作为统计性能结论。
