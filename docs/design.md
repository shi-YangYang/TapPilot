# v0.3.3：直接使用 beUI 组件

桌面渲染层使用 React 19、Tailwind CSS 4 和 Motion。组件来自用户指定的 [beUI 官方仓库](https://github.com/starc007/ui-components)，固定到 commit `c392b2e712c3d4944bfa4b24c54c8699bbf5f4c7`；组件源码及依赖保存在 `desktop/src/beui/`，可逐文件对照上游。

| 页面部分 | 实际使用的上游组件 |
| --- | --- |
| 任务输入与发送/停止 | `agents/prompt-input.tsx` |
| 顶部页面导航、无线/USB 切换 | `motion/tabs.tsx` |
| 执行进度与折叠详情 | `agents/agent-activity/` |
| 设置表单和操作 | `motion/card.tsx`、`motion/input.tsx`、`motion/button/` |
| 网络选择与提示 | `motion/select.tsx`、`motion/tooltip.tsx` |

保留上游组件的尺寸、Tailwind 类名、弹簧参数、菜单与焦点交互。主题从上游 `lib/theme-css.ts` 的 `THEME_CSS` 原样提取，字体使用本地 Geist。应用自己的 CSS 只负责窗口、页面宽度与内容布局。PromptInput 的本地扩展仅用于中文可访问名称及稳定控件 ID，记录在 `UPSTREAM.json`。

桌面业务状态由 React 管理，继续通过原有隔离 preload 调用 IPC。模型输出以文本显示；模型密钥不回填，配对凭据不进入模型请求。渲染层不访问外网，依赖和字体均打包在本地。

Android 仍使用原生 Kotlin View，按上述源码的两行紧凑输入器、底部动作、轻量标签、卡片间距和按压/切换动画实现对应界面，并保留手机所需的触摸尺寸。Android 不直接运行 React 组件。`FLAG_SECURE`、遮挡触摸保护及急停入口继续保留。

来源清单、原文件 SHA-256、MIT 许可证和字体许可证见 `desktop/src/beui/UPSTREAM.json`、`desktop/src/beui/LICENSE`、`desktop/THIRD_PARTY_NOTICES.md` 及 `desktop/src/assets/Geist-LICENSE.txt`。发布包同时包含许可证。只使用公开 MIT 组件，不含 beUI Pro 内容。
