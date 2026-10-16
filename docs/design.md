# v0.3.5：黑底白字工作空间

沿用 v0.3.4 布局，桌面采用 184px 深灰侧栏、黑色工作区、统一的 720px 内容宽度。导航、连接状态与急停都有固定位置；任务页使用 32px 标题、三行输入区和两个快捷任务入口，空闲时不展示无内容的结果占位。模型和设备页统一标题、字段和分区对齐。最小窗口为 960×700，侧栏缩至 168px。

背景为近黑 `#101010`，文字为近白 `#f4f4f4`，表面为深灰 `#181818` / `#202020`，分隔线为 `#303030`。主按钮白底黑字，辅助文字灰色；错误与急停悬停保留少量语义红色。导航、输入框、按钮的尺寸与圆角不变。应用主题在 `desktop/src/theme.css` 覆盖官方语义 token，页面样式通过同一组变量取色；窗口启动背景与浏览器原生控件也使用深色。

Android 同样使用黑底白字、白色主按钮与深灰表面，并统一启动背景、系统栏浅色图标、输入光标和原生对话框颜色。全宽细线导航、30sp 页标题、三行任务输入区与 48dp 操作触区保持不变。

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
