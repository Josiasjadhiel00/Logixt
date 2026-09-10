import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireAdmin, logEvent } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const id = req.query.id as string;
  if (!id) return fail(res, 400, 'ID_REQUERIDO', 'Falta el id de la empresa.');

  if (req.method === 'GET') {
    const { rows } = await sql`
      SELECT e.id, e.nombre, e.email, e.telefono, e.logo, e.estado, e.plan_id,
             e.periodo_gracia_dias, e.fecha_creacion, e.fecha_actualizacion,
             p.nombre AS plan_nombre, p.precio AS plan_precio
      FROM empresas e LEFT JOIN planes p ON p.id = e.plan_id
      WHERE e.id = ${id}
    `;
    const empresa = rows[0];
    if (!empresa) return fail(res, 404, 'NO_ENCONTRADA', 'Empresa no encontrada.');

    const { rows: subs } = await sql`
      SELECT id, estado, fecha_inicio, fecha_proximo_pago, fecha_cancelacion, created_at
      FROM suscripciones WHERE empresa_id = ${id} ORDER BY created_at DESC
    `;
    const { rows: usuarios } = await sql`
      SELECT id, nombre, email, rol, estado, ultimo_acceso FROM usuarios WHERE empresa_id = ${id}
      ORDER BY created_at ASC
    `;
    return ok(res, { empresa, suscripciones: subs, usuarios });
  }

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const accion = body.accion as string;

    const { rows: existingRows } = await sql`SELECT id, estado FROM empresas WHERE id = ${id}`;
    if (existingRows.length === 0) return fail(res, 404, 'NO_ENCONTRADA', 'Empresa no encontrada.');

    switch (accion) {
      case 'editar': {
        const { nombre, telefono, logo, periodoGraciaDias } = body as {
          nombre?: string; telefono?: string; logo?: string; periodoGraciaDias?: number;
        };
        const { rows } = await sql`
          UPDATE empresas SET
            nombre = COALESCE(${nombre ?? null}, nombre),
            telefono = COALESCE(${telefono ?? null}, telefono),
            logo = COALESCE(${logo ?? null}, logo),
            periodo_gracia_dias = COALESCE(${periodoGraciaDias ?? null}, periodo_gracia_dias),
            fecha_actualizacion = now()
          WHERE id = ${id}
          RETURNING id, nombre, telefono, logo, periodo_gracia_dias
        `;
        await logEvent({ empresaId: id, adminId: ctx.admin.id, tipoEvento: 'EMPRESA_EDITADA', detalle: body });
        return ok(res, { empresa: rows[0] });
      }

      case 'suspender': {
        await sql`UPDATE empresas SET estado = 'SUSPENDIDA', fecha_actualizacion = now() WHERE id = ${id}`;
        await logEvent({ empresaId: id, adminId: ctx.admin.id, tipoEvento: 'EMPRESA_SUSPENDIDA' });
        return ok(res, { success: true });
      }

      case 'reactivar': {
        await sql`UPDATE empresas SET estado = 'ACTIVA', fecha_actualizacion = now() WHERE id = ${id}`;
        await logEvent({ empresaId: id, adminId: ctx.admin.id, tipoEvento: 'EMPRESA_REACTIVADA' });
        return ok(res, { success: true });
      }

      case 'desactivar': {
        // INACTIVA: distinto de suspensión por impago; uso para cierres definitivos/voluntarios.
        await sql`UPDATE empresas SET estado = 'INACTIVA', fecha_actualizacion = now() WHERE id = ${id}`;
        await logEvent({ empresaId: id, adminId: ctx.admin.id, tipoEvento: 'EMPRESA_DESACTIVADA' });
        return ok(res, { success: true });
      }

      case 'cambiar_plan': {
        const { planId } = body as { planId?: string };
        if (!planId) return fail(res, 400, 'PLAN_REQUERIDO', 'Falta el id del nuevo plan.');
        const { rows: planRows } = await sql`SELECT id FROM planes WHERE id = ${planId} AND activo = true`;
        if (planRows.length === 0) return fail(res, 400, 'PLAN_INVALIDO', 'Plan no válido.');

        await sql`UPDATE empresas SET plan_id = ${planId}, fecha_actualizacion = now() WHERE id = ${id}`;
        await sql`
          UPDATE suscripciones SET plan_id = ${planId}, updated_at = now()
          WHERE id = (SELECT id FROM suscripciones WHERE empresa_id = ${id} ORDER BY created_at DESC LIMIT 1)
        `;
        await logEvent({ empresaId: id, adminId: ctx.admin.id, tipoEvento: 'PLAN_CAMBIADO', detalle: { planId } });
        return ok(res, { success: true });
      }

      case 'extender_suscripcion': {
        const { dias } = body as { dias?: number };
        if (!dias || dias <= 0) return fail(res, 400, 'DIAS_INVALIDOS', 'Debes indicar un número de días válido.');

        const { rows: subRows } = await sql`
          SELECT id, fecha_proximo_pago FROM suscripciones
          WHERE empresa_id = ${id} ORDER BY created_at DESC LIMIT 1
        `;
        if (subRows.length === 0) return fail(res, 404, 'SIN_SUSCRIPCION', 'Esta empresa no tiene suscripción.');

        const base = subRows[0].fecha_proximo_pago ? new Date(subRows[0].fecha_proximo_pago) : new Date();
        const nuevaFecha = base > new Date() ? base : new Date();
        nuevaFecha.setDate(nuevaFecha.getDate() + Number(dias));

        await sql`
          UPDATE suscripciones SET
            estado = 'ACTIVE',
            fecha_proximo_pago = ${nuevaFecha.toISOString()},
            updated_at = now()
          WHERE id = ${subRows[0].id}
        `;
        // Si la empresa había quedado suspendida por impago, restaurar acceso automáticamente.
        await sql`UPDATE empresas SET estado = 'ACTIVA', fecha_actualizacion = now() WHERE id = ${id} AND estado = 'SUSPENDIDA'`;

        await logEvent({
          empresaId: id,
          adminId: ctx.admin.id,
          tipoEvento: 'SUSCRIPCION_EXTENDIDA_MANUALMENTE',
          detalle: { dias, nuevaFecha: nuevaFecha.toISOString() },
        });
        return ok(res, { success: true, fechaProximoPago: nuevaFecha.toISOString() });
      }

      default:
        return fail(res, 400, 'ACCION_INVALIDA', 'Acción no reconocida.');
    }
  }

  return methodNotAllowed(res, ['GET', 'PATCH']);
}
