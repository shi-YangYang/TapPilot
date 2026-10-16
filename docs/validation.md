# 验证记录

## 重复操作与观察时机修复 v0.3.9（2026-10-16）

范围为 S2 的相关运行时、桌面诊断和 Android 观察集成：不扩大重试预算，不移除急停或权限保护，不增加任务内容持久化。

- 读取失败任务的当前桌面进度，确认 12 轮后停止；旧版仅显示工具摘要，未保存动作参数或失败原因。源码和应用数据目录检查未发现任务历史数据库，不能据此还原原任务的每一次调用。
- 在已授权的 vivo V2352A 上通过 MCP 读取新树并定位购物文件夹：原生点击返回接受，但组合观察及后续独立读取都未显示打开；从新树目标 bounds 推导的单次触控手势成功打开文件夹。旧版组合观察仍先返回旧树，后续读取才看到文件夹内容。此项确认原生动作兼容性和观察过早两个现象，不代表已证明原任务全部失败原因。
- 服务端 10 项定向检查通过：新增 9 项进展与诊断回归，加既有快照 ID 变化用例。覆盖读取后判断、初始预读不计数、局部查找、重复动作不被快照或等待时长绕过、事件计数不冒充界面进展、无变化提示、错误脱敏，以及已接受动作观察失败后不重放。没有重复全套运行时测试。
- Android `ObservationSettleWindowTest` 3 项通过，覆盖动画开始事件、后续内容事件、伪唤醒、持续刷新截止、无事件与零等待；Debug APK 构建成功，版本 `0.3.9` / versionCode `12`。
- 桌面 typecheck、server/desktop 构建通过。隔离临时 profile 的 `electron-step-diagnostics.cjs` 通过，使用合成事件验证具体动作、失败原因、错误码、界面未变化和任务结束后的进度保留，没有请求真实模型。
- macOS arm64 应用打包成功。首次真机覆盖安装返回 `INSTALL_FAILED_ABORTED: User rejected permissions`，未绕过系统安装确认。用户随后解锁并授权重新安装，`adb install -r` 成功，`dumpsys package` 确认 `versionName=0.3.9`、`versionCode=12`。
- 更新后 MCP `get_device_info` 与 `get_ui_tree` 返回 `BRIDGE_CLOSED`；`dumpsys accessibility` 显示所有用户的 Enabled services / Bound services 均为空。已请用户手动重新开启 TapPilot 无障碍服务；目前不能把新版事件等待记为真机验收通过。

新版已安装，待手机无障碍服务恢复后，用电脑客户端重跑原任务。当前验证不包含用户模型的完整拼多多搜索流程。

## 电脑模型代理修复 v0.3.8（2026-10-16）

范围为 S2 的模型网络集成验证：共享运行时支持可选请求实现，电脑注入独立内存 Electron 网络会话。未改模型参数、手机传输或 UI 布局；Android 仅同步版本。

- 对用户已配置地址进行不带认证的 HEAD 诊断：原 Node fetch 直连返回 `UND_ERR_CONNECT_TIMEOUT`；经电脑现有系统代理获得 HTTP 401。没有解密/读取模型密钥，没有发送模型任务或手机界面。修复后用生产 `createModelFetch()` 再验证默认网络会话：`systemProxySelected=true`，同一地址获得 HTTP 401，确认原网络故障已解除。此结果不代表密钥、模型名称或工具调用已经验收。
- `server/test/model-transport.test.ts` 定向 4 项一次通过：测试连接与每轮 Agent 使用注入网络、请求限制保留、取消与响应上限、错误脱敏且不重试。
- `desktop/test/electron-model-network.cjs` 一次通过：独立临时 Electron profile 及本地合成代理验证真实模型请求经过代理、显式 Authorization 保留、浏览器 Cookie 不发送且响应 Cookie 不保存、重定向不跟随、取消生效。没有调用真实模型或操作手机。
- server、desktop 构建成功；macOS arm64 安装包版本为 `0.3.8`。Android Debug APK 构建成功，版本同步为 `0.3.8` / versionCode `11`；本次没有安装或操作真机。未重复手机、主题、无线协议或完整测试套件。

