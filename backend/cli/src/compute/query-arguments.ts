const flags: Record<string, string[]> = {
  sinfo: [
    "--noheader",
    "--Node",
    "--long",
    "--summarize",
    "--exact",
    "--responding",
    "--dead",
    "--list-reasons",
    "--help",
    "--usage",
    "--version",
    "--json",
    "-h",
    "-N",
    "-l",
    "-s",
    "-e",
    "-r",
    "-d",
    "-R",
    "-V",
  ],
  squeue: [
    "--noheader",
    "--long",
    "--me",
    "--array",
    "--start",
    "--steps",
    "--help",
    "--usage",
    "--version",
    "--json",
    "-h",
    "-l",
    "-r",
    "-s",
    "-V",
  ],
  pbsnodes: ["-a", "-l", "-S", "-j", "--version"],
  bhosts: ["-w", "-l", "-a", "-s", "-V"],
  qhost: ["-q", "-j", "-F", "-xml", "-help"],
}
const values: Record<string, string[]> = {
  sinfo: ["--partition", "--nodes", "--states", "--format", "--Format", "--sort", "-p", "-n", "-t", "-o", "-O", "-S"],
  squeue: [
    "--partition",
    "--nodes",
    "--states",
    "--format",
    "--Format",
    "--sort",
    "--user",
    "--jobs",
    "--name",
    "--account",
    "-p",
    "-w",
    "-t",
    "-o",
    "-O",
    "-S",
    "-u",
    "-j",
    "-n",
    "-A",
  ],
  pbsnodes: [],
  bhosts: [],
  qhost: ["-h", "-u"],
}

export const clusterQueryCommands = Object.keys(flags)

export function validateQuery(command: string, args: string[]) {
  if (!Object.hasOwn(flags, command) || args.length > 32) throw new Error("Unsupported cluster status query.")
  const validValue = (value: string) =>
    !!value && value.length <= 512 && !value.startsWith("-") && !/[\x00-\x1f\x7f]/.test(value)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (flags[command].includes(arg)) continue
    const equal = arg.indexOf("=")
    const key = equal < 0 ? arg : arg.slice(0, equal)
    if (values[command].includes(key) && validValue(equal < 0 ? (args[++index] ?? "") : arg.slice(equal + 1))) continue
    // 只允许只读短选项组合；不接受配置文件、插件、循环执行或调度修改选项。
    if (/^-[A-Za-z]+$/.test(arg) && [...arg.slice(1)].every((letter) => flags[command].includes(`-${letter}`))) continue
    throw new Error(`Unsupported option '${arg}'. This terminal bridge accepts read-only status flags only.`)
  }
}
