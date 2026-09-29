// 分子坐标投影参考 OpenAI4S thumbs.ts（MIT，2026 openai4s contributors）；许可见 NOTICE。
export interface Point {
  x: number
  y: number
  z: number
}
const POINT_LIMIT = 500

function point(values: string[]): Point[] {
  if (values.length !== 3 || values.some((value) => !value.trim())) return []
  const [x, y, z] = values.map(Number)
  return [x, y, z].every(Number.isFinite) ? [{ x: x!, y: y!, z: z! }] : []
}

export function molecularPoints(text: string, format: string): Point[] {
  const lines = text.split(/\r?\n/)
  if (["pdb", "ent", "pdbqt"].includes(format)) {
    const atoms = lines.filter((line) => /^(ATOM  |HETATM)/.test(line))
    const backbone = atoms.filter((line) => line.slice(12, 16).trim() === "CA")
    return (backbone.length >= 3 ? backbone : atoms).flatMap((line) =>
      point([line.slice(30, 38), line.slice(38, 46), line.slice(46, 54)]),
    )
  }
  if (format === "xyz")
    return lines
      .slice(2, 2 + Math.max(0, Number.parseInt(lines[0] ?? "", 10)))
      .flatMap((line) => point(line.trim().split(/\s+/).slice(1, 4)))
  if (format === "gro")
    return lines
      .slice(2, 2 + Math.max(0, Number.parseInt(lines[1] ?? "", 10)))
      .flatMap((line) => point([line.slice(20, 28), line.slice(28, 36), line.slice(36, 44)]))
  if (format === "mol2") {
    const start = lines.findIndex((line) => line.trim() === "@<TRIPOS>ATOM")
    if (start < 0) return []
    const end = lines.findIndex((line, index) => index > start && line.startsWith("@<TRIPOS>"))
    return lines
      .slice(start + 1, end < 0 ? undefined : end)
      .flatMap((line) => point(line.trim().split(/\s+/).slice(2, 5)))
  }
  if (format === "mol" || format === "sdf") {
    // 只读取明确的 V2000 原子区，避免把键记录或第二个分子误当作坐标。
    if (!lines[3]?.includes("V2000")) return []
    const count = Number.parseInt(lines[3].slice(0, 3), 10)
    return lines
      .slice(4, 4 + Math.max(0, count))
      .flatMap((line) => point([line.slice(0, 10), line.slice(10, 20), line.slice(20, 30)]))
  }
  return []
}

async function cifPoints(text: string): Promise<Point[]> {
  const { CIF } = await import("molstar/lib/mol-io/reader/cif")
  const parsed = await CIF.parseText(text).run()
  if (parsed.isError) throw new Error(parsed.message)
  const atoms = parsed.result.blocks[0]?.categories.atom_site
  if (!atoms) return []
  const x = atoms.getField("Cartn_x"),
    y = atoms.getField("Cartn_y"),
    z = atoms.getField("Cartn_z")
  if (!x || !y || !z) return []
  const model = atoms.getField("pdbx_PDB_model_num")
  const name = atoms.getField("label_atom_id")
  const all: Point[] = [],
    backbone: Point[] = []
  for (let i = 0; i < atoms.rowCount; i++) {
    if (model && model.str(i) !== model.str(0)) continue
    const row = point([x.str(i), y.str(i), z.str(i)])
    all.push(...row)
    if (name?.str(i) === "CA") backbone.push(...row)
  }
  return backbone.length >= 3 ? backbone : all
}

export function projectMolecule(input: Point[]): string | undefined {
  const valid = input.filter((p) => [p.x, p.y, p.z].every(Number.isFinite))
  if (!valid.length) return
  const step = Math.max(1, Math.ceil(valid.length / POINT_LIMIT))
  const points = valid.filter((_, index) => index % step === 0)
  const bounds = (axis: keyof Point) => ({
    min: Math.min(...points.map((p) => p[axis])),
    max: Math.max(...points.map((p) => p[axis])),
  })
  const x = bounds("x"),
    y = bounds("y"),
    z = bounds("z")
  const scale = Math.min(208 / (x.max - x.min || 1), 116 / (y.max - y.min || 1))
  const dots = points
    .map((p, index) => {
      const depth = (p.z - z.min) / (z.max - z.min || 1)
      return {
        x: 120 + (p.x - (x.min + x.max) / 2) * scale,
        y: 74 - (p.y - (y.min + y.max) / 2) * scale,
        depth,
        hue: 240 - (240 * index) / Math.max(1, points.length - 1),
      }
    })
    .sort((a, b) => a.depth - b.depth)
  const circles = dots
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(Math.max(2, 9 - Math.sqrt(points.length)) + p.depth * 1.5).toFixed(2)}" fill="hsl(${p.hue.toFixed(0)} 65% 60%)" opacity="${(0.8 + p.depth * 0.2).toFixed(2)}"/>`,
    )
    .join("")
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 148">${circles}</svg>`)}`
}

export async function molecularThumbnail(text: string, format: string) {
  const points = format === "cif" || format === "mmcif" ? await cifPoints(text) : molecularPoints(text, format)
  return projectMolecule(points)
}
