import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { DeadlineError } from "../src/deadline.js"
import { httpFailure, networkFailure } from "../src/transport-retry.js"
import { forbiddenErrorPunctuation, reviewFailureMessages, reviewFailureText, reviewStageLabels } from "../src/review-failure-text.js"
import { uiText } from "../src/ui-text.js"

const failures = uiText.review.failures, stages = uiText.review.stages
const source = readdirSync(new URL("../src/", import.meta.url))
  .filter(name => /\.tsx?$/.test(name) && name !== "ui-text.ts" && name !== "review-failure-text.ts")
  .map(name => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")).join("\n")

test("every mapped internal message and stage label is still produced by the source", () => {
  for (const message of reviewFailureMessages.keys()) assert.ok(source.includes(JSON.stringify(message)), message)
  for (const stage of reviewStageLabels.keys()) assert.ok(source.includes(JSON.stringify(stage)), stage)
  assert.ok(source.includes("`Reviewer HTTP ${response.status}`"))
  assert.ok(source.includes("`API key environment variable ${config.apiKeyEnv} is unset or empty`"))
})

test("every fixed failure and stage copy entry has an internal source", () => {
  const fixed = Object.keys(failures).filter(key => typeof failures[key as keyof typeof failures] === "string")
  assert.deepEqual([...new Set(reviewFailureMessages.values())].sort(), fixed.sort())
  assert.deepEqual([...new Set(reviewStageLabels.values())].sort(), Object.keys(stages).sort())
})

test("review failures display their interface copy", () => {
  for (const [message, key] of reviewFailureMessages) assert.equal(reviewFailureText(new Error(message)), failures[key])
  assert.equal(reviewFailureText(httpFailure(new Response(null, { status: 503 }))), failures.http(503))
  assert.equal(reviewFailureText(httpFailure(new Response(null, { status: 401 }))), failures.http(401))
  assert.equal(reviewFailureText(networkFailure(new TypeError("PRIVATE"), "Reviewer network request failed")), failures.network)
  assert.equal(reviewFailureText(new Error("API key environment variable REVIEW_KEY is unset or empty")), failures.apiKeyMissing("REVIEW_KEY"))
  assert.equal(reviewFailureText(new Error(uiText.review.evidenceUnavailable)), uiText.review.evidenceUnavailable)
})

test("deadlines display the mapped stage, and unknown stages keep their label", () => {
  for (const [label, key] of reviewStageLabels) assert.equal(reviewFailureText(new DeadlineError(label)), failures.timedOut(stages[key]))
  assert.equal(reviewFailureText(new DeadlineError("Pending invocation lookup")), failures.timedOut("Pending invocation lookup"))
})

test("interface text contains no em dashes, semicolons or middle dots, except graphics", () => {
  const graphics = new Set<unknown>([uiText.review.staticIndicator, uiText.review.scanner])
  // Every formatter runs with each sample in all parameters, covering both sides of its branches.
  const samples: unknown[] = [true, false, 0, 1, 2, "Sample", undefined, "conversation", "lifetime"]
  const texts: string[] = []
  const collect = (value: unknown): void => {
    if (graphics.has(value)) return
    if (typeof value === "string") texts.push(value)
    else if (typeof value === "function") for (const sample of samples) texts.push(String(value(...Array(value.length).fill(sample))))
    else if (value && typeof value === "object") Object.values(value).forEach(collect)
  }
  collect(uiText)
  assert.ok(texts.length > 150)
  for (const text of texts) assert.doesNotMatch(text, forbiddenErrorPunctuation, text)
  for (const message of reviewFailureMessages.keys()) assert.doesNotMatch(reviewFailureText(new Error(message)), forbiddenErrorPunctuation)
})

test("host error text is shown without em dashes, semicolons or middle dots", () => {
  assert.equal(reviewFailureText(new Error("Server unavailable — retry later")), "Server unavailable, retry later")
  assert.equal(reviewFailureText(new Error("Request failed; status 500")), "Request failed, status 500")
  assert.equal(reviewFailureText(new Error("Session · permission missing")), "Session, permission missing")
  assert.equal(reviewFailureText(new Error("Trailing;")), "Trailing")
  assert.equal(reviewFailureText(new Error("—;·")), uiText.review.failed)
  assert.equal(reviewFailureText(new DeadlineError("Host—lookup")), failures.timedOut("Host, lookup"))
})

test("unrecognized failures keep their message and empty ones fall back", () => {
  assert.equal(reviewFailureText(new Error("Host client error")), "Host client error")
  assert.equal(reviewFailureText(new Error("")), uiText.review.failed)
  assert.equal(reviewFailureText("not an error"), uiText.review.failed)
  assert.equal(reviewFailureText(undefined), uiText.review.failed)
})
