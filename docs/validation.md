# 验证记录

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
