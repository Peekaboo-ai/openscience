export function sshConfigTokens(value: string, platform: NodeJS.Platform = process.platform) {
  const tokens: string[] = []
  let token = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (escaped) {
      token += char
      escaped = false
      continue
    }
    if (char === "\\") {
      // Windows 盘符和 UNC 路径中的反斜杠是目录分隔符，不能按 shell 转义吞掉。
      const windows =
        platform === "win32" &&
        (/^[a-z]:/i.test(token) ||
          token.startsWith("\\") ||
          (!token && value[index + 1] === "\\") ||
          !/[\\\s'"#]/.test(value[index + 1] ?? ""))
      if (windows) token += char
      else escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else token += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "#") break
    if (/\s/.test(char)) {
      if (token) tokens.push(token)
      token = ""
      continue
    }
    token += char
  }
  if (escaped) token += "\\"
  if (token) tokens.push(token)
  return tokens
}
