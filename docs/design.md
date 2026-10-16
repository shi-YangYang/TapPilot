# v0.3.2 界面设计

根据用户指定的 [beUI](https://beui.dev/) 免费设计体系重新实现桌面与手机客户端。使用现有 HTML/CSS 与 Kotlin 原生 View，不引入 React，不使用 Pro 付费组件，也不在产品页面展示开发框架信息。

- 近白背景、浅灰表面、细边框，以 `#0285F7` 蓝色标记主要操作。
- 统一圆角卡片、胶囊导航和按钮层级；减少装饰，增加内容之间的留白。
- 任务页以输入框和执行结果为中心；模型与连接状态紧凑呈现。
- 模型页保留清晰字段，设备页区分授权、连接与停止操作；补充说明按需查看。
- 动效只服务于按压、焦点和页面切换；尊重减少动画设置，关键控件保留可见标签及键盘焦点。

设计参考：[Theme](https://beui.dev/docs/theme)、[Button](https://beui.dev/components/motion/button)、[Card](https://beui.dev/components/motion/card)、[Tabs](https://beui.dev/components/motion/tabs)、[Prompt Input](https://beui.dev/components/agents/prompt-input)、[Motion](https://beui.dev/docs/motion-patterns)。本项目原生实现，不宣称直接安装了 beUI React 组件库。beUI 免费源码的 [MIT 许可证](https://github.com/starc007/ui-components/blob/main/LICENSE) 归属 Saurabh Chauhan。
