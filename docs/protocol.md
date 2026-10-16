# TapPilot 本机协议

本协议连接电脑端工具适配层与 Android 无障碍服务。独立客户端自行运行 LLM 循环；外部 Agent 可使用标准 MCP stdio。下述 NDJSON 是内部设备协议。

## 动作和界面一起返回

`act_and_observe` 将一次动作、事件等待、新 UI 读取合并在单个设备 RPC：

```json
{"id":"synthetic-request","method":"act_and_observe","params":{"action":"click_element","arguments":{"snapshotId":"session:2","nodeId":"n7"},"waitMs":350}}
```

`action` 仅允许 `click_element`、`input_text`、`scroll`、`swipe`、`press_key`、`open_settings`。`arguments` 按对应原工具的严格 schema 验证，不接受额外批准字段。`waitMs` 为 0–1500，默认 350；从 v0.3.9 起，等待动作结果 revision 之后的事件，再等待连续 120ms 无新事件，始终受原 `waitMs` 总上限约束。v0.3.16 的组合手势先等待 Android 完成回调，再开始这个观察预算；回调等待有独立上限，整个组合调用受 9 秒内部期限约束。无事件或持续刷新时到上限结束，0 表示不等待。不把动作自身推进 revision 当作导航完成。根节点暂时为空时，仅在剩余观察预算内等新事件后补读，最多补读两次，不重新执行动作。新树仍需由模型检查，动画可能继续发生；公共 `wait_for_ui_change` 行为不变。

结果含 `action`（原动作结果）、`observation`（完整新快照）、`timings`（`actionMs`、`waitMs`、`observationMs`、`totalMs`）。动作失败时返回 `ok:false`；动作已接受但观察失败时返回 `ok:true`、保留 `action` 并附 `observationError`。后者不可重放动作。`GESTURE_CANCELLED` / `GESTURE_COMPLETION_TIMEOUT` 分别表示手势中断/未确认完成，组合结果保留 `accepted:true`，并标记 `completion:"cancelled"/"unknown"`；桌面停止任务，避免把未知结果当作可安全重试。正常完成的组合手势标记 `completion:"completed"`。

MCP manual 模式继续通过原有独立 CLI 批准内部点击/输入/手势的单次参数，组合调用不改变批准通道。宿主记录新的 observation 快照；观察失败时旧引用已清除。独立客户端另对疑似敏感提交停止，交用户在手机手工完成。

从 v0.3.14 起，外部 MCP 的 `click_element`、`input_text`、`scroll`、`swipe`、`press_key`、`open_settings` 也由宿主自动映射到一次 `act_and_observe` 设备 RPC，默认 `waitMs:350`。参数及原动作结果字段保持兼容，在原结果旁新增 `observation`、`timings` 和可选 `observationError`。例如独立点击返回 `result:{accepted:true,action:"click",revision:12,...,observation:{snapshotId:"session:3",revision:14,...},timings:{...}}`；显式组合工具仍将原动作结果放在 `result.action` 对象内。

模型直接检查返回的 `observation`，并用它的 `snapshotId/nodeId` 执行下一步，不需要为取得节点再次读取。动作顶层的 `revision` 仍是接受动作时的版本，观察有自己更新后的版本。目标未出现、界面仍在变化、树被截断或节点失效时，仍可读取或等待以补足证据；有界事件等待不保证所有页面加载完成。派发后即使超时或断线，也清除旧快照和批准；观察内容无效时保留已接受动作、返回 `observation:null` 与 `observationError`，不得自动重放。

发给模型的 UI 省略空字符串、null、默认 false 能力属性（保留 `enabled/checked/selected/focused:false`）；控制器仍使用完整快照校验。节点身份、父子关系、顺序、边界和文字不变。

## 通道与消息边界

Android 在 `localabstract:tappilot` 接受 Unix socket 连接，不监听网络端口。Mac 为选定且已获用户授权的 ADB 设备创建临时转发：

```sh
adb -s DEVICE_SERIAL forward tcp:0 localabstract:tappilot
```

