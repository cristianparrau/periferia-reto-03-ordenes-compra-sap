import { stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { z } from "zod"
import { escribirTexto } from "../core/archivos.ts"
import { registrar } from "../core/log.ts"
import { definirHerramienta, fallo, ok, type ContextoHerramienta, type Resultado } from "../core/tipos.ts"
import { cargarMaestros, RUTAS } from "../dominio/datos.ts"
import { validar, type Validacion } from "../dominio/controles.ts"
import { registrarControl } from "../dominio/control.ts"
import { generarEvidencia } from "../dominio/evidencia.ts"
import { leerPaquete, type Paquete } from "../dominio/paquete.ts"
import { construirOrden } from "../dominio/payload.ts"
import { SapMock } from "../sap/mock.ts"

const argCaso = z.string().regex(/^[a-z0-9-]+$/, "caso inválido").describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, ej. sol-001")

async function responder<T>(ctx: ContextoHerramienta, herramienta: string, caso: string, r: Resultado<T>, resumen: (d: T) => string): Promise<string> {
  const existe = await stat(RUTAS.caso(ctx.directory, caso)).then(() => true, () => false)
  await registrar(ctx.directory, { herramienta, caso: existe ? caso : undefined, sessionId: ctx.sessionId, ok: r.ok, resumen: r.ok ? resumen(r.data) : r.error })
  return JSON.stringify(r)
}

async function seguro<T>(fn: () => Promise<Resultado<T>>): Promise<Resultado<T>> {
  try {
    return await fn()
  } catch (e) {
    return fallo(`Error inesperado: ${e instanceof Error ? e.message : "desconocido"}`)
  }
}

const rel = (ctx: ContextoHerramienta, ruta: string) => relative(ctx.directory, ruta).replaceAll("\\", "/")

/** Las herramientas siempre releen el paquete desde la fuente: el modelo no transporta montos entre pasos. */
async function paqueteValidado(dir: string, caso: string): Promise<Resultado<{ paquete: Paquete; validacion: Validacion }>> {
  const paquete = await leerPaquete(dir, caso)
  if (!paquete.ok) return paquete
  const maestros = await cargarMaestros(dir)
  if (!maestros.ok) return maestros
  return ok({ paquete: paquete.data, validacion: validar(paquete.data, maestros.data) })
}

export const leer_paquete = definirHerramienta({
  description: "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si existe) de un caso y los devuelve normalizados.",
  args: { caso: argCaso },
  async execute({ caso }, ctx) {
    const r = await seguro(async () => {
      const p = await leerPaquete(ctx.directory, caso)
      if (!p.ok) return p
      const { aprobacion_cruda: _omitido, ...visible } = p.data
      return ok({ ...visible, cotizacion: visible.cotizacion ? { ...visible.cotizacion, texto: undefined } : null })
    })
    return responder(ctx, "oc_leer_paquete", caso, r, (d) => `${d.solicitud.solicitud_id}: ${d.solicitud.proveedor_nombre}, ${d.solicitud.valor_total} ${d.solicitud.moneda}${d.faltantes.length ? `, faltan: ${d.faltantes.join(", ")}` : ""}`)
  },
})

export const validar_paquete = definirHerramienta({
  description: "Valida el paquete contra maestros y controles RC1–RC10: devuelve apta, bloqueos, confirmaciones, valores derivados y si es retroactiva.",
  args: { caso: argCaso },
  async execute({ caso }, ctx) {
    const r = await seguro(async () => {
      const v = await paqueteValidado(ctx.directory, caso)
      return v.ok ? ok(v.data.validacion) : v
    })
    return responder(ctx, "oc_validar", caso, r, (d) => `apta=${d.apta}, bloqueos=[${d.bloqueos.map((b) => b.codigo)}], confirmaciones=[${d.confirmaciones.map((c) => c.codigo)}], retroactiva=${d.retroactiva}`)
  },
})

export const construir_payload = definirHerramienta({
  description: "Construye la orden de compra exactamente como quedaría en SAP (validada con esquema) y guarda la trazabilidad de cada valor.",
  args: { caso: argCaso },
  async execute({ caso }, ctx) {
    const r = await seguro(async () => {
      const v = await paqueteValidado(ctx.directory, caso)
      if (!v.ok) return v
      if (!v.data.validacion.apta) return fallo(`No se construye la OC: ${v.data.validacion.bloqueos.map((b) => b.detalle).join(" | ")}`)
      const c = construirOrden(v.data.paquete, v.data.validacion, null)
      if (!c.ok) return c
      const ruta = join(RUTAS.salida(ctx.directory, caso), "trazabilidad.json")
      await escribirTexto(ruta, JSON.stringify(c.data.trazabilidad, null, 2))
      await escribirTexto(join(RUTAS.salida(ctx.directory, caso), "payload.json"), JSON.stringify(c.data.orden, null, 2))
      return ok({ orden: c.data.orden, ruta_trazabilidad: rel(ctx, ruta), confirmaciones_pendientes: v.data.validacion.confirmaciones })
    })
    return responder(ctx, "oc_construir_payload", caso, r, (d) => `OC ${d.orden.proveedor.nombre}, ${d.orden.posiciones.length} posición(es), trazabilidad en ${d.ruta_trazabilidad}`)
  },
})

export const generar_evidencia = definirHerramienta({
  description: "Genera la evidencia del correo de aprobación (aprobacion.txt y aprobacion.pdf) con su hash sha256.",
  args: { caso: argCaso },
  async execute({ caso }, ctx) {
    const r = await seguro(async () => {
      const p = await leerPaquete(ctx.directory, caso)
      if (!p.ok) return p
      if (!p.data.aprobacion_cruda) return fallo("No hay correo de aprobación para generar la evidencia. Pídelo al solicitante.")
      const e = await generarEvidencia(p.data.aprobacion_cruda, RUTAS.salida(ctx.directory, caso))
      return ok({ ruta: rel(ctx, e.txt), ruta_pdf: rel(ctx, e.pdf), sha256: e.sha256 })
    })
    return responder(ctx, "oc_generar_evidencia", caso, r, (d) => `${d.ruta} sha256=${d.sha256.slice(0, 12)}…`)
  },
})

type CreacionOC = { numero_oc: string; fecha: string | null; idempotente: boolean; retroactiva: boolean; evidencia?: string }

export const crear = definirHerramienta({
  description: "Crea la OC en SAP (simulado) si está apta; si hay confirmaciones pendientes exige confirmado=true tras confirmación explícita del usuario. Idempotente por solicitud.",
  args: {
    caso: argCaso,
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje"),
  },
  async execute({ caso, confirmado }, ctx) {
    const r = await seguro<CreacionOC>(async () => {
      const v = await paqueteValidado(ctx.directory, caso)
      if (!v.ok) return v
      const { paquete, validacion } = v.data
      const maestros = await cargarMaestros(ctx.directory)
      if (!maestros.ok) return maestros
      const sap = new SapMock(RUTAS.sap(ctx.directory), maestros.data.proveedores)
      const fila = { solicitud_id: paquete.solicitud.solicitud_id, retroactiva: validacion.retroactiva, bloqueos: validacion.bloqueos, confirmaciones: validacion.confirmaciones }

      const existente = await sap.buscarOrdenPorReferencia(paquete.solicitud.solicitud_id)
      if (existente) {
        await registrarControl(ctx.directory, { ...fila, resultado: "idempotente", numero_oc: existente.numero_oc })
        return ok({ numero_oc: existente.numero_oc, fecha: null, idempotente: true, retroactiva: validacion.retroactiva })
      }
      if (!validacion.apta) {
        await registrarControl(ctx.directory, { ...fila, resultado: "bloqueada", numero_oc: null })
        return fallo(`OC bloqueada: ${validacion.bloqueos.map((b) => `[${b.codigo}] ${b.detalle}`).join(" | ")}`)
      }
      const confirmacionValida = confirmado === true && ctx.confirmacionHumana !== false
      if (validacion.confirmaciones.length > 0 && !confirmacionValida) {
        await registrarControl(ctx.directory, { ...fila, resultado: "pendiente_confirmacion", numero_oc: null })
        return fallo(`requiere confirmación explícita: ${validacion.confirmaciones.map((c) => `[${c.codigo}] ${c.detalle}`).join(" | ")}`)
      }
      if (!paquete.aprobacion_cruda) return fallo("No hay correo de aprobación.")
      const evidencia = await generarEvidencia(paquete.aprobacion_cruda, RUTAS.salida(ctx.directory, caso))
      const quien = validacion.confirmaciones.length ? `analista (sesión ${ctx.sessionId})` : null
      const c = construirOrden(paquete, validacion, quien)
      if (!c.ok) return c
      const creada = await sap.crearOrden(c.data.orden)
      await registrarControl(ctx.directory, { ...fila, resultado: "creada", numero_oc: creada.numero_oc })
      return ok({ numero_oc: creada.numero_oc, fecha: creada.fecha, idempotente: false, retroactiva: validacion.retroactiva, evidencia: rel(ctx, evidencia.txt) })
    })
    return responder(ctx, "oc_crear", caso, r, (d) => `OC ${d.numero_oc}${d.idempotente ? " (ya existía)" : " creada"}${d.retroactiva ? " RETROACTIVA" : ""}`)
  },
})
