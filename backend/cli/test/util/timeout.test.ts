import { describe, expect, test } from "bun:test"
import { withTimeout } from "../../src/util/timeout"

describe("util.timeout", () => {
  test("should resolve when promise completes before timeout", async () => {
    const fastPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("fast"), 10)
    })

    const result = await withTimeout(fastPromise, 100)
    expect(result).toBe("fast")
  })

  test("should reject when promise exceeds timeout", async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("slow"), 200)
    })

    await expect(withTimeout(slowPromise, 50)).rejects.toThrow("Operation timed out after 50ms")
  })

  test("a rejected operation releases its deadline without keeping the process alive", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { withTimeout } from ${JSON.stringify(new URL("../../src/util/timeout.ts", import.meta.url).href)};
         const failure = new Error("connection refused");
         try {
           await withTimeout(Promise.reject(failure), 60_000);
           throw new Error("Expected rejection");
         } catch (error) {
           if (error !== failure) throw error;
           console.log("original rejection preserved");
         }`,
      ],
      { stdout: "pipe", stderr: "pipe", windowsHide: true },
    )
    const deadline = Promise.withResolvers<never>()
    const timer = setTimeout(() => deadline.reject(new Error("Rejected operation retained its deadline")), 2000)
    try {
      expect(await Promise.race([child.exited, deadline.promise])).toBe(0)
      expect(await new Response(child.stdout).text()).toContain("original rejection preserved")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
    }
  })
})
