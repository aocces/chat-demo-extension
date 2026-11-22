/** 扩展宿主检测：只有装了本扩展的页面才有 chrome.runtime.id，普通网页里 chrome 也可能存在但无 runtime。 */
type HostChrome = {
  runtime?: { id?: string; getURL?: (path: string) => string }
  windows?: { create?: (options: Record<string, unknown>) => Promise<unknown> }
}

const hostChrome = (globalThis as { chrome?: HostChrome }).chrome

export const isExtensionHost = Boolean(hostChrome?.runtime?.id)

/** 能否开独立窗口：扩展页里可用，普通网页构建下为 false，入口按钮不渲染。 */
export const canOpenPopupWindow = Boolean(
  isExtensionHost && hostChrome?.runtime?.getURL && hostChrome?.windows?.create
)

/** 在新窗口里打开 chat-demo 自身（扩展面板是同一个页面，宽度更适合 480）。 */
export const openInPopupWindow = () => {
  if (!canOpenPopupWindow) return
  const url = hostChrome?.runtime?.getURL?.('panel/index.html?standalone=1')
  if (!url) return
  void hostChrome?.windows?.create?.({ url, type: 'popup', width: 480, height: 900 })
}
