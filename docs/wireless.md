# v0.3 局域网连接

用户在电脑显式开启配对后，电脑只监听选定的本机私有 IPv4 网卡。手机主动建立 `WSS /phone` 连接；日常连接不需要 ADB、开发者选项或数据线。ADB 仅作为可选开发安装/调试工具保留。

## 配对

URI 形如 `tappilot://pair?host=LAN_IP&port=PORT&fingerprint=SHA256_DER&token=RANDOM_TOKEN`，由电脑显示为二维码或复制链接。证书与 token 每次会话重建，初次配对窗口为 5 分钟。手机严格检查主机地址、端口、字段、证书指纹及有效期；不采用全信任 TLS，不把凭据发送给模型。

电脑用系统 OpenSSL 生成短期自签名证书。私钥只在权限受限的临时目录中生成，读入内存后立即清除临时文件。TLS 最低 1.2。配对 token 为 32 字节随机值，服务端使用恒定时间比较。手机扫描成功后发送 `hello`：

```json
{"type":"hello","version":1,"token":"<ephemeral>","deviceId":"<installation-id>","deviceName":"<display-name>"}
```

服务端验证后回复 `{"type":"ready","version":1}`。每个会话绑定唯一设备 ID，同时只接受一个设备连接。已配对会话拒绝另一设备，不自动切换。断线后用户可重新连接同一设备；原任务的 Bridge 绑定旧连接代次，不能因此继续派发。

## 设备 RPC

使用原来的 `{id,method,params}` / `{id,ok,result|error,meta:{durationMs}}` JSON 信封，每帧一个消息；不换成模型专用协议。请求最多 256 KiB，帧最多 4 MiB，禁止二进制帧。请求 ID 严格对应；未知 ID 或坏 schema 终止连接，已超时/取消请求的已知晚回包丢弃。

普通 pending 请求有上限，急停有独立保留槽。模型动作仍逐个观察和执行，传输层不自动重试，不进行失败补发。手机断开时未执行的队列任务失效；已经送交 Android 的动作可能已经发生。网络状态不能撤销动作，因此必须先查看手机再开始新任务。

`PhoneBridge.close()` 只取消当前任务请求，保留配对供下一任务使用。`WirelessHub.close()` 结束监听、配对和设备连接。两端 UI 必须区分“取消任务”“断开连接”和“紧急停止”。急停的持久状态仍只能由用户在手机上恢复。

已认证且参数有效的急停在接收路径立即锁存并保存停止状态，不进入可取消的普通任务队列；随后断线不会撤回该停止状态。保存失败返回 `STOP_PERSISTENCE_FAILED`，不宣称持久急停成功；手机本地恢复也必须先成功保存状态才解除停止。

## 边界

- 本版为同一局域网，没有公网 relay、自动 NAT 穿透或无线 ADB。
- 配对凭据仅保留在当前内存会话，应用重启后重新扫码。
- Android 无障碍与通知/相机权限由用户按需授予；扫码可用粘贴链接替代。
- 手机本地任务与无线任务不应同时派发操作；急停独立于普通任务。
- 不把配对 URI、token、私钥、屏幕内容写入日志。
- 测试使用合成设备与临时凭据；跨端传输测试不冒充真机原生界面导航验收。

## 可执行的跨端集成检查

构建 `server`，以及 Android 的 `:app:assembleDebug`、`:app:assembleDebugAndroidTest` 后，将两份 APK 安装到明确指定的测试模拟器：

```bash
adb -s emulator-5580 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5580 install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
node scripts/wireless-integration.mjs --serial emulator-5580
```

脚本只接受模拟器，启动真实 TLS/WSS 主机并通过 Android 生产连接代码执行三次 RPC：读取、动作及新观察、再次读取。界面执行器是合成夹具，不需要开启无障碍，不修改系统权限。ADB 只负责测试部署与启动 instrumentation，三个设备 RPC 走 WSS。凭据仅在本次测试内存和子进程参数中使用，不打印、不落盘。

默认选本机局域网网卡；没有局域网地址时可明确加 `--emulator-host-alias`，通过模拟器的 `10.0.2.2` 访问主机 loopback，证书指纹校验仍开启。成功输出 `PASS Android production TLS/WSS + desktop PhoneClient (synthetic UI executor)`。
