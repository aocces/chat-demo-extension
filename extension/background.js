// Service Worker：只做调度，不存任何内存状态（SW 随时会被回收）。
// 待处理内容一律写 chrome.storage.session，由侧边栏页面自己取。
const MENU_ID = 'compose-selection'
const PENDING_KEY = 'pendingCompose'
const SHOT_KEY = 'pendingScreenshot'
const INJECT_FILES = ['floater.js', 'capture.js']
const EXT_VERSION = chrome.runtime.getManifest().version

// 每次 SW 启动都要重新声明：回收重启后这些行为不会自动恢复。
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('sidePanel.setPanelBehavior failed', error))

function buildQuote(selection, source) {
  const quoted = selection
    .split('\n')
    .map((line) => `> ${line.trim()}`)
    .join('\n')
  const origin = source ? `\n\n（来自 ${source}）` : ''
  return `${quoted}${origin}\n\n`
}

async function handOff(text) {
  await chrome.storage.session.set({ [PENDING_KEY]: text })
  // 页面可能还没挂载完；storage 是兜底，消息只是让已打开的面板立刻响应。
  await chrome.runtime.sendMessage({ type: 'compose', text }).catch(() => {})
}

// content script 只在页面加载时注入。扩展重载后已打开的标签页不会有悬浮球，
// 所以安装/更新/浏览器启动时主动补注入一次（脚本自身有幂等保护）。
async function reinjectOpenTabs() {
  let tabs = []
  try {
    tabs = await chrome.tabs.query({})
  } catch (error) {
    console.warn('tabs query failed', error)
    return
  }
  await Promise.all(
    tabs
      .filter((tab) => tab.id != null && /^https?:\/\//.test(tab.url ?? ''))
      .map((tab) =>
        chrome.scripting
          .executeScript({ target: { tabId: tab.id }, files: INJECT_FILES })
          .catch(() => {})
      )
  )
}

// SW 每次启动都会跑顶层代码；用 session 标记保证每个浏览器会话只补注入一次。
// 扩展重载时 session 会清空，于是旧标签页里的失效 content script 会被新实例替换。
async function bootstrapInject() {
  try {
    const { contentScriptsBooted } = await chrome.storage.session.get('contentScriptsBooted')
    if (contentScriptsBooted) return
    await chrome.storage.session.set({ contentScriptsBooted: true })
    await reinjectOpenTabs()
  } catch (error) {
    console.warn('content script bootstrap 失败', error)
  }
}

void bootstrapInject()

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用 DeepSeek 处理选中内容',
      contexts: ['selection'],
    })
  })
  await reinjectOpenTabs()
  if (reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('panel/index.html') })
  }
})

chrome.runtime.onStartup.addListener(() => {
  void reinjectOpenTabs()
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return
  const selection = (info.selectionText || '').trim()
  if (!selection) return
  await handOff(buildQuote(selection, tab?.title))
  await openPanel(tab?.windowId)
})

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-panel') {
    const window = await chrome.windows.getLastFocused()
    await openPanel(window.id)
    return
  }
  if (command === 'capture-region') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id == null) return
    // 快捷键不经过用户手势链路，交给页面自己发起截图请求。
    await chrome.tabs.sendMessage(tab.id, { type: 'START_CAPTURE' }).catch(() => {})
  }
})

// 网页悬浮球点击：优先开侧边栏；用户手势传不过去时退化成独立窗口，保证点击一定有结果。
// 截屏交接不能用这个兜底——用户明确要求截图只贴到侧边栏，不再弹独立窗口。
async function openPanel(windowId, { fallbackWindow = true } = {}) {
  try {
    if (windowId == null) throw new Error('no window id')
    await chrome.sidePanel.open({ windowId })
    return true
  } catch (error) {
    const text = errorText(error)
    // 已经打开时部分 Chrome 版本会以异常形式返回；这不算失败，也不该再开窗口。
    if (/already open|already opened|已经打开/i.test(text)) return true
    if (!fallbackWindow) return false
    console.warn('sidePanel.open 失败，改为打开独立窗口', error)
    await chrome.windows.create({
      url: chrome.runtime.getURL('panel/index.html?standalone=1'),
      type: 'popup',
      width: 480,
      height: 900,
    })
    return true
  }
}

// ---------- 截屏：整屏抓取 + OffscreenCanvas 裁切 ----------
async function captureTab(tab) {
  if (tab?.windowId == null) throw new Error('无法确定当前标签页')
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'jpeg',
    quality: 92,
  })
  if (!dataUrl) throw new Error('截图返回为空')
  return dataUrl
}

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer())
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK))
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`
}

async function cropImage(dataUrl, rect, viewport) {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  const scale = bitmap.width / (viewport.w || bitmap.width)
  const sx = Math.max(0, Math.min(Math.round(rect.x * scale), bitmap.width - 1))
  const sy = Math.max(0, Math.min(Math.round(rect.y * scale), bitmap.height - 1))
  const sw = Math.max(1, Math.min(Math.round(rect.w * scale), bitmap.width - sx))
  const sh = Math.max(1, Math.min(Math.round(rect.h * scale), bitmap.height - sy))
  if (sw < 8 || sh < 8) throw new Error('选区太小（少于 8 像素）')
  const canvas = new OffscreenCanvas(sw, sh)
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  bitmap.close?.()
  return { dataUrl: await blobToDataUrl(out), size: { w: sw, h: sh } }
}

const errorText = (error) => String(error?.message ?? error)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 先包一层：sendResponse 只能调用一次，且异步分支必须在返回 true 后调用。
  const respond = (payload) => {
    try {
      sendResponse(payload)
    } catch (error) {
      console.warn('[deepseek-chat] 消息回应失败', error)
    }
  }

  if (message?.type === 'PING') {
    respond({ ok: true, version: EXT_VERSION })
    return
  }

  if (message?.type === 'open-panel') {
    void openPanel(sender.tab?.windowId)
    respond({ ok: true })
    return
  }

  // 截屏前尝试把侧边栏打开；失败也没有关系，截图会留在 storage 等侧边栏来取。
  // 这里绝不能退化开独立窗口——用户明确要求截图只贴到侧边栏。
  if (message?.type === 'ensure-panel') {
    void (async () => {
      const opened = await openPanel(sender.tab?.windowId, { fallbackWindow: false })
      respond({ ok: true, opened })
    })()
    return true
  }

  if (message?.type === 'CAPTURE_TAB') {
    void (async () => {
      try {
        respond({ ok: true, dataUrl: await captureTab(sender.tab) })
      } catch (error) {
        respond({ ok: false, error: errorText(error) })
      }
    })()
    return true
  }

  if (message?.type === 'CROP') {
    void (async () => {
      try {
        respond({ ok: true, ...(await cropImage(message.dataUrl, message.rect, message.viewport)) })
      } catch (error) {
        respond({ ok: false, error: errorText(error) })
      }
    })()
    return true
  }

  if (message?.type === 'SCREENSHOT_READY') {
    // 裁切完成后落 storage，面板加载时取走作为附件；同时打开侧边栏。
    void (async () => {
      try {
        await chrome.storage.session.set({
          [SHOT_KEY]: { dataUrl: message.dataUrl, size: message.size, at: Date.now() },
        })
      } catch (error) {
        console.warn('[deepseek-chat] 截图交接失败', error)
        respond({ ok: false, error: errorText(error) })
        return
      }
      // 截图已经进 storage；这里只尝试把侧边栏打开，失败也不弹独立窗口。
      const panelOpened = await openPanel(sender.tab?.windowId, { fallbackWindow: false })
      respond({ ok: true, panelOpened })
    })()
    return true
  }
})
