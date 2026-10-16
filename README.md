# TapPilot — Android AI Agent

用户自行配置 LLM 的 Android 手机助手。提供 **TapPilot 桌面客户端、Android 独立客户端，以及可选 MCP 接口**。模型接入和任务循环由 TapPilot 自己运行；使用独立客户端不需要 Codex。优先使用原生 UI 语义与节点动作，不依赖 OCR，也不把截图作为每步输入。

独立客户端支持 Chat Completions 兼容接口：API Base URL、API Key、模型名称由用户配置。能接入接口不等于模型一定能够可靠完成任务；模型需要支持 function tool calls。Android 客户端直接调用本机无障碍执行层，日常运行无需电脑、ADB 或数据线。桌面客户端支持同一局域网内配对后的无线连接，也保留 USB 开发通道。**构建通过不代表真机或任意模型验收通过**；实际覆盖见 [验证记录](docs/validation.md)。

## 独立客户端快速开始

v0.3.5 双端改为黑底白字、深灰分层：桌面使用窄侧栏和独立任务区，手机采用细线导航和开放式设置分区。继续使用 beUI 的 React 组件与 Motion 动效，Android 为原生适配。[组件来源与设计说明](docs/design.md)记录了布局、上游版本及许可证。本次仅更新配色源码，现有安装包仍为 v0.3.4；使用新版需按下方命令重新构建。

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

在客户端的模型配置页填写接口地址（通常包含 `/v1`）、模型名称与密钥，保存并测试连接。选择设备后开始任务。桌面密钥使用 Electron safeStorage，Android 使用 AndroidKeyStore 加密保存；不能使用安全存储时明确失败，不回退到明文。界面内容会发送给用户选择的模型服务，其保留策略由该服务决定。TapPilot 不默认保存任务、回答或 UI 树。

Android APK 构建与安装见下文。也可以把 APK 传到手机，通过系统安装器手动安装，无需为独立运行开启开发者选项。手动开启无障碍并允许自动化后，在手机内配置模型和任务；执行期间通过通知或 App 停止。部分系统会限制侧载权限或后台运行，须使用系统允许的用户授权流程。

首版独立客户端遇到发送、购买、删除等疑似敏感提交控件会停止，请用户在手机手动完成。关键词判断无法覆盖所有业务语义，模型仍受任务范围约束。它不会自动操作 MCP 的人工批准 CLI。桌面演示模式使用合成设备与合成模型，不会操作真机，也不代表真实 LLM 验收。

可直接输入：**“打开系统设置，根据当前页面进入电池相关页面，告诉我显示了什么，不修改任何设置。”** 查看进度中的模型耗时、工具耗时和调用次数，以区分模型等待与手机操作耗时。

### 电脑无线控制手机

1. 安装两端客户端，电脑和手机加入同一局域网。手机手动开启无障碍服务并允许自动化。
2. 电脑设备页选择无线模式和本机局域网地址，点击「显示二维码」。仅此时启动监听。
3. 手机设备页扫描电脑二维码，或粘贴配对链接。手机验证二维码中的证书指纹，再通过加密 WebSocket 主动连接电脑。配对信息不能交给陌生人。
4. 电脑确认手机连接后选择该设备，在任务页开始任务。无线任务不调用 ADB，无需 USB 调试。
5. 取消任务保留配对连接；断开无线连接或退出电脑客户端会结束本次会话。手机有可见前台通知，可断开或紧急停止。

初次配对有效 5 分钟，每次电脑客户端会话生成新的证书和配对信息。已配对设备在同一会话内可由用户重新连接；应用重启后重新扫码。断线会终止旧任务，即使重新连接也不会重放旧动作。本版不提供公网中继、不开放无线 ADB。

## 技术选择与边界

手机端无障碍服务读取 `AccessibilityNodeInfo`，将树裁剪为 JSON。USB 开发通道监听抽象 Unix socket `tappilot`，校验对端为 Android shell/root UID；独立手机客户端使用 HTTPS 访问用户配置的模型。Mac 端可复用授权 USB ADB 转发，MCP Server 仍可通过 stdio 供外部 Agent 使用。协议格式与模型厂商解耦，不内置云端代理或共享 API Key。

