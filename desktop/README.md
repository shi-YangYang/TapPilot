# TapPilot 桌面客户端

独立桌面 App：自行配置 OpenAI 兼容模型接口，直接执行手机任务，不需要 Codex。

```bash
cd server
npm ci
npm run build
cd ../desktop
npm ci
npx --no-install install-electron
npm run build
npm start
```

先在“模型”页填写 API 地址、模型名称和密钥并测试连接，再在“设备”页连接手机。打开“任务”页输入任务并开始。发送、下单、付款和删除等敏感提交由用户在手机上手动完成。

推荐无线连接：电脑与手机连接同一个局域网，在桌面设备页选择正确的网卡地址，点击“显示二维码”。在手机 TapPilot 的设备页扫描二维码或粘贴链接，连接成功后在桌面点击“选择此手机”。手机仍需安装 TapPilot、手动开启无障碍服务并允许自动化，日常无线使用无需开发者模式、ADB 或数据线。

配对仅在用户点击开始后绑定选中的局域网 IPv4 地址。手机主动连接本次证书指纹固定的 WSS 会话，二维码含随机配对令牌，首次配对有效期 5 分钟；每个会话仅允许一台手机。令牌、证书、配对链接只留在内存，不写入配置，不发送给模型。配对成功或过期后二维码与链接从界面清除，复制链接仅在有效待配对状态可用。取消任务保留连接；断开会话或退出客户端后必须重新配对。网络中断会取消当前任务，重连后不会自动重放动作。

USB 开发通道保留在设备页第二个选项。它仍需 USB 调试授权与本机 Android platform-tools；桌面端自动寻找 macOS Android SDK 中的 ADB，也可填写绝对路径。

“体验演示”使用合成设备和脚本化模型，不会请求模型或操作手机；它不能证明真实手机任务已经执行。界面醒目标明演示模式。

本地打包 macOS 应用（当前机器架构）：

```bash
npm run package:mac
```

输出为 `release/TapPilot-darwin-<arch>/TapPilot.app`，可以直接打开或移入“应用程序”。这是未签名的本地开发包；公开分发需要开发者签名与 notarization。Electron 会包含自身运行时，无线会话使用 macOS 系统 OpenSSL 创建临时证书，只有 USB 通道需要本机 ADB。包内不会包含用户配置或任务记录。

任务及必要的界面信息会发送给用户配置的模型服务。任务历史仅保留于内存，退出后清除；API Key 经 Electron safeStorage 使用 macOS 钥匙串加密后写入应用数据目录，不回传 renderer。系统密钥存储不可用时拒绝保存密钥，不降级为明文。更换未签名应用构建可能触发钥匙串重新授权。

取消立即中断后续模型与工具调度，已发出的动作可能已完成。紧急停止使用独立连接请求手机持久停止；连接中断时界面明确提示无法确认，用户应在手机急停或关闭无障碍服务。恢复只能在手机上手动进行。

开发检查：`npm test` 针对配置、密钥保护、IPC 来源、无线配对生命周期和取消；`npx electron test/electron-smoke.cjs` 使用临时配置运行真实 Electron UI，验证演示与取消；`npx electron test/electron-wireless-smoke.cjs` 用临时配置、合成 WSS 手机和合成模型验证无线完整闭环、任务复用、取消和独立急停。后者会显式开启当前局域网网卡上的临时配对监听，结束即关闭，不会访问真实手机。可设 `TAPPILOT_SMOKE_SCREENSHOT=/tmp/tappilot-desktop.png` 或 `TAPPILOT_WIRELESS_SCREENSHOT=/tmp/tappilot-wireless.png` 保存合成 UI 截图，无线截图在配对凭据隐藏后生成。

无线故障排查：没有网卡地址时先连接 Wi-Fi；多个地址时选择手机同网段的 Wi-Fi 网卡；连接超时检查双方是否被访客 Wi-Fi / AP 隔离或防火墙阻断；配对过期先断开再重新生成。请勿关闭 TLS 校验、把监听暴露到公网或尝试复用旧二维码。
