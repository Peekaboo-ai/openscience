import { expect, test } from "bun:test"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { executionSession, fullAccessExecution, tmpdir } from "../fixture/fixture"

test("shell environment activation owns PATH and does not acquire an unrelated Python runtime", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await using mode = await fullAccessExecution()
      const session = await executionSession()
      const result = await (
        await BashTool.init()
      ).execute(
        {
          command:
            'export CONDA_PREFIX=/explicit/user/environment; printf "prefix=%s\\n" "$CONDA_PREFIX"; printf "path=%s\\n" "$PATH"; printf "target=%s\\n" "${PIP_TARGET-unset}"; printf "pycache=%s\\n" "${PYTHONPYCACHEPREFIX-unset}"; printf "no_bytecode=%s\\n" "$PYTHONDONTWRITEBYTECODE"',
          description: "Inspect explicit shell environment",
          timeout: 10_000,
        },
        {
          sessionID: session.id,
          messageID: "msg_env",
          agent: "research",
          abort: AbortSignal.any([]),
          messages: [],
          metadata() {},
          async ask() {},
        },
      )
      expect(result.metadata.exit, result.output).toBe(0)
      expect(result.output).toContain("prefix=/explicit/user/environment")
      expect(result.output).toContain("target=unset")
      expect(result.output).toContain("pycache=unset")
      expect(result.output).toContain("no_bytecode=1")
      expect(result.output).not.toContain("runtime/bin")
      expect(result.metadata.execution_environment).toMatchObject({ profile: "shell" })
    },
  })
})

test("cancellation during permission never launches the command", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await using mode = await fullAccessExecution()
      const session = await executionSession()
      const controller = new AbortController()
      await expect(
        (await BashTool.init()).execute(
          { command: "echo should-not-start", description: "Cancelled command" },
          {
            sessionID: session.id,
            messageID: "msg_cancel",
            agent: "research",
            abort: controller.signal,
            messages: [],
            metadata() {},
            async ask() {
              controller.abort(new Error("stop before preparation"))
            },
          },
        ),
      ).rejects.toThrow("stop before preparation")
    },
  })
})

test("a running command deadline stops execution without reporting a user cancellation", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await using mode = await fullAccessExecution()
      const session = await executionSession()
      const result = await (
        await BashTool.init()
      ).execute(
        {
          command: "printf started; sleep 20; printf should-not-finish",
          description: "Verify deadline",
          timeout: 1500,
        },
        {
          sessionID: session.id,
          messageID: "msg_deadline",
          agent: "research",
          abort: AbortSignal.any([]),
          messages: [],
          metadata() {},
          async ask() {},
        },
      )
      expect(result.output).toContain("started")
      expect(result.output).toContain("exceeding timeout 1500 ms")
      expect(result.output).not.toContain("User aborted")
      expect(result.output).not.toContain("should-not-finish")
      expect(result.metadata.exit).not.toBe(0)
    },
  })
}, 15_000)