现有电脑配置保留。退出旧版并打开新版后，用户可在模型页通过「测试连接」验证实际认证和接口响应。

## 电脑主控与扫码修复 v0.3.7（2026-10-16）

范围为 S3 的相关 Android 验证：移除手机模型运行/任务服务，保留 USB 与无线执行接口；调整连接 UI，清理退役的手机模型凭据，补齐扫码运行依赖。桌面仅同步引导文案和版本，不重复桌面全套测试。

- 真机 crash buffer 定位到两次相同的 `NoClassDefFoundError: androidx.core.content.ContextCompat`，调用来自 ZXing `CaptureManager.openCameraWithPermission`。ZXing 4.3.0 的依赖声明遗漏 AndroidX Core；之前仅测试 APK 提供该类。正式 `implementation` 补充 `androidx.core:core:1.13.1`。
- Android Debug 与 AndroidTest APK 构建成功；最后一处触区由 44dp 调整为 48dp 恰在首轮编译后写入，因此仅增量重建 APK 纳入该改动，没有重复已通过的单测。版本为 `0.3.7` / versionCode `10`。
- JVM 定向检查 9 项一次通过：`PairingTest` 3 项、`WirelessConnectionTest` 6 项，覆盖配对校验、通道互斥、RPC 参数拒绝、断线取消和急停。
- 独立 API 34 arm64 模拟器仪器测试 9 项一次通过（4.161 秒）：`ClientInstrumentedTest` 4 项、`ScannerInstrumentedTest` 2 项、`EmergencyStopInstrumentedTest` 2 项、`LegacyModelCleanupInstrumentedTest` 1 项。扫码测试使用仅加载正式 APK 的独立 ClassLoader，避免测试依赖再次掩盖缺包；实际启动扫码 Activity 并验证安全窗口与拒绝相机权限后退出。UI 测试覆盖两个连接入口、固定急停、主题及配对草稿保持，无线连接期间阻止切换到 USB。旧模型清理测试只用合成命名空间与密钥。
- server/desktop 构建及 macOS arm64 打包成功，Plist 版本为 `0.3.7`。Android 已通过 `adb install -r` 覆盖安装到授权的 V2352A 真机，安装成功并确认 `versionName=0.3.7`、`versionCode=10`，没有清空应用数据或代开权限。

临时模拟器已清理。尚未实测真机相机解码电脑二维码和用户模型的完整无线任务；上述扫码启动回归不冒充真实配对验收。真机更新后由用户打开 TapPilot，允许所需权限，再从电脑发起任务。

## 主题切换 v0.3.6（2026-10-16）

范围为 S2：双端主题切换、独立本地偏好、Android 视图重建及桌面主题初始化资源。验证聚焦主题与草稿/运行状态保留，不扩展到无线协议或完整服务端测试。

- server 与 desktop 构建成功；桌面新增的主题定向 Electron 检查一次通过。实际点击切换，确认两色值、三页默认/960×700布局、当前页与未保存草稿保留、合成任务运行不中断、仅保存主题、刷新恢复浅色且不恢复敏感草稿。没有调用真实模型或配对手机。深浅两色截图保存于 `desktop/release/ui-preview-v0.3.6/`，已查看任务页实际效果。
- Android Debug/AndroidTest 单次构建成功；独立 API 34 arm64 模拟器运行 `themeSwitchPreservesDraftsAndLiveStateAndOnlyPersistsAppearance`，一次返回 `OK (1 test)`。覆盖五项输入、选区/焦点、页/滚动、合成任务及连接状态、后续观察者更新、主题恢复和草稿不持久化，以及 `FLAG_SECURE`、系统栏与弹窗主题。临时模拟器和目录已清理，未进行真机操作、截图或完整测试套件。
- macOS arm64 应用已打包，Plist 版本为 `0.3.6`；Android 构建版本为 `0.3.6` / versionCode `9`。两个安装包已更新，真机外观仍留待后续验证。

