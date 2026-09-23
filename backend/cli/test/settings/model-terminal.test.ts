import { expect, test } from "bun:test"
import { WSContext } from "hono/ws"
import { CustomConnections } from "../../src/provider/custom-connections"
import { CredentialLifecycle } from "../../src/credentials/lifecycle"
import { CredentialTeardown } from "../../src/credentials/teardown"
import { Instance } from "../../src/project/instance"
import { Pty } from "../../src/pty"
import { executionSession, fullAccessExecution, tmpdir } from "../fixture/fixture"

test("adding, rotating, and deleting model credentials retains the same live terminal and shell state", async () => {
  // 只作用于测试框架的独立配置和临时项目，退出时恢复策略。
  await using access = await fullAccessExecution()
  await using tmp = await tmpdir()
  const unsubscribe = CredentialLifecycle.onRevoke(CredentialTeardown.apply)
  let connectionID: string | undefined
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const terminal = await Pty.create({ sessionID: session.id })
        let output = ""
        let closed = false
        const socket = new WSContext({
          readyState: 1,
          send: (data) => {
            output += String(data)
          },
          close: () => {
            closed = true
          },
        })
        const transport = Pty.connect(terminal.id, socket)!
        transport.onMessage("\0")
        const check = async (label: string) => {
          Pty.write(terminal.id, `printf 'CONTINUITY_%s_%s\\n' ${label} "$OSC_CONTINUITY"\r`)
          const match = `CONTINUITY_${label}_preserved`
          for (let i = 0; i < 1000 && !output.includes(match); i++) await Bun.sleep(20)
          expect(output).toContain(match)
          expect(closed).toBe(false)
          expect(Pty.get(terminal.id)?.pid).toBe(terminal.pid)
        }
        try {
          Pty.write(terminal.id, "OSC_CONTINUITY=preserved\r")
          await check("before")
          const input = {
            name: "Terminal fixture",
            url: "https://example.invalid/v1",
            key: "fixture-only",
            models: ["fixture-model"],
          }
          const added = await CustomConnections.save(input)
          connectionID = added.id
          await check("added")
          await CustomConnections.save({ ...input, id: added.id, key: "fixture-rotated" })
          await check("rotated")
          await CustomConnections.remove(added.id)
          connectionID = undefined
          await check("removed")
        } finally {
          transport.onClose()
          await Pty.remove(terminal.id)
        }
      },
    })
  } finally {
    if (connectionID) await CustomConnections.remove(connectionID)
    unsubscribe()
    await Instance.provide({ directory: tmp.path, fn: () => Instance.dispose() })
  }
}, 60_000)
