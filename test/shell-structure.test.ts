import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { shellStructure, UNRESOLVED, type ShellToken } from "../src/shell-structure.js"

const scan = (command: string) => shellStructure(command, () => {})
const word = (value: string, nested: string[] = []): ShellToken => ({ kind: "word", value, nested })
const op = (value: string): ShellToken => ({ kind: "op", value })

test("separators, group tokens, ordinary comments, and continuation", () => {
  assert.deepEqual(scan("{ echo one; ( echo two && echo three ) || echo four | cat; }\npython job.py").tokens,
    [op("{"), word("echo"), word("one"), op(";"), op("("), word("echo"), word("two"), op("&&"),
      word("echo"), word("three"), op(")"), op("||"), word("echo"), word("four"), op("|"),
      word("cat"), op(";"), op("}"), op(";"), word("python"), word("job.py")])
  assert.deepEqual(scan("echo ab\\\ncd # ; python ghost.py\npython real.py").tokens,
    [word("echo"), word("abcd"), op(";"), word("python"), word("real.py")])
  assert.deepEqual(scan("echo 'literal#hash' \\#hash").tokens, [word("echo"), word("literal#hash"), word("#hash")])
})

test("shell-quote decodes literal words without turning escaped globs into expansion", () => {
  const operands = [String.raw`a\ b`, String.raw`a\*b`, String.raw`a\?b`, "'a*b'", '"a b"', "''", String.raw`\$HOME`, "'2'", String.raw`\2`]
  const values = ["a b", "a*b", "a?b", "a*b", "a b", "", "$HOME", "2", "2"]
  assert.deepEqual(scan(`printf %s ${operands.join(" ")}`).tokens, [word("printf"), word("%s"), ...values.map(v => word(v))])
  // These fixed harmless Bash probes independently check byte-faithful literals.
  for (let i = 0; i < operands.length; i++) {
    const output = execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", `printf '%s' ${operands[i]}`],
      { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 2000 })
    assert.deepEqual(output, Buffer.from(values[i]!), operands[i])
  }
})

test("variables, globs, nested substitution source, and quoted literal substitutions", () => {
  assert.deepEqual(scan('echo a$HOME/b "${HOME}/x" *.py foo?bar $(cat "x y") `printf ok` "$(printf y)"').tokens,
    [word("echo"), word(`a${UNRESOLVED}/b`), word(`${UNRESOLVED}/x`), word(UNRESOLVED),
      word(UNRESOLVED), word(UNRESOLVED, ['cat "x y"']), word(UNRESOLVED, ["printf ok"]),
      word(UNRESOLVED, ["printf y"])])
  assert.deepEqual(scan("echo '$(not executed)' \\`also-not-executed\\` $(echo \"$(printf nested)\")").tokens,
    [word("echo"), word("$(not executed)"), word("`also-not-executed`"),
      word(UNRESOLVED, ['echo "$(printf nested)"'])])
  assert.equal(scan('echo pre$(cat one; echo two)post').tokens[1]?.kind, "word")
  assert.deepEqual(scan('echo pre$(cat one; echo two)post').tokens[1], word(`pre${UNRESOLVED}post`, ["cat one; echo two"]))
  assert.deepEqual(scan('echo "${x:-$(printf hi)}"').tokens,
    [word("echo"), word(UNRESOLVED, ["printf hi"])])
  assert.deepEqual(scan("echo ~/file '~' \\~ X=~user").tokens,
    [word("echo"), word(`${UNRESOLVED}/file`), word("~"), word("~"), word(`X=${UNRESOLVED}user`)])
})

test("ambiguous substitution delimiters cannot expose apparent shell statements", () => {
  for (const command of [
    'node "$(echo ${v:-)}; node decoy.js)" < config.json',
    'node "${v:-"}; node decoy.js"}" < config.json',
    'node `printf "a` ; node decoy.js` < config.json',
  ]) {
    const result = scan(command)
    assert.deepEqual(result.tokens, [], command)
    assert.ok(result.limitations.length, command)
  }
})

test("redirections bind adjacent IO numbers, preserve targets, and never expose targets as statements", () => {
  assert.deepEqual(scan("2>out '2'>out \\2>>out 0<input echo <<< '$HOME' >\"a b\"").tokens,
    [{ kind: "redirect", operator: "2>", target: "out" }, word("2"),
      { kind: "redirect", operator: ">", target: "out" }, word("2"),
      { kind: "redirect", operator: ">>", target: "out" },
      { kind: "redirect", operator: "0<", target: "input" }, word("echo"),
      { kind: "redirect", operator: "<<<", target: "$HOME", quoted: true },
      { kind: "redirect", operator: ">", target: "a b" }])
  assert.deepEqual(scan('echo >$(printf file)').tokens,
    [word("echo"), { kind: "redirect", operator: ">", target: UNRESOLVED, nested: ["printf file"] }])
})

test("closed heredocs attach bodies without parsing their shell-looking contents", () => {
  assert.deepEqual(scan("cat <<'EOF' <<-TAB\npython decoy.py; $(run)\nEOF\n\tbad | text\n\tTAB\npython real.py").tokens,
    [word("cat"), { kind: "redirect", operator: "<<", target: "EOF", quoted: true,
      body: "python decoy.py; $(run)\n" },
    { kind: "redirect", operator: "<<-", target: "TAB", quoted: false, body: "\tbad | text\n" },
    op(";"), word("python"), word("real.py")])
  assert.deepEqual(scan("cat <<EOF\nnot closed\n").tokens, [])
  assert.match(scan("cat <<EOF\nnot closed\n").limitations.join(" "), /heredoc/)
  let calls = 0
  assert.equal(shellStructure(`cat <<EOF\n${"x".repeat(32768)}\nEOF`, () => { calls++ }).tokens.length, 3)
  assert.ok(calls >= 9, String(calls))
})

test("ambiguous forms fail closed without partial tokens", () => {
  const commands = ["echo okay; echo $'\\xff'", "echo a\u00a0b", "echo a\\\u00a0b", "echo a[bc]", "echo a{b,c}",
    "echo a#b", "echo okay; echo 'unterminated", "echo $(broken", "echo `broken", "echo $((1+2))",
    "echo hi & python decoy.py", "echo ok |& cat", "cat <(echo hi)", "cat <<$DELIM\nbody\n",
    "echo ${x:-$'\\xff'}"]
  for (const command of commands) {
    const result = scan(command)
    assert.deepEqual(result.tokens, [], command)
    assert.ok(result.limitations.length > 0, command)
  }
})

test("input and callback budgets bound lexical work", () => {
  assert.deepEqual(scan("x".repeat(65537)).tokens, [])
  assert.match(scan("x".repeat(65537)).limitations.join(" "), /limit/)
  let calls = 0
  assert.equal(shellStructure("x".repeat(32768), () => { calls++ }).tokens.length, 1)
  assert.ok(calls >= 9, String(calls))
  assert.throws(() => shellStructure("a".repeat(8192), () => { throw new Error("stopped") }), /stopped/)
})
