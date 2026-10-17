# TapPilot — Android AI Agent

由电脑控制 Android 手机的 AI 助手。**电脑配置 LLM、接收任务并决定操作，手机只负责连接、读取界面和执行动作。** 桌面客户端可自行运行，无需 Codex；也保留可选 MCP 接口供外部 Agent 使用。优先使用原生 UI 语义与节点动作，不依赖 OCR，也不把截图作为每步输入。

电脑端支持 Chat Completions 兼容接口：API Base URL、API Key、模型名称由用户配置，模型需要支持 function tool calls。电脑通过 **USB（ADB）或同一局域网内扫码配对**连接手机。扫码连接日常使用不需要 ADB、开发者模式或数据线；手机端没有模型配置和独立任务入口。**构建通过不代表真机或任意模型验收通过**；实际覆盖见 [验证记录](docs/validation.md)。

## 桌面客户端快速开始

版本号仍为 v0.3.19，本次将节点重新定位、遮挡检查和点按执行统一放到 Android。桌面客户端与 MCP 共用工具控制层，USB 与扫码连接共用手机执行器，无需 Codex。**需要重新构建并安装本次电脑端和手机 APK，即使界面仍显示同一版本号。** 旧 APK 未声明 `node-v1` 执行能力时，目标动作会返回 `EXECUTOR_UPGRADE_REQUIRED`，不会回退到旧电脑算法。结束前仍自动核对手机状态；失败原因与模型说明分别显示。

模型输出长度使用厂商默认值，请求不发送输出 token 上限；客户端也不再按累计 token 用量停止任务。厂商返回截断回复时不执行该轮动作。两端保留黑白主题切换，默认深色并记住选择。桌面使用 beUI 的 React 组件与 Motion 动效，Android 为原生适配，见 [组件来源与设计说明](docs/design.md)。

电脑端开发构建：

```bash
cd server
npm ci
npm run build
cd ../desktop
npm ci
npx --no-install install-electron
npm run build
npm start
# 生成本机 macOS .app
npm run package:mac
```

在**电脑客户端**的模型页填写接口地址（通常包含 `/v1`）、模型名称与密钥，保存并测试连接。在设备页通过 USB 或扫码连接手机，再到任务页输入目标。密钥只保存在电脑，使用 Electron safeStorage；不能使用安全存储时明确失败，不回退到明文。界面内容会发送给用户选择的模型服务，其保留策略由该服务决定。TapPilot 不默认保存任务、回答或 UI 树。

