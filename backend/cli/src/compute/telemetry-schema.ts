import z from "zod"

const percent = z.number().finite().min(0).max(100).nullable()
const bytes = z.number().finite().nonnegative().nullable()

export namespace ComputeTelemetry {
  export const Device = z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["GPU", "DCU", "TPU"]),
    source: z.string(),
    utilization: percent,
    memoryUsed: bytes,
    memoryTotal: bytes,
    memoryPercent: percent,
    temperature: z.number().finite().nullable(),
    power: bytes,
  })
  export type Device = z.infer<typeof Device>

  export const AcceleratorScope = z.object({
    kind: z.enum(["host", "allocation", "unavailable"]),
    jobID: z.string().optional(),
    expectedDevices: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
  })

  export const Sample = z.object({
    sampledAt: z.number(),
    hostname: z.string(),
    cpu: z.object({ utilization: percent, cores: z.number().nonnegative() }),
    memory: z.object({ used: bytes, total: bytes }),
    devices: Device.array(),
    acceleratorScope: AcceleratorScope.optional(),
    issues: z.string().array(),
  })
  export type Sample = z.infer<typeof Sample>

  export const Target = z.object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(["host", "slurm", "pbs", "ssh", "modal"]),
    state: z.enum(["running", "queued", "unavailable"]),
    sessionID: z.string().optional(),
    jobID: z.string().optional(),
  })
  export type Target = z.infer<typeof Target>

  export const Report = z.object({
    targets: Target.array(),
    selected: z.string(),
    nodes: z.string().array(),
    node: z.string().optional(),
    state: z.enum(["live", "queued", "unavailable", "finished"]),
    sample: Sample.nullable(),
    issues: z.string().array(),
    intervalMs: z.number(),
  })
  export type Report = z.infer<typeof Report>
}
