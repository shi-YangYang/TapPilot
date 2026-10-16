# 独立客户端实施与验收

最终目标：电脑和手机各有 TapPilot 客户端，用户配置自己的 LLM；减少模型与设备往返；每个可运行版本验证后 commit。

## 版本

- v0.1：原生无障碍 + USB MCP 基线，提交 `a2d746e`。
- v0.2：桌面客户端、手机独立任务循环、加密模型配置、一步动作与观察、运行指标。完成本地构建、协议与客户端测试；真实手机/用户模型联调待后续，详见 validation.md。
- 后续：配对无线连接，完整双端联调，按发现的问题继续迭代。

## 运行边界

桌面：Electron 受限 renderer → main process → LLM runtime / 手机工具适配 → USB bridge → Android 无障碍。

手机：原生任务 UI → 前台任务服务 → 用户配置的 HTTPS LLM → 本 App 无障碍执行器。任务运行不依赖桌面进程；Android 和厂商后台限制仍需实际设备验证。

MCP 保留给外部 Agent。独立客户端不把 Codex 当作运行时，也不把模型 API Key 写入 MCP 工具输入。工具结果和第三方界面文本始终作为不可信数据。应用本身的配置、授权和恢复界面继续受保护，不能由手机自动化接口点击。

## 模型协议

先实现 Chat Completions 兼容接口，用户配置 API 地址、模型名和密钥。Base URL 自动补 `/chat/completions`；已填写完整 endpoint 时不重复补。支持工具 schema、assistant tool_calls 和关联 tool_call_id 的结果回传。协议依据 [官方 Chat Completions 参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)，不假定所有厂商原生 API 或模型均兼容。

客户端验证响应结构、工具 allowlist 和参数。网络失败、未知动作结果、模型格式错误均不自动重试变更。轮次、执行时间、请求/响应与上下文大小有界；取消后不再派发后续动作。高风险提交停止并交用户手工完成，不提供模型可调用的自批准机制。

## 效率验收

1. 任务启动宿主预读 UI，首个模型回合可以决策，不必先请求读取。
2. 单个 `act_and_observe` 完成一次原生动作、事件等待、新 UI 读取：设备 RPC 数量由三次降为一次。
3. 去掉空字段与默认 false 属性，保留节点身份、顺序、父子关系、边界、禁用状态和所有可见文字。
4. 历史快照被后续快照替换，不把所有完整 UI 一直重复发送。
5. 显示 modelMs、toolMs、totalMs、modelRequests、toolCalls；组合工具返回 actionMs、waitMs、observationMs、totalMs。只使用本地单调时钟，不跨设备相减墙上时钟。

合成测试证明协议和往返减少，不代替真实模型决策能力、OEM 兼容性或完整任务速度实测。

## 仍需真实外部状态的检查

配置用户自己的模型服务后，用相同“设置 → 电池”任务测试两个客户端，确认不运行 Codex 仍可自主完成。API 密钥应在已构建客户端中填写，不发送到开发对话，不保存到仓库或测试夹具。

真机必须已连接并由用户开启服务。开发自动化不能通过写系统设置、批准 socket 或伪造用户操作开启权限。
