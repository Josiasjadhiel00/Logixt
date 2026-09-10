import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../../../lib/db';
import { requireAdmin, logEvent } from '../../../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const id = req.query.id as string;
  const { notas } = (req.body ?? {}) as { notas?: string };

  const { rows } = await sql`
    UPDATE transferencias_pago SET
      estado = 'RECHAZADO', notas_admin = ${notas ?? null}, revisado_por = ${ctx.admin.id}, revisado_en = now()
    WHERE id = ${id} AND estado = 'PENDIENTE'
    RETURNING id, empresa_id
  `;
  if (rows.length === 0) {
    return fail(res, 409, 'NO_DISPONIBLE', 'Esta transferencia no existe o ya fue revisada.');
  }

  await logEvent({
    empresaId: rows[0].empresa_id,
    adminId: ctx.admin.id,
    tipoEvento: 'TRANSFERENCIA_RECHAZADA',
    detalle: { transferenciaId: id, notas },
  });

  return ok(res, { success: true });
}
