export const editTools = new Set(["write", "edit", "patch"])
export const directoryTools = new Set(["shell", "write", "edit", "patch", "read", "glob", "grep"])
export const nativeTools = new Set([...directoryTools, "skill", "execute", "search", "question", "subagent", "lsp", "webfetch", "websearch", "todowrite", "todoread"])

/** The judge's uncertain-linkage path is for registered-tool permissions.
 * Native operation categories retain their existing evidence requirements. */
export const codeModeToolAction = (action: string) => !nativeTools.has(action) && action !== "external_directory"
