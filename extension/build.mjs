// 构建扩展：生成图标 → 跑 chat-demo 生产构建 → 同步 dist 到 extension/panel
// → 往面板 HTML 注入 bridge.js。
// 不用 `npm run build`，因为它的脚本是 Unix 写法（rm -rf + NODE_ENV 前缀），Windows 上会失败。
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const dist = join(root, 'dist')
const panel = join(here, 'panel')
const cli = join(root, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js')

if (!existsSync(cli)) {
  console.error(`未找到 rspack：${cli}\n请先在 ${root} 执行 pnpm install`)
  process.exit(1)
}

console.log('▸ 生成图标')
const icons = spawnSync(process.execPath, [join(here, 'icons.mjs')], { stdio: 'inherit' })
if (icons.status !== 0) process.exit(icons.status ?? 1)

console.log('▸ 构建 chat-demo（production）')
const build = spawnSync(process.execPath, [cli, 'build', '-c', 'rspack.config.ts'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: 'inherit',
})
if (build.status !== 0) {
  console.error('构建失败，未更新 panel')
  process.exit(build.status ?? 1)
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html 不存在，构建可能没有输出')
  process.exit(1)
}

console.log('▸ 同步 dist → extension/panel')
rmSync(panel, { recursive: true, force: true })
mkdirSync(panel, { recursive: true })
cpSync(dist, panel, { recursive: true })

// 面板是重新生成的，所以注入放在每次构建后做，而不是手改产物。
const panelHtmlPath = join(panel, 'index.html')
const panelHtml = readFileSync(panelHtmlPath, 'utf8')
const bridgeTags = [
  '<script defer src="../bridge.js"></script>',
  '<script defer src="../shot-bridge.js"></script>',
]
const missing = bridgeTags.filter((tag) => !panelHtml.includes(tag))
if (missing.length) {
  const injected = panelHtml.replace('</head>', `  ${missing.join('\n  ')}\n  </head>`)
  if (injected === panelHtml) {
    console.error('注入失败：面板 HTML 里没有 </head>')
    process.exit(1)
  }
  writeFileSync(panelHtmlPath, injected)
  console.log('▸ 已注入 bridge.js 与 shot-bridge.js')
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifestPath = join(here, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.version !== version) {
  manifest.version = version
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`▸ manifest.version 已同步为 ${version}`)
}

console.log('✓ 完成。chrome://extensions → 加载已解压的扩展程序 → 选 extension/')
