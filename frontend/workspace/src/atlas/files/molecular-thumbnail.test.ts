import { describe, expect, test } from "bun:test"
import { molecularPoints, molecularThumbnail, projectMolecule } from "./molecular-thumbnail"

describe("molecular thumbnails", () => {
  test("reads PDB coordinates without treating metadata as atoms", () => {
    const pdb = "HEADER    TEST\nATOM      1  CA  ALA A   1      11.104  13.207   9.309  1.00 20.00           C\nEND"
    expect(molecularPoints(pdb, "pdb")).toEqual([{ x: 11.104, y: 13.207, z: 9.309 }])
    expect(molecularPoints("ATOM      1  CA  ALA A   1           invalid", "pdb")).toEqual([])
  })
  test("does not interpret comments or trailing XYZ lines as coordinates", () => {
    expect(molecularPoints("2\ncarbon\nC 0 1 2\nO 3 4 5\nC 6 7 8", "xyz")).toEqual([
      { x: 0, y: 1, z: 2 },
      { x: 3, y: 4, z: 5 },
    ])
    expect(molecularPoints("1\ninvalid\nC 1 NaN 2", "xyz")).toEqual([])
  })
  test("uses the CIF parser for quoted atom names and reordered columns", async () => {
    const cif =
      "data_test\nloop_\n_atom_site.label_atom_id\n_atom_site.Cartn_z\n_atom_site.Cartn_x\n_atom_site.Cartn_y\n'CA' 3 1 2\n#\n"
    expect(await molecularThumbnail(cif, "cif")).toStartWith("data:image/svg+xml,")
  })
  test("bounds rendered points and keeps degenerate structures finite", () => {
    const large = Array.from({ length: 20_000 }, (_, x) => ({ x, y: 0, z: 0 }))
    const svg = decodeURIComponent(projectMolecule(large)!)
    expect(svg.match(/<circle/g)?.length).toBeLessThanOrEqual(500)
    expect(svg).not.toMatch(/NaN|Infinity/)
    expect(projectMolecule([{ x: NaN, y: 0, z: 0 }])).toBeUndefined()
    expect(decodeURIComponent(projectMolecule([{ x: 0, y: 0, z: 0 }])!)).toContain('cx="120.00"')
  })
})
