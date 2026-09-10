import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { isWithinGracePeriod, logEvent } from '../../lib/tenant';
import { ok, fail } from '../../lib/response';

/**
 * Job programado (Vercel Cron, ver vercel.json). Se ejecuta periódicamente
 * y es la fuente de verdad para las transiciones de estado por tiempo:
 *
 *   ACTIVE / TRIALING  --(fecha_proximo_pago vencida)-->  PAST_DUE
 *   PAST_DUE           --(vencido el período de gracia)-->  SUSPENDED (+ empresa SUSPENDIDA)
 *
 * El guard de tenant (lib/tenant.ts) también aplica esta misma lógica de
 * gracia en tiempo real como red de seguridad, pero es este cron el que
 * persiste el cambio de estado en la base de datos.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${cronSecret}`) {
      return fail(res, 401, 'NO_AUTORIZADO', 'Endpoint de cron protegido.');
    }
  }

  const now = new Date();
  let pasadasAVencidas = 0;
  let suspendidas = 0;

  // 1) ACTIVE/TRIALING con fecha_proximo_pago vencida -> PAST_DUE
  const { rows: vencidas } = await sql`
    SELECT id, empresa_id FROM suscripciones
    WHERE estado IN ('ACTIVE', 'TRIALING') AND fecha_proximo_pago IS NOT NULL AND fecha_proximo_pago < ${now.toISOString()}
  `;
  for (const sub of vencidas) {
    await sql`UPDATE suscripciones SET estado = 'PAST_DUE', updated_at = now() WHERE id = ${sub.id}`;
    await logEvent({ empresaId: sub.empresa_id, tipoEvento: 'SUSCRIPCION_VENCIDA', detalle: { suscripcionId: sub.id } });
    pasadasAVencidas++;
  }

  // 2) PAST_DUE cuyo período de gracia ya expiró -> SUSPENDED + empresa SUSPENDIDA
  const { rows: pastDue } = await sql`
    SELECT s.id, s.empresa_id, s.fecha_proximo_pago, e.periodo_gracia_dias
    FROM suscripciones s JOIN empresas e ON e.id = s.empresa_id
    WHERE s.estado = 'PAST_DUE'
  `;
  for (const sub of pastDue) {
    const enGracia = isWithinGracePeriod(sub.fecha_proximo_pago, sub.periodo_gracia_dias);
    if (!enGracia) {
      await sql`UPDATE suscripciones SET estado = 'SUSPENDED', updated_at = now() WHERE id = ${sub.id}`;
      await sql`UPDATE empresas SET estado = 'SUSPENDIDA', fecha_actualizacion = now() WHERE id = ${sub.empresa_id}`;
      await logEvent({ empresaId: sub.empresa_id, tipoEvento: 'SUSCRIPCION_SUSPENDIDA_POR_IMPAGO', detalle: { suscripcionId: sub.id } });
      suspendidas++;
    }
  }

  return ok(res, { ejecutado: now.toISOString(), pasadasAVencidas, suspendidas });
}
