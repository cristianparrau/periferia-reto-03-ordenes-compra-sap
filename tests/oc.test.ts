import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import * as oc from "../src/tools/oc.ts"
import { OrdenCompraSchema } from "../src/sap/adapter.ts"
import { sha256 } from "../src/dominio/evidencia.ts"
import { monto, normalizarNit, contieneAprobacion } from "../src/dominio/parseo.ts"
import { unidad, textoBreve } from "../src/dominio/payload.ts"
import { parse, proyectoTemporal } from "./ayudas.ts"
import type { ContextoHerramienta } from "../src/core/tipos.ts"

type Hallazgo = { codigo: string; detalle: string }
type Validacion = { apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; retroactiva: boolean; derivados: Record<string, { valor: string; fuente: string } | null> }
type Creacion = { numero_oc: string; idempotente: boolean; retroactiva: boolean }

let p: Awaited<ReturnType<typeof proyectoTemporal>>
let ctx: ContextoHerramienta
before(async () => { p = await proyectoTemporal(); ctx = p.ctx })
after(async () => { await p.limpiar() })

const validar = async (caso: string) => parse<Validacion>(await oc.validar_paquete.execute({ caso }, ctx)).data
const crear = async (caso: string, confirmado?: boolean, humano?: boolean) => parse<Creacion>(await oc.crear.execute({ caso, confirmado }, { ...ctx, confirmacionHumana: humano }))
const codigos = (h: Hallazgo[]) => h.map((x) => x.codigo)

describe("parseo de textos", () => {
  it("montos en formato colombiano y NIT sin DV", () => {
    assert.equal(monto("COP 11.400.000"), 11400000)
    assert.equal(normalizarNit("900.555.111-2"), "900555111")
  })
  it("'Aprobado' explícito, sin negaciones", () => {
    assert.equal(contieneAprobacion("Aprobado, proceder."), true)
    assert.equal(contieneAprobacion("No aprobado por presupuesto"), false)
    assert.equal(contieneAprobacion("Rechazado"), false)
  })
  it("unidad y texto breve SAP", () => {
    assert.equal(unidad("Bolsa de 100 horas de arquitectura"), "H")
    assert.equal(unidad("Licencias 120 puestos, vigencia 12 meses"), "UN")
    assert.equal(unidad("Soporte mensual"), "MES")
    assert.ok(textoBreve("x".repeat(80)).length <= 40)
  })
})

describe("controles RC1–RC10 sobre los fixtures", () => {
  it("sol-001 apta sin excepciones", async () => {
    const v = await validar("sol-001")
    assert.deepEqual([v.apta, v.bloqueos.length, v.confirmaciones.length], [true, 0, 0])
  })
  it("sol-002 bloqueo RC1 (proveedor inexistente) con acción sugerida", async () => {
    const v = await validar("sol-002")
    assert.deepEqual(codigos(v.bloqueos), ["RC1"])
    assert.match(v.bloqueos[0]?.detalle ?? "", /Acción: solicitar la creación del proveedor/)
  })
  it("sol-003 bloqueo RC2 (aprobador de otro centro) y escalamiento porque ningún aprobador tiene tope", async () => {
    const v = await validar("sol-003")
    assert.deepEqual(codigos(v.bloqueos), ["RC2"])
    assert.match(v.bloqueos[0]?.detalle ?? "", /escalar a la dirección financiera/)
  })
  it("sol-004 confirmación RC5 con ambos valores", async () => {
    const v = await validar("sol-004")
    assert.deepEqual(codigos(v.confirmaciones), ["RC5"])
    assert.match(v.confirmaciones[0]?.detalle ?? "", /26\.500\.000.*25\.000\.000/)
  })
  it("sol-005 retroactiva (RC8)", async () => {
    const v = await validar("sol-005")
    assert.equal(v.retroactiva, true)
    assert.deepEqual(codigos(v.confirmaciones), ["RC8"])
  })
  it("sol-006 IVA derivado con confirmación (RC6) y condiciones derivadas (RC7)", async () => {
    const v = await validar("sol-006")
    assert.deepEqual(codigos(v.confirmaciones), ["RC6"])
    assert.equal(v.derivados.indicador_iva?.valor, "C1")
    assert.equal(v.derivados.condiciones_pago?.valor, "Z030")
  })
  it("RC3, RC4, RC9 y RC10 con solicitudes modificadas", async () => {
    const ruta = join(p.dir, "fixtures/reto-03/solicitudes/sol-001/solicitud.json")
    const original = await readFile(ruta, "utf8")
    const s = JSON.parse(original) as Record<string, unknown>
    await writeFile(ruta, JSON.stringify({ ...s, cantidad: 700, valor_total: 66500000, subarea: "Marketing", fecha_solicitud: "2026-08-25" }))
    const v = await validar("sol-001")
    assert.deepEqual(codigos(v.bloqueos).sort(), ["RC3", "RC4"])
    assert.ok(codigos(v.confirmaciones).includes("RC9"))
    await writeFile(ruta, JSON.stringify({ ...s, valor_total: 999 }))
    assert.ok(codigos((await validar("sol-001")).bloqueos).includes("RC10"))
    await writeFile(ruta, original)
  })
})

