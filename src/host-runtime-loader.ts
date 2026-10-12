import { createRequire, isBuiltin } from "node:module"
import type { setupHostRuntime } from "./host-runtime.js"

declare const __HOST_RUNTIME__: string

type HostRuntime = { setupHostRuntime: typeof setupHostRuntime }
let runtime: Promise<HostRuntime> | undefined

/** Only the CLI resolves terminal modules, through the host's public imports.
 * The evaluated source is our fixed build output, never configuration or input. */
export function loadHostRuntime(): Promise<HostRuntime> {
  return runtime ??= (async () => {
    const [solid, core, renderer, rpc] = await Promise.all([
      import("solid-js"), import("@opentui/core"), import("@opentui/solid"), import("@opencode/plugin/rpc"),
    ])
    const modules = new Map<string, unknown>([
      ["solid-js", solid], ["@opentui/core", core], ["@opentui/solid", renderer], ["@opencode/plugin/rpc", rpc],
    ])
    const nativeRequire = createRequire(import.meta.url)
    const require = (name: string): unknown => {
      if (modules.has(name)) return modules.get(name)
      // No terminal package lookup, legacy SDK, private host import, or arbitrary
      // package fallback. Non-host dependencies are bundled at build time.
      if (isBuiltin(name)) return nativeRequire(name)
      throw new Error(`Unexpected host runtime dependency: ${name}`)
    }
    const module = { exports: {} as HostRuntime }
    // Keep embedded source opaque to host import rewriting. Only the real
    // public imports above are resolved by the host, not string data in our CJS.
    const source = Buffer.from(__HOST_RUNTIME__, "base64").toString("utf8")
    new Function("require", "module", "exports", source)(require, module, module.exports)
    if (typeof module.exports.setupHostRuntime !== "function") throw new Error("Host runtime setup unavailable")
    return module.exports
  })()
}
