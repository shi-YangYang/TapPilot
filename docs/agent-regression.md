# Agent 回归测试

不按某个 App 写固定点击脚本。模型选择当前界面上的语义目标；执行器负责验证快照、计算触点、检查限制并返回观察。新失败应先分清是目标不可操作、几何歧义、真实页面变化，还是模型没有遵循恢复反馈，再用合成反例补测试。

## 场景与预期

| 场景 | 必须满足的行为 | 用例位置 |
| --- | --- | --- |
| 中心被普通按钮局部遮挡 | 在当前目标区域内计算未覆盖点，验证后只发送一次触控 | `client-node-tap`、`client-target-refresh` |
| 完全重叠、窄缝、无点击目标 | 明确拒绝，不试探点击，不改用原始坐标重放 | `client-node-tap`、`client-tap-guard` |
| 全屏空布局与底部子按钮 | 空容器本身不被当成实心遮挡；子控件仍参与命中判断 | `client-node-tap`、`client-tap-guard` |
| 可见竞争控件超出父容器边界 | 保留其屏幕边界，不能假设父容器必定裁剪 | `client-node-tap`、`client-tap-guard` |
| 密码、敏感内容、禁用、隐藏目标 | 不通过换点或换工具规避 | `client-node-tap`、`client-tap-guard` |
| 刷新后目标移动或被完全覆盖 | 重新计算；身份不变且位置可验证才发送，否则返回新观察 | `client-target-refresh` |
| 初始停在受保护页面 | 仅提供一次明确的 `open_settings` 出口，未离开则停止；不读取或操作保护控件 | `runtime-recovery-policy` |
| 中途遇到保护、急停、连接失效、手势结果未知 | 停止后续操作，不重放可能已发生的动作 | `runtime`、`runtime-host-refresh` |
| 换节点、读取设备信息、刷新 ID 后继续失败 | 连续 3 次可信的执行前拒绝即停止；只有动作和完整观察确认进展才重置 | `runtime-recovery-policy` |
| 快照真实失效 | 最多补读一次，再由下一轮选择；不自动重发刚才动作 | `runtime-host-refresh`、`runtime-client-integration` |
| 手机连续拒绝过期快照，刷新后内容与 ID 持续变化 | 与电脑拒绝共享连续 3 次上限；前两次只读恢复，第三次停止；已接受动作的观察错误不算拒绝 | `runtime-recovery-policy` |
| 手机最后复核发现内容、位置、状态或结构变化 | 流式比较完整树并尽早拒绝，保留路径、完整性与指纹校验；固定原因经 USB/无线到达桌面 | Android `SnapshotValidationTest`、`bridge`、`wireless`、`tools`、`ui-projection` |
| 动作拒绝后模型直接结束 | 保留模型说明，但显示未完成；局部匹配、元数据和补读不能消除未恢复的动作失败 | `runtime-completion-evidence` |
| 前台元数据与先前界面不一致 | 同时清除完成依据和模型上下文中的旧界面；匹配时保留 | `runtime-completion-evidence` |
| 模型回答期间切换应用、窗口或服务会话 | 结束前只读核对一次，不增加模型轮次；变化或读取失败不能标记完成 | `runtime-completion-evidence` |
| 完整页面超过默认读取容量 | 收尾读取不能退回较小默认容量而误报截断 | `runtime-completion-evidence` |
| 模型回答与失败原因同时存在 | 桌面分别展示原因和未确认的模型说明；下次任务清除旧错误 | `desktop/test/electron-step-diagnostics.cjs` |

`runtime-client-integration.test.ts` 连接真实 `runAgent → PhoneClient → ToolController`，仅替换模型响应与手机 RPC，覆盖五条链：三步导航与局部重叠、中文输入与搜索、保护页退出、过期手势恢复、页面上下文变化后重新选择。模型替身依据最新投影的标签和能力选目标，手机替身每次生成新快照和节点 ID；断言手机收到最新引用、每轮最多一次动作、动作结果直接成为下一轮观察，并核对请求数和读取数。

## 相关回归命令

在 `server` 目录执行：

```bash
node --import tsx --test \
  test/client-node-tap.test.ts test/client-tap-guard.test.ts \
  test/client-target-refresh.test.ts test/client-tools.test.ts \
  test/runtime-client-integration.test.ts test/runtime-recovery-policy.test.ts \
  test/runtime-host-refresh.test.ts test/runtime-progress.test.ts \
  test/runtime.test.ts test/runtime-argument-repair.test.ts \
  test/runtime-completion-evidence.test.ts \
  test/context-action-guidance.test.ts test/ui-projection.test.ts \
  test/model-projection-serialization.test.ts test/model-output-limit.test.ts \
  test/model-transport.test.ts
```

这是动作匹配和恢复策略修改时的相关范围，不要求每次文案修改运行。失败后只修复并重跑受影响的检查；已通过且代码未变的用例不重复执行。

结束核对只检查当前会话、应用和窗口是否连续，不证明模型的自然语言结论一定正确，也不验证同一窗口中的所有动态内容。它不会把截图或新 UI 再发给模型；耗时和调用数计入“结束核对”。

## 真机验收

在电脑 TapPilot 配置自己的模型并连接测试手机。测试期间保持手机解锁，不同时手动切换页面。使用普通导航与只读任务，例如进入电池页读取状态、返回桌面打开指定 App、在搜索框输入测试词并读取结果。付款、发送、删除、权限授权、验证码等交给用户完成。

每个任务分别记录是否到达预期页面、模型请求数、动作数、执行前拒绝数、补读数和耗时；以手机上的实际结果确认，不以 RPC 的 accepted 代替成功。失败时保留固定错误码及耗时，构造不含真实聊天或凭据的合成用例；不保存完整用户界面作为测试夹具。

合成测试验证执行逻辑，真机测试验证 Android 事件与 App 的可访问性实现，两者不能互相替代。Accessibility Tree 未提供绘制顺序、透明遮挡和所有自绘控件；完全重叠且无充分证据时仍应拒绝。视觉兜底可作为后续独立适配能力，本轮没有以猜测坐标替代它。
