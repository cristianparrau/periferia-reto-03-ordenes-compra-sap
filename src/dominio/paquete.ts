import { join } from "node:path"
import { leerJson } from "../core/archivos.ts"
import { fallo, ok, type Resultado } from "../core/tipos.ts"
import { AprobacionSchema, CorreoSchema, leerTexto, RUTAS, SolicitudSchema, type AprobacionCruda, type Solicitud } from "./datos.ts"
import { contieneAprobacion, parsearCotizacion, parsearFactura, type Cotizacion, type Factura } from "./parseo.ts"

/** Paquete normalizado (sección 7.2 del PRD). Adjunto ausente → null + nombre en `faltantes`. */
export type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: { de: string; fecha: string; aprobado: boolean; texto: string } | null
  factura: Factura | null
  faltantes: string[]
  aprobacion_cruda: AprobacionCruda | null
}

export async function leerPaquete(dir: string, caso: string): Promise<Resultado<Paquete>> {
  const base = RUTAS.caso(dir, caso)
  const correo = await leerJson(join(base, "correo.json"), CorreoSchema, "correo.json")
  if (!correo.ok) return fallo(`Caso "${caso}": ${correo.error}`)
  const solicitud = await leerJson(join(base, "solicitud.json"), SolicitudSchema, "solicitud.json (Excel de solicitud)")
  if (!solicitud.ok) return fallo(`${solicitud.error} Pide al solicitante reenviar el Excel de solicitud.`)
  const faltantes: string[] = []
  const textoCot = await leerTexto(join(base, "cotizacion.txt"))
  const cotizacion = textoCot ? parsearCotizacion(textoCot) : null
  if (!cotizacion) faltantes.push(textoCot ? "cotización ilegible" : "cotización")
  const aprob = await leerJson(join(base, "aprobacion.json"), AprobacionSchema, "aprobacion.json")
  if (!aprob.ok) faltantes.push("correo de aprobación")
  const textoFac = await leerTexto(join(base, "factura.txt"))
  const factura = textoFac ? parsearFactura(textoFac) : null
  if (textoFac && !factura) faltantes.push("factura ilegible")
  const c = correo.data
  return ok({
    correo: { id: c.id, de: c.de, asunto: c.asunto, fecha: c.fecha },
    solicitud: solicitud.data,
    cotizacion,
    aprobacion: aprob.ok ? { de: aprob.data.de, fecha: aprob.data.fecha, aprobado: contieneAprobacion(aprob.data.cuerpo), texto: aprob.data.cuerpo } : null,
    factura,
    faltantes,
    aprobacion_cruda: aprob.ok ? aprob.data : null,
  })
}
