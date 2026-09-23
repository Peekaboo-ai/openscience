import assert from "node:assert/strict"

const [gateway, projectID, sessionID, condaEnvironment] = process.argv.slice(2)
if (!gateway || !projectID || !sessionID)
  throw new Error("Usage: verify-host-environment.ts <gateway> <testProjectID> <testSessionID> [condaEnvironment]")
const headers = { "content-type": "application/json", "x-openscience-project": projectID }
async function request(route: string, init?: RequestInit) {
  const response = await fetch(gateway + route, { ...init, headers, proxy: "", signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`)
  return response.json()
}
const environment = await request("/workspace/environment")
const access = await request(`/project/${projectID}/access`)
assert.equal(access.sandbox.enabled, true, "This verification must keep sandbox protection enabled")
const pty = await request("/pty", {
  method: "POST",
  body: JSON.stringify({ sessionID, title: "Environment compatibility verification" }),
})
try {
  await request(`/pty/${pty.id}`, { method: "PUT", body: JSON.stringify({ size: { rows: 36, cols: 100 } }) })
  const url = new URL(`${gateway}/pty/${pty.id}/connect`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("projectID", projectID)
  const checks = [
    { name: "tty", command: "test -t 0 && test -t 1" },
    { name: "size", command: 'test "$(stty size)" = "36 100"' },
    ...(environment.runtimes.some((item: { name: string }) => item.name === "conda")
      ? [{ name: "conda", command: "conda env list" }]
      : []),
    ...(environment.schedulers.some(
      (item: { id: string; status: string }) => item.id === "slurm" && item.status === "ready",
    )
      ? [
          { name: "sinfo", command: "sinfo" },
          { name: "squeue", command: "squeue --me" },
        ]
      : []),
    ...(condaEnvironment
      ? [
          {
            name: "conda_activate",
            command: `conda activate '${condaEnvironment.replaceAll("'", `'\\''`)}' && python -c 'import os, sys; assert os.path.realpath(sys.prefix) == os.path.realpath(os.environ["CONDA_PREFIX"]); print(sys.prefix)' && conda deactivate`,
          },
        ]
      : []),
  ]
  const result = Promise.withResolvers<string>()
  const socket = new WebSocket(url)
  socket.binaryType = "arraybuffer"
  let output = ""
  const timer = setTimeout(() => result.reject(new Error(`PTY verification timed out: ${output.slice(-2000)}`)), 55_000)
  socket.onopen = () => {
    socket.send("\0")
    socket.send(checks.map((check) => `${check.command}; printf '\\nCHECK_${check.name}=%s\\n' "$?"`).join("; ") + "\n")
  }
  socket.onmessage = (event) => {
    output += typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)
    if (checks.every((check) => new RegExp(`CHECK_${check.name}=\\d+\\r?\\n`).test(output))) result.resolve(output)
  }
  socket.onerror = () => result.reject(new Error("Terminal WebSocket failed"))
  try {
    const terminal = await result.promise
    for (const check of checks)
      assert.match(terminal, new RegExp(`CHECK_${check.name}=0\\r?\\n`), terminal.slice(-3000))
    assert.doesNotMatch(
      terminal,
      /no job control|cannot set terminal process group|Failed to import.*encodings|log-user-session.*No such file/i,
    )
    const interrupted = Promise.withResolvers<void>()
    let interruptOutput = ""
    let sent = false
    const interruptTimer = setTimeout(
      () => interrupted.reject(new Error(`Ctrl-C did not return the prompt: ${interruptOutput}`)),
      5000,
    )
    socket.onmessage = (event) => {
      interruptOutput += typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)
      if (!sent && /INTERRUPT_READY\r?\n/.test(interruptOutput)) {
        sent = true
        setTimeout(() => socket.send("\x03"), 150)
        setTimeout(() => socket.send("printf '\\nCHECK_interrupt=%s\\n' \"$?\"\n"), 300)
      }
      if (/CHECK_interrupt=130\r?\n/.test(interruptOutput)) interrupted.resolve()
    }
    socket.send("printf '\\nINTERRUPT_READY\\n'; sleep 30\n")
    try {
      await interrupted.promise
    } finally {
      clearTimeout(interruptTimer)
    }
    console.log(
      JSON.stringify(
        {
          hostname: environment.hostname,
          sandbox: access.sandbox.enabled,
          schedulers: environment.schedulers.map((item: { id: string; status: string }) => ({
            id: item.id,
            status: item.status,
          })),
          checks: [...checks.map((check) => check.name), "ctrl-c"],
          terminal: terminal.slice(-5000),
        },
        null,
        2,
      ),
    )
  } finally {
    clearTimeout(timer)
    socket.close()
  }
} finally {
  await request(`/pty/${pty.id}`, { method: "DELETE" })
}