复用官方 [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 和 Android/ADB 平台接口。已评估 [Mobile MCP](https://github.com/mobile-next/mobile-mcp)、[Android Remote Control MCP](https://github.com/danielealbano/android-remote-control-mcp) 与 [uiautomator2](https://github.com/openatx/uiautomator2)。它们可用作完整替代方案或兼容性基准，但本项目选择更小的本地服务来落实事件等待、快照失效和明确的操作授权模式。具体取舍与来源见 [架构说明](docs/architecture.md)。

无障碍服务由系统管理，用户必须手动开启。自绘 Canvas、游戏、部分 WebView/Compose 页面可能缺少语义；Activity 只能提供事件推断的提示，不能保证获得真实 Activity 名称。密码、锁屏和系统标记的敏感控件不作为可操作目标。首版面向侧载开发，不承诺所有 App 兼容或可直接上架 Google Play。

## 目录

```text
android/             Kotlin 客户端、模型循环、密钥存储、无障碍、本地 RPC
desktop/             Electron 桌面客户端、模型/设备配置、任务进度与停止
server/              独立模型 runtime、客户端工具适配、MCP、ADB、批准 CLI
scripts/             环境检查、APK 安装、MCP 注册、真机冒烟/交互验收
examples/            Codex 配置模板、动态设置导航验收提示词
docs/                架构、通信协议、验证记录
AGENTS.md            手机操作约束、批准规则、按风险验证与停止规则
```

## 1. 环境与构建

开发构建要求 macOS、JDK 17、Node.js 22.12 或更新版本、Android SDK Platform 35、对应 Build Tools、Platform Tools (`adb`)；手机 Android 8.0/API 26 或以上。无需 Root。Gradle wrapper 会下载固定版本 Gradle，首次构建也需要访问 Google Maven/Maven Central/npm。安装已打包客户端后无需这些开发环境；桌面 USB 通道仍需 ADB。

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

Codex 先读取 UI，再按返回的 `snapshotId` / `nodeId` 操作。页面变化后旧引用失效；`STALE_SNAPSHOT` 必须重新读取和定位。点击返回 `accepted` 仅表示系统接受请求，后续 `wait_for_ui_change` 和 `get_ui_tree` 才能确认结果。使用动作结果中的 `revision` 等待后续事件；动作前的旧版本已被动作接受时主动推进，立即返回 `changed` 不能证明导航完成。也可等待目标 selector 出现，但仍需读取实际页面判断。

**`manual` 模式下，所有点击、文本输入和坐标手势均需逐次人工批准；`trusted` 模式下，按用户持续授权直接执行这些动作。** 滚动、返回/Home/最近任务、打开设置首页在两种模式下均无需批准。服务不依靠按钮关键词自动区分付款、发送、删除或提交，代理仍须遵循用户交付的任务范围。工具没有 `confirmed: true` 或修改授权模式的参数。

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
| `click_element` | 原生点击；必要时使用可点击祖先，明确返回实际目标 |
| `input_text` | `ACTION_SET_TEXT`，支持中文；拒绝密码输入 |
| `scroll` | 对指定可滚动节点执行原生动作 |
| `swipe` | 绑定快照的坐标手势，用于语义不足时的人工指导；`manual` 模式需批准 |
| `press_key` | 返回、Home、最近任务 |
| `wait_for_ui_change` | 按事件版本或 selector 等待，带超时，不循环截图 |
| `open_settings` | 仅打开设置首页；不直接跳转电池页面 |
| `act_and_observe` | 一次动作、事件等待和新 UI 读取合并成一次 RPC；动作已执行但观察失败时单独返回 `observationError` |
| `emergency_stop` | 立即锁定后续操作并通知手机端停止 |
| `take_screenshot` | 首版返回未实现状态，视觉兜底属于第二阶段 |

响应具有 `ok`、`result` 或明确 `error.code/message/retryable`，以及耗时。`wait_for_ui_change` 超时是正常结果，不等于动作失败。详细字段、限制与错误恢复见 [通信协议](docs/protocol.md)。

## 6. 验证与验收

本项目初次实现涉及安全、协议和构建，属于 S3；使用相关模块检查，不追加无关全量检查。

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
| `adb` 无设备 / `unauthorized` / `offline` | 检查 USB 线、USB 调试和手机 RSA 授权；明确选定序列号 |
| USB 多设备或网络 ADB 被拒绝 | USB 模式明确选定授权序列号；无线模式使用客户端配对，不能填网络 ADB 地址 |
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

独立执行循环启动时预读当前 UI，让第一次模型请求直接决策；`act_and_observe` 把动作、等待、读取从三次工具往返合成一次；给模型的节点去掉空字段，历史快照从上下文移除。执行仍然逐步验证，最多一个界面变更动作进入同一模型轮次，失败不自动重复执行。

截图视觉兜底与更多厂商原生 API 适配可以继续扩展。模型实际推理时间仍由用户选择的服务决定；不能把减少工具往返当作已测得整任务加速倍数。