## 深色配色 v0.3.5（2026-10-16）

范围为 S0：双端颜色、深色主题资源及版本标识；布局、业务事件、权限与安全逻辑不变。配色修改时仅检查 diff，包括桌面白底常量替换、Android 主按钮文字对比、启动/系统栏/对话框配色，当时未运行测试或构建。源码提交为 `a269f3e`。

随后按用户明确要求打包：server 编译、desktop 构建与 macOS arm64 打包、Android `:app:assembleDebug` 均一次成功。Plist 确认 Mac 应用版本为 `0.3.5`；SDK `aapt` 确认 APK 为 `versionName 0.3.5`、`versionCode 8`。未追加测试、lint、桌面 typecheck、模拟器、截图或真机安装。产物分别位于 `desktop/release/TapPilot-darwin-arm64/TapPilot.app` 和 `android/app/build/outputs/apk/debug/app-debug.apk`。

## 黑白布局改版 v0.3.4（2026-10-16）

范围：双端三页布局、应用配色和导航视觉，属于 S2。未改模型运行、无线协议、凭据存储或权限逻辑；beUI 组件源码与依赖保持不变。版本同步为 0.3.4，Android versionCode 为 7。

- 服务端版本同步后编译、桌面 bundle 和样式构建成功。先仅渲染默认窗口与 960×700 的三页截图，确认黑白灰主题、侧栏层级、对齐及可见性，没有重叠或横向溢出；未因视觉检查重复运行功能测试。
- 既有 Electron smoke 单次通过：新版导航与菜单、受控输入、模型保存/连接测试、密钥加密及清空、任务提交、合成演示和取消、三页最小窗口布局。未新增镜像实现的测试，未重复无线或服务端测试套件。
- Android Debug 与 AndroidTest APK 单次构建成功。独立 API 34 arm64 模拟器运行原 `clientLaunchesWithTaskEntryAndStartControl`，返回 `OK (1 test)`，原断言未修改。临时模拟器及目录已清理，没有启用无障碍或自动化、操作真机、移除 `FLAG_SECURE` 或截取受保护手机页面。
- macOS arm64 应用完成打包。最终桌面三页、窄窗口及合成演示截图位于 `desktop/release/ui-preview-v0.3.4/`。没有调用用户模型；Android 真机外观留待后续验证。

## 原版 beUI 组件接入 v0.3.3（2026-10-16）

范围：桌面渲染层迁移到 React、引入 Tailwind/Motion 构建和原组件、重接 UI 事件，属于 S3 的相关客户端验证；Android 为 S2 的原生布局与动画适配。上游固定到 `c392b2e712c3d4944bfa4b24c54c8699bbf5f4c7`，组件来源与有限修改见 `desktop/src/beui/UPSTREAM.json`。

- 桌面 TypeScript 检查、React/主进程 bundle 和 Tailwind 构建通过。新增组件依赖均锁定版本，官方主题、Geist 字体与许可证打包到本地。
- 普通 Electron smoke 通过：实际 React 受控表单保存/测试、密钥加密及保存后清空、PromptInput 输入和提交、Tabs/Select 键盘交互、三页与 960×700 布局、合成演示及 UI 取消。初次检查因后台测试窗口没有系统焦点而失败；测试助手改为仅对自己 webContents 使用 Chromium 焦点模拟和输入事件后通过，未操作或解锁 macOS 桌面。
- 无线 Electron smoke 通过：通过新版 UI 连接生产配对控制器与合成 WSS 手机，保存本地模拟模型配置，PromptInput 的 Enter 触发任务，经动作及新观察返回结果；UI 取消、断线后不重放、UI 急停及断开正常。配对后二维码/链接清除，配对秘密未进入模型请求、持久化配置或截图。
- 视觉检查确认使用原组件的输入器、表单、标签与菜单。主导航外层宽度修正后重新构建，仅重拍相关页面，没有重复已通过的功能检查。
- Android Debug 和 AndroidTest APK 构建成功；独立 API 34 arm64 模拟器的原三页布局测试返回 `OK (1 test)`，关键控件可见且无横向溢出。模拟器未启用自动化权限，检查后清理临时目录。原生按钮/标签动画保留系统关闭动画时的直接状态更新。
- 最终 macOS arm64 安装包生成成功，Plist 与 asar 版本均为 `0.3.3`，包内包含 beUI、Geist 许可证与字体资源；APK 元数据为 `versionName 0.3.3`、`versionCode 6`。最终三页与窄窗口截图保存于 `desktop/release/ui-preview-v0.3.3/`。

