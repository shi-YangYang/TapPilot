# 失败学习与回归评测实施记录

本轮按阶段实施、验证、提交；保持 0.3.19 不变。学习只能使用脱敏结构化证据。正在执行的任务固定使用启动时的策略，候选经验或代码不能修改运行中的控制器。

## 实施阶段

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| 1 | 有界脱敏诊断、运行链接入、错误分类与清除命令 | 已完成，44f003d |
| 2 | 120 个确定性场景、独立判定器、真实模型评测入口、Android 合成测试 App | 已实现，验证记录见下文 |
| 3 | 失败总结候选、经验验证与检索、按任务固定策略、停用与回滚 | 待实施 |
| 4 | 隔离代码修复候选、复现及保留集门禁、人工评审产物 | 待实施 |

## 验证约束

此次涉及运行时、持久化和评测基础设施，按 S3 范围验证相关子系统。已通过的检查不无理由重复。合成夹具不使用真实聊天、输入、账户或屏幕内容；真实模型测试必须显式启用，密钥只从本地配置或环境读取，不进入报告。

评测分别统计目标达成、安全拒绝、失败和证据不足。`accepted`、界面变化、模型自称完成均不能单独证明目标完成。动作结果未知时不能为了通过测试而重复动作。

Android 测试 App 与线上 App 分包。ADB 只负责安装、初始化合成场景和读取独立 oracle；测试动作走生产控制链。测试 oracle 不发给模型。无法完成的设备验证应如实标记，不能用 fixture 成功代替真机结果。

## 设计边界

- 总结是待验证假设，不是自动生效的指令。
- 线上检索使用固定枚举策略和有限匹配，不额外增加每步模型调用。
- 离线预算限制任务数、时间及候选数，不重新设置模型 token 或输出上限。
- 修复候选不修改评测器、权限规则、急停和保护逻辑，不自动安装或发布。
- 激活经验需要评测证据；代码修改需要独立评审。失败可停用，旧任务不热更新。

## 验证记录

- 诊断基础与运行链集成：13/13 通过，覆盖敏感字段拒绝、容量、队列、软链、文件所有权、清除边界和异步观察者异常。
- 确定性评测基础：120 场景，100 目标达成、20 安全拒绝；后者不计为目标达成。另覆盖假完成、误点、不同合法操作路径。这里只代表 fixture 策略下的结果。

## 本地诊断

桌面任务自动记录固定错误枚举、动作类别和耗时，最多 500 条/512 KiB；不记录任务和界面正文。`unknown` 表示当前证据不足，不代表动作未执行。只对可信宿主拒绝记 `not_sent`；手机接受动作后记 `sent/accepted`，仍不能推断任务完成。

```bash
cd server
npm run build
npm run diagnostics -- summary
npm run diagnostics -- clear
```

默认数据目录为 macOS 的 `~/Library/Application Support/TapPilot`。开发环境或其它系统用 `--root /path/to/userData` 指定已有目录。清除命令仅删除本模块的事件文件，不删除模型配置。模型HTTP状态等不在固定枚举内时归为 `UNKNOWN`，不保存服务返回的原文。

## 可复现评测

```bash
cd server
npm run eval -- --split all --mode fixture --output /tmp/tappilot-eval.json
# 单场景重复；模型需 TAPPILOT_EVAL_BASE_URL / MODEL / API_KEY 配置
npm run eval -- --split train --mode model --scenario fresh_ids-1 --runs 3 --output /tmp/tappilot-model.json
```

默认不请求外部模型。真实模型只支持现有 OpenAI Chat Completions 兼容协议；未知协议明确拒绝。可用 `--max-tasks` 和 `--timeout-ms` 限制离线评测开销。初始 120 场景为 12 类机制 × 10 seed，70 开发用例、50 保留用例；候选生成不应读取保留集，禁止按其结果反复调优后仍声称独立泛化。

已保存桌面模型可使用 Electron 在进程内读取钥匙串，不需要导出密钥：

```bash
cd desktop
./node_modules/.bin/electron scripts/evaluate-saved-model.mjs --use-saved-model --output /tmp/tappilot-saved-model.json
```

该命令明确执行 6 类场景 × 3 次，最长 20 分钟；只发送合成数据。报告不含模型配置或原始模型响应。

首次真实模型基线（18 次）为 15 目标达成、2 安全拒绝、1 会话切换后错误继续并假完成，43 次模型请求，累计约 194 秒。该失败说明会话切换不能依赖模型自主停止，需增加宿主强制边界；后续修复另记，不覆盖这份基线。

会话保护修复：任务固定首次可信完整观察的 session；节点快照失效或动作后观察缺失不会清除该身份。任何新 session 都在下一次模型决策前停止。相关运行时检查 15/15 通过，涵盖失效补读、观察缺失、收尾检查和主动忽视拒绝的模型。随后只复测原失败场景，真实模型 3/3 安全停止、0 操作派发、0 假完成，总计 3 次模型请求。单独复现可在桌面评测命令后加 `--scenarios session_change-1`。

Android 合成 App 的构建、安装、独立 oracle 与场景说明见 [testbed README](../android/testbed/README.md)。生产链示例：

```bash
node scripts/testbed-eval.mjs --serial emulator-5580 --mode fixture --output /tmp/tappilot-android.json
```

本次 API 34 模拟器验证：10 个场景合同测试通过，新增 runId 和输入相关调整后 4 个受影响测试通过；正常授权 UI bootstrap 通过。生产完整链验证 7 个可访问场景成功、0 误点；自绘 canvas 没有视觉工具，明确停止。首次 WebView 因窗口尚未前台而失败，测试 harness 增加前台确认和按实际 UI 等待表单后，单场景复测通过。未重跑其余已通过场景。该结果不代表全部品牌手机或第三方 App 的兼容性。
