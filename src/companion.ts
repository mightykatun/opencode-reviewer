import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { companionProtocol, companionRpc, sameLocation, type CompanionHandshake } from "./companion-protocol.js"
import type { PluginLifecycle } from "./plugin-lifecycle.js"

export async function setupCompanion(context: Plugin.Context, lifecycle: PluginLifecycle): Promise<CompanionHandshake> {
  const location = { directory: context.location.directory,
    ...(context.location.workspaceID ? { workspaceID: context.location.workspaceID } : {}) }
  const handshake: CompanionHandshake = {
    protocol: companionProtocol, hostVersion: context.app.version, epoch: randomUUID(), location,
    project: { ...context.location.project },
  }
  const registration = await context.rpc.register(companionRpc, {
    handshake: async (input, call) => {
      lifecycle.signal.throwIfAborted()
      call.signal.throwIfAborted()
      if (!sameLocation(input, location)) return call.error("scope", "Reviewer companion scope mismatch", {})
      return structuredClone(handshake)
    },
  })
  lifecycle.addCleanup(() => registration.dispose())
  lifecycle.signal.throwIfAborted()
  return handshake
}
