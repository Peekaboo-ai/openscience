import { expect, test } from "bun:test"
import { terminalArgs, terminalEnv, terminalSpawnEnv } from "@/pty/environment"
import { devNull } from "node:os"

test("project terminals do not inherit the parent macOS terminal session", () => {
  const env = terminalEnv(
    {
      PATH: "/usr/bin:/bin",
      COLUMNS: "160",
      LINES: "50",
      TERM_SESSION_ID: "restored-session",
      TERM_PROGRAM: "Apple_Terminal",
      TERM_PROGRAM_VERSION: "999",
      SHELL_SESSION_DIR: "/tmp/sessions",
      SHELL_SESSION_FILE: "/tmp/session",
      SHELL_SESSION_HISTORY: "/tmp/history",
    },
    "project_1",
    "ses_1",
    "/bin/zsh",
    "workstation.local",
  )

  expect(env.PATH).toBe("/usr/bin:/bin")
  expect(env.COLUMNS).toBeUndefined()
  expect(env.LINES).toBeUndefined()
  expect(env.TERM).toBe("xterm-256color")
  expect(env.HISTFILE).toBe(devNull)
  expect(env.SHELL_SESSIONS_DISABLE).toBe("1")
  expect(env.OPENSCIENCE_PROJECT_ID).toBe("project_1")
  expect(env.OPENSCIENCE_SESSION_ID).toBe("ses_1")
  expect(env.PROMPT).toBe("workstation %1~ %# ")
  expect(env.RPROMPT).toBe("")
  expect(env.PROMPT_EOL_MARK).toBe("")
  expect(env.PS1).toBeUndefined()
  expect(env.TERM_SESSION_ID).toBeUndefined()
  expect(env.TERM_PROGRAM).toBeUndefined()
  expect(env.SHELL_SESSION_DIR).toBeUndefined()
  expect(env.SHELL_SESSION_FILE).toBeUndefined()
  expect(env.SHELL_SESSION_HISTORY).toBeUndefined()
})

test("project terminals show the current workspace folder in common shell prompts", () => {
  expect(terminalEnv({}, "project_1", "ses_1", "/bin/zsh", "Aayams-MacBook-Pro-3.local").PROMPT).toBe(
    "Aayams-MacBook-Pro-3 %1~ %# ",
  )
  expect(terminalEnv({}, "project_1", "ses_1", "/bin/bash", "Aayams-MacBook-Pro-3.local").PS1).toBe(
    "Aayams-MacBook-Pro-3 \\W \\$ ",
  )
  expect(terminalEnv({}, "project_1", "ses_1", "nu", "workstation.local").PROMPT).toBeUndefined()
  expect(terminalEnv({}, "project_1", "ses_1", "C:\\Program Files\\Git\\bin\\bash", "workstation.local")).toMatchObject(
    {
      PS1: "workstation \\W \\$ ",
      BASH_SILENCE_DEPRECATION_WARNING: "1",
    },
  )
})

test("interactive shells start clean without restored sessions or user bootstrap output", () => {
  expect(terminalArgs("/bin/zsh")).toEqual(["-d", "-f", "+m", "-i"])
  expect(terminalArgs("/bin/bash")).toEqual(["--noprofile", "--norc", "-O", "checkwinsize", "-i"])
  expect(terminalArgs("C:\\Git\\bin\\bash.exe")).toEqual(["--noprofile", "--norc", "-O", "checkwinsize", "-i"])
  expect(terminalEnv({}, "project_1", "ses_1", "C:\\Git\\bin\\bash.exe", "workstation").PS1).toBe(
    "workstation \\W \\$ ",
  )
  expect(terminalArgs("/usr/local/bin/fish")).toEqual(["--no-config", "--interactive"])
  expect(terminalArgs("/bin/dash")).toEqual(["-i"])
  expect(terminalArgs("nu")).toEqual([])
})

test("native PTY environment merging cannot restore excluded hooks or credentials", () => {
  const parent = {
    PATH: "/unsafe/bin",
    PROMPT_COMMAND: "audit-hook",
    OPENAI_API_KEY: "test-secret",
    PYTHONHOME: "/wrong-python",
    BASH_ENV: "/host/profile",
  }
  const env = terminalSpawnEnv({ PATH: "/runtime/bin", TERM: "xterm-256color" }, parent)
  const merged: Record<string, string> = { ...parent, ...env }
  expect(merged).toEqual({
    PATH: "/runtime/bin",
    TERM: "xterm-256color",
    PROMPT_COMMAND: "",
    OPENAI_API_KEY: "",
    PYTHONHOME: "",
    BASH_ENV: "",
  })
  expect(parent.OPENAI_API_KEY).toBe("test-secret")
})
