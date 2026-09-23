export const terminalOptions = {
  cursorBlink: true,
  cursorStyle: "bar" as const,
  fontSize: 14,
  scrollback: 10_000,
  // readline 会自行重画光标所在的提示符；再次重排会使它向上覆盖上一条输出。
  reflowCursorLine: false,
}
