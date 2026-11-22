# chat-demo-extension

把 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 打包成 Chrome MV3 浏览器扩展。纯前端、无后端，API Key 只保存在浏览器本地。

## 功能

- 侧边栏聊天：点扩展图标打开，独立于当前网页。
- 网页悬浮球：可拖动、位置记忆；蓝色按钮开侧边栏，白色按钮框选截屏。
- 截屏即附件：确认截图时自动打开侧边栏，图片直接贴进输入框，不弹独立窗口。
- 选中即问：右键选中文本，自动引用并打开侧边栏。
- 快捷键：`Alt+Shift+D` 开侧边栏，`Ctrl+Shift+X` 框选截屏。
- 独立窗口：侧边栏底部可把同一面板打开为 480×900 窗口。

## 构建与加载

需要 Node.js 22.12+ 与 pnpm：

```bash
pnpm install
node extension/build.mjs
```

然后打开 `chrome://extensions`，开启开发者模式，选择「加载已解压的扩展程序」→ 本仓库的 `extension/` 目录。

首次使用先在侧边栏「设置 → 数据管理」里填写 DeepSeek API Key。面板产物在 `extension/panel/`，已加入 `.gitignore`，重新构建会覆盖。

## 目录

```text
extension/
  manifest.json      MV3 清单
  background.js      侧边栏、截屏、右键菜单、快捷键调度
  floater.js         网页悬浮球（可拖动）
  capture.js         框选截屏交互
  shot-bridge.js     截图 → 输入框附件
  bridge.js          选中文本 → 输入框
  build.mjs          构建面板并同步版本
  verify.mjs         Playwright 端到端验证
  panel/             由 chat-demo 构建产物生成（gitignore）
```

## 验证

```bash
# 需要 playwright-core 与 Chromium
PLAYWRIGHT_CORE=<playwright-core 目录> node extension/verify.mjs
```

覆盖面板渲染、API 连通、消息桥接、悬浮球拖动、截屏、附件贴入和“不弹独立窗口”等 25 项。

## 说明

- 截图无法抓取 `chrome://`、扩展商店等受保护页面。
- 截图时自动打开侧边栏依赖 Chrome 的用户手势；若浏览器拒绝，截图会保留在待处理区，打开侧边栏后自动贴入。
- 上游项目与许可证见 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)；本仓库沿用 MIT License。
