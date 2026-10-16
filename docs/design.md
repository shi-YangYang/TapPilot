# v0.3.7：电脑主控、手机被控

桌面保留「任务 / 模型 / 设备」三页；手机收敛为一页，只展示连接电脑、权限、状态与紧急停止，移除任务输入和模型配置。手机通过 USB（ADB）或扫码连接电脑，配对链接是扫码的备用入口。

桌面侧栏底部提供「浅色主题 / 深色主题」，手机顶部栏提供「浅色 / 深色」切换按钮，文字表示点击后将切换到的主题。默认深色，两端独立保存偏好，重新打开时沿用上次选择。切换保留当前页与未保存输入，不重新运行任务。

桌面只将 `light` / `dark` 保存为本机 `localStorage` 的 `tappilot.theme`，在样式加载前恢复；React 组件保持挂载，任务和表单状态不因主题变化而重置。浅色主题为白色背景、近黑正文，深色主题沿用下方配色。浏览器原生控件的 `color-scheme` 同步更新。

Android 仅在 `appearance` 偏好中保存 `dark_theme` 布尔值，在同一 Activity 内重建视图；配对输入、选区、焦点和滚动仅在本次切换的内存中恢复。主题切换不重建无线连接；系统栏及对话框同步所选主题。

沿用 v0.3.4 布局，桌面采用 184px 深灰侧栏、黑色工作区、统一的 720px 内容宽度。导航、连接状态与急停都有固定位置；任务页使用 32px 标题、三行输入区和两个快捷任务入口，空闲时不展示无内容的结果占位。模型和设备页统一标题、字段和分区对齐。最小窗口为 960×700，侧栏缩至 168px。

背景为近黑 `#101010`，文字为近白 `#f4f4f4`，表面为深灰 `#181818` / `#202020`，分隔线为 `#303030`。主按钮白底黑字，辅助文字灰色；错误与急停悬停保留少量语义红色。导航、输入框、按钮的尺寸与圆角不变。应用主题在 `desktop/src/theme.css` 覆盖官方语义 token，页面样式通过同一组变量取色；窗口启动背景与浏览器原生控件也使用深色。

Android 同样使用黑底白字、白色主按钮与深灰表面，并统一启动背景、系统栏图标、输入光标和原生对话框颜色。连接入口和权限状态集中在同一页，操作触区至少 48dp；页面不展示模型参数或任务执行器细节。

## 继续使用的 beUI 源码

桌面渲染层使用 React 19、Tailwind CSS 4 和 Motion。组件来自用户指定的 [beUI 官方仓库](https://github.com/starc007/ui-components)，固定到 commit `c392b2e712c3d4944bfa4b24c54c8699bbf5f4c7`；组件源码及依赖保存在 `desktop/src/beui/`，可逐文件对照上游。

| 页面部分 | 实际使用的上游组件 |
| --- | --- |
| 任务输入与发送/停止 | `agents/prompt-input.tsx` |
| 侧栏页面导航、无线/USB 切换 | `motion/tabs.tsx`（underline 变体） |
| 执行进度与折叠详情 | `agents/agent-activity/` |
| 设置表单和操作 | `motion/card.tsx`、`motion/input.tsx`、`motion/button/` |
| 网络选择与提示 | `motion/select.tsx`、`motion/tooltip.tsx` |

保留上游组件源码、弹簧参数、菜单与焦点交互。基础主题从上游 `lib/theme-css.ts` 的 `THEME_CSS` 原样提取，字体使用本地 Geist；本版通过应用主题和局部样式实现用户指定的黑白布局。PromptInput 的本地扩展仍仅用于中文可访问名称及稳定控件 ID，记录在 `UPSTREAM.json`。

桌面业务状态由 React 管理，继续通过原有隔离 preload 调用 IPC。模型输出以文本显示；模型密钥不回填，配对凭据不进入模型请求。渲染层不访问外网，依赖和字体均打包在本地。

Android 仍使用原生 Kotlin View，保留按上述源码适配的底部动作与按压/切换动画，布局依手机屏幕调整。Android 不直接运行 React 组件。`FLAG_SECURE`、遮挡触摸保护及急停入口继续保留。

来源清单、原文件 SHA-256、MIT 许可证和字体许可证见 `desktop/src/beui/UPSTREAM.json`、`desktop/src/beui/LICENSE`、`desktop/THIRD_PARTY_NOTICES.md` 及 `desktop/src/assets/Geist-LICENSE.txt`。发布包同时包含许可证。只使用公开 MIT 组件，不含 beUI Pro 内容。