模型页的**自动改进**会从任务失败中提取不含文字的结构证据，在电脑空闲时让当前模型生成条件与操作步骤，经过同模型配对测试后采用，供后续任务使用；再次失败会撤回并尝试改进子代。后台测试使用合成界面；涉及原生动态标签的新技能还必须通过专用 Android 模拟器验证，不操作日常手机。可能产生模型费用：每天最多 2 轮、200 次请求，可随时关闭或撤回改进。生成或测试失败会保存固定原因，重启后仍可看到“模型请求超时”“测试环境未准备”等状态，不保存服务商原始错误内容。它不额外增加手机执行过程中每一步的模型调用，也不自动修改运行中的源码。完整流程及能力边界见 [自动技能改进](docs/learning-implementation.md#自动技能改进)。

技能库使用本地 SQLite，按需读取和更新；每个手机任务使用冻结的内存快照。旧 JSON 技能库会在首次访问时自动迁移并保留原文件备份，升级前请退出旧版 TapPilot。

本轮已减少生成请求中重复的结构字段，并分开单次请求、单个场景和整轮评测的超时预算。经过验证的可选预防程序可在首次动作及成功动作后的下一次决策前使用新界面对比证据，不必先重复犯错；仅匹配且具备证据的窗口增加一次有界等待和读取，不增加模型轮次。完整演练还会重新加载已采用技能，在新场景中核对实际使用和业务结果。**2026-10-17 已跑通一次真实模型 + Android 34 模拟器闭环**：从此前采集的原生失败重新生成候选，完成 22 次配对运行后自动采用，再从磁盘加载，在新任务中实际使用并成功完成。正常任务对照的模型调用从 33 次降到 24 次，上下文拒绝从 9 次降到 0 次。证据及合成场景边界见上述实施记录。

原生技能采用目前覆盖 `input_text` 遇到 `PAGE_CONTEXT_CHANGED` 的动态标签场景。其他原生失败机制尚未覆盖时会明确拒绝采用，不表示任意 App 能自动修复。开发验证需另建名为 `tappilot-learning-*` 的专用 AVD，安装本项目和合成测试 App、开启测试无障碍服务，启动电脑端时指定其 ADB 串号：

```bash
TAPPILOT_SKILL_EMULATOR=emulator-5580 npm --prefix desktop start
```

串号以实际模拟器为准；可用 `ADB_PATH` 指定本机 ADB。未准备专用环境时仍可正常控制手机，但需要原生验证的新技能不会被采用。电脑设备页选中的用户手机不会用于后台学习评测。

Android APK 构建与安装见下文。扫码模式可把 APK 传到手机，通过系统安装器手动安装，无需开启开发者选项。手机手动开启无障碍并允许自动化后，连接电脑；执行期间可在手机 App 紧急停止。部分系统会限制侧载权限或后台运行，须使用系统允许的用户授权流程。

桌面任务遇到发送、购买、删除等疑似敏感提交控件会停止，请用户在手机手动完成。关键词判断无法覆盖所有业务语义，模型仍受任务范围约束。它不会自动操作 MCP 的人工批准 CLI。桌面演示模式使用合成设备与合成模型，不会操作真机，也不代表真实 LLM 验收。

可直接输入：**“打开系统设置，根据当前页面进入电池相关页面，告诉我显示了什么，不修改任何设置。”** 查看进度中的模型耗时、工具耗时和调用次数，以区分模型等待与手机操作耗时。

### 电脑无线控制手机

1. 安装两端客户端，电脑和手机加入同一局域网。手机手动开启无障碍服务并允许自动化。
2. 电脑设备页选择无线模式和本机局域网地址，点击「显示二维码」。仅此时启动监听。
3. 手机选择「扫码连接」，点击「扫描二维码」，扫描后点击「连接电脑」。也可展开「无法扫码？粘贴配对地址」作为备用入口。手机验证二维码中的证书指纹，再通过加密 WebSocket 主动连接电脑。配对信息不能交给陌生人。
4. 电脑确认手机连接后选择该设备，在任务页开始任务。无线任务不调用 ADB，无需 USB 调试。
5. 取消任务保留配对连接；断开无线连接或退出电脑客户端会结束本次会话。手机有可见前台通知，可断开或紧急停止。

初次配对有效 5 分钟，每次电脑客户端会话生成新的证书和配对信息。已配对设备在同一会话内可由用户重新连接；应用重启后重新扫码。断线会终止旧任务，即使重新连接也不会重放旧动作。本版不提供公网中继、不开放无线 ADB。

## 技术选择与边界

手机端无障碍服务读取 `AccessibilityNodeInfo`，将树裁剪为 JSON。USB 通道监听抽象 Unix socket `tappilot`，校验对端为 Android shell/root UID；无线通道由手机主动通过 WSS 连接已配对的电脑。模型调用与任务循环都在电脑运行。Mac 端可复用授权 USB ADB 转发，MCP Server 仍可通过 stdio 供外部 Agent 使用。协议格式与模型厂商解耦，不内置云端代理或共享 API Key。

复用官方 [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 和 Android/ADB 平台接口。已评估 [Mobile MCP](https://github.com/mobile-next/mobile-mcp)、[Android Remote Control MCP](https://github.com/danielealbano/android-remote-control-mcp) 与 [uiautomator2](https://github.com/openatx/uiautomator2)。它们可用作完整替代方案或兼容性基准，但本项目选择更小的本地服务来落实事件等待、快照失效和明确的操作授权模式。具体取舍与来源见 [架构说明](docs/architecture.md)。

无障碍服务由系统管理，用户必须手动开启。自绘 Canvas、游戏、部分 WebView/Compose 页面可能缺少语义；Activity 只能提供事件推断的提示，不能保证获得真实 Activity 名称。密码、锁屏和系统标记的敏感控件不作为可操作目标。首版面向侧载开发，不承诺所有 App 兼容或可直接上架 Google Play。

## 目录

```text
android/             Kotlin 被控端、连接/权限/急停、无障碍、本地 RPC
desktop/             Electron 桌面客户端、模型/设备配置、任务进度与停止
server/              电脑模型 runtime、客户端工具适配、MCP、ADB、批准 CLI
scripts/             环境检查、APK 安装、MCP 注册、真机冒烟/交互验收
examples/            Codex 配置模板、动态设置导航验收提示词
docs/                架构、通信协议、验证记录
AGENTS.md            手机操作约束、批准规则、按风险验证与停止规则
```

## 1. 环境与构建

开发构建要求 macOS、JDK 17、Node.js 22.13 或更新版本、Android SDK Platform 35、对应 Build Tools、Platform Tools (`adb`)；手机 Android 8.0/API 26 或以上。无需 Root。Gradle wrapper 会下载固定版本 Gradle，首次构建也需要访问 Google Maven/Maven Central/npm。安装已打包客户端后无需这些开发环境；桌面 USB 通道仍需 ADB。

```bash
git clone <你的 TapPilot 仓库地址>
cd TapPilot
./scripts/doctor.sh

# Android Studio 的 SDK 默认路径；已有配置时使用已有值。
export ANDROID_HOME="$HOME/Library/Android/sdk"
# Homebrew JDK 17 用户可按安装位置设置：
export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"

cd android
./gradlew assembleDebug
cd ../server
npm ci
npm run build
cd ..
```

APK 输出：`android/app/build/outputs/apk/debug/app-debug.apk`。`local.properties` 可以替代 `ANDROID_HOME` 指定本地 `sdk.dir`，该文件已加入忽略列表。已有可用 JDK 时不必执行 Homebrew 示例。

## 2. USB 开发安装与手动授权

1. 手机开启开发者选项和 USB 调试，用 USB 连接 Mac，手动同意 RSA 调试授权。
2. 执行 `adb devices -l`，确认目标序列号状态为 `device` 且为 USB 设备。
3. 安装并打开 App：

```bash
./scripts/install.sh YOUR_USB_SERIAL
```

4. 阅读 TapPilot 的能力说明，通过 App 的按钮进入系统无障碍设置，手动启用 TapPilot。若 Android 对侧载应用提示受限设置，只使用系统提供的手动授权流程；不要用 `settings put secure` 或其他脚本绕过。
5. 返回 TapPilot，点击「允许自动化 / 恢复」；首次安装默认停止，单独开启无障碍服务还不够。保持手机解锁。App 内可查看状态并紧急停止；停止后只能由用户回到手机 App 恢复。

服务运行与 ADB 授权是两件事：ADB 已连接并不代表无障碍服务已经启用。App 的普通 Activity 退出后，无障碍服务仍由系统管理；OEM 省电策略可能终止进程，需重新确认状态。

## 3. 可选：注册到 Codex

在项目根目录执行：

```bash
./scripts/register-mcp.sh YOUR_USB_SERIAL
codex mcp list
codex
```

注册脚本将解析当前 `node`、`adb` 和项目的绝对路径，运行官方支持的 `codex mcp add`。不指定序列号时只允许自动选择唯一的已授权 USB 设备；多设备时明确失败，不会猜选。模板见 [codex-config.toml](examples/codex-config.toml)，官方注册说明见 [Codex MCP 文档](https://developers.openai.com/codex/mcp/)。更换 Node 安装位置或移动仓库后重新注册。

默认使用 `manual` 模式，点击、输入和手势需要逐次人工批准。用户已经授权代理持续操作本人手机时，可以为该 USB 设备启用 `trusted` 模式：

```bash
TAPPILOT_APPROVAL_MODE=trusted ./scripts/register-mcp.sh YOUR_USB_SERIAL
```

`trusted` 必须显式固定 `TAPPILOT_SERIAL`；注册脚本会将上面的序列号写入 MCP 环境配置。此模式下点击、输入和手势不再要求终端逐次批准，仍然校验实时快照、锁屏、密码字段、停止状态和 USB 通道。模式只在服务启动时读取，不提供切换模式的 MCP 参数。更新注册后重启 Codex 或重新建立 MCP 连接；无需重装 Android APK。若要恢复逐次批准：

```bash
TAPPILOT_APPROVAL_MODE=manual ./scripts/register-mcp.sh YOUR_USB_SERIAL
```

MCP 启动本身不要求手机已连接。设备相关工具首次调用时建立转发，并校验端口仅监听 loopback；如果 ADB 用 `-a` 开放了所有网卡，连接会被拒绝。不要手动把转发端口开放到局域网。

## 4. 实际操作与授权模式

在 Codex 输入：

> 使用 TapPilot 读取当前手机界面，打开系统设置，根据实时控件找到电池相关页面，告诉我当前显示了什么。不要修改设置。

Codex 首先读取 UI，再按返回的 `snapshotId` / `nodeId` 操作。每个动作工具默认执行一次动作、短暂等待界面事件，再返回 `observation`（新 UI 树）及分段耗时；模型直接检查该界面并使用其中的新节点继续，无需常规地再调用读取或截图。`accepted` 只表示系统接受请求，仍需检查返回界面是否达到目标。只有观察失败、目标内容缺失、动画未结束或节点失效时才补读或等待。`observationError` 表示动作已被接受但观察失败，不能重放动作。重新建立 MCP 连接后才能加载新版工具行为；本次还须覆盖安装提供 `node-v1` 执行器的手机 APK。

**`manual` 模式下，所有点击、文本输入和坐标手势均需逐次人工批准；`trusted` 模式下，按用户持续授权直接执行这些动作。** 滚动、返回/Home/最近任务、打开设置首页在两种模式下均无需批准。手机执行器对付款、发送、删除或提交等疑似敏感标签拒绝自动操作；关键词无法覆盖全部业务语义，代理仍须遵循用户交付的任务范围。工具没有 `confirmed: true` 或修改授权模式的参数。

在 `manual` 模式下，当工具返回 `CONFIRMATION_REQUIRED`，Codex 应展示具体动作与批准信息。用户在独立 Mac 终端执行工具返回的命令，例如：

```bash
cd /absolute/path/to/TapPilot/server
npm run approve -- /tool-returned/private/socket/path APPROVAL_ID
```

CLI 会展示待执行动作并要求交互确认。批准后告诉 Codex 继续，它只可用**完全相同的参数**重试该工具；批准限时、单次有效，页面若已变化仍会拒绝。代理不得代替用户运行批准 CLI。批准数据只在进程内存中，退出即清除。

紧急停止可以通过手机 App 或 `emergency_stop` 工具触发。断线时 host 急停也会锁定后续写操作；设备收到急停后在本地保存停止状态。恢复需要用户操作手机，再按提示重新连接 MCP。急停不能撤销已经交给 Android 执行的动作。

## 5. 工具

| 工具 | 行为 |
| --- | --- |
| `get_device_info` | 查询 ADB 设备与手机服务状态 |
| `get_current_app` | 当前包名、窗口及尽力提供的 Activity 提示 |
| `get_ui_tree` | 带快照与版本的有界精简树 |
| `find_element` | 通过文本、资源 ID、描述或属性查询；返回新的快照引用 |
| `tap_element` | 手机端按节点重新定位、检查遮挡后点按；电脑不生成触点坐标 |
| `click_element` | `ACTION_CLICK`；必要时使用可点击祖先，同样检查目标与遮挡 |
| `input_text` | `ACTION_SET_TEXT`，支持中文；拒绝密码输入 |
| `scroll` | 对指定可滚动节点执行原生动作 |
| `swipe` | 绑定快照的坐标手势，用于语义不足时的人工指导；`manual` 模式需批准 |
| `press_key` | 返回、Home、最近任务 |
| `wait_for_ui_change` | 按事件版本或 selector 等待，带超时，不循环截图 |
| `open_settings` | 仅打开设置首页；不直接跳转电池页面 |
| `act_and_observe` | 一次动作、事件等待和新 UI 读取合并成一次 RPC；动作已执行但观察失败时单独返回 `observationError` |
| `emergency_stop` | 立即锁定后续操作并通知手机端停止 |
| `take_screenshot` | 首版返回未实现状态，视觉兜底属于第二阶段 |

响应具有 `ok`、`result` 或明确 `error.code/message/retryable`，以及耗时。七个独立动作工具保留原动作字段，并附 `observation`、`timings` 和可选 `observationError`；`act_and_observe` 保留 `{action, observation, timings}` 结构，可自定义等待上限。`wait_for_ui_change` 超时是正常结果，不等于动作失败。详细字段、限制与错误恢复见 [通信协议](docs/protocol.md)。

## 6. 验证与验收

本项目初次实现涉及安全、协议和构建，属于 S3；使用相关模块检查，不追加无关全量检查。

动作链的场景矩阵、回归命令和真机判定标准见 [Agent 回归测试](docs/agent-regression.md)。不依赖模型的 Android 测试在专用模拟器运行真实无障碍服务与测试 App，经桌面和 MCP 两个入口验证持续刷新、节点替换、遮挡及中文输入，以 App 内独立计数和最终状态判定。另保留使用合成模型和手机的运行循环测试；两者均不等于任意第三方 App 的兼容性验收。

失败诊断、120 场景评测、Android 合成测试 App、自动技能改进与隔离修复的实施记录和运行命令见 [失败学习与回归评测](docs/learning-implementation.md)。任务正文不落盘，桌面只保存有界的脱敏诊断、结构失败片段、经过严格校验的程序技能及评测元数据。合成评测改善不代表任意真实 App 已经验证成功；开发侧源码修复产物仍为 `needs_review`，需要独立评审。

```bash
# 无手机：验证 MCP、传输边界和批准机制。
cd server
npm test
cd ..

# 真机：通过真实 MCP stdio 初始化并调用 APK，打开设置、读取结构和查询。
TAPPILOT_SERIAL=YOUR_USB_SERIAL node scripts/device-smoke.mjs

# 真机动态多步骤验收：启动交互式 Codex，由模型根据当前 UI 决策。
./scripts/acceptance.sh
```

英文设置页面可为冒烟测试指定 `TAPPILOT_SETTINGS_LABEL=Settings`。冒烟测试只验证通道与基础读取，不冒充电池导航验收。交互验收允许最多 12 步导航，以真实 UI 树决定查找/滚动/点击；`manual` 模式下如需点击，用户完成上述批准，`trusted` 模式直接执行已授权操作。成功标准：进入实际电池相关页面、报告当前可见内容，并能说明对应的 MCP 操作。若 OEM Settings 包名不含 `settings`，冒烟测试会要求人工核实包名，不能把此结果直接当作平台不支持。

测试及服务日志不保存真实 UI 树；stderr 只记录方法、状态和耗时。**UI 内容仍会作为 MCP 返回值进入 Codex 对话**，其保留策略由 Codex 配置和服务决定，不能将「TapPilot 不落盘」理解为端到端不保留数据。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 浏览器可访问模型接口，但客户端报 `MODEL_CONNECTION_FAILED` | 使用 v0.3.8 或更新版并重启电脑客户端；模型请求会遵循系统代理设置。确认系统代理服务正常运行后，在模型页重新测试。不会关闭证书校验或自动重试 |
| 模型输出被截断 `MODEL_OUTPUT_LIMIT` | 检查模型厂商或网关的输出/上下文限制。客户端不再发送输出 token 上限参数，旧配置中的该字段也会被忽略。截断回复中的动作不会执行 |
| 任务因 `REPEATED_ACTION` 停止 | 使用 v0.3.10 或更新版，展开任务进度查看具体动作、失败原因和界面变化。v0.3.10 保留重新读取前的无效点击事实；原生点击被接受不代表生效，不能盲目重放。任务进度仅在当前窗口内存保留，没有可查询的历史任务数据库 |
| 任务因 `PAGE_CONTEXT_UNSTABLE` 停止 | 目标仍匹配，但操作前的页面上下文两次变化，电脑未发送这两次操作并停止继续尝试。等待页面稳定，或手动完成当前一步后开始新任务。换节点、读取状态和背景文字刷新不会恢复尝试次数 |
| `adb` 无设备 / `unauthorized` / `offline` | 检查 USB 线、USB 调试和手机 RSA 授权；明确选定序列号 |
| USB 多设备或网络 ADB 被拒绝 | USB 模式明确选定授权序列号；无线模式使用客户端配对，不能填网络 ADB 地址 |
| 旧版点击扫码直接退出 | 升级至 v0.3.7；已补齐扫码所需的 AndroidX Core 运行依赖。相机权限被拒绝时，在系统应用权限中允许相机后再试，也可粘贴配对地址 |
| 手机 TapPilot 有画面但按钮都点不动 | 第三方浮窗可能触发遮挡保护。修复版在 Android 12+ 打开授权页或扫码页时隐藏非系统浮窗；仍被遮挡会显示提示，请关闭悬浮窗后重试，不必清除应用数据 |
| 无线扫码后连接失败 | 两端同一局域网、选正确网卡；检查 Mac 防火墙/访客网络隔离和配对是否过期。不关闭证书校验，不开放 ADB 端口 |
| 无线断线后任务停止 | 检查当前手机界面，重新连接并开始新任务；旧任务不会自动恢复或重放 |
| socket 不存在 / 服务不可用 | 在手机手动开启 TapPilot 无障碍服务，检查是否被系统/OEM 停止 |
| 无活动窗口 / 设备锁定 | 手动解锁并打开一个可访问的页面；系统保护不能绕过 |
| `STALE_SNAPSHOT` | 重新 get/find 并获取新引用；动画和动态内容也可能使快照失效 |
| 控件无点击/编辑能力 | 检查可点击祖先或新的 UI 结构；不能重复盲点，密码字段不允许输入 |
| 返回空树或节点截断 | 树受 maxNodes/maxDepth 限制；适度扩大参数或滚动。自绘/敏感内容可能始终不可见 |
| 等待超时 | 检查 `timedOut` 并读取当前状态；不是每个动作都会产生目标事件 |
| 批准后仍被拒绝 | 核对相同参数、批准有效期、快照是否变化；禁止复用旧批准 |
| 已配置 `trusted` 仍要求批准 | 重启 Codex 或重新建立 MCP 连接，让服务读取新的环境配置 |
| `trusted` 模式无法启动 | `TAPPILOT_APPROVAL_MODE` 只能为 `manual` 或 `trusted`；`trusted` 必须同时配置 `TAPPILOT_SERIAL` |
| 急停后无法操作 | 用户在手机 App 恢复，并重新启动 MCP 会话；不能通过远程命令解除 |
| `lsof` 或 loopback 检查失败 | 使用 macOS 的 `lsof`，关闭开放到网络的 ADB server 后正常启动 `adb start-server`；不要使用 `adb -a` |
| Gradle 找不到 Java / SDK | 指向实际 JDK 17 与 SDK；安装 Platform 35，检查 `JAVA_HOME`/`ANDROID_HOME`/`local.properties` |
| Codex 找不到工具 | 检查 `codex mcp list`、绝对路径和已构建的 `dist/index.js`；重启会话，在 `/mcp` 查看状态 |

## 效率与后续范围

电脑任务循环启动时预读当前 UI，让第一次模型请求直接决策；`act_and_observe` 把动作、等待、读取从三次工具往返合成一次。动作后的 UI 无变化、缺失或为空，或遇到可恢复的观察错误时，电脑最多补读一次，再交给模型；等待工具只返回事件或局部匹配时也自动补读。已有完整界面且等待刷新入口可用时，下一轮暂不提供整屏读取和查找工具，缺失或截断后恢复；模型仍请求历史读取工具时会真实读取，不使用缓存冒充新界面。节点去掉空字段，历史快照从上下文移除。最多一个界面变更动作进入同一模型轮次，失败不自动重复执行。

页面持续刷新按目标身份和页面上下文分别记录证据。既有原生列表整行点击规则允许同列表其他稳定行的普通叶子文字更新；标题、表单、其他列表及无法确认的变化继续受保护。连续两次可信的页面上下文拒绝会在下一次模型请求之前停止；仅有背景文字变化、成功返回但未生效的动作、换节点或再次读取均不会清零。已接受动作后的窗口/App 切换，或唯一可编辑字段显示了本次要求输入的文字，才能恢复这项次数。测试覆盖每次读取和预检都变化的页面，详见 [持续改进实现](docs/learning-implementation.md)。

截图视觉兜底与更多厂商原生 API 适配可以继续扩展。模型实际推理时间仍由用户选择的服务决定；不能把减少工具往返当作已测得整任务加速倍数。
