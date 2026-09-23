import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { discoverRuntimeRoots } from "../../src/sandbox/runtime-roots"
import { tmpdir } from "../fixture/fixture"

test("custom Conda prefixes expose stdlib and metadata, not the surrounding home or other environments", async () => {
  await using tmp = await tmpdir()
  const prefix = path.join(tmp.path, "custom-runtime")
  for (const part of [
    "bin",
    "lib",
    "conda-meta",
    "envs/other/conda-meta",
    "envs/other/bin",
    "envs/other/lib",
    "envs/other/etc/conda",
  ])
    await fs.mkdir(path.join(prefix, part), { recursive: true })
  const history = path.join(prefix, "envs/other/conda-meta/history")
  await fs.writeFile(history, "installed")
  const roots = discoverRuntimeRoots({ PATH: path.join(prefix, "bin"), CONDA_PREFIX: prefix })
  expect(roots).toContain(path.join(prefix, "lib"))
  expect(roots).toContain(path.join(prefix, "conda-meta"))
  expect(roots).toContain(history)
  expect(roots).not.toContain(prefix)
  expect(roots).not.toContain(path.join(prefix, "envs"))
  expect(roots).not.toContain(tmp.path)
  expect(roots).not.toContain(path.join(prefix, "envs/other/lib"))
  const terminal = discoverRuntimeRoots({ PATH: path.join(prefix, "bin") }, [], { condaEnvironments: true })
  expect(terminal).toContain(path.join(prefix, "envs/other/lib"))
  expect(terminal).toContain(path.join(prefix, "envs/other/etc/conda"))
  expect(terminal).not.toContain(path.join(prefix, "envs/other"))
  expect(terminal).not.toContain(tmp.path)
})

test("versioned scheduler installs expose sibling libraries through directory aliases", async () => {
  await using tmp = await tmpdir()
  const prefix = path.join(tmp.path, "scheduler-v1")
  await fs.mkdir(path.join(prefix, "bin"), { recursive: true })
  await fs.mkdir(path.join(prefix, "lib/slurm"), { recursive: true })
  const alias = path.join(tmp.path, "scheduler")
  await fs.symlink(prefix, alias, process.platform === "win32" ? "junction" : "dir")
  const roots = discoverRuntimeRoots({ PATH: path.join(alias, "bin") })
  expect(roots).toContain(path.join(prefix, "lib"))
  expect(roots).toContain(path.join(alias, "lib"))
  expect(roots).not.toContain(tmp.path)
})

test("ambiguous and broad library paths never grant home or filesystem access", () => {
  const roots = discoverRuntimeRoots({
    PATH: "relative",
    LD_LIBRARY_PATH: [os.homedir(), path.parse(os.homedir()).root, ".", ""].join(path.delimiter),
  })
  expect(roots).toEqual([])
})
