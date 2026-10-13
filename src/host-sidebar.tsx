import type { Plugin } from "@opencode/plugin/tui"
import { CliRenderEvents, type BoxRenderable, type Renderable } from "@opentui/core"
import { createEffect, createSignal, onCleanup } from "solid-js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"
import type { HostPanelBounds, HostSidebarAnchor } from "./host-review-panel.js"

/** One public sidebar anchor and FRAME-measured app-slot geometry. Never reveal
 * the sidebar or change mouse tracking to obtain a presentation surface. */
export function setupHostSidebar(ctx: Plugin.Context, life: PluginLifecycle,
  rootSession: () => string | undefined) {
  const [sidebar, setSidebar] = createSignal<HostSidebarAnchor>()
  const [geometry, setGeometry] = createSignal<HostPanelBounds | undefined>(undefined, {
    equals: (a, b) => a?.x === b?.x && a?.y === b?.y && a?.width === b?.width && a?.height === b?.height,
  })
  life.addCleanup(ctx.ui.slot({ prepend: "sidebar.content", render: input => {
    let node: BoxRenderable | undefined
    const owner = Symbol("reviewer.sidebar")
    createEffect(() => { input.sessionID; if (node) setSidebar({ owner, sessionID: input.sessionID, node }) })
    onCleanup(() => {
      if (sidebar()?.owner !== owner) return
      setSidebar(undefined); setGeometry(undefined)
    })
    return <box ref={(value: BoxRenderable) => { node = value; setSidebar({ owner, sessionID: input.sessionID, node }) }}
      width="100%" height={1} flexShrink={0} />
  } }))
  const frame = () => {
    const current = sidebar()
    let node: Renderable | undefined = current?.node
    let region: Renderable | undefined
    // Public renderable ancestry provides the actual sidebar frame, including tabs.
    // Stop before leaving the right-hand native sidebar, never infer visibility.
    for (let depth = 0; node && depth < 16; depth++, node = node.parent ?? undefined) {
      if (node.width >= 34 && node.width <= 42 && node.x >= ctx.renderer.width / 2
        && node.x + node.width <= ctx.renderer.width && node.height > 0
        && node.y >= 0 && node.y + node.height <= ctx.renderer.height && !node.isDestroyed && node.visible) region = node
    }
    if (current && region && current.node !== region) setSidebar({ ...current, node: region })
    setGeometry(rootSession() && region ? { x: region.x, y: region.y, width: region.width, height: region.height } : undefined)
  }
  ctx.renderer.on(CliRenderEvents.FRAME, frame)
  life.addCleanup(() => {
    ctx.renderer.off(CliRenderEvents.FRAME, frame)
    setSidebar(undefined); setGeometry(undefined)
  })
  return { sidebar, geometry }
}