本轮没有调用用户模型或控制真实手机，没有移除 `FLAG_SECURE`。Android 的原生适配不等于在手机运行 React 组件；真实设备外观和任务联调仍留待后续。未重复运行无关服务端测试。

## beUI 风格改版 v0.3.2（2026-10-16）

范围：双端三页布局、控件样式及少量界面状态展示，属于 S2。参考 beUI 免费设计规范，用原有 HTML/CSS 与 Kotlin View 实现；没有引入 React 或付费组件。验证限定于客户端界面和交付构建，未重复执行服务端及无线协议测试。

- 桌面构建与 macOS arm64 打包成功，包内 `CFBundleShortVersionString` 为 `0.3.2`。服务端仅同步版本并编译，为桌面 bundle 提供当前产物。
- 扩展现有 Electron smoke，一次通过：三页导航、960px 最小窗口横向边界、可见控件尺寸、合成演示完成与取消、隔离 renderer、合成密钥加密和本地模拟模型连接。截图中的网络地址、二维码和任务数据均为合成内容，没有配对真实手机或调用付费模型。
- 查看实际桌面渲染截图，核对任务、模型、设备和窄窗口布局。截图等待调整为 CSS 过渡结束后采集；仅重新采集截图，没有重复已通过的完整 smoke。截图入口使用临时应用元数据，避免直接启动测试脚本时把 Electron 版本显示为 TapPilot 版本。
- Android `assembleDebug`、`assembleDebugAndroidTest` 成功。APK 的 versionName 为 `0.3.2`、versionCode 为 `5`。
- 独立 API 34 arm64 模拟器安装两份 APK，扩展后的现有 `clientLaunchesWithTaskEntryAndStartControl` 返回 `OK (1 test)`：切换任务、模型、设备三页，检查横向边界、关键按钮及输入框滚动后可见。未启用无障碍或自动化权限，测试结束后移除临时模拟器。

保留 `FLAG_SECURE`、遮挡触摸保护和停止机制；没有绕过安全标志获取手机截图。此次 Android 验证为模拟器布局检查，未进行真实手机外观及自动化任务联调。

## 页面精简 v0.3.1（2026-10-16）

页面修改仅涉及双端文案、静态排版、版本标识及对应说明，按 S0 检查 diff，未运行测试或构建。操作逻辑及控件 ID 保留，源码提交为 `ed16a92`。

随后按用户明确要求完成 v0.3.1 打包：server 编译、desktop 构建及 macOS arm64 打包、Android `:app:assembleDebug` 均成功。macOS 包的 `CFBundleShortVersionString` 为 `0.3.1`；SDK `aapt` 确认 APK 的 versionName 为 `0.3.1`、versionCode 为 `4`。未追加测试、lint、真机安装或手机操作。产物仍在 README 所列目录。

## 无线客户端 v0.3（2026-10-16）

范围：新增局域网认证与传输、双端连接生命周期、任务互斥，属于 S3。用户明确选择继续开发、真机联调稍后进行；本次只使用合成模型、合成设备及独立测试模拟器，不调用用户付费模型。

