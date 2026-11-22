// 框选截屏：content script 侧只负责交互；抓屏与裁切在 Service Worker 里做。
// 样式走 constructed stylesheet + Shadow DOM，避免页面 CSS/CSP 干扰。
(() => {
  if (window.top !== window) return

  const HOST_ID = 'deepseek-capture-host'
  const VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version
    } catch {
      return 'unknown'
    }
  })()

  // 扩展重载后旧 content script 仍在页面里，但它的 chrome.runtime 已经失效。
  // 重新注入时必须替换旧 UI 和入口，而不是因为“已存在”直接退出。
  document.getElementById(HOST_ID)?.remove()

  const host = document.createElement('div')
  host.id = HOST_ID
  const shadow = host.attachShadow({ mode: 'open' })

  const css = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .crop {
      position: fixed; inset: 0; z-index: 2147483400; display: none;
      cursor: crosshair; user-select: none; -webkit-user-select: none;
      background: #0f172a; pointer-events: auto;
    }
    .crop.show { display: block; }
    .bg {
      position: absolute; inset: 0; width: 100%; height: 100%;
      object-fit: fill; pointer-events: none; user-select: none;
    }
    .dim { position: absolute; inset: 0; pointer-events: none; background: rgba(15,23,42,.5); }
    .mask { position: absolute; display: none; pointer-events: none; background: rgba(15,23,42,.52); }
    .mask.show { display: block; }
    .sel {
      position: absolute; display: none; border: 1px solid #fff; cursor: move;
      contain: layout style;
    }
    .sel.show { display: block; }
    .sel::after {
      content: ''; position: absolute; inset: -1px; pointer-events: none;
      border: 1px solid rgba(99,102,241,.95);
    }
    .size {
      position: absolute; z-index: 3; left: 50%; top: -9px; transform: translate(-50%, -100%);
      background: rgba(17,24,39,.9); color: #fff; font: 11px/1 system-ui, sans-serif;
      padding: 5px 8px; border-radius: 6px; white-space: nowrap; pointer-events: none;
      font-variant-numeric: tabular-nums;
    }
    .hnd {
      position: absolute; width: 9px; height: 9px; background: #fff;
      border: 1.5px solid #4f46e5; border-radius: 2px; z-index: 2;
    }
    .hnd.nw { left:-5px; top:-5px; cursor:nwse-resize; }
    .hnd.n  { left:50%; top:-5px; margin-left:-4.5px; cursor:ns-resize; }
    .hnd.ne { right:-5px; top:-5px; cursor:nesw-resize; }
    .hnd.e  { right:-5px; top:50%; margin-top:-4.5px; cursor:ew-resize; }
    .hnd.se { right:-5px; bottom:-5px; cursor:nwse-resize; }
    .hnd.s  { left:50%; bottom:-5px; margin-left:-4.5px; cursor:ns-resize; }
    .hnd.sw { left:-5px; bottom:-5px; cursor:nesw-resize; }
    .hnd.w  { left:-5px; top:50%; margin-top:-4.5px; cursor:ew-resize; }
    .hint {
      position: absolute; left:50%; top:22px; transform:translateX(-50%);
      background:rgba(17,24,39,.82); color:#f9fafb; font:12px system-ui,sans-serif;
      padding:7px 13px; border-radius:9px; white-space:nowrap; pointer-events:none;
    }
    .hint.hide { display: none; }
    .bar {
      position: absolute; z-index: 4; display: none; align-items: center; gap: 4px;
      background: rgba(17,24,39,.94); padding:5px; border-radius:11px;
      box-shadow: 0 10px 30px rgba(0,0,0,.42);
    }
    .bar.show { display: flex; }
    .bar button {
      border:0; background:transparent; color:#e5e7eb; font:12px system-ui,sans-serif;
      padding:6px 10px; border-radius:7px; cursor:pointer; white-space:nowrap;
    }
    .bar button:hover { background:rgba(255,255,255,.12); color:#fff; }
    .bar button.primary { background:linear-gradient(150deg,#6366f1,#2563eb); color:#fff; font-weight:600; }
    .bar .sep { width:1px; height:18px; background:rgba(255,255,255,.16); margin:0 2px; }
    .toast {
      position: fixed; z-index: 2147483600; left: 50%; bottom: 26px;
      transform: translate(-50%, 12px); opacity: 0; pointer-events: none;
      max-width: calc(100vw - 32px); background: rgba(17,24,39,.96); color: #fff;
      font: 13px/1.45 system-ui, sans-serif; padding: 10px 14px; border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0,0,0,.35); transition: opacity .18s ease, transform .18s ease;
      text-align: center;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
  `
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  shadow.adoptedStyleSheets = [sheet]

  shadow.innerHTML = `
    <div class="crop">
      <img class="bg" alt="">
      <div class="dim"></div>
      <div class="mask" data-m="top"></div>
      <div class="mask" data-m="bottom"></div>
      <div class="mask" data-m="left"></div>
      <div class="mask" data-m="right"></div>
      <div class="sel">
        <span class="size"></span>
        <i class="hnd nw" data-h="nw"></i><i class="hnd n" data-h="n"></i><i class="hnd ne" data-h="ne"></i>
        <i class="hnd e" data-h="e"></i><i class="hnd se" data-h="se"></i><i class="hnd s" data-h="s"></i>
        <i class="hnd sw" data-h="sw"></i><i class="hnd w" data-h="w"></i>
      </div>
      <div class="hint">拖拽框选 · <b>Enter</b> 确认 · <b>Esc</b>/右键 取消</div>
      <div class="bar">
        <button type="button" data-act="full">整屏</button>
        <button type="button" data-act="redo">重选</button>
        <button type="button" data-act="cancel">取消</button>
        <span class="sep"></span>
        <button type="button" class="primary" data-act="ok">确认</button>
      </div>
    </div>
    <div class="toast" role="status"></div>
  `
  document.documentElement.append(host)

  const $ = (selector) => shadow.querySelector(selector)
  const cropEl = $('.crop')
  const bg = $('.bg')
  const dim = $('.dim')
  const sel = $('.sel')
  const sizeEl = $('.size')
  const hint = $('.hint')
  const bar = $('.bar')
  const toast = $('.toast')
  const masks = {
    top: $('[data-m="top"]'),
    bottom: $('[data-m="bottom"]'),
    left: $('[data-m="left"]'),
    right: $('[data-m="right"]'),
  }

  let state = null
  let drag = null
  let raf = 0
  let toastTimer = 0
  let barSize = { w: 0, h: 0 }

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
  const errorText = (error) => String(error?.message ?? error)

  function showToast(text) {
    toast.textContent = text
    toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4200)
  }

  function describeError(error) {
    const text = errorText(error)
    if (/context invalidated|message port closed|receiving end does not exist/i.test(text)) {
      return '扩展已更新，请刷新本页后重试'
    }
    return `截屏失败：${text}`
  }

  // 必须在「确认」点击的同一个任务里调用，才能把用户手势带到 Service Worker；
  // 等 CROP 异步完成后再开侧边栏就晚了，Chrome 会拒绝 sidePanel.open。
  function ensurePanel() {
    try {
      chrome.runtime
        .sendMessage({ type: 'ensure-panel' })
        .then((result) => {
          host.dataset.panelOpened = String(Boolean(result?.opened))
        })
        .catch(() => {
          host.dataset.panelOpened = 'error'
        })
    } catch {
      host.dataset.panelOpened = 'error'
    }
  }

  function normRect(rect) {
    const vp = state.vp
    const x = clamp(rect.x, 0, vp.w)
    const y = clamp(rect.y, 0, vp.h)
    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(clamp(rect.w, 0, vp.w - x)),
      h: Math.round(clamp(rect.h, 0, vp.h - y)),
    }
  }

  function placeBar(rect) {
    const vp = state.vp
    if (!bar.classList.contains('show')) {
      bar.classList.add('show')
      barSize = { w: bar.offsetWidth || 250, h: bar.offsetHeight || 34 }
    }
    let top = rect.y + rect.h + 10
    if (top + barSize.h > vp.h - 8) top = rect.y - barSize.h - 10
    if (top < 8) top = clamp(rect.y + rect.h - barSize.h - 10, 8, vp.h - barSize.h - 8)
    bar.style.left = `${clamp(rect.x + rect.w - barSize.w, 8, Math.max(8, vp.w - barSize.w - 8))}px`
    bar.style.top = `${top}px`
  }

  function render() {
    if (!state) return
    const rect = state.rect
    if (!rect || rect.w < 6 || rect.h < 6) {
      sel.classList.remove('show')
      bar.classList.remove('show')
      dim.style.display = ''
      hint.classList.remove('hide')
      Object.values(masks).forEach((node) => node.classList.remove('show'))
      return
    }
    dim.style.display = 'none'
    hint.classList.add('hide')
    sel.classList.add('show')
    sel.style.left = `${rect.x}px`
    sel.style.top = `${rect.y}px`
    sel.style.width = `${rect.w}px`
    sel.style.height = `${rect.h}px`
    const vp = state.vp
    masks.top.style.cssText = `left:0;top:0;width:${vp.w}px;height:${rect.y}px`
    masks.bottom.style.cssText = `left:0;top:${rect.y + rect.h}px;width:${vp.w}px;height:${Math.max(0, vp.h - rect.y - rect.h)}px`
    masks.left.style.cssText = `left:0;top:${rect.y}px;width:${rect.x}px;height:${rect.h}px`
    masks.right.style.cssText = `left:${rect.x + rect.w}px;top:${rect.y}px;width:${Math.max(0, vp.w - rect.x - rect.w)}px;height:${rect.h}px`
    Object.values(masks).forEach((node) => node.classList.add('show'))
    const scale = state.img.w ? state.img.w / vp.w : 1
    sizeEl.textContent = `${Math.round(rect.w * scale)} × ${Math.round(rect.h * scale)}`
    sizeEl.style.top = rect.y < 26 ? `${rect.h + 8}px` : '-9px'
    sizeEl.style.transform = rect.y < 26 ? 'translate(-50%, 0)' : 'translate(-50%, -100%)'
    placeBar(rect)
  }

  function scheduleRender() {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      render()
    })
  }

  function closeCrop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    cropEl.classList.remove('show')
    bar.classList.remove('show')
    sel.classList.remove('show')
    Object.values(masks).forEach((node) => node.classList.remove('show'))
    state = null
    drag = null
  }

  function openCrop(dataUrl) {
    const de = document.documentElement
    state = {
      dataUrl,
      rect: null,
      vp: { w: de.clientWidth || innerWidth, h: de.clientHeight || innerHeight },
      img: { w: 0, h: 0 },
    }
    bg.onload = () => {
      if (state) state.img = { w: bg.naturalWidth, h: bg.naturalHeight }
    }
    bg.src = dataUrl
    hint.classList.remove('hide')
    bar.classList.remove('show')
    sel.classList.remove('show')
    cropEl.classList.add('show')
  }

  async function startCapture() {
    if (state) return true
    if (!chrome?.runtime?.id) {
      showToast('扩展已更新，请刷新本页后重试')
      return false
    }
    const floater = document.getElementById('deepseek-chat-floater-host')
    const previous = floater?.style.display
    if (floater) floater.style.display = 'none'
    // 等两帧让悬浮球从渲染树移除，避免被截进图里。
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    let resp
    try {
      resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' })
    } catch (error) {
      resp = { ok: false, error: errorText(error) }
    } finally {
      if (floater) floater.style.display = previous ?? ''
    }
    if (!resp?.ok || !resp.dataUrl) {
      console.warn('[deepseek-chat] 截屏失败', resp?.error)
      showToast(resp?.error ? describeError(resp.error) : '截屏失败：后台没有返回截图')
      return false
    }
    openCrop(resp.dataUrl)
    return true
  }

  async function confirmCrop(useFull) {
    if (!state) return
    // 先发出去，保证还在 click/keydown 的用户手势里；随后再裁切和交接。
    ensurePanel()
    const current = state
    const rect = useFull || !current.rect
      ? { x: 0, y: 0, w: current.vp.w, h: current.vp.h }
      : { ...current.rect }
    const full = useFull || !current.rect
    closeCrop()
    let dataUrl = current.dataUrl
    let size = current.img.w ? { ...current.img } : null
    if (!full) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'CROP',
          dataUrl: current.dataUrl,
          rect,
          viewport: current.vp,
        })
        if (resp?.ok && resp.dataUrl) {
          dataUrl = resp.dataUrl
          size = resp.size
        }
      } catch (error) {
        console.warn('[deepseek-chat] 裁切失败，改用整屏', error)
      }
    }
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'SCREENSHOT_READY', dataUrl, size })
      if (!resp?.ok) {
        showToast(describeError(resp?.error ?? '后台没有接收截图'))
      } else if (resp.panelOpened) {
        showToast('截图已发送到侧边栏')
      } else {
        showToast('截图已生成，打开侧边栏后会自动加入输入框')
      }
    } catch (error) {
      console.warn('[deepseek-chat] 截图交接失败', error)
      showToast(describeError(error))
    }
  }

  cropEl.addEventListener('pointerdown', (event) => {
    if (!state || event.button !== 0) return
    if (event.target.closest?.('.bar')) return
    event.preventDefault()
    const handle = event.target.closest?.('.hnd')
    const inside = event.target.closest?.('.sel')
    let mode = 'new'
    let dir = null
    if (handle) {
      mode = 'resize'
      dir = handle.dataset.h
    } else if (inside && state.rect) {
      mode = 'move'
    }
    drag = {
      mode,
      dir,
      sx: event.clientX,
      sy: event.clientY,
      orig: state.rect ? { ...state.rect } : null,
      id: event.pointerId,
    }
    if (mode === 'new') state.rect = { x: event.clientX, y: event.clientY, w: 0, h: 0 }
    try {
      cropEl.setPointerCapture(event.pointerId)
    } catch (_) {}
    render()
  })

  cropEl.addEventListener('pointermove', (event) => {
    if (!state || !drag || event.pointerId !== drag.id) return
    const dx = event.clientX - drag.sx
    const dy = event.clientY - drag.sy
    const vp = state.vp
    if (drag.mode === 'new') {
      const sx = clamp(drag.sx, 0, vp.w)
      const sy = clamp(drag.sy, 0, vp.h)
      const ex = clamp(event.clientX, 0, vp.w)
      const ey = clamp(event.clientY, 0, vp.h)
      state.rect = {
        x: Math.min(sx, ex),
        y: Math.min(sy, ey),
        w: Math.abs(ex - sx),
        h: Math.abs(ey - sy),
      }
    } else if (drag.mode === 'move') {
      const o = drag.orig
      state.rect = normRect({ x: o.x + dx, y: o.y + dy, w: o.w, h: o.h })
    } else {
      const o = drag.orig
      let l = o.x
      let t = o.y
      let r = o.x + o.w
      let b = o.y + o.h
      if (drag.dir.includes('w')) l = o.x + dx
      if (drag.dir.includes('e')) r = o.x + o.w + dx
      if (drag.dir.includes('n')) t = o.y + dy
      if (drag.dir.includes('s')) b = o.y + o.h + dy
      l = clamp(l, 0, vp.w)
      r = clamp(r, 0, vp.w)
      t = clamp(t, 0, vp.h)
      b = clamp(b, 0, vp.h)
      if (r - l < 16) drag.dir.includes('w') ? (l = Math.max(0, r - 16)) : (r = Math.min(vp.w, l + 16))
      if (b - t < 16) drag.dir.includes('n') ? (t = Math.max(0, b - 16)) : (b = Math.min(vp.h, t + 16))
      state.rect = { x: Math.round(l), y: Math.round(t), w: Math.round(r - l), h: Math.round(b - t) }
    }
    scheduleRender()
  })

  cropEl.addEventListener('pointerup', (event) => {
    if (!state || !drag || event.pointerId !== drag.id) return
    drag = null
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    const rect = state.rect
    if (!rect || rect.w < 8 || rect.h < 8) state.rect = null
    else state.rect = normRect(rect)
    render()
  })

  bar.addEventListener('click', (event) => {
    const btn = event.target.closest?.('[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'ok') void confirmCrop(false)
    else if (act === 'full') void confirmCrop(true)
    else if (act === 'redo') {
      if (state) state.rect = null
      render()
    } else if (act === 'cancel') {
      closeCrop()
    }
  })

  cropEl.addEventListener('contextmenu', (event) => {
    if (!state) return
    event.preventDefault()
    event.stopPropagation()
    drag = null
    closeCrop()
  })

  window.addEventListener('keydown', (event) => {
    if (!state) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeCrop()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      void confirmCrop(false)
    }
  })

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'START_CAPTURE') void startCapture()
  })

  // floater.js 通过它触发，避免再绕一趟 Service Worker。
  window.__deepSeekCapture = { start: startCapture, version: VERSION }
})()
