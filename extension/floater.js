// 网页悬浮球：主按钮开侧边栏，副按钮框选截屏。
// 样式走 constructed stylesheet + Shadow DOM，不受页面 CSS/CSP 影响。
(() => {
  if (window.top !== window) return

  // 扩展重载后旧 content script 的 chrome.runtime 已失效；重新注入时替换旧悬浮球，
  // 否则页面上会一直保留那个点不动的旧实例。
  document.getElementById('deepseek-chat-floater-host')?.remove()

  const host = document.createElement('div')
  host.id = 'deepseek-chat-floater-host'
  const shadow = host.attachShadow({ mode: 'open' })

  const css = `
    :host { all: initial; }
    .dock {
      position: fixed;
      right: 20px;
      bottom: 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      z-index: 2147483000;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      cursor: grab;
    }
    .dock.dragging { cursor: grabbing; }
    .dock.dragging button { pointer-events: none; }
    button {
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      cursor: pointer;
      transition: transform 0.16s ease, box-shadow 0.16s ease;
      font-family: system-ui, sans-serif;
    }
    button:hover { transform: scale(1.07); }
    button:active { transform: scale(0.96); }
    button:focus-visible { outline: 2px solid #1f37b5; outline-offset: 2px; }
    .ball {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background-color: #4d6bfe;
      color: #fff;
      box-shadow: 0 6px 20px rgba(37, 58, 130, 0.3), 0 1px 4px rgba(37, 58, 130, 0.24);
    }
    .ball:hover { box-shadow: 0 10px 26px rgba(37, 58, 130, 0.38); }
    .shot {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: #fff;
      color: #4d6bfe;
      border: 1px solid rgba(77, 107, 254, 0.32);
      box-shadow: 0 4px 14px rgba(37, 58, 130, 0.18);
    }
    .shot:hover { box-shadow: 0 8px 18px rgba(37, 58, 130, 0.26); }
    button svg { width: 22px; height: 22px; display: block; }
    .shot svg { width: 19px; height: 19px; }
    .toast {
      position: fixed; z-index: 2147483600; right: 20px; bottom: 88px;
      max-width: min(320px, calc(100vw - 40px)); background: rgba(17,24,39,.96); color: #fff;
      font: 13px/1.45 system-ui, sans-serif; padding: 10px 13px; border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0,0,0,.35); opacity: 0; pointer-events: none;
      transform: translateY(8px); transition: opacity .18s ease, transform .18s ease;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
  `
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  shadow.adoptedStyleSheets = [sheet]

  const dock = document.createElement('div')
  dock.className = 'dock'

  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.setAttribute('role', 'status')
  let toastTimer = 0

  function showToast(text) {
    toast.textContent = text
    toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4200)
  }

  function describeError(error) {
    const text = String(error?.message ?? error)
    if (/context invalidated|message port closed|receiving end does not exist/i.test(text)) {
      return '扩展已更新，请刷新本页后重试'
    }
    return `操作失败：${text}`
  }

  async function send(message) {
    if (!chrome?.runtime?.id) {
      showToast('扩展已更新，请刷新本页后重试')
      return null
    }
    try {
      return await chrome.runtime.sendMessage(message)
    } catch (error) {
      showToast(describeError(error))
      return null
    }
  }

  // ---------- 拖动悬浮球 ----------
  const POSITION_KEY = 'floaterPosition'
  let drag = null
  let suppressClick = false

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max))
  }

  function setDockPosition(left, top) {
    dock.style.left = `${clamp(left, 8, innerWidth - dock.offsetWidth - 8)}px`
    dock.style.top = `${clamp(top, 8, innerHeight - dock.offsetHeight - 8)}px`
    dock.style.right = 'auto'
    dock.style.bottom = 'auto'
  }

  async function saveDockPosition() {
    if (!chrome?.runtime?.id) return
    const rect = dock.getBoundingClientRect()
    try {
      await chrome.storage.local.set({
        [POSITION_KEY]: { left: Math.round(rect.left), top: Math.round(rect.top) },
      })
    } catch {
      // 拖动本身不依赖存储，存不下就只在当前页面生效。
    }
  }

  async function restoreDockPosition() {
    if (!chrome?.runtime?.id) return
    try {
      const data = await chrome.storage.local.get(POSITION_KEY)
      const pos = data?.[POSITION_KEY]
      if (Number.isFinite(pos?.left) && Number.isFinite(pos?.top)) {
        setDockPosition(pos.left, pos.top)
      }
    } catch {
      // 扩展重载后旧上下文取不到 storage，保持默认位置即可。
    }
  }

  dock.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return
    const rect = dock.getBoundingClientRect()
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    }
    // 注意：不要在这里 setPointerCapture。捕获后 pointerup 的目标会变成 dock，
    // 浏览器据此生成的 click 也会落在 dock 上，按钮的 click 永远不会触发。
    // 等真正超过拖动阈值再捕获。
  })

  dock.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < 4) return
    if (!drag.moved) {
      drag.moved = true
      // 超过阈值才捕获，保证普通点击仍然由按钮自己接收。
      try {
        dock.setPointerCapture(event.pointerId)
      } catch {
        // 某些页面/输入设备不支持 pointer capture，仍可继续拖动。
      }
    }
    dock.classList.add('dragging')
    event.preventDefault()
    setDockPosition(drag.left + dx, drag.top + dy)
  })

  function endDrag(event, cancelled = false) {
    if (!drag || event.pointerId !== drag.id) return
    const moved = drag.moved
    drag = null
    dock.classList.remove('dragging')
    try {
      dock.releasePointerCapture(event.pointerId)
    } catch {
      // 已经释放时忽略。
    }
    if (moved) {
      // 拖动结束时浏览器仍会补一个 click，捕获阶段吃掉它，避免误触开侧栏/截屏。
      suppressClick = true
      setTimeout(() => {
        suppressClick = false
      }, 350)
      if (!cancelled) void saveDockPosition()
    }
  }

  dock.addEventListener('pointerup', (event) => endDrag(event))
  dock.addEventListener('pointercancel', (event) => endDrag(event, true))
  dock.addEventListener(
    'click',
    (event) => {
      if (!suppressClick) return
      event.preventDefault()
      event.stopImmediatePropagation()
      suppressClick = false
    },
    true
  )

  window.addEventListener('resize', () => {
    if (!dock.style.left) return
    const rect = dock.getBoundingClientRect()
    setDockPosition(rect.left, rect.top)
  })

  const shot = document.createElement('button')
  shot.type = 'button'
  shot.className = 'shot'
  shot.title = '框选截屏（Ctrl+Shift+X）'
  shot.setAttribute('aria-label', '框选截屏')
  shot.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 7h3l1.5-2h7L17 7h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>'
  shot.addEventListener('click', () => {
    const capture = window.__deepSeekCapture
    if (capture?.start) {
      void capture.start()
      return
    }
    showToast('截屏组件尚未加载，请刷新本页后重试')
  })

  const ball = document.createElement('button')
  ball.type = 'button'
  ball.className = 'ball'
  ball.title = '打开 DeepSeek 侧边栏'
  ball.setAttribute('aria-label', '打开 DeepSeek 侧边栏')
  ball.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="2.5" y="4" width="19" height="13" rx="4.5" fill="#fff"/>' +
    '<circle cx="8" cy="10.5" r="1.5" fill="#4d6bfe"/>' +
    '<circle cx="12" cy="10.5" r="1.5" fill="#4d6bfe"/>' +
    '<circle cx="16" cy="10.5" r="1.5" fill="#4d6bfe"/>' +
    '<path d="M7 20.5 7 16.5 11.5 16.5 Z" fill="#fff"/>' +
    '</svg>'
  ball.addEventListener('click', () => {
    // 用户手势可能传不到 SW 的 sidePanel.open；SW 失败时会退化开独立窗口。
    void send({ type: 'open-panel' })
  })

  dock.append(shot, ball)
  shadow.append(dock, toast)
  document.documentElement.append(host)
  void restoreDockPosition()
})()
