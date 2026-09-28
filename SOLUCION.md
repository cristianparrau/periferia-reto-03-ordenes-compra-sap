# SOLUCIÓN — Reto 03 · Órdenes de Compra SAP

## 1. Problema en una frase
Cada compra obliga a la analista administrativa a digitar a mano la OC en SAP y a verificar de memoria que el proveedor, el aprobador y el monto cumplen las reglas. Esto cuesta tiempo, genera errores que se corrigen en el cierre contable y hace invisible cuántas OC se crean después de la factura.

## 2. Arquitectura
```
web/index.html (chat) ──HTTP──▶ src/server.ts ──▶ src/agente.ts (ciclo) ──▶ src/llm/adapter.ts ◀── gemini.ts
                                                        │
                                                        ▼
                                      src/core/registro-herramientas.ts (valida con zod)
                                                        ▼
                                      src/tools/oc.ts ──▶ src/dominio/* ──▶ src/sap/adapter.ts ◀── mock.ts
                                                        │
                                 fixtures/reto-03 (solo lectura)        out/ (sap/, control.csv, <caso>/)
```
- **Comportamiento**: `agent/prompt.md`.
- **Conocimiento**: `src/knowledge/ordenes-compra.md`.
- **Ejecución**: `src/tools/oc.ts` delega en `src/dominio/` (paquete, parseo, controles, payload, evidencia, control) y en `src/sap/`.
- El núcleo (ciclo, servidor, adaptador LLM, front) es el mismo de los otros retos. Solo cambia `src/config.ts`.

## 3. Ciclo del agente
- Bucle modelo → herramientas → modelo con tope `MAX_ITERACIONES` (25), tope de tokens por sesión y timeout al proveedor.
- Cada llamada queda visible en el chat y en `out/log.jsonl` (y en `out/<caso>/log.jsonl`).
- **Confirmación humana con doble candado:**
  - El agente termina con `[CONFIRMAR]`; el servidor marca `needsConfirmation` y el front lo resalta.
  - En el siguiente turno el servidor calcula `confirmacionHumana` a partir del mensaje del usuario. `oc_crear` exige `confirmado: true` **y** esa confirmación, así que el modelo no puede confirmar por su cuenta.
  - Los **bloqueos nunca se saltan**, ni siquiera con `confirmado: true` (probado en la demo con sol-002).

## 4. Elección del modelo
- **Gemini 2.5 Flash** por REST, temperatura 0.
- Los controles son 100 % deterministas; el modelo solo orquesta, presenta la tabla y pide la confirmación. Un modelo rápido y económico es suficiente.
- **Costo estimado**: ~5–6 llamadas × ~7 k tokens ≈ 40 k tokens por solicitud, alrededor de **USD 0,01–0,02 por OC** con precios de lista de Flash (verificar la tarifa vigente).

## 5. Matriz de controles
| Regla | Implementación (`src/dominio/controles.ts`) | Tipo |
|---|---|---|
| RC1 | Busca por NIT normalizado (sin puntos ni DV); sin NIT, por nombre normalizado (sin tildes ni sufijos S.A.S./Ltda.). Verifica `activo`. Extra: confirma si el NIT de la cotización difiere. | Bloqueo |
| RC2 | Aprobación existe, contiene "Aprobado" sin negación ("no aprobado", "rechazado") y el remitente está en `aprobadores` del centro. | Bloqueo |
| RC3 | `valor_total ≤ tope` del aprobador; la acción sugiere quién sí puede aprobar. | Bloqueo |
| RC4 | Centro existe y la subárea le pertenece. | Bloqueo |
| RC5 | `|cotización − solicitud| / solicitud > 2 %` o sin cotización. Muestra ambos valores. | Confirmación |
| RC6 | IVA ausente → `indicador_iva_default` del proveedor. | Confirmación + derivado |
| RC7 | Condición de pago ausente → `condiciones_pago_default`. | Derivado |
| RC8 | Factura con fecha < `fecha_solicitud` → `retroactiva = true`, marcada en `control.csv`. | Confirmación |
| RC9 | Fecha de aprobación < `fecha_solicitud`. | Confirmación |
| RC10 | `|cantidad × valor_unitario − valor_total| > 1`. | Bloqueo |

