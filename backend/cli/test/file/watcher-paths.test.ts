import { describe, expect, test } from "bun:test"
import path from "node:path"
import { runtimeWatchIgnores } from "../../src/file/watcher-paths"

describe("runtime directories in project file watchers", () => {
  const root = path.resolve("research-project")
  const data = path.join(root, ".data", "onelab", "data")
  const config = path.join(root, ".data", "onelab", "config")
  test("excludes configured runtime directories even with custom names", () => {
    expect(runtimeWatchIgnores(root, [data, config, data])).toEqual([data, config])
  })
  test("retains explicit session scratch and managed project watches", () => {
    expect(runtimeWatchIgnores(path.join(data, "workspaces", "session"), [data, config])).toEqual([])
    expect(runtimeWatchIgnores(path.join(data, "projects", "research"), [data, config])).toEqual([])
  })
  test("does not exclude a sibling with a shared path prefix", () => {
    expect(runtimeWatchIgnores(root, [root + "-runtime", path.dirname(root), root])).toEqual([])
  })
})
