import type { Centro, Maestros, Proveedor } from "./datos.ts"
import type { Paquete } from "./paquete.ts"
import { normalizarNit, normalizarNombre } from "./parseo.ts"

export type Hallazgo = { codigo: string; detalle: string }

export type Derivados = {
  proveedor: { codigo_sap: string; nit: string; nombre: string } | null
  condiciones_pago: { valor: string; fuente: string } | null
  indicador_iva: { valor: string; fuente: string } | null
}

export type Validacion = { apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: Derivados; retroactiva: boolean }

const pesos = (n: number) => `COP ${n.toLocaleString("es-CO")}`
const soloFecha = (iso: string) => iso.slice(0, 10)

/** RC1: por NIT; si no hay NIT, por nombre normalizado. Debe existir y estar activo. */
function rc1(p: Paquete, m: Maestros, h: Hallazgo[], c: Hallazgo[]): Proveedor | null {
  const s = p.solicitud
  const nit = s.proveedor_nit ? normalizarNit(s.proveedor_nit) : null
  const prov = nit ? m.proveedores.find((x) => x.nit === nit) : m.proveedores.find((x) => normalizarNombre(x.nombre) === normalizarNombre(s.proveedor_nombre))
  if (!prov) {
    h.push({ codigo: "RC1", detalle: `Proveedor "${s.proveedor_nombre}"${nit ? ` (NIT ${nit})` : ""} no existe en el maestro. Acción: solicitar la creación del proveedor en SAP (RUT, certificación bancaria) antes de la OC.` })
    return null
  }
  if (!prov.activo) h.push({ codigo: "RC1", detalle: `Proveedor ${prov.nombre} está inactivo en SAP. Acción: solicitar su reactivación o elegir otro proveedor.` })
  if (p.cotizacion?.nit && p.cotizacion.nit !== prov.nit) c.push({ codigo: "RC1-NIT", detalle: `El NIT de la cotización (${p.cotizacion.nit}) no coincide con el del proveedor (${prov.nit}).` })
  return prov
}

/** RC2 y RC3: aprobación explícita, de un aprobador del centro, con tope suficiente. */
function rc2rc3(p: Paquete, centro: Centro | undefined, h: Hallazgo[]): void {
  const s = p.solicitud
  if (!p.aprobacion) return void h.push({ codigo: "RC2", detalle: "No hay correo de aprobación. Acción: pedir al solicitante el correo de aprobación de su líder." })
  if (!p.aprobacion.aprobado) h.push({ codigo: "RC2", detalle: `El correo de ${p.aprobacion.de} no contiene "Aprobado". Acción: pedir aprobación explícita.` })
  if (!centro) return
  const aprobador = centro.aprobadores.find((a) => a.email.toLowerCase() === p.aprobacion?.de.toLowerCase())
  const maxTope = Math.max(...centro.aprobadores.map((a) => a.tope))
  if (!aprobador) {
    const quienes = centro.aprobadores.filter((a) => a.tope >= s.valor_total).map((a) => `${a.nombre} (${a.email})`)
    const accion = quienes.length ? `pedir aprobación a ${quienes.join(" o ")}` : `ningún aprobador de ${centro.centro_costo} tiene tope suficiente (máx. ${pesos(maxTope)}); escalar a la dirección financiera`
    return void h.push({ codigo: "RC2", detalle: `${p.aprobacion.de} no es aprobador del centro ${centro.centro_costo} (${centro.nombre}). Acción: ${accion}.` })
  }
  if (s.valor_total > aprobador.tope) {
    const superior = centro.aprobadores.find((a) => a.tope >= s.valor_total)
    h.push({ codigo: "RC3", detalle: `${pesos(s.valor_total)} supera el tope de ${aprobador.nombre} (${pesos(aprobador.tope)}). Acción: ${superior ? `aprobación de ${superior.nombre}` : "escalar a la dirección financiera"}.` })
  }
}

