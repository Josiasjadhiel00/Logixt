import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireAdmin } from '../../lib/tenant';
import { ok, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const { rows: totales } = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE estado = 'ACTIVA')::int AS activas,
      COUNT(*) FILTER (WHERE estado = 'SUSPENDIDA')::int AS suspendidas,
      COUNT(*) FILTER (WHERE estado = 'INACTIVA')::int AS inactivas
    FROM empresas
  `;

  const { rows: pendientesTrial } = await sql`
    SELECT COUNT(*)::int AS total FROM suscripciones WHERE estado = 'TRIALING'
  `;

  const { rows: ingresos } = await sql`
    SELECT COALESCE(SUM(monto), 0)::float AS total
    FROM transferencias_pago
    WHERE estado = 'APROBADO' AND revisado_en >= date_trunc('month', now())
  `;

  const { rows: proximasAVencer } = await sql`
    SELECT s.id, e.nombre AS empresa_nombre, s.fecha_proximo_pago, s.estado
    FROM suscripciones s
    JOIN empresas e ON e.id = s.empresa_id
    WHERE s.estado IN ('ACTIVE', 'TRIALING', 'PAST_DUE')
      AND s.fecha_proximo_pago BETWEEN now() AND now() + INTERVAL '7 days'
    ORDER BY s.fecha_proximo_pago ASC
    LIMIT 20
  `;

  const { rows: transferenciasPendientes } = await sql`
    SELECT COUNT(*)::int AS total FROM transferencias_pago WHERE estado = 'PENDIENTE'
  `;

  return ok(res, {
    empresas: totales[0],
    suscripcionesEnPrueba: pendientesTrial[0].total,
    ingresosMensuales: ingresos[0].total,
    proximasAVencer,
    transferenciasPendientes: transferenciasPendientes[0].total,
  });
}
