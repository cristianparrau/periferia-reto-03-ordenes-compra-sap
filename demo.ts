/**
 * Verificación sin modelo: procesa los 6 casos llamando directamente a las herramientas.
 * Muestra idempotencia (sol-001 dos veces) y confirmación explícita (sol-004 y sol-005).
 */
import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import * as oc from "./src/tools/oc.ts"
import type { ContextoHerramienta } from "./src/core/tipos.ts"

const directory = process.cwd()
const ctx: ContextoHerramienta = { directory, sessionId: "demo" }
type Hallazgo = { codigo: string; detalle: string }
type Respuesta = { ok: boolean; data?: Record<string, unknown>; error?: string }
const parse = (s: string) => JSON.parse(s) as Respuesta

async function crear(caso: string, confirmado?: boolean): Promise<string> {
  const r = parse(await oc.crear.execute({ caso, confirmado }, ctx))
  return r.ok && r.data ? `OC ${String(r.data.numero_oc)}${r.data.idempotente ? " (idempotente: ya existía, no se duplicó)" : " creada"}` : `NO creada → ${r.error}`
}

async function procesar(caso: string): Promise<void> {
  console.log(`\n=== ${caso} ===`)
  const v = parse(await oc.validar_paquete.execute({ caso }, ctx))
  if (!v.ok || !v.data) return void console.log(`  ✗ ${v.error}`)
  const bloqueos = v.data.bloqueos as Hallazgo[]
  const confirmaciones = v.data.confirmaciones as Hallazgo[]
  console.log(`  apta=${v.data.apta} · retroactiva=${v.data.retroactiva}`)
  for (const b of bloqueos) console.log(`  BLOQUEO [${b.codigo}] ${b.detalle}`)
  for (const c of confirmaciones) console.log(`  CONFIRMAR [${c.codigo}] ${c.detalle}`)
  const d = v.data.derivados as Record<string, { valor?: string; fuente?: string } | null>
  for (const k of ["condiciones_pago", "indicador_iva"]) if (d[k]?.fuente && d[k]?.fuente !== "solicitud") console.log(`  DERIVADO ${k} = ${d[k]?.valor} (${d[k]?.fuente})`)
  if (v.data.apta) {
    const p = parse(await oc.construir_payload.execute({ caso }, ctx))
    const pos = (p.data?.orden as { posiciones: { descripcion: string; unidad: string }[] } | undefined)?.posiciones[0]
    if (pos) console.log(`  Payload: "${pos.descripcion}" · unidad ${pos.unidad}`)
  }
  console.log(`  Crear sin confirmar: ${await crear(caso)}`)
}

async function main(): Promise<void> {
  await rm(join(directory, "out"), { recursive: true, force: true })
  const casos = (await readdir(join(directory, "fixtures", "reto-03", "solicitudes"))).sort()
  for (const caso of casos) await procesar(caso)

  console.log("\n=== Idempotencia ===")
  console.log(`  sol-001 segunda vez: ${await crear("sol-001")}`)
  console.log("\n=== Confirmación explícita ===")
  console.log(`  sol-004 con confirmado=true: ${await crear("sol-004", true)}`)
  console.log(`  sol-005 con confirmado=true: ${await crear("sol-005", true)}`)
  console.log(`  sol-002 con confirmado=true (bloqueo no se salta): ${await crear("sol-002", true)}`)
  const e = parse(await oc.generar_evidencia.execute({ caso: "sol-004" }, ctx))
  console.log(`  Evidencia sol-004: ${String(e.data?.ruta)} sha256=${String(e.data?.sha256).slice(0, 16)}…`)
  console.log("\nControl: out/control.csv · SAP simulado: out/sap/ordenes.jsonl")
}

main().catch(() => {
  console.error("La demo falló de forma inesperada.")
  process.exitCode = 1
})
