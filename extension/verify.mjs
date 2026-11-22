// 用 Playwright 启动 Chromium 加载 extension/，验证四件事：
// 1) MV3 能装（拿到 Service Worker 与扩展 id）
// 2) 面板页在扩展源下正常渲染（#root 有子节点）
// 3) host_permissions 生效（无 Key 请求 /models 得到 401，而非被 CSP/CORS 拦下）
// 4) bridge.js 能把后台文本写进 React 受控 textarea（消息通道 + storage 兜底两条路径）
// 运行：PLAYWRIGHT_CORE=<playwright-core 目录> node extension/verify.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ESM 不认 NODE_PATH，playwright-core 不在本项目依赖里时用绝对路径导入。
async function loadPlaywright() {
  let mod
  try {
    mod = await import('playwright-core')
  } catch (error) {
    const hint = process.env.PLAYWRIGHT_CORE
    if (!hint) throw error
    mod = await import(pathToFileURL(resolve(hint, 'index.js')).href)
  }
  return mod.chromium ?? mod.default?.chromium ?? mod.default
}

const COMPOSER = '[class*="textareaWrapper"] textarea'
const here = dirname(fileURLToPath(import.meta.url))
const profile = mkdtempSync(join(tmpdir(), 'dsc-ext-'))
const chromium = await loadPlaywright()

