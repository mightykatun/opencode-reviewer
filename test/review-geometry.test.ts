import assert from "node:assert/strict"
import { test } from "node:test"
import { reviewGeometry, ReviewGeometryProof, type ReviewRegion } from "../src/review-geometry.js"
import { SidebarPresentation } from "../src/review-presentation.js"

const region = (y: number, height: number, children: ReviewRegion[] = []): ReviewRegion => ({
  x: 120, y, width: 38, height, visible: true, isDestroyed: false, getChildren: () => children,
})
const layout = () => ({ width: 160, height: 40, fast: false,
  panel: { ...region(0, 40), x: 118, width: 42 }, heading: region(1, 1), rating: region(3, 1),
  report: region(5, 29), footer: region(35, 3, [region(37, 1)]),
})

test("normal presentation requires a usable report and actual on-screen footer descendants", () => {
  const input = layout()
  assert.equal(reviewGeometry(input), true)
  input.height = input.panel.height = 8
  input.report.height = 0
  input.footer = region(6, 3, [region(8, 1)])
  assert.equal(reviewGeometry(input), false, "wide but short layout cannot inherit earlier readiness")
  input.report.height = 1
  input.footer = region(6, 2, [region(8, 1)])
  assert.equal(reviewGeometry(input), false, "a fitting container cannot hide overflowing controls")
})

test("layout guards viewport edges, missing/destroyed elements, and wrapped control rows", () => {
  for (const key of ["heading", "rating", "report", "footer"] as const) {
    const input = layout()
    input[key].isDestroyed = true
    assert.equal(reviewGeometry(input), false, key)
  }
  const input = layout()
  input.footer = region(35, 4, [region(37, 1), region(38, 1)])
  assert.equal(reviewGeometry(input), true, "both wrapped rows fit")
  input.height = 38
  assert.equal(reviewGeometry(input), false)
  assert.equal(reviewGeometry({ ...layout(), report: undefined }), false)
  assert.equal(reviewGeometry({ ...layout(), width: 150 }), false)
})

test("fast presentation requires the heading and rating, without a final report or footer", () => {
  const input = { ...layout(), fast: true, report: undefined, footer: undefined }
  assert.equal(reviewGeometry(input), true)
  input.panel.height = input.height = 4
  assert.equal(reviewGeometry(input), true)
  input.rating.y = 4
  assert.equal(reviewGeometry(input), false)
})

test("same painted footer survives branch replacement only until its next layout", () => {
  const input = layout(), proof = new ReviewGeometryProof()
  assert.equal(proof.visible(input), false, "an unpainted layout cannot approve")
  assert.equal(proof.visible(input, true), true)
  input.footer.getChildren = () => [{ ...region(0, 0), width: 0 }]
  assert.equal(proof.visible(input), true, "Checking to Allowing replaces children before layout")
  assert.equal(proof.visible(input, true), false, "an actually painted invalid layout cannot retain old proof")
  input.footer.getChildren = () => [region(37, 1)]
  assert.equal(proof.visible(input, true), true)
  input.height = 39
  assert.equal(proof.visible(input), false, "viewport changes invalidate even when containers still fit")
  assert.equal(proof.visible(input, true), false)
  input.panel.height = 39
  assert.equal(proof.visible(input, true), true)
  input.footer = { ...input.footer }
  assert.equal(proof.visible(input), false, "new footer identity requires its own painted proof")
})

test("renewed geometry is pending, never visible, while proven clipping remains lost", () => {
  const input = layout(), proof = new ReviewGeometryProof()
  assert.equal(proof.state(input, true), "visible")
  input.width = 161
  assert.equal(proof.state(input), "pending")
  input.width = 120
  assert.equal(proof.state(input), "pending", "right-anchored old Yoga coordinates await the new frame")
  input.width = 40
  assert.equal(proof.state(input), "lost", "a 42-column panel cannot fit")
  input.width = 160; input.height = 8
  assert.equal(proof.state(input), "lost", "short viewport proves clipping even before renewed paint")
})

test("owner replacement and round-trip resize cannot reuse an earlier matching proof", () => {
  const input = { ...layout(), owner: Symbol() }, proof = new ReviewGeometryProof()
  assert.equal(proof.state(input, true), "visible")
  input.owner = Symbol()
  assert.equal(proof.state(input), "pending")
  assert.equal(proof.state(input, true), "visible")
  proof.invalidate()
  assert.equal(proof.state(input), "pending", "RESIZE out and back is still a renewed paint")
  assert.equal(proof.state(input, true), "visible")
})

test("public sidebar observer distinguishes breakpoint handoff from ordinary hide/navigation cleanup", () => {
  const sidebar = new SidebarPresentation()
  let owner = sidebar.mount("root", 160)
  sidebar.unmount(owner, "root", 120, false)
  assert.equal(sidebar.state("root"), "pending")
  const replacement = sidebar.mount("root", 120)
  sidebar.unmount(owner, "root", 120, false)
  assert.equal(sidebar.state("root"), "visible", "late cleanup cannot release the new owner")
  sidebar.unmount(replacement, "root", 160, false)
  assert.equal(sidebar.state("root"), "pending")
  sidebar.frame()
  assert.equal(sidebar.state("root"), "lost", "missing replacement at FRAME is a real hide")
  for (const [session, width, hidden] of [["root", 160, false], ["other", 120, false], ["root", 120, true]] as const) {
    owner = sidebar.mount("root", 160)
    sidebar.unmount(owner, session, width, hidden)
    assert.equal(sidebar.state("root"), "lost", "ordinary cleanup is immediate, without a microtask grace")
  }
})
