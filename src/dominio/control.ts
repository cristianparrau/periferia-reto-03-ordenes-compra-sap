import { readFile } from "node:fs/promises"
import { agregarLinea } from "../core/archivos.ts"
import { RUTAS } from "./datos.ts"
import type { Hallazgo } from "./controles.ts"

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts"

export type FilaControl = { solicitud_id: string; resultado: "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion"; numero_oc: string | null; retroactiva: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[] }

const csv = (v: string) => `"${v.replaceAll('"', '""')}"`

/** Cada intento de crear OC (exitoso, bloqueado o pendiente) deja una fila para auditoría. */
export async function registrarControl(dir: string, f: FilaControl): Promise<void> {
  const ruta = RUTAS.control(dir)
  const existe = await readFile(ruta, "utf8").then(() => true, () => false)
  if (!existe) await agregarLinea(ruta, ENCABEZADO)
  const codigos = (h: Hallazgo[]) => csv(h.map((x) => x.codigo).join(";"))
  await agregarLinea(ruta, [f.solicitud_id, f.resultado, f.numero_oc ?? "", String(f.retroactiva), codigos(f.bloqueos), codigos(f.confirmaciones), new Date().toISOString()].join(","))
}