| 检查 | 结果与覆盖 |
| --- | --- |
| WirelessHub | 11 项定向测试通过；临时证书、配对认证、单设备绑定、连接代次、超时与已知晚回包、并发限额与急停保留槽、网络资源边界 |
| PhoneClient + WSS | 真实 TLS/WebSocket 合成手机验证读取、动作及新观察、结束任务后连接复用；设备工具不调用 ADB |
| 生产工具 schema + runtime | 实际 `clientTools` 经 Ajv 与多轮 HTTP 模型循环通过，覆盖点击、合法滑动及非法坐标类型拒绝。修复嵌入动作 schema 后局部 `$ref` 指向错误的问题；原 v0.2 runtime 的简化 schema 夹具未覆盖此缺陷 |
| runtime 失败处理 | 断线/会话变化/超时停止，不重放动作；动作后的新观察失败会清除旧快照依据，不能用动作前界面报告已完成 |
| TypeScript | 当前 server 编译通过；最终桌面 bundle 已包含上述 schema 与 runtime 修复 |
| Android JVM 与构建 | 初轮 24 项相关测试通过；无线队列互斥收尾后仅复测新 7 项通过；急停竞态修复后仅复测无线 6 项通过，最终 Debug 与 AndroidTest APK 构建成功 |
| 急停持久化 | 修复已认证急停在断线时被可取消队列丢弃的竞态；无效参数/握手前请求不锁存。新增 2 项仪器测试最终通过：无服务连接也保存停止状态，持久化失败明确返回错误。失败模拟的 Editor 链式委托最初绕过了故障注入，修正测试后仅重跑该失败项，通过；未重复已通过项 |
| Android 设备页 | 临时 API 34 arm64 AVD 安装 0.3 APK，新增无线页仪器测试 `OK (1 test)`；扫码/粘贴/连接入口存在，页面导航不自动连接或保存配对凭据 |
| Kotlin ↔ Node 跨端 | `scripts/wireless-integration.mjs --serial emulator-5580` 通过，急停路径改动后在最终 APK 上定向复测通过。Android 生产 OkHttp/TLS pin/WSS 与 Node 主机完成三次 RPC：合成读取 → 动作及新观察 → 再读取。ADB 仅安装与启动测试，不传输这三次操作 |
| 桌面单测 | 11 项通过；配置/凭据保护、IPC 来源、配对代次/取消/过期与连接关闭 |
| 实际 Electron 完整链路 | 显式配对、证书 pin 握手、清除二维码/令牌显示、选择设备、真实 runtime 驱动合成手机、取消后复用连接、断线取消且不重放、独立急停、关闭会话均通过。故意配置不存在的 ADB 路径，证明无线链路不依赖 ADB；配对秘密未进入模型请求和持久化配置 |
| 最终 macOS 包 | `TapPilot.app` 的 asar 版本为 0.3.0；main、preload、renderer、HTML、CSS 与已通过上述 Electron smoke 的 bundle 哈希一致 |

没有启用模拟器无障碍、绕过 Mac 锁屏或读取真实聊天。Android 模拟器测试的 UI 执行器是合成夹具，不能验证真实 App 的无障碍兼容性。仍待用户方便后验证：真机无线扫码、OEM 后台服务、用户自选模型的工具决策，以及双端“设置 → 电池”完整任务。公开分发签名/公证与公网中继不在本版范围。

## 独立客户端 v0.2（2026-10-16）

范围：新增电脑和手机客户端、模型协议、凭据存储、执行循环和组合设备 RPC，属于 S3。按子系统检查，修复具体问题后仅复测相关范围。