**La más difícil: RC2/RC3 en sol-003.** La aprobación es de un aprobador real, pero de otro centro (Comercial), y el caso no se resuelve cambiando de aprobador: ningún aprobador de Administración tiene tope para 74 M (el máximo es 30 M). Por eso la acción sugerida no es "pide otra aprobación" sino "escala a la dirección financiera". Otras decisiones delicadas:
- **Unidad**: "vigencia 12 meses" no significa unidad MES; son 120 licencias (UN).
- **Texto breve**: se trunca a 40 caracteres y la trazabilidad lo marca como derivado.

## 6. Diseño del adaptador SAP real
- **Opción elegida**: OData `API_PURCHASEORDER_PROCESS_SRV` (S/4HANA), expuesto a través de SAP Integration Suite o SAP BTP.
  - **Por qué**: es la API estándar liberada para crear OC, usa REST/JSON (encaja con Node) y no requiere conectores RFC nativos.
  - **Alternativa**: si el sistema es ECC, `BAPI_PO_CREATE1` vía RFC con un conector (node-rfc o un middleware).
  - **Dado que la viabilidad no está confirmada**, la interfaz `SapAdapter` permite cambiar de implementación sin tocar herramientas ni agente.
- **Mapeo**:
  - `proveedor.codigo_sap` → `Supplier`
  - `sociedad` → `CompanyCode`
  - `organizacion_compras` → `PurchasingOrganization`
  - `condiciones_pago` → `PaymentTerms`
  - `moneda` → `DocumentCurrency`
  - `posiciones[]` → `to_PurchaseOrderItem` (`PurchaseOrderItem` = numero, `PurchaseOrderItemText` = descripcion, `OrderQuantity`, `PurchaseOrderQuantityUnit`, `NetPriceAmount`, `TaxCode`)
  - Imputación → `to_AccountAssignment` (`CostCenter`; la subárea como `WBSElement` u objeto CO según la configuración)
  - `referencia.solicitud_id` → campo de referencia del encabezado (`CorrespncExternalReference`)
  - Evidencia → adjunto vía `API_CV_ATTACHMENT_SRV`
- **Autenticación**: OAuth2 client credentials (BTP) o usuario técnico. Credenciales en un gestor de secretos (Key Vault), inyectadas como variables al backend. Nunca en el agente, el prompt ni los logs. Permisos mínimos: solo crear OC.
- **Idempotencia**: antes de crear, `buscarOrdenPorReferencia(solicitud_id)` consulta en SAP por la referencia externa. Los reintentos usan backoff y vuelven a consultar antes de reintentar la creación.
- **Error parcial** (OC creada pero falla el adjunto): se registra la OC con estado "evidencia pendiente" en control y se reintenta solo el adjunto. Nunca se crea una segunda OC.
- **Plan B sin conexión**:
  - Generar un archivo de carga masiva (plantilla LSMW/Migration Cockpit o CSV) con las OC ya validadas.
  - O entregar el payload como tabla lista para copiar campo por campo en ME21N.
  - La validación y la evidencia siguen ahorrando la mayor parte del trabajo.

## 7. Lectura del proceso (para la dirección)
La demo muestra un caso real del patrón: sol-005 llega con factura del 10-ago para una solicitud del 27-ago, y la aprobación dice "ya llegó la factura, por favor crear la OC para poder radicarla". La OC deja de ser un control previo al gasto y se convierte en un trámite para poder pagar: la cotización no se compara y el aprobador valida un gasto ya comprometido.

**Propuesta:**
1. **Medir**: `control.csv` marca cada OC retroactiva. Reportar mensualmente el porcentaje por centro de costo y por proveedor.
2. **Regla**: "sin OC no se radica factura". Contabilidad devuelve facturas sin OC previa, salvo excepciones de urgencia aprobadas por la dirección financiera.
3. **Facilitar el camino correcto**: con el agente, crear una OC toma minutos, así que la excusa del tiempo desaparece.
4. **Decisión pendiente**: tolerar las retroactivas con marca o rechazarlas. El agente ya las mide para que la dirección decida con datos.

## 8. Decisiones y trade-offs
| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Las herramientas reciben solo `caso` (+`confirmado`) y releen el paquete desde la fuente | Pasar `paquete`/`payload` del modelo entre herramientas, como sugiere el contrato | El modelo no puede alterar un monto entre pasos (riesgo del PRD). `oc_crear` recalcula y valida todo antes de crear. |
| Controles deterministas en código | Validación con el LLM | Auditables, reproducibles y testeables. Un control financiero no puede depender de una respuesta probabilística. |
| Parseo de cotización y factura con regex | Extracción con el LLM | El formato es estable y hay que interpretar el formato colombiano de miles (11.400.000). Un fallo devuelve `null` con el nombre de lo faltante, nunca un valor inventado. |
| Idempotencia consultando SAP por referencia | Bandera local "ya creada" | Funciona igual con el SAP real y ante reintentos o reinicios. |
| OC por el valor de la solicitud aunque la cotización difiera (con confirmación) | Usar el valor de la cotización | La solicitud es lo aprobado; la diferencia se muestra y la decide el humano. |

