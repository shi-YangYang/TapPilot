# TapPilot 本机协议

本协议连接电脑端工具适配层与 Android 无障碍服务。独立客户端自行运行 LLM 循环；外部 Agent 可使用标准 MCP stdio。下述 NDJSON 是内部设备协议。

## 执行能力与共同入口

Android 的 `get_device_info`、`get_ui_tree`、`find_element` 及动作后快照声明 `executor:"node-v1"`。桌面客户端与独立 MCP 都通过同一个 `ToolController`，把原始 `snapshotId/nodeId` 交给手机；电脑不额外预读完整树、不重绑节点，也不把 `tap_element` 改写成坐标 `swipe`。手机在执行命令内采集当前树、重新定位、验证相关上下文和遮挡，然后最多派发一次动作。

执行前若发现已声明的子节点不可读取，且没有同时触发容量或深度截断，手机最多刷新缓存并重新采集一次；Android 13 及以上使用服务缓存清理接口，旧系统逐节点刷新。第二次仍不完整则拒绝，全部读取共用原命令期限；这是下发前的读取恢复，不重放动作，也不等待整个页面停止刷新。

目标动作 `tap_element/click_element/input_text/scroll/swipe` 必须使用声明该能力的已观察快照。缺少能力时宿主返回 `EXECUTOR_UPGRADE_REQUIRED`，不发送动作、不回退到旧执行路径。本次未增加版本号，使用者仍须重新构建并安装本次两端产物；不能仅凭版本号判断 APK 已包含执行器。

## 动作和界面一起返回

`act_and_observe` 将一次动作、事件等待、新 UI 读取合并在单个设备 RPC：

```json
{"id":"synthetic-request","method":"act_and_observe","params":{"action":"tap_element","arguments":{"snapshotId":"session:2","nodeId":"n7"},"waitMs":350}}
```

`action` 仅允许 `tap_element`、`click_element`、`tap_visual`、`swipe_visual`、`input_text`、`scroll`、`swipe`、`press_key`、`open_settings`。`arguments` 按对应原工具的严格 schema 验证，不接受额外批准字段。`waitMs` 为 0–1500，默认 350，用于动作后的语义条件等待；普通观察先留出最多 120ms 让动作到达 App，再做有界读取，不要求全局事件静默。组合手势先等 Android 完成回调，回调等待有独立上限，整个组合调用受 9 秒内部期限约束。根节点暂时为空时只在剩余预算内补读，不重新执行动作。支持 `windowReadiness` 的手机还执行下文所述独立、共享且不重置的交互稳定预算；因此 `waitMs` 不等于整个 RPC 的耗时上限。`waitMs:0` 仍等手势回调，但只做一次即时观察，不据此证明新页面就绪。

结果含 `action`（原动作结果）、`observation`（新快照及质量）、`execution`（执行证据）、`timings`（`actionMs`、`waitMs`、`observationMs`、`totalMs`）。动作失败时返回 `ok:false`；动作已接受但观察失败时返回 `ok:true`、保留 `action` 并附 `observationError`。后者不可重放动作。`GESTURE_CANCELLED` / `GESTURE_COMPLETION_TIMEOUT` 分别表示手势中断/未确认完成，组合结果保留 `accepted:true`，并标记 `completion:"cancelled"/"unknown"`；桌面停止任务，避免把未知结果当作可安全重试。正常完成的组合手势标记 `completion:"completed"`。

MCP manual 模式继续通过原有独立 CLI 批准内部点击/输入/手势的单次参数，组合调用不改变批准通道。宿主记录新的 observation 快照；观察失败时旧引用已清除。疑似敏感提交、目标几何和遮挡限制由同一手机执行器处理，对桌面与 MCP 一致；被拒绝时交用户在手机手工完成。

外部 MCP 的 `tap_element`、`click_element`、`tap_visual`、`swipe_visual`、`input_text`、`scroll`、`swipe`、`press_key`、`open_settings` 也由宿主自动映射到一次 `act_and_observe` 设备 RPC，默认 `waitMs:350`。参数及原动作结果字段保持兼容，在原结果旁新增 `observation`、`timings` 和可选 `observationError`。例如独立点击返回 `result:{accepted:true,action:"click",revision:12,...,observation:{snapshotId:"session:3",revision:14,...},timings:{...}}`；显式组合工具仍将原动作结果放在 `result.action` 对象内。

模型直接检查返回的 `observation`，并用它的 `snapshotId/nodeId` 执行下一步，不需要为取得节点再次读取。动作顶层的 `revision` 仍是接受动作时的版本，观察有自己更新后的版本。目标未出现、界面仍在变化、树被截断或节点失效时，仍可读取或等待以补足证据；有界事件等待不保证所有页面加载完成。派发后即使超时或断线，也清除旧快照和批准；观察内容无效时保留已接受动作、返回 `observation:null` 与 `observationError`，不得自动重放。

### 有界连续导航（宿主工具）

电脑端普通任务暂不向模型提供此实验工具，恢复根据当前页面逐步定位、操作和观察。MCP 仍可调用；受控评测可显式设置运行器 `allowBatchedNavigation:true`。默认任务不会因为连续查找的步数预算而中断。

`navigate_until({snapshotId,mode:"swipe"|"scroll",direction,container?,stopWhen,maxSteps?})` 由桌面与 MCP 共用的控制器执行，只在 `trusted` 模式和完整可读的原生 UI 上开放。`maxSteps` 为 1–4，默认 2；`swipe` 的方向指手指移动方向（up/down/left/right），路径从当前唯一根节点或指定容器的 bounds 推导；原生 `scroll` 必须给出容器 selector，每步重新唯一定位。`stopWhen` 使用普通 selector，目标出现即停，不自动点击。

