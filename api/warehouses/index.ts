import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireTenant, requireRole, logEvent } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireTenant(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const { rows } = await sql`
      SELECT id, nombre, codigo, ciudad, direccion, es_principal, created_at
      FROM almacenes WHERE empresa_id = ${ctx.empresa.id} ORDER BY es_principal DESC, created_at ASC
    `;
    return ok(res, { almacenes: rows });
  }

  if (req.method === 'POST') {
    if (!requireRole(ctx, res, ['ADMINISTRADOR'])) return;

    const body = (req.body ?? {}) as { nombre?: string; codigo?: string; ciudad?: string; direccion?: string };
    if (!body.nombre || !body.codigo) {
      return fail(res, 400, 'DATOS_INCOMPLETOS', 'Nombre y código son requeridos.');
    }

    // Límite del plan: número máximo de almacenes.
    const { rows: planRows } = await sql`
      SELECT pl.max_almacenes FROM empresas e JOIN planes pl ON pl.id = e.plan_id WHERE e.id = ${ctx.empresa.id}
    `;
    const { rows: countRows } = await sql`SELECT COUNT(*)::int AS total FROM almacenes WHERE empresa_id = ${ctx.empresa.id}`;
    if (planRows[0] && countRows[0].total >= planRows[0].max_almacenes) {
      return fail(
        res, 403, 'LIMITE_PLAN_ALCANZADO',
        `Tu plan permite un máximo de ${planRows[0].max_almacenes} almacén(es). Actualiza tu plan para agregar más.`
      );
    }

    const { rows } = await sql`
      INSERT INTO almacenes (empresa_id, nombre, codigo, ciudad, direccion, es_principal)
      VALUES (${ctx.empresa.id}, ${body.nombre}, ${body.codigo}, ${body.ciudad ?? null}, ${body.direccion ?? null}, false)
      RETURNING id, nombre, codigo, ciudad, direccion, es_principal
    `;
    await logEvent({ empresaId: ctx.empresa.id, usuarioId: ctx.usuario.id, tipoEvento: 'ALMACEN_CREADO', detalle: { almacenId: rows[0].id } });
    return ok(res, { almacen: rows[0] }, 201);
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}
