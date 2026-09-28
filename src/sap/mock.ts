import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { agregarLinea } from "../core/archivos.ts"
import { fechaReferencia } from "../core/fechas.ts"
import type { Proveedor } from "../dominio/datos.ts"
import type { OrdenCompra, SapAdapter } from "./adapter.ts"

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

const PRIMER_NUMERO = 4500000001

/** SAP simulado sobre out/sap/ordenes.jsonl. Numeración secuencial e idempotencia por solicitud_id. */
export class SapMock implements SapAdapter {
  private readonly archivo: string
  constructor(
    carpeta: string,
    private readonly proveedores: Proveedor[],
  ) {
    this.archivo = join(carpeta, "ordenes.jsonl")
  }

  private async registros(): Promise<Registro[]> {
    const texto = await readFile(this.archivo, "utf8").catch(() => "")
    return texto.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Registro)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const p = this.proveedores.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const r = (await this.registros()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const existentes = await this.registros()
    const numero_oc = String(PRIMER_NUMERO + existentes.length)
    const fecha = fechaReferencia()
    await agregarLinea(this.archivo, JSON.stringify({ numero_oc, fecha, orden }))
    return { numero_oc, fecha }
  }
}