宿主先读一次新 UI，后续逐步调用现有手机 `act_and_observe`，使用每次返回的新快照继续，不需要每步请求模型。会话、应用或窗口变化、目标模糊、不可读、动作失败、页面无进展或回环时立即停止；20 秒后不再派发新步骤。每步仍经过手机原有校验、取消与急停。返回 `navigation:{completedSteps,stopReason,targetFound,error?,uncertainStep?}` 及最终 `observation`。中途失败保留已接受的动作记录，未知执行不返回旧 UI 冒充当前状态；电脑运行器遇到 `navigation.error` 停止且不重放。找到目标仅是定位条件，不是业务任务完成。此工具不重复点击、不批量使用截图凭据；手动批准模式应继续使用逐次批准的单步工具。

节点动作的成功结果还含 `executor:"node-v1"`、`dispatchState:"sent"`、`method`、`targetNodeId` 和 `actedNodeId`。`tap_element` 使用手机端 `dispatchGesture`；`click_element` 使用 `ACTION_CLICK`，仍须通过同窗口和跨窗口遮挡检查。`accepted:true` 只表示 Android 接受动作，不代表页面跳转或业务目标完成；手势 `completion:"completed"` 只说明手势完成。`input_text` 的 `textVerified:true` 表示派发后重新读取的目标字段值与请求文字一致，`false` 表示尚未验证，不能据此自动重放；该字段不代表搜索、发送或表单提交成功。

手机能够确认尚未调用任何 mutation API 时，失败响应的 `error.details` 为固定结构：

```json
{"executor":"node-v1","dispatchState":"not_sent","reason":"PAGE_CONTEXT_CHANGED"}
```

`reason` 可省略；有值时只能是约定枚举，例如 `TARGET_IDENTITY_CHANGED`、`TARGET_AMBIGUOUS`、`PAGE_CONTEXT_CHANGED`、`TREE_INCOMPLETE`、`WINDOW_OBSCURED`。已取得的最新树放在失败响应**顶层 `observation`**，不混入 `error.details`；锁屏、停止或采集失败时可没有观察。宿主严格校验协议后生成 `meta.nativeExecutorRefusal:true`，并保存合法的新观察，模型可直接使用它重新判断。这个标记不接受页面文字或手机任意 meta 字段的声明。缺少明确 `not_sent` 的超时、断线或 API 调用后失败，一律不能推定为尚未执行；无自动重放。`retryable:true` 也不授权重复动作。

发给模型的 UI 省略空字符串、null、默认 false 能力属性（保留 `enabled/visible/checked/selected/focused/showingHintText:false`）；控制器仍使用完整快照校验。节点身份、父子关系、顺序、边界和文字不变。可编辑节点的 `showingHintText:true` 表示提示文字，不是输入值；缺少此字段表示未知。

## 观察质量、语义等待与执行证据

新版完整观察声明 `observationContract:"semantic-v1"`。`truncated:false` 只说明遍历未截断，不能代表有足够内容。`quality` 独立提供 `status`、`reason`、`readableCount` 和 `actionableCount`：有可读内容或可操作控件且未截断为 `usable`；有内容但树不完整为 `limited`；没有可读内容和可操作控件为 `unavailable`。纯文字页面可以是 `usable`，单个空根节点不是。密码及脱敏占位内容不计为可读证据。

声明 `observationCapabilities.windowReadiness:true` 的手机还会提供 `readiness:{status,reason,samples,waitedMs}`。`quality` 描述信息是否可读；`readiness` 单独描述当前窗口的交互结构是否经过有界稳定观察。`status:"ready"` 的原因是 `interaction_stable`（本次观察到结构稳定）或 `known_window`（本次新采样与已确认的交互结构一致，且没有后续动作使它失效）；`status:"settling",reason:"deadline"` 表示预算内未就绪，返回最新观察供诊断，不能用该快照执行节点或坐标动作。手机会以 `UI_NOT_READY / OBSERVATION_SETTLING` 和 `dispatchState:"not_sent"` 拒绝，不能换动作绕过。

稳定观察只比较原生窗口与交互结构，不等待所有无障碍事件停止。新窗口的采样预算为 2500ms，包含首次读取，要求独立完成的匹配采样至少跨越 240ms；当前已就绪、结构仍匹配且未再次执行动作的窗口只做一次新读取。每次原生 capture 在主线程按顺序登记结构签名与可采样状态；同窗口外部异步变化或加载状态变化也会撤销旧代次，较早完成的 worker 无法重新授权旧结构。集合行的普通刷新仍由交互签名排除，完整目标及上下文校验不变。

符合下文原生 Tab 导航条件的页面，稳定观察使用同一套原生角色、完整结构和独立被动标签条件生成手机内部的导航结构摘要。只有这些栏外标签的文字值可不影响稳定采样，其最新内容仍完整返回；首次打开时持续刷新也可通过正常的有界采样得到 ready，不需要先有静态快照或调用方提供 `allowedLabelChanges`。完整层级、几何、状态、Tab 身份和原生语义必须保持不变；不满足条件则回到原有稳定判定。该摘要不是动作授权，执行前仍对具体目标重新校验，不能据 ready 推定普通按钮、输入或提交操作也可忽略文字变化。

