import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { workspacesProfile } from "../src/workspaces-profile.mjs"

test("installed profiles use user storage, independent of inherited development paths", () => {
  const local = path.resolve("fixture-local")
  const profile = workspacesProfile({ LOCALAPPDATA: local, OPENSCIENCE_DATA_DIR: "/development/data" }, "/roaming")
  assert.equal(profile.root, path.join(local, "OpenScience Workspaces"))
  for (const value of Object.values(profile.environment)) assert.ok(value.startsWith(profile.root + path.sep))
  assert.notEqual(profile.environment.OPENSCIENCE_DATA_DIR, "/development/data")
  assert.equal(profile.userData, path.join(profile.root, "desktop"))
})

test("explicit isolated profiles preserve spaces and Unicode without touching the default profile", () => {
  const root = path.resolve("fixture 用户/isolated profile")
  const profile = workspacesProfile({ OPENSCIENCE_WORKSPACES_HOME: root }, "/roaming")
  assert.equal(profile.root, root)
  assert.equal(profile.logs, path.join(root, "logs"))
  assert.equal(profile.environment.OPENSCIENCE_CONFIG_DIR, path.join(root, "config"))
})
