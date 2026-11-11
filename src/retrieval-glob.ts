type State = { next: number[]; match?: (character: string) => boolean }
const segment = (character: string) => character !== "/"

/** Thompson-style matching visits each pattern state at most once per input
 * character. Braces branch without expanding strings; stars never backtrack.
 * Character-class regexes receive exactly one code unit, never a path. */
export function globMatcher(pattern: string, basenameOnly = false, withinBudget = () => true): (path: string) => boolean {
  const states: State[] = [], braces = new Map<number, number>(), stack: number[] = []
  const node = (next: number[] = [], match?: State["match"]) => states.push({ next, match }) - 1
  const classEnd = (at: number) => pattern.indexOf("]", at + 2)
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "[" && classEnd(i) >= 0) i = classEnd(i)
    else if (pattern[i] === "{") stack.push(i)
    else if (pattern[i] === "}") {
      const start = stack.pop()
      if (start !== undefined) braces.set(start, i)
    }
  }
  const compile = (from: number, to: number): { start: number; end: number } => {
    const start = node()
    let current = start
    const consume = (match: NonNullable<State["match"]>, repeat = false) => {
      const end = node()
      states[current]!.next.push(node([repeat ? current : end], match))
      if (repeat) states[current]!.next.push(end)
      current = end
    }
    for (let i = from; i < to; i++) {
      const character = pattern[i]!, close = braces.get(i)
      if (character === "{" && close !== undefined && close < to) {
        const end = node()
        let begin = i + 1
        for (let j = begin; j <= close; j++) {
          if (j === close || pattern[j] === ",") {
            const branch = compile(begin, j)
            states[current]!.next.push(branch.start)
            states[branch.end]!.next.push(end)
            begin = j + 1
          } else if (pattern[j] === "[" && classEnd(j) >= 0 && classEnd(j) < close) j = classEnd(j)
          else if (braces.has(j)) j = braces.get(j)!
        }
        current = end; i = close
      } else if (character === "*") {
        if (pattern[i + 1] !== "*" || i + 1 >= to) consume(segment, true)
        else if (pattern[i + 2] !== "/" || i + 2 >= to) {
          consume(value => !"\n\r\u2028\u2029".includes(value), true); i++
        } else {
          // **/ accepts zero segments, including an empty segment before '/'.
          const end = node(), part = node()
          states[current]!.next.push(end, part)
          states[part]!.next.push(node([part], segment), node([current], value => value === "/"))
          current = end; i += 2
        }
      } else if (character === "?") consume(segment)
      else if (character === "[" && classEnd(i) >= 0 && classEnd(i) < to) {
        const end = classEnd(i), body = pattern.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")
        const set = new RegExp(`^[${body}]$`)
        consume(value => set.test(value)); i = end
      } else consume(value => value === character)
    }
    return { start, end: current }
  }
  const { start, end } = compile(0, pattern.length)
  return path => {
    const text = basenameOnly ? path.slice(path.lastIndexOf("/") + 1) : path
    const seen = new Uint32Array(states.length)
    let generation = 0
    const closure = (queue: number[]) => {
      const live: number[] = []
      generation++
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i]!, state = states[id]!
        if (seen[id] === generation) continue
        seen[id] = generation
        if (state.match || id === end) live.push(id)
        else queue.push(...state.next)
      }
      return live
    }
    let live = closure([start])
    for (let i = 0; i < text.length && live.length; i++) {
      if (!(i & 63) && !withinBudget()) return false
      const next: number[] = []
      for (const id of live) if (states[id]!.match?.(text[i]!)) next.push(...states[id]!.next)
      live = closure(next)
    }
    return live.includes(end)
  }
}
