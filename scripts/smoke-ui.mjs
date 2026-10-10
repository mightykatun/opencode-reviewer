import { setTimeout as sleep } from "node:timers/promises"

// Interpret only SGR rendition. tmux -e captures text and colors without issuing
// terminal commands. The selected command must have a distinct, painted background.
export function renditionRows(ansi) {
  let background
  return ansi.split("\n").map(line => {
    let text = ""
    const backgrounds = []
    for (const token of line.matchAll(/\x1b\[[\d;]*m|\x1b\][^\x07]*(?:\x07)|[^\x1b]/gu)) {
      if (token[0].startsWith("\x1b[")) {
        const codes = token[0].slice(2, -1).split(";").map(Number)
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i]
          if (code === 0 || code === 49) background = undefined
          else if (code === 48 && codes[i + 1] === 2) { background = codes.slice(i + 2, i + 5).join(","); i += 4 }
          else if (code === 48 && codes[i + 1] === 5) { background = `index:${codes[i + 2]}`; i += 2 }
          else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) background = `ansi:${code}`
          else if (code === 38 && codes[i + 1] === 2) i += 4
          else if (code === 38 && codes[i + 1] === 5) i += 2
        }
      } else if (!token[0].startsWith("\x1b")) {
        text += token[0]
        backgrounds.push(...Array(token[0].length).fill(background))
      }
    }
    return { text, backgrounds }
  })
}

export function selectedPaletteResult(ansi, title) {
  const lines = renditionRows(ansi)
  if (!lines.some(row => row.text.includes("Commands"))) return false
  const matches = lines.map((row, index) => ({ ...row, index, at: row.text.indexOf(title) })).filter(row => row.at >= 0)
  if (matches.length < 2) return false
  const input = matches[0]
  return matches.slice(1).some(row => {
    // Exact result title; the host may append a shortcut after multiple spaces.
    const after = row.text.slice(row.at + title.length)
    if (after.trim() && !/^\s{2,}/.test(after)) return false
    const background = row.backgrounds[row.at]
    return background !== undefined && background !== input.backgrounds[input.at]
      && row.backgrounds.slice(row.at, row.at + title.length).every(value => value === background)
  })
}

/** Real keystrokes, selected result proof, then a caller-owned behavioral postcondition. */
export async function activatePalette({ send, capture, timeoutMs = 20000, intervalMs = 80 }, title, postcondition) {
  if (typeof postcondition !== "function") throw new Error("Palette activation requires a postcondition")
  const wait = async (phase, predicate) => {
    const end = Date.now() + timeoutMs
    let screen
    do {
      screen = await capture()
      if (await predicate(screen)) return
      await sleep(intervalMs)
    } while (Date.now() < end)
    throw new Error(`Palette ${phase} timed out for ${JSON.stringify(title)}\n${screen}`)
  }
  send("C-p")
  await wait("opening", screen => screen.includes("Commands"))
  send("C-u"); send("-l", title)
  await wait("selected result", screen => selectedPaletteResult(screen, title))
  send("Enter")
  await wait("postcondition", screen => !screen.includes("Commands") && postcondition(screen.replace(/\x1b\[[\d;]*m/g, "")))
}
