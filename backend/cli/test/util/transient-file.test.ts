import { expect, test } from "bun:test"
import { transientFile } from "../../src/util/transient-file"

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`temporary ${code} can recover without changing the operation`, async () => {
    let calls = 0
    const result = await transientFile(
      async () => {
        if (++calls < 3) throw Object.assign(new Error("shared handle"), { code })
        return "published"
      },
      { delays: [0, 0] },
    )
    expect(result).toBe("published")
    expect(calls).toBe(3)
  })
}

test("permanent errors retain their cause and unknown errors are never retried", async () => {
  for (const code of ["EACCES", "ENOSPC", "ENOENT", "EEXIST"]) {
    let calls = 0
    const error = Object.assign(new Error(code), { code })
    await expect(
      transientFile(
        async () => {
          calls++
          throw error
        },
        { delays: [0, 0] },
      ),
    ).rejects.toBe(error)
    expect(calls).toBe(code === "EACCES" ? 3 : 1)
  }
})

test("cancellation and the caller's budget stop retries before another file operation", async () => {
  const controller = new AbortController()
  const error = Object.assign(new Error("busy"), { code: "EPERM" })
  let calls = 0
  const pending = transientFile(
    async () => {
      calls++
      controller.abort()
      throw error
    },
    { signal: controller.signal, delays: [100] },
  )
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  expect(calls).toBe(1)
  await expect(
    transientFile(
      async () => {
        throw error
      },
      { delays: [100], timeoutMs: 1 },
    ),
  ).rejects.toBe(error)
})
