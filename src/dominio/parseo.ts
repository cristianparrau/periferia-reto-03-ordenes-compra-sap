/** Extracción determinista de los textos de cotización y factura (sin LLM). */

export function soloDigitos(texto: string): string {
  return texto.replace(/\D/g, "")
}

/** "900.555.111-2" → "900555111" (sin puntos ni dígito de verificación). */
export function normalizarNit(texto: string): string {
  return soloDigitos(texto.split("-")[0] ?? texto)
}

/** "COP 11.400.000" → 11400000. Formato colombiano: punto como separador de miles. */
export function monto(texto: string): number | null {
  const m = texto.match(/([\d.]+)(?:,(\d{1,2}))?/)
  if (!m?.[1]) return null
  return Number(m[1].replace(/\./g, "") + (m[2] ? `.${m[2]}` : ""))
}

function campo(texto: string, patron: RegExp): string | null {
  return texto.match(patron)?.[1]?.trim() ?? null
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(fecha + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

export type Cotizacion = { referencia: string | null; proveedor: string; nit: string | null; total: number; moneda: string; fecha: string | null; validez_hasta: string | null; texto: string }

export function parsearCotizacion(texto: string): Cotizacion | null {
  const total = texto.match(/TOTAL[^:\n]*:\s*([A-Z]{3})\s*([\d.,]+)/i)
  const proveedor = campo(texto, /Proveedor:\s*(.+)/i)
  if (!total?.[1] || !total[2] || !proveedor) return null
  const fecha = campo(texto, /Fecha:\s*(\d{4}-\d{2}-\d{2})/i)
  const dias = campo(texto, /Validez[^:]*:\s*(\d+)\s*d[ií]as/i)
  const nit = campo(texto, /NIT:\s*([\d.\-]+)/i)
  return {
    referencia: campo(texto, /COTIZACI[OÓ]N\s+([\w-]+)/i),
    proveedor,
    nit: nit ? normalizarNit(nit) : null,
    total: monto(total[2]) ?? 0,
    moneda: total[1].toUpperCase(),
    fecha,
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
  }
}

export type Factura = { numero: string; fecha: string; total: number }

export function parsearFactura(texto: string): Factura | null {
  const numero = campo(texto, /No\.\s*([\w-]+)/i)
  const fecha = campo(texto, /Fecha de emisi[oó]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const total = campo(texto, /TOTAL:\s*[A-Z]{3}\s*([\d.,]+)/i)
  if (!numero || !fecha || !total) return null
  return { numero, fecha, total: monto(total) ?? 0 }
}

/** "Aprobado" explícito y sin negación ("no aprobado", "rechazado"). */
export function contieneAprobacion(cuerpo: string): boolean {
  const t = cuerpo.toLowerCase()
  if (/\bno\s+aprobad|rechazad|no se aprueba/.test(t)) return false
  return /aprobad[oa]/.test(t)
}

export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(s a s|sas|s a|sa|ltda|s de r l)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
