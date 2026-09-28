# Proceso de órdenes de compra

## Entrada
Cada compra llega por correo con la solicitud (Excel), la cotización del proveedor y el correo de aprobación del líder. Si la factura ya llegó, también se adjunta.

## Controles
| Regla | Qué verifica | Efecto |
|---|---|---|
| RC1 | Proveedor existe (por NIT, o por nombre si no hay NIT) y está activo | Bloqueo |
| RC2 | Aprobación con "Aprobado" enviada por un aprobador del centro de costo | Bloqueo |
| RC3 | Valor total ≤ tope del aprobador | Bloqueo |
| RC4 | Subárea pertenece al centro de costo | Bloqueo |
| RC5 | Diferencia cotización vs solicitud ≤ 2 % (o no hay cotización) | Confirmación |
| RC6 | IVA ausente → se toma el default del proveedor | Confirmación + derivado |
| RC7 | Condición de pago ausente → default del proveedor | Derivado (solo se informa) |
| RC8 | Factura anterior a la solicitud → OC retroactiva | Confirmación + marca en control |
| RC9 | Aprobación anterior a la solicitud | Confirmación |
| RC10 | Cantidad × valor unitario = valor total (± 1) | Bloqueo |

## Reglas SAP
- Sociedad y organización de compras: 1000.
- Texto breve de la posición: máximo 40 caracteres (se trunca y se informa).
- Unidad: H para horas, MES para servicios mensuales, UN en los demás casos.
- La OC es idempotente por solicitud: crearla dos veces devuelve el mismo número.

## OC retroactivas
Son las que se crean después de recibir la factura. Se permiten solo con confirmación y quedan marcadas en `out/control.csv` para que la dirección las mida.

## Acciones sugeridas ante bloqueos
- Proveedor inexistente: solicitar su creación en SAP con RUT y certificación bancaria.
- Proveedor inactivo: solicitar la reactivación o cambiar de proveedor.
- Aprobador sin autoridad o tope insuficiente: pedir aprobación a un aprobador del centro con tope suficiente; si no existe, escalar a la dirección financiera.
