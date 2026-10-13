import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"

const name = "__REVIEWER_HISTORY_WORKER__"
const prefix = `const ${name} = `

// Both compositions reference this production value, not an informational copy.
export const historyWorkerBanner = source => `${prefix}${JSON.stringify(source)};`

function nodesOf(ast) {
  const nodes = []
  const walk = node => {
    if (!node || typeof node !== "object") return
    if (node.type) nodes.push(node)
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "leadingComments", "trailingComments", "innerComments", "tokens"].includes(key)) continue
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === "object") walk(value)
    }
  }
  walk(ast.program)
  return nodes
}

function workerConsumer(nodes) {
  const bindings = nodes.filter(node => node.type === "VariableDeclarator" && /^historyWorkerSource\d*$/.test(node.id.name))
  assert.equal(bindings.length, 1, "Expected one production history worker default")
  const binding = bindings[0], value = binding.init
  assert.equal(value?.type, "ConditionalExpression", "Missing source-test fallback")
  assert.equal(value.test.type, "BinaryExpression")
  assert.equal(value.test.operator, "===")
  assert.equal(value.test.left.type, "UnaryExpression")
  assert.equal(value.test.left.operator, "typeof")
  assert.equal(value.test.left.argument.name, name)
  assert.equal(value.test.right.value, "string")
  assert.equal(value.consequent.name, name, "Worker default must use the shared source")
  assert.equal(value.alternate.value, "", "Direct source fallback must remain empty")

  const classes = nodes.filter(node => node.type === "VariableDeclarator" && /^HistoryWorker\d*$/.test(node.id.name))
  assert.equal(classes.length, 1, "Expected one production HistoryWorker")
  const constructor = classes[0].init?.body?.body.find(node => node.kind === "constructor")
  assert.ok(constructor, "Missing production worker constructor")
  assert.equal(constructor.params.length, 1)
  const parameter = constructor.params[0]
  assert.equal(parameter.type, "AssignmentPattern")
  assert.equal(parameter.right.name, binding.id.name, "Worker constructor must consume the inspected default")
  const writes = nodes.filter(node => node.type === "NewExpression" && node.start >= constructor.start && node.end <= constructor.end)
    .filter(node => node.callee.name === "Worker" || node.callee.property?.name === "Worker")
  assert.equal(writes.length, 1, "Expected one actual worker source consumer")
  assert.equal(writes[0].arguments[0]?.name, parameter.left.name, "Actual worker must receive its source parameter")
  assert.equal(writes[0].arguments[1]?.type, "ObjectExpression")
  const options = writes[0].arguments[1].properties
  assert.equal(options.find(node => node.key.name === "eval")?.value.value, true)
  assert.equal(options.find(node => node.key.name === "env")?.value.type, "ObjectExpression")
  assert.equal(options.find(node => node.key.name === "env").value.properties.length, 0)
  return binding.id.name
}

/** Read bundle bytes and AST only. Never evaluate package, terminal or worker code. */
export function verifyBundledHistoryWorker(bundle, expected) {
  const lines = bundle.split("\n").filter(line => line.startsWith(prefix))
  assert.equal(lines.length, 1, "Expected exactly one production history worker mapping")
  assert.ok(lines[0].endsWith(";"), "Invalid production worker declaration")
  const json = lines[0].slice(prefix.length, -1)
  const source = JSON.parse(json)
  assert.equal(typeof source, "string", "Worker source must be a fixed string")
  assert.ok(source.length > 0, "Worker source must not be empty")
  assert.equal(JSON.stringify(source), json, "Worker source must be canonical JSON")
  if (expected !== undefined) assert.equal(source, expected, "Bundled worker differs from the supplied source")

  // Resolve the validation toolchain from the checked-out package, including when
  // this helper itself comes from the active-policy sparse checkout.
  const { parseSync } = createRequire(path.resolve("package.json"))("@babel/core")
  const parse = (text, sourceType) => nodesOf(parseSync(text, { sourceType, babelrc: false, configFile: false }))
  const outer = parse(bundle, "module")
  const definitions = outer.filter(node => node.type === "VariableDeclarator" && node.id.name === name)
  assert.equal(definitions.length, 1, "Expected one fixed worker definition")
  assert.equal(definitions[0].init?.value, source)
  assert.equal(outer.filter(node => node.type === "StringLiteral" && node.value === source).length, 1,
    "Worker source must not be embedded twice")
  const exported = outer.filter(node => node.type === "ExportSpecifier" && node.exported.name === "historyWorkerSource")
  assert.equal(exported.length, 1, "Missing public worker source export")
  assert.equal(exported[0].local.name, workerConsumer(outer), "Public export must expose the actual worker default")

  const loaders = outer.filter(node => node.type === "NewExpression" && node.callee.name === "Function")
  assert.equal(loaders.length, 1, "Expected one fixed terminal loader")
  const loader = loaders[0]
  assert.deepEqual(loader.arguments.slice(0, -1).map(node => node.value),
    ["require", "module", "exports", "__REVIEWER_BUNDLED_SOUNDS__", name], "Loader arguments must stay fixed")
  const calls = outer.filter(node => node.type === "CallExpression" && node.callee === loader)
  assert.equal(calls.length, 1, "Missing actual terminal loader invocation")
  assert.equal(calls[0].arguments.length, 5)
  assert.equal(calls[0].arguments[3]?.name, "__REVIEWER_BUNDLED_SOUNDS__")
  assert.equal(calls[0].arguments[4]?.name, name, "Terminal must receive the exact shared worker reference")

  const payloads = outer.filter(node => node.type === "CallExpression" && node.callee.type === "MemberExpression"
    && node.callee.object.name === "Buffer" && node.callee.property.name === "from"
    && node.arguments[0]?.type === "StringLiteral" && node.arguments[1]?.value === "base64")
  assert.equal(payloads.length, 1, "Expected one fixed opaque terminal payload")
  const decode = outer.find(node => node.type === "CallExpression" && node.callee.object === payloads[0]
    && node.callee.property.name === "toString" && node.arguments[0]?.value === "utf8")
  const decoded = outer.find(node => node.type === "VariableDeclarator" && node.init === decode)
  assert.ok(decoded, "Terminal payload must decode to a fixed local source")
  assert.equal(loader.arguments.at(-1)?.name, decoded.id.name, "Loader must execute only the inspected payload")
  const terminal = Buffer.from(payloads[0].arguments[0].value, "base64").toString("utf8")
  assert.equal(Buffer.from(terminal).toString("base64"), payloads[0].arguments[0].value, "Invalid terminal encoding")
  const inner = parse(terminal, "script")
  assert.equal(inner.filter(node => node.type === "VariableDeclarator" && node.id.name === name).length, 0,
    "Terminal must not define another worker source")
  assert.ok(!inner.some(node => node.type === "StringLiteral" && node.value.includes(source)),
    "Terminal must not embed the worker body")
  workerConsumer(inner)
  return source
}