Android 14+ 另外核对根节点的窗口内坐标、屏幕坐标及系统窗口边界。仅当根节点从窗口原点完整覆盖窗口、屏幕尺寸未缩放时，要求屏幕边界与系统窗口一致；若窗口尺寸恰好等于整个显示屏，还要求其原点回到显示屏原点。启动阶段整体移出屏幕的节点与窗口样本不参与 ready 判定；恢复一致后继续原有 240ms 稳定采样与 2.5 秒总期限，不额外 sleep。部分根节点、缩放或缺少元数据时不推断坐标映射，保留原有判定。使用公开的 [getBoundsInWindow API](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo#getBoundsInWindow(android.graphics.Rect))，不将窗口通知当作动画完成证明。

手机在尝试向 Android 派发动作前撤销旧的就绪记录，即便 Activity 和窗口 ID 不变也开始新的观察代次。预检拒绝本身不撤销记录，但预检 capture 若发现交互结构变化，仍会撤销旧证据；Android 拒绝派发也不能证明界面绝对没变。手势完成或取消回调再撤销一次，防止其他读取把尚未结束的手势误认证为稳定。旧代次的并发采样不能确认或重新发布 ready。

`waitMs>0` 的动作后观察共享一次最多 2500ms 的稳定预算，并受动作整体 9 秒期限约束；达到上限仍未稳定就返回 `settling`，不重放动作。`waitMs:0` 返回一次新捕获和未认证的 `settling`，后续需重新读取，不能沿用旧窗口的 ready。输入值和勾选状态也须在最终 ready 观察中验证，不能仅靠 Android 接受动作。

`input_text` 且 `waitMs>0` 时，手机继续采样至派发完成后至少 1000ms，才允许确认就绪；最后的交互结构仍须跨样本稳定至少 240ms。这覆盖常见的输入防抖、按钮启用和局部搜索延迟，避免输入值立即读回就过早返回。此窗口在原 2500ms 预算内，不随事件重置，不阻塞主线程；普通点击、滑动和 `waitMs:0` 不增加该窗口。提前匹配的 `waitFor` 或另一读者确认的已知窗口也不能跳过它。1000ms 是有界观察策略，不能预测更晚的网络或业务更新；`input_value` 仅验证输入值，业务完成仍需明确结果条件，后续目标校验照常执行。

`wait_for_ui_change` 沿用调用者原有截止时间。原生集合内部的数据更新不阻塞外围结构就绪，但这些数据仍保留在返回树中，执行时的目标和上下文校验不因此放宽。`ready` 不是“网络请求全部完成”，也不能保证模型思考期间页面不再变化；已有明确目标时仍可使用 selector 等待该目标。手机完成等待后，电脑端对仍可读但未就绪的窗口最多补一次只读观察，再次未就绪就停止，不额外消耗模型轮次或重放动作。

已有 ready 基线的显式 `allowedLabelChanges` 保留一个窄例外：只有唯一目标与声明标签的完整上下文校验通过，且其间没有新派发、窗口离返、结构、状态、几何或受保护上下文变化，才可继承该基线用于这一次节点动作。该路径返回 `action.readinessEvidence:"declared_label_changes"`，不把全窗口重新标为 ready。它是手机创建的内部动作证据，客户端不能通过输入这个字段取得授权。未 ready 的初始快照不能使用此路径；动作后仍 settling 时仍为 unverified，不能声称输入或业务完成。集合刷新使用独立的就绪代次，不因该继承证据失效而无限等待。

`wait_for_ui_change` 可指定最新 `snapshotId` 作为基线。共同控制器在能力和 revision 匹配时自动附加该基线，桌面与 MCP 使用同一实现。事件仅唤醒读取；按基线相同的节点数和深度预算采集，实际比较包名、窗口、控件内容、状态、几何和层级，不比较句柄、revision 或等待元数据。事件持续但树未改变时保持等待至期限；事件与有界本地补读共同驱动检查，不等待事件完全停止；即使缺少无障碍事件也会在等待期间补读。期限处再做一次有界读取；最终读取另有至多 2 秒余量。带 selector 时等匹配控件出现，已经出现则立即返回；窗口切换返回 `window_changed`，不会拿旧窗口目标继续等待。

返回完整树，无需再调用 `get_ui_tree`，并包含 `wait:{mode:"semantic",status:"changed"|"matched"|"timed_out"|"window_changed",semanticChanged:boolean}`。没有快照基线的旧调用保持事件语义，明确标记 `mode:"events",semanticChanged:null`；事件到达不能证明界面变化。不存在的基线返回 `STALE_SNAPSHOT`，不默默退化为事件等待。停止、锁屏、保护页面和会话变化会中止等待；仅暂时无根窗口允许在原期限内补读。

支持本次增强的手机在设备信息和完整树中声明 `observationCapabilities:{readinessWait:true,actionSelectorWait:true}`。`wait_for_ui_change.requireUsable:true` 要求完整可读树；带 selector 时还要求可见目标匹配，空的新窗口不会提前结束恢复。`wait.ready` 仅说明满足这个观察条件。默认省略时保留原来的变化等待语义。`act_and_observe.waitFor` 可在同一个 `waitMs` 预算内等待预期控件，返回 `observationWait:{status:"matched"|"ready"|"timed_out",ready:boolean}`；超时保留已执行的动作和最后观察，不重放动作。`usable` 不代表所有业务内容都已加载；需要特定控件时应提供 selector。

动作后的 `execution` 区分 `dispatch:"sent"`、`acceptance:"accepted"`、`effect:"changed"|"unchanged"|"unknown"` 与 `verification:"unverified"|"verified"`。`changed` 仅证明前后观察不同，不证明业务目标成功；观察缺失或质量不足时为 `unknown`。最终观察中唯一身份匹配的输入框值与请求一致、且原生 `showingHintText:false` 时，返回 `verification:"verified",verificationScope:"input_value"`；同一开关的 checked 状态发生预期切换时可返回 `verificationScope:"checked_state"`。提示文字即使恰好等于请求也不能证明输入成功；输入被格式化、回退或身份无法确认时保持 unverified；局部验证不代表搜索、发送或整个任务成功。任何已派发或派发状态不明的动作都不自动重放。

电脑端将新契约结果视为权威观察，不为已返回的完整动作/等待例行补读。初始界面或动作后的内容不足最多触发一次 1 秒语义等待；对声明 readinessWait 的手机自动要求 requireUsable，变化等待刚返回的空窗口仍可进入这次有界恢复；仍不可读且窗口信息可核对时，进入下述按需截图观察。没有可信窗口信息时以 `UI_OBSERVATION_UNAVAILABLE` 停止。预防技能也直接消费完整等待结果，不额外读取；质量与等待元数据不计作任务进展。

## 按需截图观察

桌面模型配置 `vision:boolean` 默认 `false`，旧配置缺少字段也按 `false` 处理；只有用户在模型页显式开启“支持图片”才向该服务发送图片，不猜测模型名称。每次查找操作目标都先读 Accessibility 树，目标可用时优先使用原生节点动作。页面恢复后仍为 `quality.status:"unavailable"` 可触发截图；页面虽 `usable`、但当前具体目标缺失或不可访问，也可通过下述 `observe_target` 请求一张图。原生标题可读不代表画布中的目标可操作，树被截断也不等于确定目标不存在。纯文本模型使用 `allowScreenshot:false`，没有视觉动作入口；需要视觉才能继续时返回 `VISION_REQUIRED`，不先截图再尝试发送，也不自动配置额外视觉模型。图片请求被服务商明确拒绝时返回 `MODEL_VISION_UNSUPPORTED`，不静默删图重试。

`take_screenshot {}` 经桌面与 MCP 共用的 `ToolController` 调用手机原生无障碍截图。Android API 30–33 截取默认显示屏后裁剪到已核对的活动应用窗口，API 34+ 使用 `takeScreenshotOfWindow`，API 30 以下返回 `SCREENSHOT_UNSUPPORTED`。服务声明 `canTakeScreenshot`，仍需用户启用无障碍服务并允许控制；不使用 Root、ADB 截图或 OCR。API 能力依据 [Android AccessibilityService 官方文档](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService)。

捕获前后检查服务会话、应用、活动窗口、边界与窗口拓扑；窗口不一致返回 `SCREENSHOT_CONTEXT_CHANGED` 并丢弃图片。锁屏、停止、受保护应用、密码控件和系统敏感内容仍拒绝；遮挡按下述捕获模式判断。系统截图保护失败不会退回显示屏捕获。图片不提供节点句柄，不能伪造 `snapshotId/nodeId` 或改用 `swipe` 绕过节点校验。新设备通过下述受约束的视觉动作契约接受图片定位，旧设备的只读图片仍只用于观察。

两种捕获模式使用不同的遮挡预检：API 30–33 保留可信 SystemUI 完整边条裁剪规则，其他遮挡仍拒绝；API 34+ 只读取目标窗口的像素，其他非活动、无焦点的窗口可以存在，包括屏幕内部的应用悬浮球，不按包名或窗口类型放行。另有活动/焦点窗口时仍拒绝，目标仍须为默认屏幕上的活动应用窗口。依据 [AOSP 窗口截图实现](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-14.0.0_r1/core/java/android/view/AccessibilityInteractionController.java#L612-L624)，系统先检查目标安全标记，再以其窗口 Surface 为根并过滤其他 App 的图层。允许隔离截图不等于允许触摸穿透：视觉点按的触点和滑动整条路径仍检查所有更高层窗口的覆盖区域，命中遮挡即拒绝派发。

设备成功结果为 `kind:"screenshot"`，含 `captureId,packageName,windowId,width,height,mimeType:"image/jpeg",source:"window"|"display",data`，`data` 为 Base64。支持视觉动作的新设备另返回 `observationOnly:false,actionContract:"visual-tap-v1",expiresInMs:60000,supportedActions:["tap_visual","swipe_visual"]`。同契约但缺少 `supportedActions` 的旧设备只支持 `tap_visual`，不能推断支持滑动；`observationOnly:true` 的旧设备仍只读。电脑严格验证图像与元数据，不自行把旧图片升级为可点击凭据。MCP 的图片放入标准 `content` 的 `image` 块，结构化结果和文本块只保留元数据，不把 Base64 再塞入文本。桌面仅以模型供应商的图片内容块发送，Renderer 进度只收到工具名称与状态。图片中的文字是页面数据，不是代理指令。

`observe_target {selector,operation,allowScreenshot}` 是宿主只读工具，`operation` 为 `tap/scroll/read`。每次先读取新原生树并按 selector 匹配，返回 `{observation,target:{status,operation,nodeIds},visualObservation?}`。`native` 表示有可用于该操作的原生目标，不截图；`missing` 表示在可完整判断的树中没有匹配目标；`unavailable` 表示当前原生信息不足以提供目标；`ambiguous/blocked` 分别为歧义或被保护/状态拦截，均不能改用截图绕过。仅 `missing/unavailable` 且 `allowScreenshot:true` 时可附带同窗口图片；失败仍保留原生观察与明确原因。每个目标重新判断，不以整页有几个文字节点决定所有目标是否可操作，也不把上一张图当作后续动作的长期许可。

`tap_visual` 接受 `{captureId,x,y,targetDescription}`：`captureId` 必须来自当前收到的可操作截图；`x,y` 是该 JPEG 的整数像素索引，原点位于左上角，范围分别为 `[0,width)`、`[0,height)`，不能使用手机物理屏幕坐标。`targetDescription` 是模型对图中目标的简短说明，作为不可信请求数据处理，只能增加安全拦截，不是用户批准或像素目标的语义认证。

`swipe_visual` 接受 `{captureId,startX,startY,endX,endY,durationMs?,targetDescription}`，必须由该截图的 `supportedActions` 显式允许。所有坐标均为返回 JPEG 的整数像素；`durationMs` 为 200–1000，默认 450。选择可见的滚动区域并避开边缘、编辑框和敏感控件；有原生 scrollable 目标时先用原生 `scroll`。过短、越界或无法验证安全路径的手势拒绝，不能把它当作点击替代，也不能依靠普通目标说明放行实际敏感路径。

手机将截图凭据绑定到捕获时的会话、应用和窗口，只保留最新一份，最多 60 秒；新截图、原生变更动作、急停以及服务断连重绑均撤销旧凭据。进入手机校验的视觉动作尝试会消费对应凭据，不能再次使用；不存在或已替换的引用不会授权操作。无法建立截图与窗口的精确几何对应时，截图仍为 `observationOnly:true`。执行前重新截图并核对窗口、方向和尺寸：点按检查目标邻域像素稳定，远处视频或动画变化不再单独否决；浏览滑动允许内容帧变化，同时检查整条路径的遮挡、编辑框及敏感控件，不能只验证起止点。随后由手机映射坐标，最多派发一次手势。凭据过期、已使用、窗口变化或点击目标邻域变化时拒绝，不沿用旧坐标重试。重新截图也必须通过相同保护检查；敏感提交、受保护页面和系统安全机制不因视觉路径而放行。内部比对使用最长边 640 像素的图像证据；新图收到超过 1 秒后不派发手势。图像比较仍有阈值和采集到派发之间的时间差，不承诺消除全部竞态；点击目标自身持续变化仍可能被拒绝。窗口截图可以隔离内容，不表示允许穿过系统栏或其他遮挡窗口操作。

动作结果声明 `executor:"visual-tap-v1"`，`action` 为 `tap_visual` 或 `swipe_visual`，报告 `accepted,revision,dispatchState,durationMs,completion`；`completion` 为 `pending/completed/cancelled/unknown`，观察中的执行验证保持保守的 `unverified`。动作后首先返回原生 `observation`；若原生树仍不可用，宿主在同次工具结果附带 `visualObservation` 截图，模型直接使用该结果继续观察。截图失败不取消已发生的点按，也不能因此重放动作。只有图片证据时，桌面仅开放观察与图片能力明确支持的视觉动作，禁止其他界面变更动作。截图不是永久运行模式：下一步重新按目标判断，有可用原生目标就切回节点操作。单次凭据、图像匹配及系统接受手势只能证明本次受约束的派发，不能证明模型正确理解目标或业务任务完成；后续结果仍须核对。

JPEG 最长边 1280 像素、编码后至多 384 KiB，处理全程在内存，单次捕获预算 4 秒。初次进入不可读页面时的自动截图，每任务最多尝试 3 次，达到该上限以 `SCREENSHOT_LIMIT` 停止。视觉动作后的同次结果最多附带一张新图，不计入这 3 次初次兜底；它仍受任务轮次上限（最多 40 轮）以及同画面同位置无进展停止规则约束。视觉动作前还有一次手机内部截图比对，不发送给模型。新观察替换旧图，上下文最多保留最近一张。原生限流、超时、捕获失败分别返回 `SCREENSHOT_RATE_LIMITED/SCREENSHOT_TIMEOUT/SCREENSHOT_FAILED`，不通过连续截图或重复动作绕过。没有可用截图工具时返回 `SCREENSHOT_UNAVAILABLE`。MCP 没有桌面任务轮次概念，调用方需自行控制任务截图次数，手机保护检查仍相同。

Android 原生 `NO_ACCESSIBILITY_ACCESS`（2）返回 `SCREENSHOT_UNAVAILABLE`，不与 `SECURE_WINDOW`（6）的 `SCREENSHOT_PROTECTED` 混为一谈。截图错误可携带严格白名单 `details:{reason}`：`WINDOW_OBSCURED`、`SYSTEM_SECURE_WINDOW`、`SCREENSHOT_ACCESS_DENIED`、`SENSITIVE_NODE`、`SENSITIVE_SCAN_LIMIT`、`UNSUPPORTED_WINDOW`。`SCREENSHOT_PROTECTED` 接受上述原因；`SCREENSHOT_UNAVAILABLE` 只接受 `SCREENSHOT_ACCESS_DENIED`，`SENSITIVE_FIELD` 只接受 `SENSITIVE_NODE`。这些原因与节点执行证据分开，不能据此推断或重放此前动作。桌面与 MCP 保留固定原因，诊断不记录原始界面或任意错误文字；旧手机缺少原因时只能显示“截图观察被拦截”，不能断言 App 禁止截图或权限未开启。

只有手机在派发前确认图像比较失败的 `VISUAL_SCENE_CHANGED`，才返回 `error.details:{executor:"visual-tap-v1",dispatchState:"not_sent",visualComparison:{...}}`。`visualComparison` 记录触发项 `dimensions/local_pixels/local_mean`（兼容旧设备的 `global_fraction/global_mean`）、凭据年龄 `referenceAgeMs`、全图和局部像素总数、显著变化像素数及每通道平均差（乘 1000 的整数）。尺寸不同无法比较时，除基准全图像素数外的比较统计为 `null`。该证据独立于 `node-v1` 的原生拒绝标记，不授权自动重试。旧版或没有该证据的错误仍保留未知派发状态，不能仅凭错误码推断未点击。

TapPilot 不将截图写入诊断日志、技能 SQLite、测试报告或普通工具文本。视觉比较诊断也不包含坐标、图片、差分图、指纹、目标说明或页面文字。发送到外部模型/MCP 客户端后的保留由对方负责，不能将本机内存处理解释为端到端不保留数据。

模型无关的真实 Android 回归入口见 [测试沙盒](../android/testbed/README.md#语义观察与执行结果回归)。目标级视觉滑动使用 `node scripts/visual-swipe-eval.mjs --serial emulator-5580 --output /tmp/tappilot-visual-swipe.json`：隔离 API 34+ 模拟器上的合成页面保留原生标题，目标先仅在 Canvas 中，一次滑动后变为原生按钮。桌面/MCP 都检查目标缺失时才附图、显式滑动能力、动作回包已含原生目标、再次查找零新增截图、已使用凭据拒绝重放及独立手势计数。坐标从合成几何映射到 JPEG；不使用真实 App、模型或聊天，也不保存图像、UI 或坐标。这个集成用例验证已使用凭据，不代替 60 秒过期边界的策略测试。

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

MCP 外层由官方 SDK 处理，工具结果在 `structuredContent` 及文本 content 中提供 `{ok,result|error,meta,observation?}`，工具失败时同时设置 `isError:true`。主机错误可额外包含 `error.details`（例如待确认请求），不会把原始异常或 ADB 输出直接交给模型。`get_device_info` 是诊断例外：设备列表成功时外层可为 `ok:true`，但其中 `result.bridge.ok:false` 仍明确表示手机服务未连通，调用者必须检查该字段。

## MCP 工具参数

参数均为 JSON 对象；未声明字段由 MCP 层拒绝。空参数工具传 `{}`。

| 工具 | 参数 | 结果语义 |
| --- | --- | --- |
| `get_device_info` | `{}` | ADB 设备、选中 serial、主机停止状态，以及 bridge 诊断；手机端附 `protocolVersion:1`、`executor:"node-v1"`、session、Android 版本、锁屏/停止状态 |
| `get_current_app` | `{}` | `packageName,windowId,activityHint,activityHintIsAuthoritative:false,revision,stopped` |
| `get_ui_tree` | `maxNodes?`、`maxDepth?` | `executor,observationContract,snapshotId,revision,packageName,windowId,nodes,truncated,quality` |
| `find_element` | `selector`、`maxResults?` | 新快照元数据与 `elements`；无匹配返回空数组，有截断时标记 `truncated` |
| `observe_target` | `selector,operation,allowScreenshot` | 新原生树与 `target` 状态/节点；仅当前目标缺失或不可访问且允许图片时附 `visualObservation` |
| `tap_element` | `snapshotId,nodeId` | 手机重新定位和验证后点按一次；返回实际执行目标，不由电脑生成坐标 |
| `click_element` | `snapshotId,nodeId` | `ACTION_CLICK`，通过同样的目标及遮挡验证；可明确报告可点击祖先 |
| `input_text` | `snapshotId,nodeId,text` | `ACTION_SET_TEXT` 替换整个字段，空串清空；最多 4096 字符，不提供 Enter/发送动作 |
| `scroll` | `snapshotId,nodeId,direction` | `direction` 为 `forward/backward/up/down/left/right`，目标必须为可滚动节点 |
| `swipe` | `snapshotId,startX,startY,endX,endY,durationMs?` | 绑定快照的屏幕像素手势；直接设备调用接受后返回 `completion:"pending"`；组合调用从 v0.3.16 起等待回调并报告完成状态 |
| `press_key` | `key` | `back/home/recents` 三种系统全局动作 |
| `wait_for_ui_change` | `sinceRevision,snapshotId?,timeoutMs?,selector?,requireUsable?` | 完整新 UI 与 `quality,changed,timedOut,matched,wait`；指定快照时按界面内容等待 |
| `open_settings` | `{}` | 标准 `Settings.ACTION_SETTINGS` 打开设置首页，后续仍靠树选择页面 |
| `emergency_stop` | `{}` | 主机先停止，再尝试停止手机；可返回手机停止未确认错误 |
| `take_screenshot` | `{}` | 当前应用的 JPEG 观察与固定元数据；MCP 图像在 `content` 的 `image` 块，结构化内容不含像素 |
| `tap_visual` | `captureId,x,y,targetDescription` | 使用具有 `visual-tap-v1` 契约的单次截图凭据；坐标采用返回 JPEG 的像素，手机复核窗口/图像后点按并返回原生或视觉观察 |
| `swipe_visual` | `captureId,startX,startY,endX,endY,durationMs?,targetDescription` | 截图必须显式支持；JPEG 像素路径，200–1000ms（默认 450）；手机复核窗口、整条路径与图像后派发一次滑动 |

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
| 截图 | JPEG 最长边 1280 像素、384 KiB；原生 4 秒期限、1 秒频控；桌面初次视觉兜底最多 3 次/任务；每次视觉动作最多附带 1 张后续图；上下文保留最新 1 张 |
| 视觉点按凭据 | `visual-tap-v1`，60 秒内单次使用；旧设备的 `observationOnly:true` 不支持点击 |
| 并发 | Android 4 个 socket 工作线程、8 个排队请求，最多 2 个事件等待者以给控制请求留出线程；主机同一时间最多一个动作执行，急停不等待动作队列 |

## 快照和节点引用

每次服务连接有独立 session；UI 事件推动 revision。快照以 session、revision 和本次采集身份关联，返回的节点引用只在所属快照有效，不能将 resourceId、文本、树路径或列表下标视为永久 ID。

节点动作使用调用者刚刚读到的 `snapshotId` 和 `nodeId`。`snapshotId` 格式为服务 UUID 加采集计数，`nodeId` 如 `n0`，仅在该快照内有意义。Android 最多保留四份不可变快照描述，不跨请求保留活的 `AccessibilityNodeInfo`。事件与手势回调推进 revision，但不会仅因事件到达就删除节点证据；生命周期变化、已接受动作和急停仍清空快照。`TYPE_WINDOWS_CHANGED` 另推进窗口拓扑计数，旧坐标手势因拓扑变化而失效。

节点执行前，手机重新采集与原快照同范围的树，检查会话、应用、窗口、目标及祖先身份、实际操作容器、唯一性和相关页面上下文；执行前再刷新真实节点，并核对指纹及当前窗口遮挡。目标的新句柄和位置可以变化，但身份必须唯一。默认列表策略对满足隔离条件的**同一原生列表内其他条目的既有非交互叶子文字**允许刷新；目标后代、标题、收件人、表单状态和其他无法确认的变化仍拒绝。输入与滚动不使用这项点击例外。页面持续刷新不会触发自动动作重试。

原生 Tab 导航另有一个自动、局部的校验路径，仅用于 `tap_element/click_element` 切换未选中的 Tab：

- Android 必须提供完整的 Tab 角色、单行单选集合和集合项语义；包含 2～8 个可区分且互不重叠的 Tab，恰好一个已选中，实际点击目标是其中一个未选中的 Tab。栏内额外交互控件、嵌套集合或不完整语义均不适用。
- 两份完整快照的会话、应用、窗口、全部有序层级、几何、绘制顺序、节点身份、状态和原生语义保持一致。唯一允许的差异是栏外 1～8 个独立、可见、启用的被动叶子标签的 `text/contentDescription` 值；文字与描述的有无不变。标签不得位于任何交互控件内、与导航栏重叠、包含截断内容，或具有标题、pane、标签关联等保护语义。
- 页面存在输入、勾选、密码、已识别的收件人/账户/金额等业务上下文或敏感操作时关闭自动路径。普通按钮和表单继续使用原有严格校验，不能因目标唯一、文字刷新频繁或看起来像时间而获得放行。业务词检查是保守拒绝条件，不是能理解所有 App 语义的分类器。

该机制依据原生结构，不按 App 包名、Clock 资源 ID 或时间格式适配。调用方无需声明可忽略节点，手机只派发一次动作，桌面和 MCP 共用同一执行逻辑。目标或相关上下文变化、遮挡、窗口切换仍拒绝；不能把此路径用于坐标手势、滚动、输入或提交操作。

`tap_element`、`click_element`、`input_text` 可显式传入 `allowedLabelChanges: [nodeId, ...]`，列表为同一原快照内 1～8 个不重复节点。它表示调用方已确认这些节点只是允许刷新的状态文字，**不是手机自动推断其业务含义**；不得将收件人、账户、金额或其他任务条件列入。省略参数保留默认策略，旧手机不支持时返回参数错误，电脑端不会删除参数后重试。

手机要求列入节点为启用、可见、有文字且与操作目标不重叠的只读叶子；禁止目标、祖先、目标后代、交互控件内的标签，以及原生标题、pane 或标签关联保护的节点/后代。只对列入节点的 `text/contentDescription` 值允许变化，文字/描述的有无、全部节点的有序结构、bounds、类型、ID、状态和未列入文字仍须一致。该路径不叠加默认列表例外；不能放宽滚动、坐标手势、遮挡、密码或敏感提交检查。原生语义证据只保留于手机内存，不增加发给模型的节点字段。Android 跨进程调用仍不提供原子业务事务。

节点动作结果含 `contextVerification: "default_context" | "explicit_label_changes" | "native_tab_navigation"`、`allowedLabelChangesCount`（显式声明数量，0～8）和 `automaticLabelChangesCount`（原生 Tab 路径自动核验的变化标签数量，0～8）。实际采用自动路径时，前者计数为 0、后者为 1～8；其他路径的自动计数为 0。需要继承既有就绪基线时，自动路径可另返回 `action.readinessEvidence:"native_tab_navigation"`。这些字段都是手机返回的证据，不能作为请求参数取得授权，也不表示任务完成。`input_text.textVerified` 只验证输入框的实际值；必须继续使用同一次调用返回的观察确认业务结果。调用方若错误地将未标注业务文字显式声明为状态，普通 TextView 无法提供足够证据纠正这个语义判断，因此不应把显式声明能力当作通用“忽略页面变化”开关。

如果因 `PAGE_CONTEXT_CHANGED` 拒绝，且手机能确认结构、边界、状态与原生语义均一致，仅 1～8 个节点的文字发生变化，则在同次拒绝的 `observation` 附带 `changedLabelNodeIds`。这些 ID 属于返回的新快照，只描述实际差异；收件人变化也会如实列出，**不代表可以忽略**。不重复携带旧/新文字；直接查看观察中的节点即可。模型投影若裁剪掉任一引用节点，会省略整个差异字段，避免留下无法解释的节点引用。

`tap_element` 与 `click_element` 共享敏感目标、可点击祖先及可见区域校验；同窗口内容完全遮挡或上层窗口遮挡时均拒绝，不允许换动作绕过。无障碍访问跨进程，采集和执行不能承诺原子事务；动作后仍须核对观察。

`get_ui_tree` 用精简节点列表和 `parentId` 表示层次。节点携带 `nodeId`、`text`、`contentDescription`、`resourceId`、`className`、`bounds`（屏幕像素 `[left,top,right,bottom]`）、`clickable`、`scrollable`、`editable`、`enabled`、`password`、`visible`；v0.3.16 另提供 `checkable/checked/selected/focused`，明确状态用于目标核对和结果判断。密码文本和描述返回 `[REDACTED]`；普通文字及描述各最多返回 1000 字符；ID、类型、包名及 Activity 提示等输出字符串有 512 字符上限。节点数、遍历深度、访问预算或序列化体积耗尽，或声明存在的子节点无法读取时，顶层 `truncated:true`，即使 `maxNodes:500` 也不保证可返回 500 个节点；单字段字符上限不单独标记，因此长文本也不能视为完整内容。

```json
{
  "executor":"node-v1",
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

`swipe` 也必须传 `snapshotId`，并要求窗口拓扑计数未变化。执行前重新采集同范围的树并比较窗口、包名、所有返回节点的路径与指纹；不接受被截断的快照，避免只校验一个局部节点后对已变化页面执行坐标动作。短手势还须命中同一唯一、非敏感控件；所有手势执行前检查上层窗口遮挡。手势完成/取消回调只推进 revision，工具不会把 `completion:"pending"` 说成成功到达目标。

UI 事件是失效信号，不是完整 diff，也不保证所有 App 都正确发送。即使没有新事件，动作前仍要验证节点。动作返回成功表示 Android 接受了该动作；业务成功只能通过后续 UI 观察确认。

采集和整树手势校验在 Android 13+ 先调用系统公开的 `clearCache()`，避免完整但过时的 Accessibility 缓存被当作新证据；旧系统或清缓存失败时逐节点 `refresh()`，刷新失败则视为证据缺失。缺少子节点的有限补读仍只读一次，不重复派发动作。这能处理内容事件延迟或遗漏，不能消除采集结束到跨进程动作实际发生之间的全部竞态。

## 动作确认

主机在启动时读取 `TAPPILOT_APPROVAL_MODE`，仅接受 `manual` 或 `trusted`，未配置时默认 `manual`。`trusted` 必须同时配置 `TAPPILOT_SERIAL`，将持续授权固定到明确的 USB 设备。模式是启动配置，不是 MCP 工具参数；更改后需要重新启动 MCP 服务或建立新连接，不影响 Android 协议，也无需更新 APK。

`trusted` 模式下，`tap_element`、`click_element`、`tap_visual`、`swipe_visual`、`input_text`、`swipe` 按用户的持续授权直接执行，不创建待批准请求或要求终端确认。两种模式都保留对应路径的快照/截图凭据及目标检查、USB 设备限制、锁屏/密码字段保护和急停。手机执行器会拒绝疑似敏感标签，但不能覆盖全部业务风险，代理必须遵循用户实际授权的任务范围。

`manual` 模式下，`tap_element`、`click_element`、`tap_visual`、`swipe_visual`、`input_text`、`swipe` 在主机经过同一确认门。首次调用只创建待确认请求并返回 `CONFIRMATION_REQUIRED`，不向手机执行动作。结果包含待确认 ID 和本机确认入口。

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
| `EXECUTOR_UPGRADE_REQUIRED` | 重新构建并安装本次手机 APK，重连后读新快照；不回退电脑执行算法 |
| `TARGET_CHANGED` | 优先检查失败响应的新观察及固定原因；未确认新目标前不重放 |
| `STALE_SNAPSHOT` / `NO_KNOWN_SNAPSHOT` / `NODE_NOT_FOUND` | 重读 UI、重新选择，不沿用旧 ID |
| `TRUNCATED_SNAPSHOT` | 手势要求完整快照；扩大有界采集参数，或选择原生滚动，不绕过快照校验 |
| `NOT_CLICKABLE` / `NOT_EDITABLE` / `NOT_SCROLLABLE` | 原生控件不支持该动作；解释失败或重新选明确目标 |
| `NODE_DISABLED` / `NODE_NOT_VISIBLE` / `NODE_NOT_ACTIONABLE` | 当前控件或祖先不可操作；等待可验证的状态变化 |
| `ACTION_REJECTED` | 系统/App 拒绝动作，或滚动已到边界；重新观察，停止盲目重试 |
| `VISUAL_REFERENCE_INVALID` / `VISUAL_REFERENCE_EXPIRED` | 图片凭据缺失、已覆盖、已消费或超过 60 秒；旧凭据不能重试，重新观察后再决定下一步 |
| `VISUAL_CONTEXT_CHANGED` / `VISUAL_SCENE_CHANGED` | 截图所属窗口或图像证据已变化，未派发点按；不继续使用旧图片坐标 |
| `VISUAL_TARGET_UNSAFE` | 目标用途敏感或无法确认低风险，或对应可访问目标受保护；用户手动处理，不修改描述规避检查 |
| `VISUAL_ACTION_UNSUPPORTED` / `VISUAL_ACTION_UNAVAILABLE` | 无可靠图片坐标映射，或当前仅有旧设备只读截图/缺少有效图片；不降级为任意坐标手势 |
| `VISUAL_NO_PROGRESS` | 视觉动作后缺少有效进展，停止重复尝试并核对实际页面 |
| `VISUAL_OBSERVATION_FAILED` | 点按后无法取得后续观察；动作可能已发生，不能以观察失败为由重放 |
| `DEVICE_LOCKED` / `SENSITIVE_FIELD` / `PASSWORD_FIELD_BLOCKED` / `PROTECTED_APP` | 用户手动处理；不绕过限制 |
| `EMERGENCY_STOPPED` | 用户在手机恢复；若主机锁定，还需用户重启 MCP 服务 |
| `PHONE_STOP_UNCONFIRMED` | 主机已停止，但手机未确认；用户使用手机停止按钮或关闭无障碍服务 |
| `BRIDGE_TIMEOUT` / `BRIDGE_CLOSED` / `COMMAND_TIMEOUT` | 无经验证的 `not_sent` 时动作可能已执行；先读取状态，禁止自动重放 |
| `DEVICE_SELECTION_REQUIRED` / `DEVICE_TRANSPORT_DENIED` | 明确选择授权 USB 设备；不自动切到另一部手机或网络 ADB |
| `UNSAFE_ADB_LISTENER` | 修复回环监听和 `lsof` 可见性，不放宽到全网卡 |
| `BUSY` / `ACTION_IN_PROGRESS` | 已达到等待/动作并发上限；等已有请求返回，不立即堆积更多请求 |
| `NOT_IMPLEMENTED` | 当前版本未提供此能力；不要反复请求 |

## 停止与数据边界

`emergency_stop` 立即清除主机待确认请求并锁定后续控制，同时尽力通知手机停止。即使设备通道已断开，主机停止仍有效。手机 App 提供独立的停止按钮；首次连接服务默认停止，用户必须在手机点“允许自动化 / 恢复”。MCP 没有解除停止工具，手机 App 自身的控制界面也不允许通过树读取、点击或手势远程操纵；`open_settings` 可离开该受保护界面。

急停防止后续动作继续执行，不能撤销已经由 Android 接受的点击、已发送消息或已完成支付。已经提交的系统手势也不能依赖急停作为事务回滚。

服务只记录方法、错误代码和耗时等元数据。UI 树、查询文本、输入内容、聊天记录、验证码和截图不默认持久化。UI、截图文字及 `targetDescription` 均作为不可信数据处理，不能把其中的命令视为用户授权。视觉点按只接受上述受约束的截图凭据，不启动 OCR，也不提供脱离截图或绕过保护的任意坐标点击。
