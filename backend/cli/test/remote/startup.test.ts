import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { openRemoteShell, startupReply } from "../../src/remote/startup"
import { RemoteClient } from "../../src/remote/client"
import { PREFIX } from "../../src/remote/protocol"

function peer(script: string) {
  const proc = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const exited = new Promise<void>((resolve) => proc.once("close", () => resolve()))
  return {
    proc,
    async [Symbol.asyncDispose]() {
      proc.kill()
      await exited
    },
  }
}

test("one process handles split platform output, empty cache reply and protocol handoff", async () => {
  await using child = peer(`
    process.stdout.write('Login banner\\nOPENSCIENCE_PLAT');
    setTimeout(() => process.stdout.write('FORM Linux x86_64\\n'), 20);
    let input='';
    process.stdin.on('data', chunk => {
      input += chunk;
      if (!input.includes('\\n')) return;
      input='';
      process.stdout.write('OPENSCIENCE_CACHE \\r\\n' + ${JSON.stringify(PREFIX)} + JSON.stringify({id:'hello',type:'hello',version:1,home:'/research'}) + '\\n');
    });
  `)
  const abort = new AbortController()
  expect(await startupReply(child.proc, "OPENSCIENCE_PLATFORM ", abort.signal)).toBe("Linux x86_64")
  expect(await startupReply(child.proc, "OPENSCIENCE_CACHE ", abort.signal, "check-cache")).toBe("")
  const client = new RemoteClient(child.proc, () => undefined)
  try {
    expect(await client.ready).toBe("/research")
  } finally {
    client.close()
  }
})

test("startup reports SSH diagnostics on an early exit", async () => {
  await using child = peer(`process.stderr.write('Connection closed by gateway\\n'); process.exitCode=1`)
  await expect(startupReply(child.proc, "OPENSCIENCE_PLATFORM ", new AbortController().signal)).rejects.toThrow(
    "Connection closed by gateway",
  )
})

test("startup has a bounded timeout and releases its listeners", async () => {
  await using child = peer(`setInterval(() => {}, 1000)`)
  await expect(
    startupReply(child.proc, "OPENSCIENCE_PLATFORM ", new AbortController().signal, undefined, 50),
  ).rejects.toThrow("Remote startup timed out")
  expect(child.proc.stdout.listenerCount("data")).toBe(0)
  expect(child.proc.stdin.listenerCount("error")).toBe(0)
})

test("cancellation releases a pending startup read", async () => {
  await using child = peer(`setInterval(() => {}, 1000)`)
  const abort = new AbortController()
  const pending = startupReply(child.proc, "OPENSCIENCE_PLATFORM ", abort.signal)
  abort.abort()
  await expect(pending).rejects.toThrow("Connection cancelled")
  expect(child.proc.stdout.listenerCount("data")).toBe(0)
})

test("startup rejects an oversized unframed banner", async () => {
  await using child = peer(`process.stdout.write('x'.repeat(70 * 1024)); setInterval(() => {}, 1000)`)
  await expect(startupReply(child.proc, "OPENSCIENCE_PLATFORM ", new AbortController().signal)).rejects.toThrow(
    "exceeded its limit",
  )
})

test("a closed SSH startup retries before handing off a single live process", async () => {
  await using failed = peer(`process.stderr.write('Connection closed by gateway\\n'); process.exitCode=1`)
  await using ready = peer(`process.stdout.write('OPENSCIENCE_PLATFORM Linux x86_64\\n'); setInterval(() => {}, 1000)`)
  let attempts = 0
  const retries: number[] = []
  const opened = await openRemoteShell(
    () => (++attempts === 1 ? failed.proc : ready.proc),
    new AbortController().signal,
    (attempt) => retries.push(attempt),
  )
  expect(opened.proc).toBe(ready.proc)
  expect(opened.platform).toBe("Linux x86_64")
  expect(attempts).toBe(2)
  expect(retries).toEqual([2])
})

test("SSH authentication failures are not retried", async () => {
  await using child = peer(
    `process.stderr.write('Permission denied (publickey).\\nConnection closed by gateway\\n'); process.exitCode=1`,
  )
  let attempts = 0
  await expect(
    openRemoteShell(
      () => {
        attempts++
        return child.proc
      },
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("Permission denied")
  expect(attempts).toBe(1)
})

test("cancelling SSH retry backoff does not start another process", async () => {
  await using child = peer(`process.stderr.write('Connection reset by peer\\n'); process.exitCode=1`)
  const abort = new AbortController()
  let attempts = 0
  await expect(
    openRemoteShell(
      () => {
        attempts++
        return child.proc
      },
      abort.signal,
      () => abort.abort(),
    ),
  ).rejects.toThrow()
  expect(attempts).toBe(1)
})

test("SSH startup stops after three transient failures", async () => {
  const children: ReturnType<typeof peer>[] = []
  try {
    await expect(
      openRemoteShell(
        () => {
          const child = peer(`process.stderr.write('Connection reset by peer\\n'); process.exitCode=1`)
          children.push(child)
          return child.proc
        },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("Connection reset")
    expect(children).toHaveLength(3)
  } finally {
    await Promise.all(children.map((child) => child[Symbol.asyncDispose]()))
  }
})
