import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireAdmin, logEvent } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const id = req.query.id as string;
  if (!id) return fail(res, 400, 'ID_REQUERIDO', 'Falta el id del plan.');

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as {
      nombre?: string; precio?: number; maxUsuarios?: number; maxAlmacenes?: number;
      funciones?: Record<string, boolean>; activo?: boolean;
    };
    const { rows } = await sql`
      UPDATE planes SET
        nombre = COALESCE(${body.nombre ?? null}, nombre),
        precio = COALESCE(${body.precio ?? null}, precio),
        max_usuarios = COALESCE(${body.maxUsuarios ?? null}, max_usuarios),
        max_almacenes = COALESCE(${body.maxAlmacenes ?? null}, max_almacenes),
        funciones = COALESCE(${body.funciones ? JSON.stringify(body.funciones) : null}, funciones),
        activo = COALESCE(${body.activo ?? null}, activo),
        updated_at = now()
      WHERE id = ${id}
      RETURNING id, nombre, precio, periodo, max_usuarios, max_almacenes, funciones, activo
    `;
    if (rows.length === 0) return fail(res, 404, 'NO_ENCONTRADO', 'Plan no encontrado.');
    await logEvent({ adminId: ctx.admin.id, tipoEvento: 'PLAN_EDITADO', detalle: { planId: id } });
    return ok(res, { plan: rows[0] });
  }

  return methodNotAllowed(res, ['PATCH']);
}