const context = await chromium.launchPersistentContext(profile, {
  // 默认用 Playwright 自带的 Chromium：Chrome 137+ 官方构建已移除 --load-extension。
  ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  headless: false,
  args: [
    `--disable-extensions-except=${here}`,
    `--load-extension=${here}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  viewport: { width: 420, height: 820 },
})

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

console.log(`chromium: ${context.browser()?.version() ?? 'unknown'}`)

try {
  let worker = context.serviceWorkers()[0]
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => undefined)
  }
  if (!worker) {
    const diag = await context.newPage()
    await diag.goto('chrome://extensions/')
    await diag.waitForTimeout(2000)
    await diag.screenshot({ path: join(here, 'verify-extensions-page.png') })
    console.log('✗ 没有 Service Worker；已截图 chrome://extensions 便于诊断')
    process.exitCode = 3
  } else {
    const extensionId = new URL(worker.url()).host
    console.log(`extension id: ${extensionId}`)

    const page = await context.newPage()
    const errors = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      // 我们自己的无 Key 探测会产生一条 401 资源错误，不算页面缺陷。
      const url = msg.location()?.url ?? ''
      if (url.includes('api.deepseek.com/models')) return
      errors.push(msg.text())
    })
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

    await page.goto(`chrome-extension://${extensionId}/panel/index.html`, {
      waitUntil: 'networkidle',
    })
    await page.waitForTimeout(1200)

    const rootChildren = await page.evaluate(
      () => document.getElementById('root')?.childElementCount ?? 0
    )
    check(rootChildren > 0, '面板渲染', `#root children: ${rootChildren}`)
    const pageTitle = await page.title()
    check(pageTitle === 'DeepSeek Chat', '页面标题与扩展名一致', pageTitle)
    console.log(`  title: ${pageTitle}`)

    const probe = await page.evaluate(async () => {
      try {
        const response = await fetch('https://api.deepseek.com/models')
        return { status: response.status }
      } catch (error) {
        return { error: String(error) }
      }
    })
    check(probe.status === 401, 'host_permissions 与 API 连通', JSON.stringify(probe))

    // 4a) 消息通道：后台 → 页面
    await page.waitForSelector(COMPOSER, { timeout: 15000 })
    const viaMessage = '第一段（来自消息通道）'
    await worker.evaluate(
      (text) => chrome.runtime.sendMessage({ type: 'compose', text }),
      `${viaMessage}\n\n`
    )
    await page.waitForTimeout(400)
    const valueAfterMessage = await page.$eval(COMPOSER, (el) => el.value)
    check(
      valueAfterMessage.includes(viaMessage),
      'bridge 消息通道写入',
      JSON.stringify(valueAfterMessage.slice(0, 30))
    )

    // 4b) storage 兜底：面板晚挂载时也能取到
    const viaStorage = '第二段（来自 storage 兜底）'
    await worker.evaluate(
      (text) => chrome.storage.session.set({ pendingCompose: `${text}\n\n` }),
      viaStorage
    )
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector(COMPOSER, { timeout: 15000 })
    await page.waitForTimeout(600)
    const valueAfterReload = await page.$eval(COMPOSER, (el) => el.value)
    check(
      valueAfterReload.includes(viaStorage),
      'bridge storage 兜底写入',
      JSON.stringify(valueAfterReload.slice(0, 30))
    )

    const leftover = await worker.evaluate(() => chrome.storage.session.get('pendingCompose'))
    check(!leftover?.pendingCompose, '待处理内容取用后清除')

    // 4c) handOff 之后两条通道都指向同一份内容（右键菜单实际走的就是这条）
    const handOffBefore = await page.$eval(COMPOSER, (el) => el.value)
    await worker.evaluate(() => handOff('第三段（handOff 路径）\n\n'))
    await page.waitForTimeout(400)
    const handOffAfter = await page.$eval(COMPOSER, (el) => el.value)
    check(
      handOffAfter.includes('第三段（handOff 路径）') && handOffAfter.length > handOffBefore.length,
      'handOff 路径写入',
      JSON.stringify(handOffAfter.slice(-24))
    )

    check(errors.length === 0, '无 console 错误', `${errors.length} 条`)
    errors.slice(0, 5).forEach((line) => console.log(`  ! ${line}`))

    // 5) 侧栏浮层 + 独立窗口入口
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const openSider = page.getByRole('button', { name: '打开边栏' })
    check((await openSider.count()) > 0, '边栏入口可见')
    if (await openSider.count()) {
      await openSider.first().click()
      await page.waitForTimeout(350)
      const drawer = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[class*="drawer-"]')].find(
          (node) => node.getBoundingClientRect().width > 0
        )
        if (!el) return null
        const style = getComputedStyle(el)
        return {
          position: style.position,
          top: style.top,
          radius: style.borderRadius,
          elevated: style.boxShadow !== 'none',
        }
      })
      check(
        drawer?.position === 'absolute' && drawer.radius !== '0px' && drawer.elevated,
        '历史侧栏浮于上层',
        JSON.stringify(drawer)
      )
      const drawerSizing = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[class*="drawer-"]')].find(
          (node) => node.getBoundingClientRect().width > 0
        )
        if (!el) return null
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
          height: Math.round(rect.height),
          viewport: document.documentElement.clientHeight,
          bottom: style.bottom,
          maxHeight: style.maxHeight,
        }
      })
      check(
        drawerSizing?.height < drawerSizing.viewport - 100,
        '浮层高度随内容（短列表不撑满）',
        JSON.stringify(drawerSizing)
      )
      await page.screenshot({ path: join(here, 'verify-drawer.png') })
      console.log('screenshot: extension/verify-drawer.png')

      // 6) 设置页：扩展宿主下不再出现「位置信息」（设置入口也在抽屉里）
      const popupVisible = async () =>
        (await page.getByRole('button', { name: '在独立窗口打开' }).count()) > 0
      const settingsButton = page.getByRole('button', { name: '设置', exact: true })
      if (await settingsButton.count()) {
        await settingsButton.first().click()
        await page.waitForTimeout(250)
        const generalTab = page.getByRole('button', { name: '通用设置' })
        if (await generalTab.count()) await generalTab.first().click()
        await page.waitForTimeout(250)
        const locationCount = await page.getByText('位置信息', { exact: true }).count()
        check(locationCount === 0, '设置页不显示地理位置', `命中 ${locationCount} 处`)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
        // 设置弹窗关闭后抽屉可能也收起，重新展开再点独立窗口入口。
        if (!(await popupVisible())) await openSider.first().click()
        await page.waitForTimeout(300)
      } else {
        check(false, '设置页不显示地理位置', '没找到设置按钮')
      }

      const popupButton = page.getByRole('button', { name: '在独立窗口打开' })
      check((await popupButton.count()) > 0, '侧栏有独立窗口入口')
      if (await popupButton.count()) {
        const newPagePromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null)
        await popupButton.first().click()
        const newPage = await newPagePromise
        const url = newPage?.url() ?? ''
        check(url.includes('standalone=1'), '点击后打开独立窗口', url || '未捕获新窗口')
        if (newPage) await newPage.close()
      }
    }

    // 7) 网页悬浮球：content script 注入 + 点击送达后台
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>floater test</title><p>测试悬浮球</p>')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const site = await context.newPage()
    await site.goto(`http://127.0.0.1:${server.address().port}/`)
    await site.waitForTimeout(800)
    const ball = site.locator('#deepseek-chat-floater-host .ball')
    const shotButton = site.locator('#deepseek-chat-floater-host .shot')
    check((await ball.count()) > 0 && (await shotButton.count()) > 0, '悬浮球双按钮注入')

    // 拖动悬浮球：位置必须真的变化，且拖完不能误触开侧栏。
    const dockBefore = await site.locator('#deepseek-chat-floater-host .ball').boundingBox()
    if (dockBefore) {
      const startX = dockBefore.x + dockBefore.width / 2
      const startY = dockBefore.y + dockBefore.height / 2
      await site.mouse.move(startX, startY)
      await site.mouse.down()
      await site.mouse.move(startX - 130, startY - 90, { steps: 10 })
      await site.mouse.up()
      await site.waitForTimeout(250)
    }
    const dockAfter = await site.locator('#deepseek-chat-floater-host .ball').boundingBox()
    check(
      Boolean(dockBefore && dockAfter && dockAfter.x < dockBefore.x - 60 && dockAfter.y < dockBefore.y - 40),
      '悬浮球可拖动',
      JSON.stringify({ before: dockBefore, after: dockAfter })
    )

    // 模拟 chrome://extensions 的「刷新」：旧 content script 还在页面里，
    // 后台补注入时必须替换旧 UI，否则旧的 chrome.runtime 失效会报 context invalidated。
    await site.evaluate(() => {
      document.getElementById('deepseek-chat-floater-host')?.setAttribute('data-stale', '1')
      document.getElementById('deepseek-capture-host')?.setAttribute('data-stale', '1')
    })
    const siteTab = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      return tab?.id == null ? null : { id: tab.id, url: tab.url }
    })
    if (siteTab) {
      await worker.evaluate(
        ({ tabId }) =>
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['floater.js', 'capture.js'],
          }),
        { tabId: siteTab.id }
      )
    }
    await site.waitForTimeout(400)
    const replaced = await site.evaluate(() => {
      const floater = document.getElementById('deepseek-chat-floater-host')
      const capture = document.getElementById('deepseek-capture-host')
      return {
        floater: Boolean(floater) && !floater.hasAttribute('data-stale'),
        capture: Boolean(capture) && !capture.hasAttribute('data-stale'),
        count: document.querySelectorAll('#deepseek-chat-floater-host').length,
      }
    })
    check(
      replaced.floater && replaced.capture && replaced.count === 1,
      '重载后补注入替换旧 content script',
      JSON.stringify(replaced)
    )

    await worker.evaluate(() => {
      globalThis.__probeMessages = []
      chrome.runtime.onMessage.addListener((message) => {
        globalThis.__probeMessages.push(message)
      })
    })
    if (await ball.count()) {
      await ball.click()
      await site.waitForTimeout(600)
      const seen = await worker.evaluate(() => globalThis.__probeMessages ?? [])
      check(
        seen.some((message) => message?.type === 'open-panel'),
        '悬浮球点击送达后台',
        JSON.stringify(seen)
      )
      await site.screenshot({ path: join(here, 'verify-floater.png') })
      console.log('screenshot: extension/verify-floater.png')
    }

    // 8) 框选截屏：按钮 → 抓屏 → 遮罩 → 框选 → 确认 → 写入待处理附件
    const pagesBeforeShot = context.pages().length
    if (await shotButton.count()) {
      // 截图附件走的是 chat-demo 的 acceptFiles，没有 API Key 会直接 return。
      // 测试 profile 是全新的，这里先写入一个假 Key，确保验证的是「附件真的出现」。
      await page.evaluate(() => localStorage.setItem('chat-demo:api-key', 'sk-test-only'))
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForSelector(COMPOSER, { timeout: 15000 })
      // 首次安装会自动打开一个全页面板 tab，captureVisibleTab 抓的是活动 tab，先切回来。
      await site.bringToFront()
      await site.waitForTimeout(200)
      await shotButton.click()
      const cropVisible = await site
        .locator('#deepseek-capture-host .crop.show')
        .waitFor({ state: 'visible', timeout: 12000 })
        .then(() => true)
        .catch(() => false)
      check(cropVisible, '截屏遮罩出现')
      if (cropVisible) {
        // 面板的 shot-bridge 会消费截图并触发 file input 的 change。
        await page.evaluate(() => {
          globalThis.__fileChanges = 0
          document.addEventListener(
            'change',
            (event) => {
              if (event.target?.type === 'file') globalThis.__fileChanges += 1
            },
            true
          )
        })
        // 面板的 shot-bridge 会立刻消费并删除 storage 项，所以在写入瞬间捕获。
        await worker.evaluate(() => {
          globalThis.__shotSeen = null
          chrome.storage.session.onChanged.addListener((changes) => {
            if (changes.pendingScreenshot?.newValue) {
              globalThis.__shotSeen = changes.pendingScreenshot.newValue
            }
          })
        })
        await site.screenshot({ path: join(here, 'verify-crop.png') })
        console.log('screenshot: extension/verify-crop.png')
        // 在遮罩上拖一个矩形（Playwright 操作的是宿主页，pointer 事件会落到 shadow 内）
        await site.mouse.move(120, 160)
        await site.mouse.down()
        await site.mouse.move(300, 300, { steps: 8 })
        await site.mouse.up()
        await site.waitForTimeout(300)
        const selVisible = await site.evaluate(() =>
          Boolean(document.getElementById('deepseek-capture-host')?.shadowRoot?.querySelector('.sel.show'))
        )
        check(selVisible, '框选矩形生成')
        await site.evaluate(() =>
          document
            .getElementById('deepseek-capture-host')
            ?.shadowRoot?.querySelector('[data-act="ok"]')
            ?.click()
        )
        await site.waitForTimeout(1200)
        const panelOpened = await site.evaluate(
          () => document.getElementById('deepseek-capture-host')?.dataset.panelOpened
        )
        check(panelOpened === 'true', '截图确认时自动打开侧边栏', panelOpened ?? '无返回')
        const shot = await worker.evaluate(() => globalThis.__shotSeen)
        check(
          Boolean(shot?.dataUrl?.startsWith('data:image/jpeg')),
          '截图结果写入待处理附件',
          shot ? `${shot.size?.w ?? '?'}×${shot.size?.h ?? '?'} / ${shot.dataUrl.length}B` : 'none'
        )
        await page.waitForTimeout(400)
        const changes = await page.evaluate(() => globalThis.__fileChanges ?? 0)
        check(changes > 0, '截图已送入面板附件输入', `change 事件 ${changes} 次`)

        const attachment = await page
          .waitForSelector('img[alt^="deepseek-shot-"]', { timeout: 5000 })
          .catch(() => null)
        const attachmentAlt = await attachment?.getAttribute('alt').catch(() => null)
        check(Boolean(attachment), '截图附件出现在输入框', attachmentAlt ?? '未找到缩略图')

        await page.waitForTimeout(800)
        const standalonePages = context.pages().filter((p) => p.url().includes('standalone=1'))
        check(
          context.pages().length === pagesBeforeShot && standalonePages.length === 0,
          '截屏不弹出独立窗口',
          `pages ${pagesBeforeShot} → ${context.pages().length}`
        )
      }
    }
    if (!site.isClosed()) await site.close()
    await new Promise((resolve) => server.close(resolve))

    // 打开真实侧边栏后，测试用的 panel tab 可能被 Chrome 关闭；
    // 功能断言已经跑完，这里只为留一张最终面板截图，关掉就跳过。
    if (!page.isClosed()) {
      await page.bringToFront()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(here, 'verify-panel.png') })
      console.log('screenshot: extension/verify-panel.png')
    } else {
      console.log('panel tab 已被侧边栏替换，跳过最终截图')
    }

    if (failures.length > 0) process.exitCode = 2
    console.log(failures.length === 0 ? '\n全部通过' : `\n失败项：${failures.join('、')}`)
  }
} finally {
  await context.close()
  // Chromium 退出后偶尔还会短暂占用 profile 里的临时文件，清理失败不影响验证结论。
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch (error) {
    console.warn(`临时 profile 未清理：${error.message}`)
  }
}
