import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"

const name = "__REVIEWER_HISTORY_WORKER__"
const prefix = `const ${name} = `

export const historyWorkerBanner = source => `${prefix}${JSON.stringify(source)};`
export const assertNoBundledHistoryWorker = bundle => assert.ok(!bundle.includes(name), "Unexpected history worker in bundle")

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
    .filter(node => /^Worker\d*$/.test(node.callee.name ?? "") || node.callee.property?.name === "Worker")
  assert.equal(writes.length, 1, "Expected one actual worker source consumer")
  assert.equal(writes[0].arguments.length, 2)
  assert.equal(writes[0].arguments[0]?.name, parameter.left.name, "Actual worker must receive its source parameter")
  assert.equal(writes[0].arguments[1]?.type, "ObjectExpression")
  const options = writes[0].arguments[1].properties
  assert.deepEqual(options.map(node => node.key?.name).sort(), ["env", "eval"])
  assert.ok(options.every(node => node.type === "ObjectProperty" && !node.computed))
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
  const nodes = nodesOf(parseSync(bundle, { sourceType: "module", babelrc: false, configFile: false }))
  const definitions = nodes.filter(node => node.type === "VariableDeclarator" && node.id.name === name)
  assert.equal(definitions.length, 1, "Expected one fixed worker definition")
  assert.equal(definitions[0].init?.value, source)
  assert.equal(nodes.filter(node => node.type === "StringLiteral" && node.value === source).length, 1,
    "Worker source must not be embedded twice")
  const exported = nodes.filter(node => node.type === "ExportSpecifier" && node.exported.name === "historyWorkerSource")
  assert.equal(exported.length, 1, "Missing public worker source export")
  assert.equal(exported[0].local.name, workerConsumer(nodes), "Public export must expose the actual worker default")

  return source
}
