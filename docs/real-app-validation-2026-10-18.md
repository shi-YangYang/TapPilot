# 2026-10-18 真实 App 与真实模型验证

后续 Clock 动态文字问题的修复、冷启动几何诊断及最终真实模型复测，见[原生导航刷新验证](native-tab-refresh-validation-2026-10-18.md)。下文保留最初批次的结果，不覆盖历史失败。

在 Android 14 / API 34 / arm64 的独立模拟器 `emulator-5580` 上，使用电脑端已保存的模型配置、生产 `runAgent`、PhoneClient 和 Android 执行器，完成了 8 次真实模型任务，涉及 6 个真实 App。7 次任务完成并通过独立 UIAutomator 终态检查，1 次失败。单次功能样本不能推算成功率，完成也不代表过程中没有错误。

本次没有修改版本号或创建 commit，没有更新或操作物理手机。模型没有收到测试选择器或动作路线；测试不使用专用结束工具或在目标出现时提前中止模型。完成必须同时满足生产运行时正常结束、独立终态正确、行为检查通过。

## 新安装的应用

| App | 实际版本 | APK 来源 | 本轮状态 |
| --- | --- | --- | --- |
| Fossify Calculator | 1.4.0 / 10 | [官方发布](https://github.com/FossifyOrg/Calculator/releases/tag/1.4.0) | 真实模型计算任务完成 |
| Fossify Clock | 1.6.0 / 10 | [官方发布](https://github.com/FossifyOrg/Clock/releases/tag/1.6.0) | 真实模型任务失败，已得到无模型复现 |
| NewPipe | 0.29.1 / 1015 | [官方发布](https://github.com/TeamNewPipe/NewPipe/releases/tag/v0.29.1) | 停在系统通知权限界面，未发起模型任务 |
| Fossify File Manager | 1.6.2 / 14 | [官方发布](https://github.com/FossifyOrg/File-Manager/releases/tag/1.6.2) | 要求全部文件访问权限，未发起模型任务 |

四个 APK 均通过 APK 签名校验。下载地址、包名、版本和 SHA256 保存在下方 JSON 报告中；签名校验成功不等于另行确认发布者身份。另使用模拟器里已有的拼多多、Wikipedia、AntennaPod 和 Markor。未自动处理系统授权，准备受阻不计作任务通过。

## 模型任务结果

| App / 任务 | 模型请求 | 运行耗时 | 结果及过程中保留的问题 |
| --- | ---: | ---: | --- |
| Calculator / 实际输入 12 × 13 | 7 | 25.1 秒 | 完成，独立读到 156；6 次点按，无工具错误 |
| Wikipedia / App theme 面板 | 6 | 37.3 秒 | 完成；中途 `NOT_SCROLLABLE`、`UI_NOT_READY` 各一次 |
| AntennaPod / Playback 选项 | 7 | 29.1 秒 | 完成；中途一次 `UI_NOT_READY` |
| Markor / 便签内搜索 | 4 | 19.4 秒 | 完成，无工具错误；已有目标便签正文，不能算重新写正文的验证 |
| Clock / 打开 Stopwatch | 2 | 5.3 秒 | 失败；两次 `TARGET_CHANGED / PAGE_CONTEXT_CHANGED`，均未派发 |
| 拼多多 / 搜索机械键盘 | 5 | 44.4 秒 | 完成；中途一次 `TARGET_CHANGED / TARGET_IDENTITY_CHANGED` |
| Markor / 中文异值输入 | 3 | 19.9 秒 | 完成；实际改写编辑器并核对新文字，无工具错误 |
| AntennaPod / 开放连续查找工具后复测 | 6 | 28.1 秒 | 完成，无工具错误；模型选择一次普通滚动，未调用连续查找 |

七个完成任务的 `swipeRequestsWhileTargetVisible` 与 `modelToolCallsAfterGoal` 均为 0：测试登记的导航目标可见时没有请求滑动，完整验收条件满足后没有额外模型工具调用。每个任务另有一次生产运行时的最终界面复核，单独计数。判定仅覆盖这些任务登记的可见目标，不代表所有页面的任意目标。

前七次任务开放原生单步操作。最后一次另外开放生产 `navigate_until` 并开启 `allowBatchedNavigation`，但模型没有实际调用它。因此本轮没有连续查找工具派发的真实 App 覆盖，也没有 `tap_visual` / `swipe_visual` 或动态视频页面的验证。

## Clock 失败的对照

目标 Stopwatch 标签以及实际可点击父节点均保持匹配，发生变化的是目标区域外的一个时间文字节点。手机端仍按全页上下文变化拒绝。独立读取确认没有进入秒表页面，不能记作成功或模型误报成功。

不调用模型，读取后等待 3 秒再点按，同样得到 `PAGE_CONTEXT_CHANGED`，派发次数为 0。检查实际页面后，只对与打开秒表无关的时间节点声明已有的 `allowedLabelChanges`，同样等待 3 秒，一次点按成功，独立 UIAutomator 确认秒表页签选中、值为 0.0、计时尚未启动。

这一对照说明既有执行接口可以完成该动作；默认真实模型没有正确使用这份声明，自动任务仍失败。不能把人为提供声明的确定性通过算作模型已经学会，也没有新增 Clock 包名适配或按时间格式全局忽略内容。后续需要解决无关动态状态的语义声明与执行合同衔接，同时保留收件人、金额等上下文校验。

Wikipedia 的 `NOT_SCROLLABLE` 请求选择了实际 `scrollable:false` 的节点；执行器拒绝符合当前节点证据。两条 `UI_NOT_READY` 以及拼多多的目标变化拒绝保留在报告中，本轮没有证据证明它们全部消失。

## 代码、检查与证据

本轮补充真实 App 用例及观察器白名单，移除评测专用结束捷径，增加旁路行为判定与生产连续查找工具支持。测试脚本不会因为达到目标而替模型结束。相关模型评测脚本测试 17 项通过；多 App 脚本测试 11 项通过，白名单修改后定向检查通过；Android 观察器测试 APK 构建及模拟器初始化通过。未重跑无关全项目检查。

- [脱敏运行报告](../android/testbed/build/reports/real-app-model-2026-10-18.json)：保留八次模型运行、两次 Clock 确定性对照、耗时、错误、行为指标和独立终态；不包含完整界面、模型回答、密钥或真实聊天。
- [运行命令与验收规则](multi-app-testing.md)：真实模型使用电脑端已保存配置，所有设备测试必须串行执行。
- [拼多多测试说明](real-app-testing.md)：包含搜索结果判定及权限、登录、网络阻塞边界。

JSON 位于本机构建目录，未纳入版本控制；清理 build 后需重新生成。模拟器结果不代替厂商真机、双开微信或视觉操作的验证。
