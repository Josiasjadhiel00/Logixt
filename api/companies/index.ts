import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireAdmin, logEvent } from '../../lib/tenant';
import { hashPassword } from '../../lib/auth';
import { ok, fail, methodNotAllowed } from '../../lib/response';

const TRIAL_DAYS = 14;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const { rows } = await sql`
      SELECT
        e.id, e.nombre, e.email, e.telefono, e.estado, e.fecha_creacion,
        p.nombre AS plan_nombre,
        s.estado AS suscripcion_estado,
        s.fecha_proximo_pago,
        (SELECT COUNT(*) FROM usuarios u WHERE u.empresa_id = e.id) AS total_usuarios
      FROM empresas e
      LEFT JOIN planes p ON p.id = e.plan_id
      LEFT JOIN LATERAL (
        SELECT estado, fecha_proximo_pago FROM suscripciones
        WHERE empresa_id = e.id ORDER BY created_at DESC LIMIT 1
      ) s ON true
      ORDER BY e.fecha_creacion DESC
    `;
    return ok(res, { empresas: rows });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as {
      nombre?: string;
      email?: string;
      telefono?: string;
      planId?: string;
      adminUser?: { nombre?: string; email?: string; password?: string };
    };

    if (!body.nombre || !body.email || !body.planId || !body.adminUser?.email || !body.adminUser?.password) {
      return fail(res, 400, 'DATOS_INCOMPLETOS', 'Nombre, email, plan y datos del usuario administrador son requeridos.');
    }
    if (body.adminUser.password.length < 8) {
      return fail(res, 400, 'PASSWORD_DEBIL', 'La contraseña del usuario debe tener al menos 8 caracteres.');
    }

    const { rows: planRows } = await sql`SELECT id FROM planes WHERE id = ${body.planId} AND activo = true`;
    if (planRows.length === 0) {
      return fail(res, 400, 'PLAN_INVALIDO', 'El plan seleccionado no existe o no está activo.');
    }

    const { rows: existing } = await sql`SELECT id FROM empresas WHERE email = ${body.email.toLowerCase().trim()}`;
    if (existing.length > 0) {
      return fail(res, 409, 'EMPRESA_DUPLICADA', 'Ya existe una empresa registrada con ese email.');
    }
    const { rows: existingUser } = await sql`
      SELECT id FROM usuarios WHERE email = ${body.adminUser.email.toLowerCase().trim()}
    `;
    if (existingUser.length > 0) {
      return fail(res, 409, 'USUARIO_DUPLICADO', 'Ya existe un usuario registrado con ese email.');
    }

    const { rows: empresaRows } = await sql`
      INSERT INTO empresas (nombre, email, telefono, estado, plan_id)
      VALUES (${body.nombre}, ${body.email.toLowerCase().trim()}, ${body.telefono ?? null}, 'ACTIVA', ${body.planId})
      RETURNING id, nombre, email, estado, fecha_creacion
    `;
    const empresa = empresaRows[0];

    const fechaProximoPago = new Date();
    fechaProximoPago.setDate(fechaProximoPago.getDate() + TRIAL_DAYS);

    const { rows: subRows } = await sql`
      INSERT INTO suscripciones (empresa_id, plan_id, estado, fecha_proximo_pago)
      VALUES (${empresa.id}, ${body.planId}, 'TRIALING', ${fechaProximoPago.toISOString()})
      RETURNING id, estado, fecha_proximo_pago
    `;

    const passwordHash = await hashPassword(body.adminUser.password);
    const username = body.adminUser.email.split('@')[0].toLowerCase();
    await sql`
      INSERT INTO usuarios (empresa_id, nombre, username, email, password_hash, rol, estado)
      VALUES (
        ${empresa.id}, ${body.adminUser.nombre || body.nombre}, ${username},
        ${body.adminUser.email.toLowerCase().trim()}, ${passwordHash}, 'ADMINISTRADOR', 'Activo'
      )
    `;

    await sql`
      INSERT INTO almacenes (empresa_id, nombre, codigo, es_principal)
      VALUES (${empresa.id}, 'Almacén Principal', 'ALM-01', true)
    `;

    await logEvent({
      empresaId: empresa.id,
      adminId: ctx.admin.id,
      tipoEvento: 'EMPRESA_CREADA',
      detalle: { nombre: empresa.nombre, planId: body.planId },
    });

    return ok(res, { empresa, suscripcion: subRows[0] }, 201);
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}