转发返回的端口用于连接 `127.0.0.1`。主机校验监听地址必须是回环地址；手机校验 peer UID 为 2000 或 0。ADB/手机连接中断、无障碍服务关闭、进程重启均可能中止请求；连接恢复后必须获取新状态，不重放旧动作。

每个消息是一个 UTF-8 JSON 对象，以 `\n` 结尾。字符串中的换行使用 JSON 转义，中文直接采用 UTF-8。TCP/Unix stream 的一次 `read` 不等于一条消息，接收方按换行缓存拆包。每条连接只处理一组请求/响应，随后关闭；请求和响应通过 `id` 匹配。`id` 是 1～128 字符的字符串。

```json
{"id":"req-1","method":"get_ui_tree","params":{}}
```

```json
{"id":"req-1","ok":true,"result":{},"meta":{"durationMs":8}}
```

```json
{"id":"req-2","ok":false,"error":{"code":"STALE_SNAPSHOT","message":"Read the current UI again before acting.","retryable":true},"meta":{"durationMs":2}}
```

`result` 依具体方法变化；`meta.durationMs` 是设备端处理耗时，不等于模型思考耗时。主机另外记录端到端调用耗时。失败必须返回错误，不能通过空结果或 `ok:true` 隐藏未执行动作。

MCP 外层由官方 SDK 处理，工具结果在 `structuredContent` 及文本 content 中提供 `{ok,result|error,meta}`，工具失败时同时设置 `isError:true`。主机错误可额外包含 `error.details`（例如待确认请求），不会把原始异常或 ADB 输出直接交给模型。`get_device_info` 是诊断例外：设备列表成功时外层可为 `ok:true`，但其中 `result.bridge.ok:false` 仍明确表示手机服务未连通，调用者必须检查该字段。

## MCP 工具参数

参数均为 JSON 对象；未声明字段由 MCP 层拒绝。空参数工具传 `{}`。

| 工具 | 参数 | 结果语义 |
| --- | --- | --- |
| `get_device_info` | `{}` | ADB 设备、选中 serial、主机停止状态，以及 bridge 诊断；手机端附 `protocolVersion:1`、session、Android 版本、锁屏/停止状态 |
| `get_current_app` | `{}` | `packageName,windowId,activityHint,activityHintIsAuthoritative:false,revision,stopped` |
| `get_ui_tree` | `maxNodes?`、`maxDepth?` | `snapshotId,revision,packageName,windowId,nodes,truncated` |
| `find_element` | `selector`、`maxResults?` | 新快照元数据与 `elements`；无匹配返回空数组，有截断时标记 `truncated` |
| `click_element` | `snapshotId,nodeId` | 原生点击；可明确报告向上选择的可点击祖先 |
| `input_text` | `snapshotId,nodeId,text` | `ACTION_SET_TEXT` 替换整个字段，空串清空；最多 4096 字符，不提供 Enter/发送动作 |
| `scroll` | `snapshotId,nodeId,direction` | `direction` 为 `forward/backward/up/down/left/right`，目标必须为可滚动节点 |
| `swipe` | `snapshotId,startX,startY,endX,endY,durationMs?` | 绑定快照的屏幕像素手势；直接设备调用接受后返回 `completion:"pending"`；组合调用从 v0.3.16 起等待回调并报告完成状态 |
| `press_key` | `key` | `back/home/recents` 三种系统全局动作 |
| `wait_for_ui_change` | `sinceRevision,timeoutMs?,selector?` | `changed,timedOut,matched,revision`；带 selector 时还含匹配节点及快照元数据 |
| `open_settings` | `{}` | 标准 `Settings.ACTION_SETTINGS` 打开设置首页，后续仍靠树选择页面 |
| `emergency_stop` | `{}` | 主机先停止，再尝试停止手机；可返回手机停止未确认错误 |
| `take_screenshot` | `{}` | 第一阶段返回 `NOT_IMPLEMENTED` |

