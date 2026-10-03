// 远端代理使用回环 URL，但仍要穿过 SSH 和共享存储，不能沿用本机设置页的预算。
export function readTimeout(base: string, path: string) {
  const url = new URL(base)
  const remote =
    url.pathname.includes("/remote-workspaces/") || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (remote) return 60_000
  return path.startsWith("/settings/") ? 15_000 : 30_000
}
