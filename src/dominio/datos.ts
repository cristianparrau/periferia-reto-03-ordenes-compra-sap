import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { leerJson } from "../core/archivos.ts"
import { ok, type Resultado } from "../core/tipos.ts"

export const RUTAS = {
  caso: (dir: string, caso: string) => join(dir, "fixtures", "reto-03", "solicitudes", caso),
  maestros: (dir: string) => join(dir, "fixtures", "reto-03", "maestros"),
  salida: (dir: string, caso: string) => join(dir, "out", caso),
  sap: (dir: string) => join(dir, "out", "sap"),
  control: (dir: string) => join(dir, "out", "control.csv"),
}

export const SolicitudSchema = z.object({
  solicitud_id: z.string(),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number({ error: "cantidad no numérica" }),
  valor_unitario: z.number({ error: "valor_unitario no numérico" }),
  valor_total: z.number({ error: "valor_total no numérico" }),
  moneda: z.string(),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_solicitud inválida"),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CorreoSchema = z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string(), cuerpo: z.string(), adjuntos: z.array(z.string()) })
export const AprobacionSchema = z.object({ de: z.string(), para: z.string(), cc: z.array(z.string()).optional(), fecha: z.string(), asunto: z.string(), cuerpo: z.string() })
export type AprobacionCruda = z.infer<typeof AprobacionSchema>

export const ProveedorSchema = z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string(), condiciones_pago_default: z.string(), indicador_iva_default: z.string(), activo: z.boolean() })
export type Proveedor = z.infer<typeof ProveedorSchema>
export const CentroSchema = z.object({ centro_costo: z.string(), nombre: z.string(), subareas: z.array(z.string()), aprobadores: z.array(z.object({ email: z.string(), nombre: z.string(), tope: z.number() })) })
export type Centro = z.infer<typeof CentroSchema>
const CodigoSchema = z.object({ codigo: z.string(), descripcion: z.string() })

export type Maestros = { proveedores: Proveedor[]; centros: Centro[]; iva: string[]; condiciones: string[] }

export async function cargarMaestros(dir: string): Promise<Resultado<Maestros>> {
  const m = RUTAS.maestros(dir)
  const [p, c, i, cp] = await Promise.all([
    leerJson(join(m, "proveedores.json"), z.array(ProveedorSchema), "proveedores.json"),
    leerJson(join(m, "centros-costo.json"), z.array(CentroSchema), "centros-costo.json"),
    leerJson(join(m, "indicadores-iva.json"), z.array(CodigoSchema), "indicadores-iva.json"),
    leerJson(join(m, "condiciones-pago.json"), z.array(CodigoSchema), "condiciones-pago.json"),
  ])
  if (!p.ok) return p
  if (!c.ok) return c
  if (!i.ok) return i
  if (!cp.ok) return cp
  return ok({ proveedores: p.data, centros: c.data, iva: i.data.map((x) => x.codigo), condiciones: cp.data.map((x) => x.codigo) })
}

export async function leerTexto(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch {
    return null
  }
}
