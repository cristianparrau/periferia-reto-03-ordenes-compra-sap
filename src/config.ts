import { crear, construir_payload, generar_evidencia, leer_paquete, validar_paquete } from "./tools/oc.ts"

/** Nombre que ve el modelo: "oc_<export>". validar_paquete se expone como "validar" (contrato del PRD). */
export const APLICACION = {
  nombre: "Órdenes de compra SAP",
  ejemplo: "Procesa la solicitud \"sol-004\" y no la crees hasta que yo lo confirme.",
  prefijo: "oc",
  herramientas: { leer_paquete, validar: validar_paquete, construir_payload, generar_evidencia, crear },
}