## 9. Supuestos
- `valor_total` e importes de cotización incluyen IVA (así lo indican las cotizaciones).
- Cada solicitud genera una sola posición (10).
- Se compara solo la fecha de la aprobación, ignorando la hora.
- Si el aprobador no pertenece al centro, RC3 no se evalúa por separado, pero la acción informa si algún aprobador del centro tiene tope suficiente.
- La fecha de la OC en el SAP simulado es la fecha de ejecución.

## 10. Cobertura
Pruebas automatizadas: `npm test` (node:test) cubre el entorno, el ciclo del agente, el adaptador, el servidor con distintos `.env` y el dominio; ver README.

| HU | Estado | Falta para producción |
|---|---|---|
| HU-1 Leer paquete | Hecho | Leer `.xlsx`, `.pdf` y `.eml` reales (P1 `oc_leer_excel` no implementado). |
| HU-2 Validar | Hecho (RC1–RC10) | Maestros en línea desde SAP. |
| HU-3 Payload | Hecho, con esquema zod y trazabilidad | — |
| HU-4 Evidencia | txt + sha256 (P0) y pdf (P1) hechos | Firma digital si auditoría la exige. |
| HU-5 Crear OC | Hecho (secuencia, idempotencia, control) | Adaptador SAP real. |
| HU-6 Errores | Hecho | — |

Resultados de la demo:
- **sol-001**: OC 4500000001; segunda ejecución idempotente.
- **sol-002**: bloqueada (RC1).
- **sol-003**: bloqueada (RC2; escalar).
- **sol-004**: confirmación RC5 (26,5 M vs 25 M) y luego OC 4500000002.
- **sol-005**: confirmación RC8 y luego OC 4500000003, retroactiva.
- **sol-006**: confirmación RC6 con IVA y condiciones derivados.

## 11. Uso de IA
- **Asistente**: Claude (Anthropic) en modo agente sobre la carpeta del proyecto.
- **Para qué**: análisis de fixtures (identificación de trampas como el aprobador de otro centro o la unidad por "horas"), generación del código, pruebas de validación (esquema, sha256, secuencia, determinismo, robustez) y redacción de este documento.
- **Decisiones propias**: Node, Gemini y revisar/validar cada bloque antes de continuar.
- **Corregido durante la revisión**: la primera versión infería unidad `MES` para sol-001 porque la descripción dice "vigencia 12 meses". Se corrigió para que solo "mensual" o "por mes" sean MES, y se agregó una prueba.
- En la instalación desde cero se detectó que un valor no numérico en `.env` (ej. `MAX_ITERACIONES=abc`) dejaba el tope en `NaN` y el agente nunca llamaba al modelo. Se agregó la validación del entorno con zod al arrancar, `npm run verificar` y la suite `npm test`.

## 12. Riesgos para producción
| Riesgo | Mitigación |
|---|---|
| Conexión a SAP no viable | Plan B (carga masiva o payload para ME21N) detrás de la misma interfaz. |
| Formatos reales de cotización variables | Parser por proveedor con pruebas; si falla, confirmación "sin cotización legible". Opcionalmente, extracción asistida por LLM validada por el humano. |
| Aprobación por correo suplantable | Verificar cabeceras DKIM/SPF del `.eml`; a mediano plazo, flujo de aprobación en SAP. |
| Maestros desactualizados | Consultar SAP en línea (`consultarProveedor`) en lugar de archivos. |
| Duplicados por reintentos | Idempotencia por referencia consultada en SAP antes de cada creación. |
| El modelo "arregla" un monto | Las herramientas no aceptan montos del modelo; recalculan todo desde la fuente. |
| Link público que consume la clave del modelo | Límite de mensajes por IP (`LIMITE_CHAT_POR_MINUTO`, 429 con Retry-After), tope de iteraciones y de tokens por sesión, tope de sesiones en memoria; en producción, SSO corporativo. |
| Archivos generados descargables en `/out/` desde el link público | Los datos del reto son ficticios; en producción, `out/` no se publica y los archivos se entregan en SharePoint con permisos por rol. |
