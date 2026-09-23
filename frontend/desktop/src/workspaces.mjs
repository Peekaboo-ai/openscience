import { mkdirSync } from "node:fs"
import { app } from "electron"
import { workspacesProfile } from "./workspaces-profile.mjs"

const profile = workspacesProfile(process.env, app.getPath("appData"))
for (const directory of [profile.userData, profile.logs]) mkdirSync(directory, { recursive: true })
app.setName("OpenScience Workspaces")
app.setPath("userData", profile.userData)
app.setPath("logs", profile.logs)
// 安装目录只存放程序；升级、卸载均不迁移或删除科研数据和用户凭据。
Object.assign(process.env, profile.environment)
// 本地定制版无需云端账号即可工作；账号和托管服务仍由设置页单独授权。
process.env.OPENSCIENCE_DESKTOP_ONBOARDING = "optional"
await import("./main.mjs")
