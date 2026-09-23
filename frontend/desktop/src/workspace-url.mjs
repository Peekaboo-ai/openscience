export function workspaceUrl(address, { onboarding = "required", updates = false } = {}) {
  const url = new URL("/", address)
  url.searchParams.set("desktop", "1")
  if (onboarding === "optional") url.searchParams.set("desktop-onboarding", "optional")
  if (updates) url.searchParams.set("desktop-update", "1")
  return url.href
}
