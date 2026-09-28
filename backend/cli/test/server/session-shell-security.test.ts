import { expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Sandbox } from "../../src/sandbox/sandbox"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { fullAccessExecution, sandboxedExecution, tmpdir } from "../fixture/fixture"
import { SessionPrompt } from "../../src/session/prompt"

test("direct shell commands retain silent exit failures for the model and UI", async () => {
  await using _execution = await fullAccessExecution()
  await using workspace = await tmpdir()
  await Instance.provide({
    directory: workspace.path,
    fn: async () => {
      const session = await Session.create({ title: "shell exit status" })
      for (const exit of [0, 7]) {
        const result = await SessionPrompt.shell({
          sessionID: session.id,
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          command: `exit ${exit}`,
        })
        const part = result.parts[0]
        expect(part.state.status).toBe("completed")
        if (part.state.status !== "completed") throw new Error("Shell did not settle")
        expect(part.state.metadata.exit).toBe(exit)
        if (exit) expect(part.state.output).toContain("Command exited with code 7")
        else expect(part.state.output).not.toContain("bash_metadata")
      }
    },
  })
}, 30_000)

test("the legacy session shell route runs untrusted projects only inside its sandbox", async () => {
  await using _sandbox = await sandboxedExecution()
  await using workspace = await tmpdir()
  await using outside = await tmpdir()
  const state = await Instance.provide({
    directory: workspace.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      return { projectID: Instance.project.id, session: await Session.create({ title: "shell route" }) }
    },
  })
  const target = path.join(outside.path, "escaped")
  const fetch = Server.internalFetch()
  const invoke = () =>
    fetch(
      `http://openscience.internal/session/${state.session.id}/shell?directory=${encodeURIComponent(workspace.path)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openscience-project": state.projectID,
        },
        body: JSON.stringify({
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          command: `printf escaped > ${JSON.stringify(target)}`,
        }),
      },
    )

  const initial = await invoke()
  expect(initial.status).toBe(Sandbox.available() ? 200 : 403)
  if (!Sandbox.available()) {
    expect(await initial.json()).toMatchObject({
      name: "ExecutionAuthorityDeniedError",
      data: { reason: "sandbox_unavailable" },
    })
  }
  expect(await Bun.file(target).exists()).toBe(false)

  if (Sandbox.available()) {
    await Instance.provide({
      directory: workspace.path,
      fn: async () => {
        const status = await ProjectTrust.status(Instance.project)
        await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
      },
    })
    const confined = await invoke()
    expect(confined.status).toBe(200)
    expect(await Bun.file(target).exists()).toBe(false)
  }

  await Instance.provide({
    directory: workspace.path,
    fn: () => Session.remove(state.session.id),
  })
}, 30_000)
