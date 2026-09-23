import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { createDirectory, folderName, projectDirectory } from "../../src/remote/directories"

test("blank project directory creates a named folder and repeated opening is idempotent", async () => {
  await using root = await tmpdir()
  const directory = await projectDirectory({ name: "Research 研究", directory: " " }, root.path)
  expect(directory).toBe(await fs.realpath(path.join(root.path, "Research 研究")))
  await fs.writeFile(path.join(directory, "keep.txt"), "keep")
  expect(await projectDirectory({ name: "Research 研究" }, root.path)).toBe(directory)
  expect(await fs.readFile(path.join(directory, "keep.txt"), "utf8")).toBe("keep")
})

test("explicit working folders stay in place and new folders never overwrite collisions", async () => {
  await using root = await tmpdir()
  const folder = await createDirectory(root.path, "Selected")
  expect(await projectDirectory({ directory: folder, name: "Different project name" }, root.path)).toBe(folder)
  await expect(createDirectory(root.path, "Selected")).rejects.toThrow()
  await fs.writeFile(path.join(root.path, "file"), "data")
  await expect(projectDirectory({ name: "file" }, root.path)).rejects.toThrow()
  await expect(projectDirectory({ directory: path.join(root.path, "missing"), name: "Unused" })).rejects.toThrow()
})

test("automatic folders reject path traversal and malformed names", () => {
  for (const name of ["", " ", ".", "..", "../outside", "a/b", "a\\b", "a\nb", "a\0b"]) {
    expect(() => folderName(name)).toThrow()
  }
  expect(folderName("  My research  ")).toBe("My research")
})
