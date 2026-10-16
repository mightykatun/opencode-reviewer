// Independent fixture wire contract. Keep closure-free for generated observers.
export function rpcDefinition() {
  const text = { type: "string", minLength: 1, maxLength: 16384 }
  const location = { type: "object", properties: { directory: text, workspaceID: text },
    required: ["directory"], additionalProperties: false }
  return { id: "opencode-reviewer", methods: {
    handshake: { input: location, output: { type: "object", properties: {
      protocol: { const: 1 }, hostVersion: text, epoch: { type: "string", format: "uuid" }, location,
      project: { type: "object", properties: { id: text, directory: text, canonical: text },
        required: ["id", "directory", "canonical"], additionalProperties: false },
    }, required: ["protocol", "hostVersion", "epoch", "location", "project"], additionalProperties: false },
    errors: { scope: { type: "object", properties: {}, additionalProperties: false } } },
    invocation: { input: { type: "object", properties: { location, epoch: text, sessionID: text, requestID: text },
      required: ["location", "epoch", "sessionID", "requestID"], additionalProperties: false },
    output: { anyOf: [{ type: "null" }, { type: "object", properties: {
      request: { type: "object" }, invocation: { type: "object" },
    }, required: ["request", "invocation"], additionalProperties: false }] },
    errors: { scope: { type: "object", properties: {}, additionalProperties: false } } },
  }, events: {} }
}
