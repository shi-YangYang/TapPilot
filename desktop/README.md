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

先在“模型”页填写 API 地址、模型名称和密钥并测试连接，再在“设备”页刷新并选择 USB 手机。首次连接仍需手机安装 TapPilot、开启无障碍服务、允许自动化和 USB 调试。桌面端自动寻找 macOS Android SDK 中的 ADB，也可填写绝对路径。打开“任务”页输入任务并开始。发送、下单、付款和删除等敏感提交由用户在手机上手动完成。

“体验演示”使用合成设备和脚本化模型，不会请求模型或操作手机；它不能证明真实手机任务已经执行。界面醒目标明演示模式。

本地打包 macOS 应用（当前机器架构）：

```bash
npm run package:mac
```

输出为 `release/TapPilot-darwin-<arch>/TapPilot.app`，可以直接打开或移入“应用程序”。这是未签名的本地开发包；公开分发需要开发者签名与 notarization。Electron 会包含自身运行时，USB 通道仍需要本机 ADB。包内不会包含用户配置或任务记录。

任务及必要的界面信息会发送给用户配置的模型服务。任务历史仅保留于内存，退出后清除；API Key 经 Electron safeStorage 使用 macOS 钥匙串加密后写入应用数据目录，不回传 renderer。系统密钥存储不可用时拒绝保存密钥，不降级为明文。更换未签名应用构建可能触发钥匙串重新授权。

取消立即中断后续模型与工具调度，已发出的动作可能已完成。紧急停止使用独立连接请求手机持久停止；连接中断时界面明确提示无法确认，用户应在手机急停或关闭无障碍服务。恢复只能在手机上手动进行。

开发检查：`npm test` 针对配置、密钥保护、IPC 来源和取消；`npx electron test/electron-smoke.cjs` 使用临时配置运行真实 Electron UI，验证演示与取消。可设 `TAPPILOT_SMOKE_SCREENSHOT=/tmp/tappilot-desktop.png` 输出合成 UI 截图。
