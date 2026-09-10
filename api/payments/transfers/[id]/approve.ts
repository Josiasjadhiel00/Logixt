import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../../../lib/db';
import { requireAdmin, logEvent } from '../../../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const id = req.query.id as string;

  const { rows: transferRows } = await sql`
    SELECT id, empresa_id, suscripcion_id, estado FROM transferencias_pago WHERE id = ${id}
  `;
  const transfer = transferRows[0];
  if (!transfer) return fail(res, 404, 'NO_ENCONTRADA', 'Transferencia no encontrada.');
  if (transfer.estado !== 'PENDIENTE') {
    return fail(res, 409, 'YA_REVISADA', 'Esta transferencia ya fue revisada.');
  }

  const { rows: subRows } = await sql`
    SELECT s.id, s.fecha_proximo_pago, p.periodo
    FROM suscripciones s JOIN planes p ON p.id = s.plan_id
    WHERE s.empresa_id = ${transfer.empresa_id}
    ORDER BY s.created_at DESC LIMIT 1
  `;
  const sub = subRows[0];
  if (!sub) return fail(res, 404, 'SIN_SUSCRIPCION', 'La empresa no tiene una suscripción activa a extender.');

  const base = sub.fecha_proximo_pago && new Date(sub.fecha_proximo_pago) > new Date()
    ? new Date(sub.fecha_proximo_pago)
    : new Date();
  if (sub.periodo === 'ANUAL') {
    base.setFullYear(base.getFullYear() + 1);
  } else {
    base.setMonth(base.getMonth() + 1);
  }

  await sql`
    UPDATE suscripciones SET estado = 'ACTIVE', fecha_proximo_pago = ${base.toISOString()}, updated_at = now()
    WHERE id = ${sub.id}
  `;
  await sql`
    UPDATE empresas SET estado = 'ACTIVA', fecha_actualizacion = now()
    WHERE id = ${transfer.empresa_id} AND estado = 'SUSPENDIDA'
  `;
  await sql`
    UPDATE transferencias_pago SET estado = 'APROBADO', revisado_por = ${ctx.admin.id}, revisado_en = now()
    WHERE id = ${id}
  `;

  await logEvent({
    empresaId: transfer.empresa_id,
    adminId: ctx.admin.id,
    tipoEvento: 'TRANSFERENCIA_APROBADA',
    detalle: { transferenciaId: id, nuevaFechaProximoPago: base.toISOString() },
  });

  return ok(res, { success: true, fechaProximoPago: base.toISOString() });
}
