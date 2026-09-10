import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { loadTenantContext } from '../../lib/tenant';
import { ok, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const { context, authError, accessBlocked } = await loadTenantContext(req);

  if (authError) {
    return ok(res, { authenticated: false });
  }

  if (!context) {
    return ok(res, { authenticated: false });
  }

  let plan = null;
  if (context.empresa.planId) {
    const { rows } = await sql`
      SELECT id, nombre, precio, periodo, max_usuarios, max_almacenes, funciones
      FROM planes WHERE id = ${context.empresa.planId}
    `;
    plan = rows[0] ?? null;
  }

  return ok(res, {
    authenticated: true,
    bloqueado: accessBlocked
      ? { codigo: accessBlocked.code, mensaje: accessBlocked.message }
      : null,
    usuario: {
      id: context.usuario.id,
      nombre: context.usuario.nombre,
      email: context.usuario.email,
      rol: context.usuario.rol,
    },
    empresa: {
      id: context.empresa.id,
      nombre: context.empresa.nombre,
      estado: context.empresa.estado,
    },
    suscripcion: context.suscripcion,
    plan,
  });
}
