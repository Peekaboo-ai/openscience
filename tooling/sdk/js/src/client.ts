export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpenScienceClient } from "./gen/sdk.gen.js"
export { type Config as OpenScienceClientConfig, OpenScienceClient }

export function createOpenScienceClient(
  config?: Config & { directory?: string; projectID?: string; project?: string },
) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    // 与 v2 保持一致：中文用户目录不能直接放进只接受字节值的 HTTP 请求头。
    const directory = /[^\x00-\x7F]/.test(config.directory) ? encodeURIComponent(config.directory) : config.directory
    config.headers = {
      ...config.headers,
      "x-openscience-directory": directory,
    }
  }

  const project = config?.projectID ?? config?.project
  if (project) {
    config.headers = {
      ...config.headers,
      "x-openscience-project": project,
    }
  }

  const client = createClient(config)
  return new OpenScienceClient({ client })
}
