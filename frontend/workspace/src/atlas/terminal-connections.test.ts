import { describe, expect, test } from "bun:test"
import { createTerminalConnections } from "./terminal-connections"

describe("terminal connection ownership", () => {
  test("background terminal errors do not replace the connected terminal's status", () => {
    let active = "local"
    const connections = createTerminalConnections(() => active)
    connections.connected("local")
    connections.failed("remote", new Error("Remote connection lost"))
    expect(connections.error()).toBe("")
    expect(connections.pending()).toBe(false)
    active = "remote"
    expect(connections.error()).toBe("Remote connection lost")
    connections.connected("local")
    expect(connections.error()).toBe("Remote connection lost")
    connections.connected("remote")
    expect(connections.error()).toBe("")
  })

  test("new tabs wait for their own connection and closed tabs release their state", () => {
    let active: string | undefined = "first"
    const connections = createTerminalConnections(() => active)
    expect(connections.pending()).toBe(true)
    connections.connected("first")
    active = "second"
    expect(connections.pending()).toBe(true)
    connections.failed("second", new Error("Access denied"))
    expect(connections.pending()).toBe(false)
    connections.retain(["first"])
    expect(connections.error()).toBe("")
    expect(connections.pending()).toBe(true)
    active = undefined
    expect(connections.pending()).toBe(false)
  })
})
