import path from "node:path"
import type { FileEvidence, Limits, SkillContext, SkillEvidence } from "./types.js"
import { boundedCopy } from "./tool-evidence.js"
import { captureFile, withinDirectory } from "./evidence.js"
import { FileLimit, omittedFile } from "./files.js"
import { fileAccess, type FileScope } from "./file-access.js"
import { reviewStage } from "./deadline.js"

/** Decode only literal shell words, atomically. Adjacent quoted/unquoted pieces
 * belong to one argument. This never interprets expansions or shell controls. */
function commandTokens(text: string, check: () => boolean, maxTokens: number) {
  const parts: string[] = []
  let value = "", quote = "", active = false
  const unsupported = { limitation: "Unsupported shell syntax in a skill command was not resolved; the whole command was omitted." }
  for (let cursor = 0; cursor < text.length; cursor++) {
    if (!check()) return undefined
    const char = text[cursor]!
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(char)) return unsupported
    if (quote === "'") {
      if (char === "'") quote = ""
      else value += char
    } else if (char === "\\") {
      const next = text[++cursor]
      if (next === undefined || /[\u0000-\u001f\u007f]/.test(next)) return unsupported
      // In double quotes, backslashes before ordinary characters stay literal.
      value += quote === '"' && !/["\\$`]/.test(next) ? `\\${next}` : next
      active = true
    } else if (quote === '"') {
      if (char === '"') quote = ""
      else if (char === "$" || char === "`") return unsupported
      else value += char
    } else if (char === " " || char === "\t") {
      if (active) {
        if (parts.length >= maxTokens) return undefined
        parts.push(value); value = ""; active = false
      }
    } else if (char === "'" || char === '"') {
      quote = char; active = true
    } else {
      if (/[|&;<>()[\]{}$`*?~#]/.test(char) || (char === "!" && !active)) return unsupported
      value += char; active = true
    }
    if (value.length > 4096) return { limitation: "Skill command exceeded the literal argument length limit; the whole command was omitted." }
  }
  if (quote) return unsupported
  if (active) {
    if (parts.length >= maxTokens) return undefined
    parts.push(value)
  }
  return { parts }
}

/** Literal references in main instructions only. No directory walks, expansion,
 * execution, external retrieval or recursive reading of supporting files. */
export function skillReferences(text: string, signal: AbortSignal) {
  const references = new Set<string>(), limitations = new Set<string>()
  const end = performance.now() + 250
  let tokens = 0, steps = 0
  const check = () => {
    reviewStage(signal, "Skill reference discovery")
    return ++steps <= 16 * 1024 * 1024 && performance.now() < end
  }
  const add = (raw: string, origin: "prose" | "literal" | "link") => {
    if (++tokens > 16384 || references.size >= 256 || !check()) return false
    // Quoting is part of the reference syntax, not permission to rewrite the
    // filename. In particular `notes.md!` must not select notes.md.
    let value = origin === "literal" ? raw : raw.trim()
    if (origin === "link") {
      if (value.startsWith("<") && !value.includes(">")) { limitations.add("An invalid skill file link was not resolved."); return true }
      value = value.startsWith("<") ? value.slice(1, value.indexOf(">")) : value.split(/\s+["']/)[0]!
      if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//") || value.startsWith("#")) return true
      value = value.split("#", 1)[0]!
      try { value = decodeURIComponent(value) } catch { limitations.add("An invalid encoded skill file reference was not resolved."); return true }
    } else if (origin === "prose") value = value.replace(/[,;:.!]$/, "")
    if (!value || value.endsWith("/")) return true
    const literalPath = value.includes("/") || /\.(?:mdx?|txt|rst|py|sh|bash|zsh|js|mjs|cjs|ts|tsx|json|ya?ml|toml|ini|cfg|conf|sql|xml|html|css|csv|ipynb|go|rs|rb|ps1|bat|wasm|so|exe)[,;:.!]*$/i.test(value)
    if (origin !== "link" && !literalPath) return true
    if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) return true
    if (value.length > 4096 || /[\u0000-\u001f\u007f$*?{}\\]/.test(value) || value.startsWith("~")) {
      limitations.add("Dynamic, globbed or invalid skill file references were not resolved."); return true
    }
    references.add(value)
    return true
  }
  let exhausted = false
  // Consume balanced constructs before looking for bare words. Unsupported link
  // syntax is one omitted construct, never a source of plausible suffix paths.
  const balanced = (start: number, open: string, close: string) => {
    let depth = 1, unsupported = false, cursor = start + 1
    for (; cursor < text.length; cursor++) {
      if (!check()) { exhausted = true; break }
      const char = text[cursor]
      if (char === "\\") { unsupported = true; cursor++; continue }
      if (char === open) { depth++; unsupported = true }
      else if (char === close && --depth === 0) return { end: cursor + 1, unsupported }
      if (char === "\r" || char === "\n" || (open === "(" && (char === "[" || char === "]"))) unsupported = true
    }
    return { end: text.length, unsupported: true }
  }
  for (let cursor = 0; cursor < text.length && !exhausted;) {
    if (!check()) { exhausted = true; break }
    const char = text[cursor]!
    if (char === "[") {
      const label = balanced(cursor, "[", "]")
      if (exhausted) break
      if (text[label.end] !== "(") { cursor = label.end; continue }
      const destination = balanced(label.end, "(", ")")
      if (exhausted) break
      if (label.unsupported || destination.unsupported) limitations.add("Unsupported Markdown skill link was not resolved; the whole link was omitted.")
      else exhausted = !add(text.slice(label.end + 1, destination.end - 1), "link")
      cursor = destination.end
    } else if (char === "`" || char === '"' || char === "'") {
      // Apostrophes inside prose words do not begin quoted filenames.
      if (char === "'" && /[\p{L}\p{N}]/u.test(text[cursor - 1] ?? "")) { cursor++; continue }
      const opening = cursor++
      // Matching Markdown backtick runs keep nested shell backticks inside the
      // same span, where unsupported substitutions can be omitted as a whole.
      while (char === "`" && text[cursor] === char) {
        if (!check()) { exhausted = true; break }
        cursor++
      }
      const width = cursor - opening, start = cursor
      let close = -1
      while (cursor < text.length && !exhausted) {
        if (!check()) { exhausted = true; break }
        if (text[cursor] !== char) { cursor++; continue }
        const run = cursor++
        while (char === "`" && text[cursor] === char) {
          if (!check()) { exhausted = true; break }
          cursor++
        }
        if (cursor - run === width) { close = run; break }
      }
      if (exhausted) break
      if (close === -1) { limitations.add("Unclosed quoted skill reference was not resolved."); break }
      const quoted = text.slice(start, close)
      // Validate the entire recognized command before publishing any references;
      // unsupported syntax must never leave a plausible prefix/suffix file behind.
      const command = char === "`" && /^(?:(?:python(?:\d+(?:\.\d+)*)?|node|bun|deno|bash|sh|zsh|cat|head|source|uv|npx|git)\s|[^\s]+\.(?:py|sh|bash|js|mjs|ts)\s|\.{1,2}\/[^\s]+\s+--)/.test(quoted)
      if (command) {
        const parsed = commandTokens(quoted, check, 16384 - tokens)
        if (!parsed) exhausted = true
        else if ("limitation" in parsed) limitations.add(parsed.limitation)
        else for (const part of parsed.parts) {
          if (!add(part, "literal")) { exhausted = true; break }
        }
      } else exhausted = !add(quoted, "literal")
    } else if (/[\s<>()[\]{}]/.test(char)) cursor++
    else {
      const start = cursor++
      const url = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(text.slice(start, start + 128))
      while (cursor < text.length && !(url ? /[\s`"'<>]/ : /[\s`"'<>()[\]{}]/).test(text[cursor]!)) {
        if (!check()) { exhausted = true; break }
        cursor++
      }
      if (!exhausted) exhausted = !add(text.slice(start, cursor), "prose")
    }
  }
  if (exhausted) limitations.add("Skill reference discovery reached its bounded work limit; additional references were not inspected.")
  return { references: [...references], limitations: [...limitations] }
}

export async function collectSkillEvidence(context: SkillContext, limits: Limits, signal: AbortSignal,
  scope: FileScope = fileAccess.scope(signal)): Promise<SkillEvidence> {
  reviewStage(signal, "Skill evidence collection")
  const skill = context.skill
  if (typeof skill?.content === "string" && skill.content.length > limits.maxEvidenceBytes) throw new Error("Complete skill instructions exceed configured evidence byte budget")
  if (!skill || typeof skill.name !== "string" || skill.name !== context.input.name || typeof skill.content !== "string"
    || !skill.content.trim() || skill.content.includes("\0") || typeof skill.location !== "string" || !skill.location
    || (skill.description !== undefined && typeof skill.description !== "string")) throw new Error("Complete host skill definition unavailable")
  const mandatory = boundedCopy({ tool: context.tool, input: context.input, permission: context.permission,
    skill: { name: skill.name, location: skill.location, content: skill.content,
      ...(skill.description === undefined ? {} : { description: skill.description }) } }, limits.maxEvidenceBytes)
  const discovery = skillReferences(skill.content, signal)
  const limitations = [...context.limitations,
    "Skill instructions are the host catalog snapshot. Only directly referenced local supporting files within the skill directory are inspected; directories, further references, imports and external URLs are not followed. No instructions or scripts were executed.",
    ...discovery.limitations]
  if (!context.userPrompt) limitations.push("User prompt unavailable.")
  let remaining = limits.maxEvidenceBytes - mandatory.bytes
  // The main catalog-supplied skill counts as one file, without rereading SKILL.md.
  const limit = new FileLimit(Math.max(0, limits.maxFiles - 1), scope)
  const files: FileEvidence[] = [], seen = new Set<string | symbol>()
  const base = path.isAbsolute(skill.location) && !skill.location.includes("\0") ? path.dirname(skill.location) : undefined
  const canonical = base && discovery.references.length ? await scope.canonical(base) : undefined
  // Compare verified filesystem paths without loading the main instructions
  // again. Lexical equality can hide a different file behind link/../SKILL.md.
  const main = canonical?.path ? await scope.canonical(skill.location) : undefined
  if (discovery.references.length && !canonical?.path) limitations.push("Local skill directory unavailable; supporting files were not read.")
  if (canonical?.path && !main?.path) limitations.push(`Main skill file identity unavailable (${main?.reason}); supporting files were not read.`)
  for (const filename of discovery.references) {
    reviewStage(signal, "Skill supporting files")
    const declared = base ? path.isAbsolute(filename) ? filename : `${base}/${filename}` : undefined
    let file: FileEvidence = { filename, ...(declared ? { path: declared } : {}), status: "local skill directory unavailable" }
    if (base && declared && canonical?.path) {
      if (!withinDirectory(base, declared)) file.status = "outside the skill directory; contents not provided"
      else if (!main?.path) file.status = "main skill file identity unavailable; contents not provided"
      else {
        const target = await scope.canonical(declared)
        if (target.path === main.path) continue
        const { key, withinLimit } = await limit.consider(declared, signal)
        if (seen.has(key)) continue
        seen.add(key)
        file = withinLimit ? await captureFile({ filename, cwd: base, executable: false }, remaining, signal, scope, canonical.path, main.path)
          : { ...file, status: "file-count limit reached" }
      }
    }
    if (file.contents === undefined) file.warning = omittedFile(file.path ?? filename)
    else remaining -= Buffer.byteLength(file.contents)
    files.push(file)
  }
  signal.throwIfAborted()
  limitations.push(...limit.limitations)
  return { ...context, ...mandatory.value, files, partial: discovery.limitations.length > 0 || files.some(file => file.contents === undefined), limitations }
}
