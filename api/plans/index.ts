import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireAdmin, logEvent } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    // Lectura pública (sin auth): se usa tanto en el panel admin como en
    // pantallas de la app tenant (ej. "Mi suscripción" o un futuro checkout).
    const { rows } = await sql`
      SELECT id, nombre, precio, periodo, max_usuarios, max_almacenes, funciones, activo
      FROM planes ORDER BY precio ASC
    `;
    return ok(res, { planes: rows });
  }

  if (req.method === 'POST') {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const body = (req.body ?? {}) as {
      nombre?: string; precio?: number; periodo?: string;
      maxUsuarios?: number; maxAlmacenes?: number; funciones?: Record<string, boolean>;
    };
    if (!body.nombre || body.precio === undefined || !body.periodo) {
      return fail(res, 400, 'DATOS_INCOMPLETOS', 'Nombre, precio y periodo son requeridos.');
    }
    if (!['MENSUAL', 'ANUAL'].includes(body.periodo)) {
      return fail(res, 400, 'PERIODO_INVALIDO', 'El periodo debe ser MENSUAL o ANUAL.');
    }

    const { rows } = await sql`
      INSERT INTO planes (nombre, precio, periodo, max_usuarios, max_almacenes, funciones)
      VALUES (
        ${body.nombre}, ${body.precio}, ${body.periodo},
        ${body.maxUsuarios ?? 5}, ${body.maxAlmacenes ?? 1}, ${JSON.stringify(body.funciones ?? {})}
      )
      RETURNING id, nombre, precio, periodo, max_usuarios, max_almacenes, funciones, activo
    `;
    await logEvent({ adminId: ctx.admin.id, tipoEvento: 'PLAN_CREADO', detalle: { planId: rows[0].id } });
    return ok(res, { plan: rows[0] }, 201);
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}
