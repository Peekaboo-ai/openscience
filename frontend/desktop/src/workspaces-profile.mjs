import path from "node:path"

export function workspacesProfile(env, appData) {
  const root = path.resolve(
    env.OPENSCIENCE_WORKSPACES_HOME || path.join(env.LOCALAPPDATA || appData, "OpenScience Workspaces"),
  )
  return {
    root,
    userData: path.join(root, "desktop"),
    logs: path.join(root, "logs"),
    environment: {
      OPENSCIENCE_DATA_DIR: path.join(root, "data"),
      OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_DATA_HOME: path.join(root, "xdg-data"),
    },
  }
}