describe("creación de OC en SAP simulado", () => {
  before(async () => rm(join(p.dir, "out"), { recursive: true, force: true }))

  it("sol-001 crea la OC 4500000001 y es idempotente", async () => {
    const a = await crear("sol-001")
    assert.deepEqual([a.data.numero_oc, a.data.idempotente], ["4500000001", false])
    const b = await crear("sol-001")
    assert.deepEqual([b.data.numero_oc, b.data.idempotente], ["4500000001", true])
  })
  it("bloqueos nunca se saltan, ni con confirmado=true", async () => {
    const r = await crear("sol-002", true, true)
    assert.equal(r.ok, false)
    assert.match(r.error ?? "", /bloqueada/)
  })
  it("confirmación: sin confirmar no crea; confirmado sin humano tampoco; con humano sí", async () => {
    assert.match((await crear("sol-004")).error ?? "", /requiere confirmación explícita/)
    assert.equal((await crear("sol-004", true, false)).ok, false)
    const r = await crear("sol-004", true, true)
    assert.equal(r.data.numero_oc, "4500000002")
  })
  it("sol-005 retroactiva queda marcada en control.csv", async () => {
    const r = await crear("sol-005", true, true)
    assert.equal(r.data.retroactiva, true)
    const control = await readFile(join(p.dir, "out/control.csv"), "utf8")
    assert.match(control, /^solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts$/m)
    assert.match(control, /SOL-2026-005,creada,4500000003,true/)
  })
  it("cada intento deja una fila en control.csv", async () => {
    const filas = (await readFile(join(p.dir, "out/control.csv"), "utf8")).trim().split("\n").slice(1)
    assert.deepEqual(filas.map((f) => f.split(",")[1]), ["creada", "idempotente", "bloqueada", "pendiente_confirmacion", "pendiente_confirmacion", "creada", "creada"])
  })
  it("las OC cumplen el esquema y la evidencia sha256 es verificable", async () => {
    const ordenes = (await readFile(join(p.dir, "out/sap/ordenes.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { orden: unknown })
    for (const o of ordenes) assert.ok(OrdenCompraSchema.safeParse(o.orden).success)
    const txt = await readFile(join(p.dir, "out/sol-004/aprobacion.txt"), "utf8")
    const [contenido, pie] = txt.split("\n\n---\n")
    const hash = pie?.match(/[0-9a-f]{64}/)?.[0]
    assert.equal(hash, sha256(contenido ?? ""))
    assert.ok(JSON.stringify(ordenes[1]).includes(hash ?? "x"))
    assert.equal((await readFile(join(p.dir, "out/sol-004/aprobacion.pdf"))).subarray(0, 4).toString(), "%PDF")
  })
  it("payload trazable: cada valor tiene fuente", async () => {
    const r = parse<{ ruta_trazabilidad: string }>(await oc.construir_payload.execute({ caso: "sol-006" }, ctx))
    const t = JSON.parse(await readFile(join(p.dir, r.data.ruta_trazabilidad), "utf8")) as Record<string, string>
    assert.match(t.proveedor ?? "", /nombre normalizado/)
    assert.match(t["posiciones[0].indicador_iva"] ?? "", /maestro\.proveedores/)
  })
})

describe("HU-6 errores", () => {
  it("JSON malformado, monto no numérico y caso inexistente dan errores legibles", async () => {
    const ruta = join(p.dir, "fixtures/reto-03/solicitudes/sol-006/solicitud.json")
    const original = await readFile(ruta, "utf8")
    await writeFile(ruta, "{malo")
    assert.match(parse(await oc.leer_paquete.execute({ caso: "sol-006" }, ctx)).error ?? "", /corrupto.*reenviar/)
    await writeFile(ruta, original.replace('"valor_total": 5400000', '"valor_total": "cinco millones"'))
    assert.match(parse(await oc.leer_paquete.execute({ caso: "sol-006" }, ctx)).error ?? "", /valor_total no numérico/)
    await writeFile(ruta, original)
    assert.match(parse(await oc.leer_paquete.execute({ caso: "no-existe" }, ctx)).error ?? "", /No se encontró correo.json/)
  })
  it("adjunto ausente: null con el nombre de lo que falta", async () => {
    await rm(join(p.dir, "fixtures/reto-03/solicitudes/sol-006/cotizacion.txt"))
    const r = parse<{ cotizacion: unknown; faltantes: string[] }>(await oc.leer_paquete.execute({ caso: "sol-006" }, ctx))
    assert.equal(r.data.cotizacion, null)
    assert.deepEqual(r.data.faltantes, ["cotización"])
  })
})
