import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireTenant, requireRole, logEvent } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireTenant(req, res);
  if (!ctx) return;
  if (!requireRole(ctx, res, ['ADMINISTRADOR'])) return;

  const id = req.query.id as string;
  const { rows: existing } = await sql`SELECT id, rol, estado FROM usuarios WHERE id = ${id} AND empresa_id = ${ctx.empresa.id}`;
  if (existing.length === 0) return fail(res, 404, 'NO_ENCONTRADO', 'Usuario no encontrado.');

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as { nombre?: string; rol?: string; estado?: string };

    // Nunca permitir desactivar o degradar al último administrador activo de la empresa.
    if ((body.estado === 'Inactivo' || body.rol === 'ALMACENERO') && existing[0].rol === 'ADMINISTRADOR') {
      const { rows: admins } = await sql`
        SELECT COUNT(*)::int AS total FROM usuarios
        WHERE empresa_id = ${ctx.empresa.id} AND rol = 'ADMINISTRADOR' AND estado = 'Activo' AND id != ${id}
      `;
      if (admins[0].total === 0) {
        return fail(res, 409, 'ULTIMO_ADMIN', 'No puedes desactivar o degradar al único administrador activo de la empresa.');
      }
    }

    const { rows } = await sql`
      UPDATE usuarios SET
        nombre = COALESCE(${body.nombre ?? null}, nombre),
        rol = COALESCE(${body.rol ?? null}, rol),
        estado = COALESCE(${body.estado ?? null}, estado),
        updated_at = now()
      WHERE id = ${id} AND empresa_id = ${ctx.empresa.id}
      RETURNING id, nombre, email, rol, estado
    `;
    await logEvent({ empresaId: ctx.empresa.id, usuarioId: ctx.usuario.id, tipoEvento: 'USUARIO_EDITADO', detalle: { usuarioId: id, cambios: body } });
    return ok(res, { usuario: rows[0] });
  }

  return methodNotAllowed(res, ['PATCH']);
}
