# 原生导航动态文字刷新修复与验证

本轮修复位于 Android 执行器，桌面与 MCP 共用；没有按 Clock 包名、资源 ID 或时间格式建立例外。版本保持不变，没有创建 commit，没有操作或更新物理手机。最终 APK 已在独立 Android 14 / arm64 模拟器验证。

## 实现范围

目标唯一、原生 Tab 角色与单行单选 collection/item 元数据完整、整个导航栏及其布局不变时，手机可以自行核验栏外独立被动标签的文字变化，继续切换未选中的 Tab。最多接受 8 个变化标签，不要求模型提供 `allowedLabelChanges`。

完整结构、几何、目标内容、状态和原生元数据仍参与验证。表单、敏感操作、可识别的收件人/账号/金额上下文及不完整证据关闭自动路径。普通按钮、输入和滚动不会因页面存在 Tab 而获得文字豁免。该机制是跨 App 的原生组件规则，并非能理解任意业务文字是否无关的分类器；自绘导航或未提供这些语义的组件继续使用原有严格校验。

持续刷新的页面在首次读取时也使用相同原生条件进行有界稳定观察，最新文字仍返回给模型。动作前仍重新采样和定位，最多派发一次；结果返回 `contextVerification:native_tab_navigation`、`automaticLabelChangesCount` 和动作后的界面。Android 接受点按与实际完成任务分别记录，业务完成由独立观察验证。

## 冷启动中发现并修复的第二个问题

第一轮 8 个用例有 1 个启动刷新失败。复现表明目标及全树 9 个节点发生整体横移，根节点宽高始终为 1080×2400，前后横坐标差为 149 像素；另一次为 227 像素。这是几何变化，拒绝点按正确，但初次观察过早返回 ready。

诊断还确认节点与系统窗口可能在启动时一起偏移。因此只比较两者是否相同不足以证明已归位。最终规则使用 API 34 的窗口内根坐标、屏幕坐标、系统窗口和显示屏尺寸：仅在根节点完整覆盖窗口且未缩放时检查坐标一致性；若窗口恰好铺满显示屏，还要求窗口回到显示屏原点。未知、部分或缩放根节点不套用这项推断。窗口归位后沿用 240ms 连续稳定采样和原有 2.5 秒总期限，没有添加固定 sleep，也没有放宽动作的几何校验。

最终运行的调试证据实际出现了 `ROOT_WINDOW_TRANSFORM` 样本拒绝，随后正常返回 ready；不是只靠重复运行恰好通过。临时坐标日志已移除，保留的调试日志仅包含固定原因枚举。

API 依据：[Android getBoundsInWindow](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo#getBoundsInWindow(android.graphics.Rect))；屏幕节点经过窗口矩阵变换的实现见 [Android 14 AOSP](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-14.0.0_r1/core/java/android/view/AccessibilityInteractionController.java)。

## 最终验证

测试通过生产 PhoneClient / MCP 调用执行器。ADB 仅用于模拟器安装、启动和测试准备；没有预设坐标、模型动作路线或自动重放失败动作。

| 验证 | 最终结果 |
| --- | --- |
| NodeActionGuard 定向单测 | 70 项通过 |
| WindowReadiness 定向单测 | 43 项通过 |
| 结果投影定向测试 | 通过；保留枚举和计数，不泄露原生私有证据 |
| Android / server 构建 | 通过 |
| 首次打开即每 80ms 刷新 | 桌面、MCP 均一次点按完成 |
| 保留已就绪快照后启动刷新 | 桌面、MCP 均一次点按完成 |
| 普通按钮遇到文字刷新 | 两个入口均拒绝，目标回调 0 次 |
| 原生 Tab 页面收件人变化 | 两个入口均拒绝，目标回调 0 次 |

设备用例合计 8 个，4 个完成动作、4 个符合预期的拒绝，失败 0。每个用例保留同一目标快照，独立观察至少 3 次刷新后只请求一次目标动作；不补读 UI、不传文字豁免、不替换句柄。

使用桌面已保存模型配置、生产 `runAgent` 和最终 APK，再运行两个真实 App：

| App / 任务 | 模型请求 | 运行耗时 | 实际结果 |
| --- | ---: | ---: | --- |
| Fossify Clock 1.6.0 / 打开 Stopwatch | 2 | 13.8 秒 | 思考约 4.9 秒后一次点按成功；自动核验 1 个变化标签，显式豁免 0，工具错误 0 |
| AntennaPod 3.12.3 / Playback → Smart mark as played | 6 | 31.6 秒 | 打开目标选项对话框；连续查找实际滚动 1 次即找到目标，工具错误 0 |

独立 UIAutomator 验证 Clock 秒表页签已选中、值为 0.0 且未启动；AntennaPod 目标选项及当前选中状态符合预期。两次模型均正常结束，`modelToolCallsAfterGoal=0`、`swipeRequestsWhileTargetVisible=0`；各有一次宿主最终复核读取，单独计数。

Clock 模型测试还验证初始页签为 Clock、Stopwatch 未选中，避免把已经在终点的页面记为成功。准备时曾因页面已在终点被拒绝，该次模型请求数为 0，未计入成功。应用在暂停时保存页签，准备过程通过生产点按切回 Clock 并返回桌面，再冷启动进行测试。

中间版本的 AntennaPod 任务虽完成，出现过一次 `UI_NOT_READY`；最终 APK 复测未再出现。这是单次复测结果，不能据此宣称该错误在所有界面消失。

## 证据与复跑

- [脱敏 JSON 报告](../android/testbed/build/reports/native-tab-refresh-validation-2026-10-18.json)：包含最终用例、真实模型步骤、独立终态，以及早期失败和不完整修复的记录。位于构建目录，清理 build 会删除。
- [执行协议](protocol.md)：完整适用条件、字段和权限边界。
- [刷新测试命令](../android/testbed/README.md#原生-tab-导航与持续刷新)、[真实 App 模型运行方法](multi-app-testing.md)。设备运行必须串行。
- [最终 Android APK](../android/app/build/outputs/apk/debug/app-debug.apk)，SHA256：`f9331650f8edc12419de3695102707a4111ba15446c9fc0c5db5a7046eba184c`。

以上结论覆盖本轮原生组件条件、模拟器和两个实际模型任务，不替代其他厂商真机、双开微信、自绘界面或动态视频的验证。