| 检查 | 结果与覆盖 |
| --- | --- |
| TypeScript 编译 | runtime、client-tools 与新 MCP 工具编译通过；最后的点击祖先保护修复已编入桌面包 |
| `runtime.test.ts` | 12 项通过；真实本地 HTTP fixture 的多轮模型协议、启动预读、工具 schema、取消、敏感错误停止、上下文压缩和无观察不冒认完成 |
| `client-tools.test.ts` | 最终 6 项通过；单次 RPC 组合、观察失败不重放、取消写入前门禁、敏感目标及实际点击祖先、空字段压缩 |
| 受影响的原 `tools.test.ts` | 10 个测试项（含子测试）通过；manual/trusted、快照、密码、急停竞态保持 |
| `stdio.test.ts` | 2 项通过；真实 MCP SDK 握手、新组合工具 schema/风险注解和既有停止状态 |
| Android JVM | 17 项通过；Runtime 12 项、HTTPS ModelClient 5 项，含合成多轮执行、取消、敏感祖先、响应截断/格式/预算与 TLS mock 服务 |
| Android APK | `assembleDebug`、`assembleDebugAndroidTest` 成功，版本 0.2.0 |
| Android 仪器测试 | 专用临时 Android 34 arm64 AVD `emulator-5580` 实际安装两份 APK，`am instrument` 返回 `OK (3 tests)`；覆盖 Activity 输入及开始控件布局、真实 AndroidKeyStore 加密保存/读取/删除、非法原生组合方法提前拒绝 |
| 桌面配置与安全测试 | 6 项通过；IPC 来源、配置格式、密钥不回传、原子保存、换服务不继承旧密钥、取消 |
| Electron 实际运行 | UI smoke 通过；renderer 隔离、无 Key 回传、合成演示/取消、导航、系统 safeStorage 保存合成 Key、真实本地 HTTP 模型连接 |
| macOS 打包 | 生成 `desktop/release/TapPilot-darwin-arm64/TapPilot.app`；同版本首次包启动确认首页与 0.2.0。最终仅更新已测试的服务端敏感祖先保护后重新打包；Mac 随后锁定，未绕过锁屏重新操作新版窗口 |

效率证据：合成多步任务预读后模型请求从 3 次降为 2 次；组合动作仅派发一次设备 RPC，替代动作/等待/读取的三次；结构化返回在保留节点身份、层次和文字的同时减少字节。以上证明往返与载荷减少，**未宣称真实 LLM 端到端耗时提高某个倍数**。

本轮开始时 ADB 未发现真实手机；测试 AVD 为独立新建临时目录，不使用其他模拟器的数据，不写系统设置开启无障碍。未在真实手机安装 v0.2，未配置或调用用户付费模型。真实双端自主“设置 → 电池”任务、OEM 前台服务和无线连接仍需后续验证。真实聊天、密码、验证码没有进入日志、仓库或夹具。

产物：Android debug APK、macOS arm64 `.app`。两者均为开发构建，公开分发签名/公证不在本地验证范围内。模型测试按钮只证明连接与响应格式，不能证明模型具备工具决策能力。

## 持续授权改造与真机验证（2026-10-16，后续）

用户明确授权持续操作本人手机后，MCP 增加 `TAPPILOT_APPROVAL_MODE=trusted`，并在本机注册配置中绑定该手机的序列号。启动配置默认仍为 `manual`；模式不能通过工具参数修改。以下结果更新了下方首次开发时尚无设备的记录。

- `npm run build` 通过；仅运行 `config.test.ts`、`tools.test.ts`、`stdio.test.ts`，14 项通过。覆盖配置校验、两种授权模式、严格参数、快照与密码保护、设备错误和急停竞态。
- 注册脚本语法检查通过；未重新构建或安装 APK。
- 使用新启动的真实 MCP stdio 连接确认 `approvalMode: trusted`，连接 iQOO Z9 Turbo（Android 16）的 AccessibilityService。
- 按当前 UI 查找「电池」，执行原生节点点击，再通过事件等待及 UI 树确认进入 `com.iqoo.powersaving` 电池页面。没有人工终端逐次批准、截图、固定坐标或 ADB 导航脚本。
- 首次点击因 UI 更新返回 `STALE_SNAPSHOT`；重新观察并定位后成功。保留节点保护，没有重复使用旧引用。
- 真机本轮验证覆盖查找、点击、等待和读取；输入及手势的持续授权分支由定向测试验证，未对手机执行额外输入或手势。

