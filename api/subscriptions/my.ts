import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { loadTenantContext } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  // Nota: usamos loadTenantContext (no requireTenant) a propósito. Este
  // endpoint debe seguir siendo accesible incluso si la suscripción está
  // suspendida — es precisamente donde el cliente ve el estado y reporta
  // un pago para reactivarla.
  const { context, authError } = await loadTenantContext(req);
  if (authError || !context) {
    return fail(res, authError?.status ?? 401, authError?.code ?? 'NO_AUTENTICADO', authError?.message ?? 'Debes iniciar sesión.');
  }

  let plan = null;
  if (context.empresa.planId) {
    const { rows } = await sql`
      SELECT id, nombre, precio, periodo FROM planes WHERE id = ${context.empresa.planId}
    `;
    plan = rows[0] ?? null;
  }

  const { rows: subs } = await sql`
    SELECT id, estado, fecha_inicio, fecha_proximo_pago, fecha_cancelacion
    FROM suscripciones WHERE empresa_id = ${context.empresa.id} ORDER BY created_at DESC LIMIT 1
  `;

  const { rows: transferencias } = await sql`
    SELECT id, monto, referencia, banco_origen, estado, notas_admin, created_at, revisado_en
    FROM transferencias_pago WHERE empresa_id = ${context.empresa.id} ORDER BY created_at DESC LIMIT 20
  `;

  return ok(res, {
    empresa: { nombre: context.empresa.nombre, estado: context.empresa.estado },
    plan,
    suscripcion: subs[0] ?? null,
    historialPagos: transferencias,
  });
}
