import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireTenant, requireRole, logEvent } from '../../lib/tenant';
import { hashPassword } from '../../lib/auth';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireTenant(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const { rows } = await sql`
      SELECT id, nombre, username, email, rol, estado, avatar, ultimo_acceso, created_at
      FROM usuarios WHERE empresa_id = ${ctx.empresa.id} ORDER BY created_at ASC
    `;
    return ok(res, { usuarios: rows });
  }

  if (req.method === 'POST') {
    if (!requireRole(ctx, res, ['ADMINISTRADOR'])) return;

    const body = (req.body ?? {}) as {
      nombre?: string; email?: string; password?: string; rol?: 'ADMINISTRADOR' | 'ALMACENERO';
    };
    if (!body.nombre || !body.email || !body.password) {
      return fail(res, 400, 'DATOS_INCOMPLETOS', 'Nombre, email y contraseña son requeridos.');
    }
    if (body.password.length < 8) {
      return fail(res, 400, 'PASSWORD_DEBIL', 'La contraseña debe tener al menos 8 caracteres.');
    }

    const { rows: planRows } = await sql`
      SELECT pl.max_usuarios FROM empresas e JOIN planes pl ON pl.id = e.plan_id WHERE e.id = ${ctx.empresa.id}
    `;
    const { rows: countRows } = await sql`SELECT COUNT(*)::int AS total FROM usuarios WHERE empresa_id = ${ctx.empresa.id}`;
    if (planRows[0] && countRows[0].total >= planRows[0].max_usuarios) {
      return fail(
        res, 403, 'LIMITE_PLAN_ALCANZADO',
        `Tu plan permite un máximo de ${planRows[0].max_usuarios} usuario(s). Actualiza tu plan para agregar más.`
      );
    }

    const emailNormalizado = body.email.toLowerCase().trim();
    const { rows: dup } = await sql`SELECT id FROM usuarios WHERE email = ${emailNormalizado}`;
    if (dup.length > 0) return fail(res, 409, 'EMAIL_DUPLICADO', 'Ya existe un usuario con ese email.');

    const passwordHash = await hashPassword(body.password);
    const username = emailNormalizado.split('@')[0];

    const { rows } = await sql`
      INSERT INTO usuarios (empresa_id, nombre, username, email, password_hash, rol, estado)
      VALUES (${ctx.empresa.id}, ${body.nombre}, ${username}, ${emailNormalizado}, ${passwordHash}, ${body.rol ?? 'ALMACENERO'}, 'Activo')
      RETURNING id, nombre, username, email, rol, estado
    `;
    await logEvent({ empresaId: ctx.empresa.id, usuarioId: ctx.usuario.id, tipoEvento: 'USUARIO_CREADO', detalle: { usuarioId: rows[0].id } });
    return ok(res, { usuario: rows[0] }, 201);
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}