selector 支持 `text`、`textContains`、`resourceId`、`contentDescription`、`className`、`clickable`、`scrollable`、`editable`、`enabled`，至少一个条件；所有条件 **AND**。除 `textContains` 为区分大小写的子串外，其余字符串精确匹配；不支持正则。`text`、`textContains`、`contentDescription` 最多 1000 字符，`resourceId` 最多 512，`className` 最多 256。节点只返回前 1000 字符，查找长文本时也应使用这一范围内的短片段。

```json
{"selector":{"textContains":"电池","enabled":true},"maxResults":20}
```

查找返回的文字标签可能不可点击而其父级可点击，也可能匹配多个条目；应先检查候选和上下文。未查到时检查 `truncated`、语言、滚动容器和当前包名，不能断言设备没有该功能。

| 资源 | MVP 上限 / 默认 |
| --- | --- |
| UI 树 | `maxNodes` 默认 300，上限 500；`maxDepth` 默认 20，上限 40；遍历节点预算为输出上限的四倍；节点数组按序列化 UTF-8 字节计量，最多 `1MiB - 8192`，留出元数据空间 |
| 查找 | 默认 20 条，上限 100；内部以 500 节点、深度 40 采集 |
| 手势 | `durationMs` 默认 350，范围 50～2000；坐标必须位于手机当前屏幕内 |
| 事件等待 | 默认 10000ms，上限 25000ms；MCP 最小 1ms，直接设备协议允许 0ms |
| 设备请求 | 单条请求最多 256KiB；读请求期限约 10 秒 |
| 主机响应 | 单条响应最多 4MiB；默认设备调用期限 10 秒，等待工具为 `timeoutMs + 3000ms` |
| 主线程命令 | 8 秒；排队但尚未开始的超时命令取消，已派发的系统动作仍需重新观察 |
| 并发 | Android 4 个 socket 工作线程、8 个排队请求，最多 2 个事件等待者以给控制请求留出线程；主机同一时间最多一个动作执行，急停不等待动作队列 |

## 快照和节点引用

每次服务连接有独立 session；UI 事件推动 revision。快照以 session、revision 和本次采集身份关联，返回的节点引用只在所属快照有效，不能将 resourceId、文本、树路径或列表下标视为永久 ID。

节点动作使用调用者刚刚读到的 `snapshotId` 和 `nodeId`。`snapshotId` 格式为服务 UUID 加采集计数，`nodeId` 如 `n0`，仅在该快照内有意义。Android 最多保留四份不可变快照描述，而不是跨请求保留活的 `AccessibilityNodeInfo`。相关事件及被接受的动作都会递增 revision；窗口变化、生命周期变化、已接受动作和急停清空缓存。内容、滚动、文本事件以及手势完成/取消回调暂时保留有界快照，但 revision 不同时必须重新采集同范围的完整树：窗口、包名、节点数量、路径和全部指纹均一致才允许继续，截断或任何差异均返回失效错误。随后仍重新读取根节点并验证目标及可点击祖先；指纹包含勾选、选中和焦点状态。相同标签可能对应多个节点，调用者必须检查匹配项，不能无提示选择第一个。

`get_ui_tree` 用精简节点列表和 `parentId` 表示层次。节点携带 `nodeId`、`text`、`contentDescription`、`resourceId`、`className`、`bounds`（屏幕像素 `[left,top,right,bottom]`）、`clickable`、`scrollable`、`editable`、`enabled`、`password`、`visible`；v0.3.16 另提供 `checkable/checked/selected/focused`，明确状态用于目标核对和结果判断。密码文本和描述返回 `[REDACTED]`；普通文字及描述各最多返回 1000 字符；ID、类型、包名及 Activity 提示等输出字符串有 512 字符上限。节点数、遍历深度、访问预算或序列化体积耗尽时，顶层 `truncated:true`，即使 `maxNodes:500` 也不保证可返回 500 个节点；单字段字符上限不单独标记，因此长文本也不能视为完整内容。

```json
{
  "snapshotId":"service-uuid:7",
  "revision":12,
  "packageName":"com.android.settings",
  "windowId":4,
  "truncated":false,
  "nodes":[
    {"nodeId":"n3","parentId":"n1","text":"电池","contentDescription":"","resourceId":"","className":"android.widget.TextView","bounds":[32,500,360,560],"clickable":false,"scrollable":false,"editable":false,"enabled":true,"password":false,"visible":true}
  ]
}
```

