// 面板侧：把截屏结果作为附件送进 chat-demo 的上传 input。
// chat-demo 的上传是 React 受控组件，必须用原生 files setter + change 事件，
// 直接改 input.value 不会触发 onChange。
(() => {
  const KEY = 'pendingScreenshot'
  const MAX_AGE_MS = 2 * 60 * 1000
  // 设置页也有一个只收 zip 的 file input，必须把对话输入框挑出来。
  const INPUT_SELECTOR = 'input[type="file"][multiple], input[type="file"][accept*=".jpg"]'
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let consuming = false

  function hasApiKey() {
    try {
      return Boolean(localStorage.getItem('chat-demo:api-key')?.trim())
    } catch {
      return true
    }
  }

  function notify(text) {
    let el = document.getElementById('deepseek-shot-notice')
    if (!el) {
      el = document.createElement('div')
      el.id = 'deepseek-shot-notice'
      Object.assign(el.style, {
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '2147483600',
        maxWidth: 'calc(100% - 32px)',
        padding: '9px 13px',
        borderRadius: '10px',
        background: 'rgba(17,24,39,.96)',
        color: '#fff',
        font: '13px/1.45 system-ui, sans-serif',
        boxShadow: '0 12px 32px rgba(0,0,0,.32)',
        pointerEvents: 'none',
        transition: 'opacity .18s ease',
      })
      document.documentElement.append(el)
    }
    el.textContent = text
    el.style.opacity = '1'
    clearTimeout(notify.timer)
    notify.timer = setTimeout(() => {
      el.style.opacity = '0'
    }, 5000)
  }

  async function waitForInput(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const input = document.querySelector(INPUT_SELECTOR)
      if (input) return input
      await sleep(200)
    }
    return null
  }

  async function waitForKey(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (hasApiKey()) return true
      await sleep(500)
    }
    return false
  }

  async function waitForAttachment(name, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const attached = document.querySelector(`img[alt="${CSS.escape(name)}"]`)
      if (attached) return attached
      await sleep(150)
    }
    return null
  }

  async function consume() {
    if (consuming) return
    consuming = true
    try {
      const data = await chrome.storage.session.get(KEY)
      const shot = data?.[KEY]
      if (!shot?.dataUrl) return
      // 过期截图不注入，避免几天前的画面突然冒出来。
      if (shot.at && Date.now() - shot.at > MAX_AGE_MS) {
        await chrome.storage.session.remove(KEY)
        return
      }

      const input = await waitForInput()
      if (!input) return // 不清 storage，页面稍后再取

      // chat-demo 的 acceptFiles 在没有 Key 时会直接 return，图片会无声消失。
      // 此时保留待处理截图，等用户填完 Key 再自动送入。
      if (!hasApiKey()) {
        notify('截图已生成，请先在设置里填写 API Key；填写后会自动加入输入框')
        if (!(await waitForKey(120000))) return
      }

      const blob = await (await fetch(shot.dataUrl)).blob()
      const name = `deepseek-shot-${Date.now()}.jpg`
      const file = new File([blob], name, { type: 'image/jpeg' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set
      if (setter) setter.call(input, transfer.files)
      else input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await chrome.storage.session.remove(KEY)

      if (!(await waitForAttachment(name))) {
        console.warn('[deepseek-chat] 截图已送出，但输入框里没有出现缩略图')
        notify('截图已生成，但没有加入输入框；请确认 API Key 后重试')
      }
    } catch (error) {
      console.warn('[deepseek-chat] 截图附件注入失败', error)
      notify('截图附件注入失败，请刷新侧边栏后重试')
    } finally {
      consuming = false
    }
  }

  chrome.storage.session.onChanged?.addListener((changes) => {
    if (changes[KEY]) void consume()
  })
  void consume()
})()
