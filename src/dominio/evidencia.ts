import { createHash } from "node:crypto"
import { join } from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { escribirTexto } from "../core/archivos.ts"
import type { AprobacionCruda } from "./datos.ts"

/** Contenido canónico del correo de aprobación: el sha256 se calcula sobre este texto exacto. */
export function textoEvidencia(a: AprobacionCruda): string {
  return [`De: ${a.de}`, `Para: ${a.para}`, `CC: ${(a.cc ?? []).join(", ")}`, `Fecha: ${a.fecha}`, `Asunto: ${a.asunto}`, "", a.cuerpo].join("\n")
}

export const sha256 = (texto: string) => createHash("sha256").update(texto, "utf8").digest("hex")

/** P0: aprobacion.txt con encabezados, cuerpo y sha256. P1: aprobacion.pdf con el mismo contenido. */
export async function generarEvidencia(a: AprobacionCruda, salida: string): Promise<{ txt: string; pdf: string; sha256: string }> {
  const contenido = textoEvidencia(a)
  const hash = sha256(contenido)
  const txt = join(salida, "aprobacion.txt")
  await escribirTexto(txt, `${contenido}\n\n---\nsha256 (contenido anterior a esta línea): ${hash}\n`)
  const doc = await PDFDocument.create()
  const pagina = doc.addPage([595, 842])
  const fuente = await doc.embedFont(StandardFonts.Helvetica)
  let y = 790
  const lineas = `${contenido}\n\nsha256: ${hash}`.split("\n").flatMap((l) => l.match(/.{1,90}/g) ?? [""])
  for (const linea of lineas) {
    pagina.drawText(linea, { x: 50, y, size: 10, font: fuente })
    y -= 16
  }
  const pdf = join(salida, "aprobacion.pdf")
  await escribirTexto(pdf, await doc.save())
  return { txt, pdf, sha256: hash }
}
