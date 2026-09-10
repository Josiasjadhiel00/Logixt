import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../../lib/db';
import { loadTenantContext, requireAdmin, logEvent } from '../../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    // El propio cliente reporta que hizo una transferencia. Debe poder
    // hacerlo incluso con la suscripción suspendida.
    const { context, authError } = await loadTenantContext(req);
    if (authError || !context) {
      return fail(res, authError?.status ?? 401, authError?.code ?? 'NO_AUTENTICADO', authError?.message ?? 'Debes iniciar sesión.');
    }

    const body = (req.body ?? {}) as { monto?: number; referencia?: string; bancoOrigen?: string; comprobanteUrl?: string };
    if (!body.monto || body.monto <= 0) {
      return fail(res, 400, 'MONTO_INVALIDO', 'Indica el monto transferido.');
    }

    const { rows: subRows } = await sql`
      SELECT id FROM suscripciones WHERE empresa_id = ${context.empresa.id} ORDER BY created_at DESC LIMIT 1
    `;

    const { rows } = await sql`
      INSERT INTO transferencias_pago (empresa_id, suscripcion_id, monto, referencia, banco_origen, comprobante_url)
      VALUES (
        ${context.empresa.id}, ${subRows[0]?.id ?? null}, ${body.monto},
        ${body.referencia ?? null}, ${body.bancoOrigen ?? null}, ${body.comprobanteUrl ?? null}
      )
      RETURNING id, monto, referencia, banco_origen, estado, created_at
    `;

    await logEvent({
      empresaId: context.empresa.id,
      usuarioId: context.usuario.id,
      tipoEvento: 'TRANSFERENCIA_REPORTADA',
      detalle: { transferenciaId: rows[0].id, monto: body.monto },
    });

    return ok(res, { transferencia: rows[0] }, 201);
  }

  if (req.method === 'GET') {
    // El admin de la plataforma revisa la cola de transferencias reportadas.
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;

    const estado = (req.query.estado as string) || 'PENDIENTE';
    const { rows } = await sql`
      SELECT t.id, t.empresa_id, e.nombre AS empresa_nombre, t.monto, t.referencia,
             t.banco_origen, t.comprobante_url, t.estado, t.notas_admin, t.created_at, t.revisado_en
      FROM transferencias_pago t
      JOIN empresas e ON e.id = t.empresa_id
      WHERE (${estado} = 'TODAS' OR t.estado = ${estado})
      ORDER BY t.created_at DESC
    `;
    return ok(res, { transferencias: rows });
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}