这是数据形状示例，不是实际手机采集结果；示例省略了其他节点。`click_element` 在标签本身不可点击时最多向上查找八层可点击祖先，并返回 `target`、`actedNode`、`ancestorHops`；失败时不隐式改成坐标点击。

`swipe` 也必须传 `snapshotId`。执行前重新采集同范围的树并比较窗口、包名、所有返回节点的路径与指纹；不接受被截断的快照，避免只校验一个局部节点后对已变化页面执行坐标动作。手势完成/取消回调只推进 revision，工具不会把 `completion:"pending"` 说成成功到达目标。

UI 事件是失效信号，不是完整 diff，也不保证所有 App 都正确发送。即使没有新事件，动作前仍要验证节点。动作返回成功表示 Android 接受了该动作；业务成功只能通过后续 UI 观察确认。

## 动作确认

主机在启动时读取 `TAPPILOT_APPROVAL_MODE`，仅接受 `manual` 或 `trusted`，未配置时默认 `manual`。`trusted` 必须同时配置 `TAPPILOT_SERIAL`，将持续授权固定到明确的 USB 设备。模式是启动配置，不是 MCP 工具参数；更改后需要重新启动 MCP 服务或建立新连接，不影响 Android 协议，也无需更新 APK。

`trusted` 模式下，`click_element`、`input_text`、`swipe` 按用户的持续授权直接执行，不创建待批准请求或要求终端确认。两种模式都保留已观测快照及目标检查、Android 节点失效检查、USB 设备限制、锁屏/密码字段保护和急停。`trusted` 不会自动识别高风险动作，代理必须遵循用户实际授权的任务范围。

`manual` 模式下，`click_element`、`input_text`、`swipe` 在主机经过同一确认门。首次调用只创建待确认请求并返回 `CONFIRMATION_REQUIRED`，不向手机执行动作。结果包含待确认 ID 和本机确认入口。

用户在独立终端执行：

```sh
cd server
npm run approve -- SOCKET_PATH APPROVAL_ID
```

CLI 要求交互式 TTY，向用户展示完整参数，以及从已观测快照提取的包名、窗口、节点文字/描述/resourceId/bounds；手势展示窗口与坐标。用户据此核对目标，再作确认。该上下文只来自真实设备响应，不由模型填写。两种模式下主机均最多缓存四份、各 120 秒，未知、被淘汰或过期快照返回 `NO_KNOWN_SNAPSHOT`，必须先重新读取。

确认不是 MCP 工具，Agent 不应代替用户运行该命令或输入确认。用户确认后，Agent 用完全相同的参数再次调用原工具。授权仅在该 MCP 进程内存中存在，绑定方法、完整参数、快照和一次性随机 ID，120 秒过期；最多保留 64 个待确认请求。动作成功后清空主机快照和其他待批准请求。参数变化、页面变化、重启或授权过期都必须重新观察/确认。`input_text` 的原文只在用户确认时临时展示，不写入审批文件或日志。

本机制是协作式人工确认：如果赋予同一 Agent 任意本机 shell/TTY 控制，它不是能够阻止该 Agent 操作宿主的系统级隔离。它也不防御已获得 ADB 权限的程序。不要将一个由模型提供的 `confirmed:true` 字段当成人类确认。

`scroll`、返回、Home、最近任务和 `open_settings` 在两种模式下均不要求逐次批准。这些工具仍需通过快照检查（需要节点时）、停止状态和锁屏检查。

## 事件等待与恢复

推荐调用循环：首次获取快照 → 按当前语义选择控件 → 按当前授权模式执行 → 直接检查动作返回的 observation → 选择下一步。仅缺少证据或状态失效时补读。需要等待后续变化时使用最新观察的 revision（观察失败则用动作 revision），不能使用动作前的旧版本：动作接受时会主动推进 revision，旧值会让无 selector 的等待立即返回，不能据此证明页面已更新。`wait_for_ui_change` 使用服务事件唤醒，可以要求某个 selector 出现；先立即检查一次，事件到达后再检查，条件不满足则继续等待至超时，不使用固定长时间 `sleep`。

