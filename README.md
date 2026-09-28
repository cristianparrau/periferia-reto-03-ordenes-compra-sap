# Reto 03 — Agente "Órdenes de Compra SAP"

Agente conversacional que lee el paquete de compra (solicitud, cotización, aprobación, factura), lo valida contra los maestros y los controles RC1–RC10, construye la OC y la crea en un SAP simulado, pidiendo confirmación ante excepciones.

## Requisitos
- Node.js 20 o superior (probado con 22).
- Una API key de Google Gemini (solo para el chat; la demo y los tests no la necesitan).

## Levantar en local (un comando)
```bash
cp .env.example .env      # y colocar GEMINI_API_KEY
npm install && npm start  # http://localhost:3000
```
`npm run dev` levanta con recarga automática.

## Variables de entorno
| Variable | Uso | Default |
|---|---|---|
| `GEMINI_API_KEY` | Clave del modelo. Solo backend. | — |
| `GEMINI_MODEL` | Modelo | `gemini-2.5-flash` |
| `MAX_ITERACIONES` | Tope herramienta→modelo por turno | 25 |
| `MAX_TOKENS_SESION` | Tope de tokens por sesión | 200000 |
| `LLM_TIMEOUT_MS` | Timeout al proveedor | 60000 |
| `FECHA_REFERENCIA` | Fecha de creación de la OC en el SAP simulado (YYYY-MM-DD) | hoy (Bogotá) |
| `PORT` | Puerto HTTP | 3000 |

## Verificar el entorno
```bash
npm run verificar             # Node, dependencias, .env (valores y formato), .env excluido de git
npm run verificar:conexion    # además prueba la clave y el modelo contra la API de Gemini
```
El servidor también valida el `.env` al arrancar: un valor inválido (por ejemplo `MAX_ITERACIONES=abc`) lo detiene con un mensaje que indica qué corregir. Sin `GEMINI_API_KEY` levanta con un aviso y el chat informa que no hay modelo.

## Demo sin modelo
```bash
npm run demo
```

## Pruebas automatizadas
```bash
npm test          # node:test, sin clave de API ni red
npm run typecheck
```
Cada prueba corre sobre una copia temporal de los fixtures (no toca `out/`). Suites:
- `entorno.test.ts`: validación del `.env`: defaults, conversión, errores y enmascarado de la clave.
- `agente.test.ts`: ciclo del agente con un modelo simulado: confirmación humana (doble candado), topes de iteraciones y tokens, errores de herramientas y del proveedor.
- `gemini.test.ts`: adaptador con `fetch` simulado: clave en cabecera, *function calling*, errores HTTP, timeout y adaptación de esquemas.
- `servidor.test.ts`: servidor real levantado con distintos `.env` (válido, sin clave, inválido): health sin exponer la clave, rutas y *path traversal*.
- `oc.test.ts`: parseo, RC1–RC10 (incluye casos modificados para RC3/RC4/RC9/RC10), idempotencia, doble candado, control.csv, esquema de la OC, sha256 de la evidencia, trazabilidad y errores.

## API
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation }` |
| GET | `/api/sessions/:id` | Historial de la sesión |
| GET | `/api/health` | `{ ok, provider, model }` (sin claves) |
| GET | `/out/<ruta>` | Descarga de archivos generados (solo lectura, dentro de `out/`) |

## Link de prueba
_Pendiente de despliegue:_ `<URL>`

## Estructura
```
agent/prompt.md                 comportamiento del agente
src/knowledge/                  conocimiento del proceso
src/tools/oc.ts                 herramientas (oc_<export>)
src/sap/                        interfaz SapAdapter + implementación simulada (out/sap/)
src/dominio/                    lectura del paquete, controles RC1–RC10, payload, evidencia, control
src/core/                       contrato de herramientas, registro, logs, archivos
src/llm/                        adaptador del proveedor (interfaz + Gemini)
src/agente.ts                   ciclo del agente
src/server.ts                   API HTTP + archivos estáticos
web/index.html                  chat
demo.ts                         verificación sin modelo
scripts/                        pruebas
```

## Salidas
- `out/sap/ordenes.jsonl`: OC creadas en el SAP simulado.
- `out/control.csv`: una fila por intento (creada, idempotente, bloqueada, pendiente_confirmacion), con marca de retroactiva.
- `out/<caso>/payload.json`, `trazabilidad.json`, `aprobacion.txt` y `aprobacion.pdf`.
