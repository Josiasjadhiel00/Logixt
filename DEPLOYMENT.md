# Desplegar Logixt SaaS en Vercel

Esta guía asume que ya tienes el proyecto subido a un repositorio de GitHub
conectado a Vercel.

## 1. Crear la base de datos (Vercel Postgres / Neon)

1. En tu proyecto de Vercel → pestaña **Storage** → **Create Database** → **Postgres** (Neon).
2. Conéctala a este proyecto. Vercel inyecta automáticamente las variables
   `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, etc. — no hay que copiarlas a mano.

## 2. Ejecutar el esquema

Con la base ya conectada, desde tu máquina local (con las variables de entorno
de Vercel descargadas vía `vercel env pull .env.local`, o pegando la
`POSTGRES_URL` directamente):

```bash
npm install
psql "$POSTGRES_URL" -f schema/schema.sql
```

Esto crea todas las tablas y siembra los 3 planes por defecto (BÁSICO,
PROFESIONAL, EMPRESA). Puedes editar `schema/schema.sql` antes de correrlo si
quieres precios o límites distintos.

## 3. Variables de entorno

En Vercel → **Settings** → **Environment Variables**, agrega (usa valores
aleatorios largos, por ejemplo con `openssl rand -base64 48`):

| Variable | Uso |
|---|---|
| `JWT_SECRET` | Firma las sesiones de los usuarios de cada empresa |
| `JWT_ADMIN_SECRET` | Firma las sesiones del panel `/admin` (debe ser distinto de `JWT_SECRET`) |
| `CRON_SECRET` | Protege el endpoint de automatización de suscripciones |

## 4. Crear el primer administrador de la plataforma

Este es el único usuario que puede entrar a `/admin`. Se crea con un script,
no desde la interfaz (por seguridad):

```bash
POSTGRES_URL="tu-connection-string" node schema/seed-admin.mjs "Tu Nombre" tu@correo.com "unaContraseñaSegura123"
```

## 5. Desplegar

```bash
git push
```

Vercel construye automáticamente (`npm run build`, detecta Vite). El cron de
`vercel.json` (`/api/cron/check-subscriptions`, diario) empieza a correr solo.

## 6. Primer uso

1. Entra a `https://tu-dominio.vercel.app/admin` con el correo/contraseña del paso 4.
2. Crea tu primera empresa desde **Empresas → Nueva empresa** (esto crea también
   su primer usuario administrador y un almacén inicial).
3. Entra a `https://tu-dominio.vercel.app` (la app normal) con las credenciales
   de ese usuario administrador de empresa.

## Cómo funciona el pago por transferencia (sin gateway automatizado)

1. El cliente reporta una transferencia desde **Mi Suscripción** (monto,
   referencia, banco) — o desde la pantalla de "Suscripción suspendida" si ya
   se venció.
2. Tú la revisas en `/admin` → **Pagos** → **Pendientes**.
3. Al aprobarla, el sistema extiende automáticamente la fecha de vencimiento
   según el período del plan (mensual/anual) y reactiva el acceso si estaba
   suspendido. Al rechazarla, queda registrada con el motivo.

No se guarda ningún dato bancario sensible — solo el monto, una referencia de
texto y el nombre del banco que el cliente escribe.

## Notas y limitaciones de esta primera versión

- **Comprobantes de pago**: el formulario de transferencia no incluye subida
  de archivos/fotos todavía (solo texto). Para eso se necesitaría integrar
  almacenamiento de archivos (por ejemplo Vercel Blob) — es la siguiente mejora
  natural si la necesitas.
- **Multi-almacén por empresa**: el backend ya soporta varios almacenes según
  el límite del plan (`max_almacenes`), pero la interfaz actual del almacén
  sigue centrada en uno seleccionado a la vez (`selectedWarehouse`), igual que
  la app original.
- **Recuperar contraseña**: no implementado todavía (ni para usuarios de
  empresa ni para admins). Por ahora, restablecer una contraseña requiere
  hacerlo manualmente en la base de datos o agregar ese flujo después.
- Todo el código nuevo del backend vive en `/api` y `/lib`; el frontend
  original no se tocó salvo lo mínimo para conectarlo a datos reales (ver
  el resumen de cambios que te compartí en el chat).
