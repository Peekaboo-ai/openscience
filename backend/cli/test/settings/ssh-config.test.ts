import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ComputeSettings } from "../../src/server/routes/settings/compute"

test("imports existing identity files through quoted paths and bounded Includes", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-import-")))
  try {
    const key = path.join(root, "research key")
    const include = path.join(root, "hosts.conf")
    const config = path.join(root, "config")
    await fs.writeFile(key, "fixture identity", { mode: 0o600 })
    await fs.writeFile(
      include,
      `Host imported\n  HostName example.invalid\n  User researcher\n  Port 2222\n  IdentityFile "${key}"\n`,
    )
    await fs.writeFile(config, `Include "${include}"\nMatch exec "must-never-run"\n  HostName ignored.invalid\n`)
    expect(await ComputeSettings.sshConfigHosts(config)).toEqual([
      {
        alias: "imported",
        hostname: "example.invalid",
        user: "researcher",
        port: 2222,
        identity_file: key,
      },
    ])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