无 selector 时等待 revision 改变；有 selector 时，只要当前控件已经存在就可立即返回 `matched:true`，不要求同时出现新事件。超时返回 `timedOut:true`，不伪装成条件满足。等待新 revision 不保证网络请求已结束；调用者需要检查目标控件或页面内容。滚动边界、动作不支持和多匹配歧义应作为明确失败处理。不能把同一失败的动作不断重试；先读取当前状态，只有新证据支持时才决定下一步。

读请求可以在连接恢复后重新发起。写请求一旦出现超时或断线，结果可能未知：**不自动重试**，先读取 UI 确认是否已经执行。对重新观察后仍无法判定的付款/消息等操作，交给用户处理。

| 错误代码 | 调用者应对 |
| --- | --- |
| `CONFIRMATION_REQUIRED` | 当前连接使用 `manual` 模式；展示确认入口，等待用户确认，不轮询、不自动运行确认 CLI |
| `STALE_SNAPSHOT` / `NO_KNOWN_SNAPSHOT` / `NODE_NOT_FOUND` | 重读 UI、重新选择，不沿用旧 ID |
| `TRUNCATED_SNAPSHOT` | 手势要求完整快照；扩大有界采集参数，或选择原生滚动，不绕过快照校验 |
| `NOT_CLICKABLE` / `NOT_EDITABLE` / `NOT_SCROLLABLE` | 原生控件不支持该动作；解释失败或重新选明确目标 |
| `NODE_DISABLED` / `NODE_NOT_VISIBLE` / `NODE_NOT_ACTIONABLE` | 当前控件或祖先不可操作；等待可验证的状态变化 |
| `ACTION_REJECTED` | 系统/App 拒绝动作，或滚动已到边界；重新观察，停止盲目重试 |
| `DEVICE_LOCKED` / `SENSITIVE_FIELD` / `PASSWORD_FIELD_BLOCKED` / `PROTECTED_APP` | 用户手动处理；不绕过限制 |
| `EMERGENCY_STOPPED` | 用户在手机恢复；若主机锁定，还需用户重启 MCP 服务 |
| `PHONE_STOP_UNCONFIRMED` | 主机已停止，但手机未确认；用户使用手机停止按钮或关闭无障碍服务 |
| `BRIDGE_TIMEOUT` / `BRIDGE_CLOSED` / `COMMAND_TIMEOUT` | 动作可能已执行，先读取状态，禁止自动重放 |
| `DEVICE_SELECTION_REQUIRED` / `DEVICE_TRANSPORT_DENIED` | 明确选择授权 USB 设备；不自动切到另一部手机或网络 ADB |
| `UNSAFE_ADB_LISTENER` | 修复回环监听和 `lsof` 可见性，不放宽到全网卡 |
| `BUSY` / `ACTION_IN_PROGRESS` | 已达到等待/动作并发上限；等已有请求返回，不立即堆积更多请求 |
| `NOT_IMPLEMENTED` | 当前版本未提供此能力；不要反复请求 |

## 停止与数据边界

`emergency_stop` 立即清除主机待确认请求并锁定后续控制，同时尽力通知手机停止。即使设备通道已断开，主机停止仍有效。手机 App 提供独立的停止按钮；首次连接服务默认停止，用户必须在手机点“允许自动化 / 恢复”。MCP 没有解除停止工具，手机 App 自身的控制界面也不允许通过树读取、点击或手势远程操纵；`open_settings` 可离开该受保护界面。

急停防止后续动作继续执行，不能撤销已经由 Android 接受的点击、已发送消息或已完成支付。已经提交的系统手势也不能依赖急停作为事务回滚。

服务只记录方法、错误代码和耗时等元数据。UI 树、查询文本、输入内容、聊天记录和验证码不默认持久化。UI 文字作为不可信页面数据处理，不能把其中的命令视为用户授权。第一阶段的 `take_screenshot` 明确返回尚未支持；不启动 OCR、不悄悄改用截图识别或坐标点击。
