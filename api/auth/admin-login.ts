import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { verifyPassword, signAdminSession, buildSessionCookie, ADMIN_COOKIE_NAME } from '../../lib/auth';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) {
    return fail(res, 400, 'DATOS_INCOMPLETOS', 'Correo y contraseña son requeridos.');
  }

  const { rows } = await sql`
    SELECT id, nombre, email, password_hash FROM admins WHERE email = ${email.toLowerCase().trim()}
  `;
  const admin = rows[0];

  if (!admin || !(await verifyPassword(password, admin.password_hash))) {
    return fail(res, 401, 'CREDENCIALES_INVALIDAS', 'Correo o contraseña incorrectos.');
  }

  const token = await signAdminSession({ sub: admin.id });
  res.setHeader('Set-Cookie', buildSessionCookie(ADMIN_COOKIE_NAME, token, 60 * 60 * 12));
  return ok(res, { admin: { id: admin.id, nombre: admin.nombre, email: admin.email } });
}
