# 合成 Android 测试场景

这是独立的开发测试 App，包名 `dev.tappilot.testbed`，只有 debug 构建，不包含在 TapPilot APK 中。它使用本地合成数据，不申请网络、悬浮窗、无障碍或其他权限，不读取真实 App 的内容。

```bash
cd android
./gradlew :testbed:assembleDebug :testbed:assembleDebugAndroidTest
adb install -r testbed/build/outputs/apk/debug/testbed-debug.apk
```

## Harness 接口

初始化场景仅启动这个合成 App，不控制其他 App、不修改系统授权：

```bash
adb shell am start -S -n dev.tappilot.testbed/.MainActivity --es scene navigation --ei seed 17 --es runId "$(uuidgen)"
```

每次启动会清空合成业务状态。固定 `seed` 使列表排列可重现。之后的操作必须通过 TapPilot 生产的读取 UI → 定位 → 动作 → 观察链路；正常开启 TapPilot 无障碍服务和允许控制仍是前提。不要将以下 oracle 命令或结果提供给执行任务的模型。

```bash
adb exec-out run-as dev.tappilot.testbed cat files/oracle.json
```

该读取利用 debug App 的 `run-as` 权限，只访问其私有合成状态文件，不重启 App。文件以 `AtomicFile` 写入，harness 读取遇到短暂换文件窗口时可重新读取一次。另有非导出、不可授权、只读的 ContentProvider `content://dev.tappilot.testbed.oracle/state`，仅供同 UID 的 instrumentation 使用；没有远程写入/reset 接口。

状态协议 `schemaVersion=1`：

| 字段 | 含义 |
|---|---|
| `runId`, `scene`, `seed`, `page` | 本轮 host UUID、场景、随机种子、真实业务页面；harness 必须检查前三项以拒绝旧结果 |
| `lastTarget` | 最后实际触发的业务控件，固定枚举 |
| `receivedInput` | `none/empty/expected/other`，不保存任意输入原文 |
| `inputField`, `focus` | 输入接收位置、当前焦点的固定标识 |
| `recipient` | `synthetic_a/synthetic_b`，用于会话目标改变场景 |
| `wrongClicks` | 错误目标的业务事件数量 |
| `revision`, `refreshCount` | 状态序号、异步刷新次数 |
| `overlayDismissed`, `completed` | 实际关闭浮层、实际完成业务目标 |

成功必须由 harness 检查 `completed=true`、预期 `page` 和 `lastTarget`、`wrongClicks=0`，不能依赖模型自述。纯拒绝场景则检查没有错误目标/输入副作用，并分别记录安全拒绝与任务完成。

## 八类场景

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

Instrumentation 是测试场景本身的合同验证，测试控件事件、真实焦点、局部 HTML、Dialog 和业务状态；它不能证明 TapPilot 生产执行器通过全部场景。生产端到端结果由独立 harness 记录：

```bash
adb install -r testbed/build/outputs/apk/androidTest/debug/testbed-debug-androidTest.apk
adb shell am instrument -w dev.tappilot.testbed.test/androidx.test.runner.AndroidJUnitRunner
```

## 生产执行链评测

仓库根目录执行（先构建 `server/dist`，设备需要已安装 TapPilot 与此测试 App，并正常开启无障碍、点击允许控制）：

```bash
node scripts/testbed-eval.mjs --serial emulator-5580 --mode fixture --output /tmp/testbed-report.json
node scripts/testbed-eval.mjs --serial emulator-5580 --scenes async_list,ime --seeds 17,29 --repeat 3
```

fixture 模式只替代模型决策；每次决策读取真实 UI 中的文本、能力和节点标识，执行仍经过生产 `runAgent → PhoneClient → ToolController → Bridge → AccessibilityService`。不使用固定坐标，也不修改生产安全策略。场景启动阶段通过生产 `get_current_app` 确认测试 App 已到前台；WebView 未加载时根据实际 UI 用 `wait_for_ui_change` 等待输入框。

真实模型模式使用调用者提供的环境变量，不读取电脑端用户密钥数据库：

```bash
# 在当前 shell 安全设置 TAPPILOT_EVAL_BASE_URL、TAPPILOT_EVAL_MODEL、TAPPILOT_EVAL_API_KEY。
node scripts/testbed-eval.mjs --serial emulator-5580 --mode model --scenes navigation,search,async_list,ime,overlay,long_list --repeat 3
```

每次生成 host UUID，并检查 oracle 中同一 `runId/scene/seed`；模型看不到 oracle，也看不到 `scenarios.json` 的 expected 状态。输出只含固定场景标识、指标、错误枚举和是否满足业务条件，不保存模型原文、界面树、输入原文或密钥。`success`、`failed`、`false_completion` 和 `unsupported_safe_rejection` 分开统计；最后一项仅是已知 fixture 策略明确拒绝不可访问的 canvas，不能计入任务成功率。真实模型返回完成而业务条件未满足，会保守记录 `false_completion`，需要后续人工区分自然语言拒绝与虚报完成。

默认只接受显式指定的 emulator serial；真机必须显式添加 `--allow-physical`，并预先人工完成系统授权。运行中不自动授予权限、解除急停或启动其他 App。

## 一次性模拟器授权（可选）

专用、无账号的临时模拟器可以使用单独的测试 bootstrap；它检查 `Build.HARDWARE` 必须是 `ranchu/goldfish`，默认跳过，只有 `bootstrap=true` 才启用。它通过 UIAutomation 读取系统设置中的实际服务入口，点击系统允许和 TapPilot 的「允许 / 恢复」，不写权限或急停数据库。它不参与评测，也不进入生产 APK。

```bash
adb -s emulator-5580 shell am instrument -w -e bootstrap true \
  -e class dev.tappilot.testbed.EmulatorSetupInstrumentedTest \
  dev.tappilot.testbed.test/androidx.test.runner.AndroidJUnitRunner
```

对真实手机仍然需要用户正常授权。模拟器系统 UI 不同导致 bootstrap 失败时，正常打开设置完成授权即可，不应放宽生产权限检查。
