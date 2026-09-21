import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"

type Record = { revision: number; message: string }

test("publishes and updates run records whose staging paths exceed Windows MAX_PATH", async () => {
  const prefix = ["runtime_run", `prj_${crypto.randomUUID().replaceAll("-", "")}`, "a".repeat(64)]
  const key = [...prefix, `run_${"b".repeat(64)}`]
  const target = path.join(Global.Path.data, "storage", ...key) + ".json"
  expect(`${target}.${process.pid}.${crypto.randomUUID()}.tmp`.length).toBeGreaterThan(260)
  try {
    await Storage.write(key, { revision: 1, message: "hello" })
    expect(await Storage.read<Record>(key)).toEqual({ revision: 1, message: "hello" })
    await Storage.update<{ revision: number }>(key, (record) => {
      record.revision++
    })
    expect(await Storage.read<Record>(key)).toEqual({ revision: 2, message: "hello" })
    await Storage.upsert<{ revision: number; message: string }>(key, (record) => ({ ...record!, revision: 3 }))
    expect(await Storage.list(prefix)).toEqual([key])
    expect(await Storage.read<Record>(key)).toEqual({ revision: 3, message: "hello" })
    await Storage.remove(key)
    expect(await Storage.list(prefix)).toEqual([])
    expect(await fs.readdir(path.dirname(target))).toEqual([])
  } finally {
    await fs.rm(path.join(Global.Path.data, "storage", ...prefix.slice(0, 2)), { recursive: true, force: true })
  }
})
