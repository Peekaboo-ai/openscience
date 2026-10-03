import { expect, test } from "bun:test"
import { readTimeout } from "./read-timeout"

test("settings deadlines do not leak into conversation reads or SSH proxy requests", () => {
  expect(readTimeout("http://127.0.0.1:4106", "/settings/sandbox")).toBe(15_000)
  expect(readTimeout("http://127.0.0.1:4106", "/session?limit=50")).toBe(30_000)
  expect(readTimeout("http://127.0.0.1:4106/remote-workspaces/bio/api", "/session")).toBe(60_000)
  expect(readTimeout("http://127.0.0.1:4106/remote-workspaces/bio/api", "/settings/sandbox")).toBe(60_000)
  expect(readTimeout("https://lab.example.org", "/settings/models")).toBe(60_000)
})
