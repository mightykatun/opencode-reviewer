/** Reviewer-owned native request, invocation and evidence data. */
export type JSONValue = null | boolean | number | string | readonly JSONValue[] | JSONObject
export interface JSONObject { readonly [key: string]: JSONValue }

export interface HostLocation {
  readonly directory: string
  readonly workspaceID?: string
}

/** A connected companion epoch, never persistent deletion authority. */
export interface HostScope {
  readonly location: HostLocation
  readonly epoch: string
}

export interface HostRequest {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
  readonly save?: readonly string[]
  readonly metadata?: JSONObject
  readonly source?: { readonly assistantID: string; readonly id: string }
  readonly message?: string
}

export interface HostInvocation {
  readonly sessionID: string
  readonly assistantID: string
  readonly callID: string
  readonly tool: string
  readonly input: JSONObject
  readonly location: HostLocation
  readonly project: { readonly id: string; readonly directory: string; readonly canonical: string }
  readonly epoch: string
}

export interface HostRequestSnapshot {
  readonly request: HostRequest
  readonly scope: HostScope
}