/** RC5: diferencia cotización vs solicitud ≤ 2 %; sin cotización se confirma. */
function rc5(p: Paquete, c: Hallazgo[]): void {
  const s = p.solicitud
  if (!p.cotizacion) return void c.push({ codigo: "RC5", detalle: "No hay cotización legible; confirmar que se crea la OC sin cotización." })
  const dif = Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total
  if (dif > 0.02) c.push({ codigo: "RC5", detalle: `Cotización ${pesos(p.cotizacion.total)} vs solicitud ${pesos(s.valor_total)} (diferencia ${(dif * 100).toFixed(1)} %). La OC se crearía por el valor de la solicitud.` })
}

function rc6rc7(p: Paquete, prov: Proveedor | null, m: Maestros, h: Hallazgo[], c: Hallazgo[], d: Derivados): void {
  const s = p.solicitud
  if (s.indicador_iva) {
    if (!m.iva.includes(s.indicador_iva)) h.push({ codigo: "IVA", detalle: `Indicador de IVA ${s.indicador_iva} no existe en el maestro.` })
    d.indicador_iva = { valor: s.indicador_iva, fuente: "solicitud" }
  } else if (prov) {
    d.indicador_iva = { valor: prov.indicador_iva_default, fuente: "maestro.proveedores (indicador_iva_default)" }
    c.push({ codigo: "RC6", detalle: `La solicitud no trae indicador de IVA; se propone ${prov.indicador_iva_default} (default del proveedor).` })
  }
  if (s.condiciones_pago) {
    if (!m.condiciones.includes(s.condiciones_pago)) h.push({ codigo: "CPAGO", detalle: `Condición de pago ${s.condiciones_pago} no existe en el maestro.` })
    d.condiciones_pago = { valor: s.condiciones_pago, fuente: "solicitud" }
  } else if (prov) d.condiciones_pago = { valor: prov.condiciones_pago_default, fuente: "maestro.proveedores (condiciones_pago_default)" }
}

/** Aplica RC1–RC10. Bloqueos impiden crear; confirmaciones requieren confirmado=true. */
export function validar(p: Paquete, m: Maestros): Validacion {
  const s = p.solicitud
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Derivados = { proveedor: null, condiciones_pago: null, indicador_iva: null }

  if (!["COP", "USD"].includes(s.moneda)) bloqueos.push({ codigo: "MONEDA", detalle: `Moneda ${s.moneda} no soportada (COP o USD).` })
  const prov = rc1(p, m, bloqueos, confirmaciones)
  if (prov) derivados.proveedor = { codigo_sap: prov.codigo_sap, nit: prov.nit, nombre: prov.nombre }
  const centro = m.centros.find((c) => c.centro_costo === s.centro_costo)
  if (!centro) bloqueos.push({ codigo: "RC4", detalle: `Centro de costo ${s.centro_costo} no existe.` })
  rc2rc3(p, centro, bloqueos)
  if (centro && !centro.subareas.includes(s.subarea)) bloqueos.push({ codigo: "RC4", detalle: `La subárea "${s.subarea}" no pertenece a ${centro.centro_costo} (${centro.subareas.join(", ")}).` })
  rc5(p, confirmaciones)
  rc6rc7(p, prov, m, bloqueos, confirmaciones, derivados)
  const retroactiva = p.factura !== null && p.factura.fecha < s.fecha_solicitud
  if (retroactiva && p.factura) confirmaciones.push({ codigo: "RC8", detalle: `OC retroactiva: la factura ${p.factura.numero} (${p.factura.fecha}) es anterior a la solicitud (${s.fecha_solicitud}). Quedará marcada en el control.` })
  if (p.aprobacion && soloFecha(p.aprobacion.fecha) < s.fecha_solicitud) confirmaciones.push({ codigo: "RC9", detalle: `La aprobación (${soloFecha(p.aprobacion.fecha)}) es anterior a la solicitud (${s.fecha_solicitud}).` })
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > 1) bloqueos.push({ codigo: "RC10", detalle: `Cantidad × valor unitario = ${pesos(calculado)} no coincide con el valor total ${pesos(s.valor_total)}. Acción: corregir la solicitud.` })

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva }
}
