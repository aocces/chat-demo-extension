# DeepSeek Chat 浏览器扩展（基于 chat-demo）

把 [chat-demo](https://github.com/deepseek-ai/chat-demo) 的静态产物包成 MV3 扩展：**纯前端、无后端、不带 Node**，API Key 留在浏览器本地。

## 功能

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 网页悬浮球（蓝） | 任意网页右下角 | 可拖动，位置存 `chrome.storage.local` 跨页面恢复；单击打开侧边栏 |
| 截屏按钮（白） | 悬浮球上方 | 框选截屏 → 确认时自动打开侧边栏 → 直接作为图片附件送进输入框；**不弹独立窗口** |
| 侧边栏聊天 | 工具栏图标 | 点图标直接开侧边栏（`setPanelBehavior({ openPanelOnActionClick })`） |
| 选中即问 | 右键菜单「用 DeepSeek 处理选中内容」 | 选中文本 → 引用块 + 页面标题，自动预填到输入框并打开侧边栏 |
| 快捷键 | `Alt+Shift+D` / `Ctrl+Shift+X` | 前者开侧栏，后者直接框选截屏；在 `chrome://extensions/shortcuts` 可改 |
| 独立窗口 | 侧栏底部「在独立窗口打开」 | 480×900 独立 popup 打开同一个面板，适合长对话 |
| 浮层侧栏 | 侧栏顶部「打开边栏」 | 历史与设置以圆角浮层覆盖在内容上方；**高度随内容自适应**，短列表只占一小块 |
| 全页模式 | 扩展详情 → 打开 `panel/index.html` | 首次安装会自动开一次，方便先配 API Key |

浏览器标题与侧栏顶栏统一为 **DeepSeek Chat**，与扩展程序名一致。

### 关于「刷新扩展后看不到悬浮球」

content script 只在**页面加载时**自动注入。在 `chrome://extensions` 点「刷新」后，已打开标签页里的旧脚本仍会留在页面上，但它的 `chrome.runtime` 已经失效——这时点悬浮球会报 `Extension context invalidated`。现在做了三层兜底：

1. `chrome.scripting.executeScript` 在安装/更新/浏览器启动时主动补注入已打开的 http(s) 标签页；
2. 补注入时**替换旧悬浮球和截屏 UI**，而不是因为 DOM 已存在就直接退出，所以重载扩展后无需刷新网页；
3. `content_scripts.matches` 加入 `file://*/*`（本地文件需手动开启「允许访问文件 URL」）。

如果仍看不到：确认你在普通网页（不是 `chrome://` / 扩展商店 / PDF 阅读器页），然后刷新该网页一次。

截屏前需要先在扩展侧栏里填好 API Key。没有 Key 时截图会先留在 `storage.session`，并提示填写；填好后自动作为附件加入输入框，不会无声丢失。

扩展宿主下设置页**不显示「位置信息」**：它只用于拼 `latest_reminder` 的地区字段，插件形态下浏览器本地时区已足够。

## 安装

```bash
node extension/build.mjs      # 生成图标 → 构建 dist → 同步 panel → 注入 bridge.js
```

然后打开 `chrome://extensions`：

1. 右上角打开「开发者模式」；
2. 「加载已解压的扩展程序」→ 选择本目录 `extension/`；
3. 首次安装会自动打开一个完整宽度的页面，在「设置」里填 API Key；
4. 之后点工具栏图标即可在侧边栏使用。

## 目录

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | MV3 清单：`sidePanel`、`content_scripts`、`commands`、图标、`host_permissions` |
| `background.js` | Service Worker：侧边栏行为、右键菜单、快捷键、悬浮球消息；状态只进 `storage.session` |
| `floater.js` | 注入网页的悬浮球：Shadow DOM + constructed stylesheet，不受页面 CSS/CSP 影响 |
| `bridge.js` | 面板侧桥接：把后台文本写进 React 受控 textarea |
| `icons.mjs` | 无依赖 PNG 编码器，生成 16/48/128 三张真实图标 |
| `build.mjs` | 构建 → 同步 → 注入 `bridge.js` → 同步 manifest 版本号 |
| `verify.mjs` | Playwright 端到端验证（装扩展、渲染、网络权限、桥接、浮层、独立窗口、悬浮球） |
| `panel/` | 生成物，勿手改 |
| `icons/` | 生成物（由 `icons.mjs` 产出） |

## 上下文是怎么进输入框的

chat-demo 没有对外接口，所以 `bridge.js` 用**原生 value setter + `input` 事件**改 React 的受控 textarea（直接赋 `.value` 不触发 `onChange`）。定位选择器是 `[class*="textareaWrapper"] textarea`——CSS Module 类名带哈希，但前缀保留。

后台递文本走两条路，缺一不可：

1. `chrome.runtime.sendMessage` → 面板已挂载时立即响应；
2. `chrome.storage.session` → 面板还没挂载（右键时常见）时，页面加载后补取并清除。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `sidePanel` | 提供侧边栏容器 |
| `storage` | `storage.session` 暂存待处理引用与截图 |
| `contextMenus` | 选中文本右键项 |
| `tabs` | 读取 `tab.title` 作为引用来源（缺此权限会静默变 `undefined`） |
| `scripting` | 扩展重载后给已打开的标签页补注入悬浮球 |
| `activeTab` + `<all_urls>` | `captureVisibleTab` 抓屏的硬性要求；也用于任意网页注入 |
| `content_scripts: http/https/file` | 在网页注入悬浮球与框选层（`window.top` 判断，只在顶层帧注入一次） |
| `host_permissions: api.deepseek.com` | 直连 DeepSeek API |

## 为什么不用 `npm run build`

原仓库的构建脚本是 `rm -rf dist && NODE_ENV=production rspack build`，`rm` 与 `NODE_ENV=` 前缀都是 Unix 写法，Windows 上直接报错。`build.mjs` 用 Node 直接调 rspack 并注入环境变量，跨平台可用。

## 已知限制

- API 只放行 `https://api.deepseek.com/*`。要换自建网关，需要改 `rspack.config.ts` 的 `apiOrigin`、manifest 的 `host_permissions`，然后重新构建。
- `captureVisibleTab` 无法抓取浏览器内置页（`chrome://`、`chrome://extensions` 等）、扩展商店与受保护内容；这些页面上截屏会失败，普通网页不受影响。
- `file://` 页面要注入悬浮球，需要在扩展详情页手动打开「允许访问文件 URL」。
- 截图走 `storage.session` 一次性交接，2 分钟未取用即作废；面板侧 `shot-bridge.js` 依赖 chat-demo 的 `input[type="file"]`，上游改结构时需同步。
- API Key 存在扩展源的 `localStorage`，会话与附件在 IndexedDB。任何能注入该扩展页面的代码都能读到 Key，只装自己信任的扩展。
- 桥接依赖上游的 DOM 结构（`textareaWrapper` 前缀 + 唯一 textarea），上游改类名会失效——`verify.mjs` 的桥接用例就是这条的回归哨兵。
- 侧边栏宽度约 400px，UI 会走移动端布局（项目自带 `viewport.ts` 断点）。
- Chrome 137 起官方构建移除了 `--load-extension` 命令行开关，自动化测试只能用 Chromium（Playwright 自带，本次实测 149）。**手动「加载已解压的扩展程序」不受影响**。

## 验证

```bash
PLAYWRIGHT_CORE="<playwright-core 所在 node_modules>/playwright-core" node extension/verify.mjs
```

最近一次实测（Chromium 149 / 420px 宽）：

```
chromium: 149.0.7827.55
extension id: lfnklihbeamnakbegnomajhpagjnamnf
✓ 面板渲染 — #root children: 1
✓ 页面标题与扩展名一致 — DeepSeek Chat
✓ host_permissions 与 API 连通 — {"status":401}
✓ bridge 消息通道 / storage 兜底 / 取用后清除 / handOff 路径
✓ 无 console 错误 — 0 条
✓ 历史侧栏浮于上层 — {"position":"absolute","top":"8px","radius":"18px","elevated":true}
✓ 浮层高度随内容（短列表不撑满） — {"height":202,"viewport":820}
✓ 设置页不显示地理位置 — 命中 0 处
✓ 侧栏有独立窗口入口 → 点击打开 .../panel/index.html?standalone=1
✓ 悬浮球双按钮注入 → 拖动位置变化 → 重载后补注入替换旧 content script → 主按钮点击送达后台
✓ 截屏遮罩出现 → 框选矩形生成 → 截图确认时自动打开侧边栏
✓ 截图结果写入待处理附件 — 73×57 / 1075B
✓ 截图已送入面板附件输入 — change 事件 1 次
✓ 截图附件出现在输入框 — deepseek-shot-*.jpg
✓ 截屏不弹出独立窗口 — pages 4 → 4
全部通过（25 项）
```

`401` 是预期结果：无 Key 请求 `/models` 返回未授权，证明请求真的到达了 API，而不是被 CSP/CORS 拦下。

截图证据：`verify-panel.png`（面板）、`verify-drawer.png`（自适应浮层侧栏）、`verify-floater.png`（双按钮悬浮球）、`verify-crop.png`（框选遮罩）。

### 源码侧改动

本轮为适配扩展形态改了上游源码（不是只包壳）：

| 文件 | 改动 |
| --- | --- |
| `src/index.html` | `<title>` 改为 DeepSeek Chat |
| `src/utils/extensionHost.ts` | 新增：检测扩展宿主与独立窗口能力 |
| `src/components/sider/Sider.tsx` | 侧栏底部加「在独立窗口打开」；抽屉布局 |
| `src/components/sider/Sider.module.css` | 抽屉改为 8px 留白 + 18px 圆角 + 阴影，浮于内容上层；**高度自适应内容**（`fit-content` + `max-height`）；压缩顶部与间距 |
| `src/components/session/MobileHeader.module.css` | 头部 60px → 52px，给 420px 侧栏腾出纵向空间 |
| `src/components/settings/SettingsDialog.tsx` | 扩展宿主下隐藏「位置信息」设置 |
| `src/i18n/{zh,en}.ts` | 新增 `openInWindow` 文案，应用名统一为 DeepSeek Chat |
| `src/components/base/icons.tsx` | 新增 `IconWindowOutline16` |

`tsc --noEmit` 通过，`build.mjs` 生产构建通过。

## 截屏功能来源

从作者另一个自用 AI 解题扩展移植而来，按本扩展形态精简改造：

| 原实现 | 移植后 |
| --- | --- |
| `background/service-worker.js` 的 `handleCapture` / `handleCrop` | `background.js` 的 `captureTab` / `cropImage`（OffscreenCanvas 裁切，逻辑一致） |
| `content/content.js` 的 700+ 行框选交互 | `capture.js` 精简为纯框选（去掉面板、解题、提示词等无关部分），Shadow DOM + constructed stylesheet |
| 截屏后作为自有聊天的附件 | `shot-bridge.js` 转成 `File` + `change` 事件，喂给 chat-demo 的上传 input |
| `Ctrl+Shift+X` | 保留；另在悬浮球上加白色相机按钮 |

`shot-bridge.js` 必须走原生 `files` setter + `change` 事件——chat-demo 的上传是 React 受控组件，直接赋值不触发 `onChange`。这和 `bridge.js` 写 textarea 是同一类问题。