模式在服务启动时读取。本轮已使用新连接完成验证；此前已经启动的 MCP 进程需重新连接才能使用新配置。未保存真实 UI 树或用户输入到测试夹具及仓库。

## 首次开发验证记录

日期：2026-10-16。范围：首版 Android APK、Mac MCP Server、通信和批准安全边界。属于 S3（新构建系统、跨模块接口及安全控制），因此执行两个子系统的构建与定向集成检查。

## 已通过

| 检查 | 结果与实际覆盖 |
| --- | --- |
| Android `:app:assembleDebug` | 成功生成 debug APK；包含最后的会话重绑清理、快照校验、响应预算和事件等待并发限制 |
| Server `npm run build` | TypeScript 编译成功，生成可直接启动的 stdio MCP Server 与人工批准 CLI |
| Server 首轮 `npm test` | 14 个测试项通过，覆盖 ADB 选择策略、NDJSON 消息边界/请求 ID/错误/超时、批准绑定/过期/单次使用、急停、实际 SDK stdio 握手与工具 schema |
| 急停竞态修复后的相关复测 | 仅重新执行 bridge/tools/stdio 相关测试，12 项通过；新增了转发等待及 socket 写入前的急停竞态检查。全项目累计 15 个独立测试项（含子测试） |
| 启动/安装/注册/验收脚本 | `bash -n` 与 `node --check` 语法检查通过；没有执行真实安装或伪造人工批准 |
| 新增文件 diff | 空白检查通过；Gradle 自动生成的 Windows wrapper 按其 CRLF 行尾检查，无需改写生成文件 |

只有相关代码再次修改后才重跑对应构建/测试，没有追加全量 lint、其他项目测试或无关检查。

Android 构建使用 JDK 17.0.20.1、Android SDK Platform 35、Gradle 8.10.2、AGP 8.8.0、Kotlin 2.1.0。依赖版本和 wrapper 分发 SHA-256 固定在项目文件中。Node 运行环境为 24.20.0，项目最低版本为 22。

产物：

- `android/app/build/outputs/apk/debug/app-debug.apk`
- `server/dist/index.js`
- `server/dist/approve.js`

产物及依赖缓存加入 `.gitignore`；从源码重新构建使用 README 中的命令，Gradle wrapper 和 npm lockfile 已保留。

## 真机验证留待后续

本轮 `adb devices -l` 未发现连接设备。用户明确选择「先完成项目和构建，真机联调稍后进行」，所以没有安装 APK、修改设备权限、执行真实 UI 操作或声称电池页面导航已通过。

Android 构建验证了编译和打包；主机测试中的设备返回使用模拟数据。真实 SDK stdio 测试启动了编译后的服务，但不能验证 OEM 的无障碍行为、SELinux/adbd 配置、中文输入效果或实际 App 兼容性。

连接手机后的验证顺序：

1. `scripts/install.sh USB_SERIAL` 安装，用户手动启用无障碍并在 TapPilot 点击「允许自动化 / 恢复」。
2. `TAPPILOT_SERIAL=USB_SERIAL node scripts/device-smoke.mjs` 验证 MCP → ADB → APK 的真实链路。
3. `scripts/register-mcp.sh USB_SERIAL` 注册，然后 `scripts/acceptance.sh` 启动由 Codex 实时决策的设置 → 电池任务。按要求人工批准点击。
4. 依据实际页面报告结果。服务未启用、受保护页面、节点失效或 OEM 差异均按明确错误处理，不把失败当成成功。

截图视觉回退、批量执行和无人值守跨 App 工作流属于第二阶段。本版每次点击/输入/坐标手势仍需人工确认。
