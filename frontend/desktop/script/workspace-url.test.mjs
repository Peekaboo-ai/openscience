import assert from "node:assert/strict"
import test from "node:test"
import { workspaceUrl } from "../src/workspace-url.mjs"

test("local workspace entry keeps desktop routing and native update capabilities", () => {
  const url = new URL(workspaceUrl("http://127.0.0.1:43819", { onboarding: "optional", updates: true }))
  assert.equal(url.origin, "http://127.0.0.1:43819")
  assert.equal(url.searchParams.get("desktop"), "1")
  assert.equal(url.searchParams.get("desktop-onboarding"), "optional")
  assert.equal(url.searchParams.get("desktop-update"), "1")
})

test("upstream launch still requires onboarding and does not advertise an unavailable updater", () => {
  for (const onboarding of [undefined, "required", "unknown"]) {
    const url = new URL(workspaceUrl("http://127.0.0.1:43819", { onboarding }))
    assert.equal(url.searchParams.get("desktop"), "1")
    assert.equal(url.searchParams.has("desktop-onboarding"), false)
    assert.equal(url.searchParams.has("desktop-update"), false)
  }
})
