# 隔离修复候选

本模块运行开发侧的修复实验，不在手机任务中修改代码。首版只允许替换 `server/src/runtime/ui-projection.ts` 中 `bounds`、`meaningful`、`projectNode`、`projectNodes` 四个展示辅助函数。动作执行、目标校验、权限、保护提示、错误枚举、测试、依赖及构建文件均不在修改范围。

## 使用

从 `server` 目录执行，先构建服务端。`BASE_SHA` 必须是完整的 40 位 Git commit SHA；不自动采用工作区未提交改动。

```sh
node dist/repair/cli.js prepare --repo .. --baseline "$BASE_SHA" > candidate.json
```

修改候选 JSON 的 `replacements[].content`，保留原始文件与函数哈希。候选只接受完整的允许函数声明，不接受 shell、任意文件路径或任意补丁操作。事件使用固定字段，例如以下合成实验描述：

```json
{"schemaVersion":1,"actionKind":"tap_element","errorCode":"NODE_NOT_ACTIONABLE","reason":"NO_CLICKABLE_TARGET","count":3,"mechanism":"fresh_ids","scenarioId":"fresh_ids-1"}
```

`selectRepairIncidents(groups)` 可以从脱敏诊断聚类中选择实验候选；场景映射是待验证的假设，不代表已找到根因。把选择结果保存为 `incident.json`，建立输出目录后运行：

```sh
node dist/repair/cli.js evaluate --repo .. --baseline "$BASE_SHA" --incident incident.json --candidate candidate.json --out ./repair-artifacts --budget-ms 60000
```

单次最多 3 个候选、总预算最多 120 秒。执行基线及候选的训练与保留用例，生成私有目录中的 `report.json` 和 `candidate.patch`。基线未复现、目标失败未改善、任何误操作、假完成、安全或成功回退都会拒绝。补丁不会自动应用、提交、安装或发布。

需要模型提出候选时，显式使用 `propose`，并在可信父进程配置 `TAPPILOT_MODEL_BASE_URL`、`TAPPILOT_MODEL_KEY`、`TAPPILOT_MODEL_NAME`。不要把密钥写进候选、命令参数或提交文件。默认 `prepare/evaluate` 不调用付费模型。

```sh
node dist/repair/cli.js propose --repo .. --baseline "$BASE_SHA" --incident incident.json > candidate.json
```

模型只接收允许源码和固定诊断元数据。候选仍必须经过同一套严格解析及隔离评测，模型的解释或声称成功不会成为验收证据。

## 隔离及证据范围

- 需要 macOS `sandbox-exec`。运行前真实探测外部文件读取、联网和子进程创建均被拒绝；不可用时报告 `blocked/SANDBOX_UNAVAILABLE`，没有无沙箱降级路径。
- 候选只得到合成的原始 UI JSON，在受限子进程输出投影 JSON。系统运行库及隔离目录可读，只有隔离的 scratch 目录可写。环境重建，不继承用户模型密钥、代理或 Node 注入参数。
- 独立的业务状态、固定模型策略、执行守卫和验收器留在可信父进程。候选不能访问用例期望值、修改测试、伪造测试报告或操作真实手机。
- 每次投影最多 1.5 秒，超时会终止进程组；子进程创建被系统策略禁止。协议及输出大小有上限，不保存候选的原始 stdout/stderr。
- 报告记录候选基线 SHA、源码及候选哈希、可信评测器源码指纹；评测器在运行期间变化会拒绝报告。基线与候选始终使用同一份可信评测安装。
- `needs_review` 仅表示允许范围内的合成实验通过，仍需代码审查。`scope=synthetic_projection_helpers_only`、`realIncidentVerified=false` 明确说明其不证明真实 App 中的原问题已经解决，也不能用于宣称任意执行器代码都能自动修复。

自动化验证使用临时 Git 仓库中的合成损坏投影函数：基线确实失败，替换函数后完整训练及保留场景通过，并确认原始仓库与 HEAD 未改变。它验证修复流水线，不将人为构造的缺陷当作生产缺陷。
