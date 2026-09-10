import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { verifyPassword, signTenantSession, buildSessionCookie, TENANT_COOKIE_NAME } from '../../lib/auth';
import { ok, fail, methodNotAllowed } from '../../lib/response';
import { logEvent } from '../../lib/tenant';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) {
    return fail(res, 400, 'DATOS_INCOMPLETOS', 'Correo y contraseña son requeridos.');
  }

  const { rows } = await sql`
    SELECT id, empresa_id, nombre, email, password_hash, rol, estado
    FROM usuarios
    WHERE email = ${email.toLowerCase().trim()}
  `;
  const user = rows[0];

  // Mismo mensaje de error para email inexistente o password incorrecto,
  // para no revelar cuáles correos están registrados.
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return fail(res, 401, 'CREDENCIALES_INVALIDAS', 'Correo o contraseña incorrectos.');
  }

  if (user.estado !== 'Activo') {
    return fail(res, 403, 'USUARIO_INACTIVO', 'Tu usuario está inactivo. Contacta a tu administrador.');
  }

  const { rows: empresaRows } = await sql`SELECT estado FROM empresas WHERE id = ${user.empresa_id}`;
  const empresa = empresaRows[0];
  if (!empresa || empresa.estado === 'INACTIVA') {
    return fail(res, 403, 'EMPRESA_INACTIVA', 'Esta empresa no está disponible actualmente.');
  }

  const token = await signTenantSession({
    sub: user.id,
    empresaId: user.empresa_id,
    rol: user.rol,
  });

  await sql`UPDATE usuarios SET ultimo_acceso = now() WHERE id = ${user.id}`;
  await logEvent({ empresaId: user.empresa_id, usuarioId: user.id, tipoEvento: 'LOGIN' });

  res.setHeader('Set-Cookie', buildSessionCookie(TENANT_COOKIE_NAME, token, 60 * 60 * 12));
  return ok(res, {
    usuario: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
  });
}
