// 侧边栏页面侧的桥：把后台递过来的文本写进 chat-demo 的输入框。
// chat-demo 没有对外接口，所以这里用「原生 value setter + input 事件」
// 让 React 的受控 textarea 认这次修改（直接改 .value 不会触发 onChange）。
const PENDING_KEY = 'pendingCompose'
const COMPOSER_SELECTOR = '[class*="textareaWrapper"] textarea'
const DEDUPE_MS = 1500

let lastApplied = { text: '', at: 0 }

const findComposer = () => document.querySelector(COMPOSER_SELECTOR)

function waitForComposer(timeoutMs = 15000) {
  const immediate = findComposer()
  if (immediate) return Promise.resolve(immediate)
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const composer = findComposer()
      if (!composer) return
      observer.disconnect()
      clearTimeout(timer)
      resolve(composer)
    })
    const timer = setTimeout(() => {
      observer.disconnect()
      resolve(null)
    }, timeoutMs)
    observer.observe(document.documentElement, { childList: true, subtree: true })
  })
}

function applyText(composer, text) {
  const now = Date.now()
  if (lastApplied.text === text && now - lastApplied.at < DEDUPE_MS) return
  lastApplied = { text, at: now }

  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  const current = composer.value
  const next = current.trim()
    ? `${current}${current.endsWith('\n') ? '' : '\n'}${text}`
    : text
  setValue.call(composer, next)
  composer.dispatchEvent(new Event('input', { bubbles: true }))
  composer.focus({ preventScroll: true })
  composer.setSelectionRange(next.length, next.length)
}

async function compose(text) {
  if (!text) return
  const composer = await waitForComposer()
  if (!composer) {
    console.warn('[deepseek-chat] 没找到输入框，可能界面还没加载完')
    return
  }
  applyText(composer, text)
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'compose') return
  compose(message.text)
})

// 页面可能晚于右键菜单动作挂载，这里补取一次遗留内容。
async function consumePending() {
  const data = await chrome.storage.session.get(PENDING_KEY)
  const text = data?.[PENDING_KEY]
  if (!text) return
  await chrome.storage.session.remove(PENDING_KEY)
  await compose(text)
}

consumePending()
