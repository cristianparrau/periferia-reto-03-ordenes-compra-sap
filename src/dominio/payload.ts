import { OrdenCompraSchema, type OrdenCompra } from "../sap/adapter.ts"
import type { Validacion } from "./controles.ts"
import { sha256, textoEvidencia } from "./evidencia.ts"
import type { Paquete } from "./paquete.ts"
import { fallo, ok, type Resultado } from "../core/tipos.ts"

const LIMITE_TEXTO_SAP = 40

/** Unidad de medida inferida de la descripción; por defecto unidades. */
export function unidad(descripcion: string): "UN" | "H" | "MES" {
  const t = descripcion.toLowerCase()
  if (/\bhoras?\b/.test(t)) return "H"
  // "vigencia 12 meses" describe el producto, no la unidad de compra: solo cuenta "mensual" o "por mes".
  if (/mensual|por mes\b|mensualidad/.test(t)) return "MES"
  return "UN"
}

export function textoBreve(descripcion: string): string {
  return descripcion.length <= LIMITE_TEXTO_SAP ? descripcion : descripcion.slice(0, LIMITE_TEXTO_SAP - 1).trimEnd() + "…"
}

export type Construccion = { orden: OrdenCompra; trazabilidad: Record<string, string> }

/** Arma la OC; cada valor lleva su fuente (solicitud, cotizacion, maestro.<nombre> o derivado). */
export function construirOrden(p: Paquete, v: Validacion, confirmadoPor: string | null): Resultado<Construccion> {
  const s = p.solicitud
  const d = v.derivados
  if (!d.proveedor || !d.condiciones_pago || !d.indicador_iva || !p.aprobacion || !p.aprobacion_cruda) return fallo("No se puede construir la OC: hay bloqueos sin resolver (proveedor, aprobación o condiciones).")
  const descripcion = textoBreve(s.descripcion)
  const orden = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000" as const,
    organizacion_compras: "1000" as const,
    proveedor: d.proveedor,
    moneda: s.moneda as "COP" | "USD",
    condiciones_pago: d.condiciones_pago.valor,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: sha256(textoEvidencia(p.aprobacion_cruda)) },
    posiciones: [{ numero: 10, descripcion, cantidad: s.cantidad, unidad: unidad(s.descripcion), precio_unitario: s.valor_unitario, centro_costo: s.centro_costo, subarea: s.subarea, indicador_iva: d.indicador_iva.valor }],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: confirmadoPor })),
  }
  const validada = OrdenCompraSchema.safeParse(orden)
  if (!validada.success) return fallo(`La OC no cumple el esquema: ${validada.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`)
  const trazabilidad: Record<string, string> = {
    "referencia.solicitud_id": "solicitud", "referencia.correo_id": "correo", "referencia.cotizacion_ref": "cotizacion",
    "sociedad": "derivado (constante de la sociedad)", "organizacion_compras": "derivado (constante)",
    "proveedor": s.proveedor_nit ? "maestro.proveedores (por NIT de la solicitud)" : "maestro.proveedores (por nombre normalizado; la solicitud no trae NIT)",
    "moneda": "solicitud", "condiciones_pago": d.condiciones_pago.fuente,
    "aprobador.email": "aprobacion", "aprobador.fecha_aprobacion": "aprobacion", "aprobador.evidencia_sha256": "derivado (sha256 del correo de aprobación)",
    "posiciones[0].descripcion": descripcion === s.descripcion ? "solicitud" : `derivado (solicitud truncada a ${LIMITE_TEXTO_SAP} caracteres)`,
    "posiciones[0].cantidad": "solicitud", "posiciones[0].unidad": "derivado (inferida de la descripción)", "posiciones[0].precio_unitario": "solicitud",
    "posiciones[0].centro_costo": "solicitud", "posiciones[0].subarea": "solicitud", "posiciones[0].indicador_iva": d.indicador_iva.fuente,
  }
  return ok({ orden: validada.data, trazabilidad })
}
