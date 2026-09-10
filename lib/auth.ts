import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';

const TENANT_SECRET = new TextEncoder().encode(requireEnv('JWT_SECRET'));
const ADMIN_SECRET = new TextEncoder().encode(requireEnv('JWT_ADMIN_SECRET'));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Falla rápido y claro en vez de firmar tokens con un secreto vacío/adivinable.
    throw new Error(
      `Falta la variable de entorno ${name}. Configúrala en el proyecto de Vercel.`
    );
  }
  return value;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface TenantSessionPayload {
  sub: string; // usuario.id
  empresaId: string;
  rol: 'ADMINISTRADOR' | 'ALMACENERO';
}

export interface AdminSessionPayload {
  sub: string; // admin.id
}

const SESSION_TTL = '12h';

export async function signTenantSession(payload: TenantSessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .setAudience('tenant')
    .sign(TENANT_SECRET);
}

export async function verifyTenantSession(token: string): Promise<TenantSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, TENANT_SECRET, { audience: 'tenant' });
    return payload as unknown as TenantSessionPayload;
  } catch {
    return null;
  }
}

export async function signAdminSession(payload: AdminSessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .setAudience('admin')
    .sign(ADMIN_SECRET);
}

export async function verifyAdminSession(token: string): Promise<AdminSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, ADMIN_SECRET, { audience: 'admin' });
    return payload as unknown as AdminSessionPayload;
  } catch {
    return null;
  }
}

const isProd = process.env.VERCEL_ENV === 'production';

export function buildSessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isProd) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearCookie(name: string): string {
  return buildSessionCookie(name, '', 0);
}

export const TENANT_COOKIE_NAME = 'logixt_session';
export const ADMIN_COOKIE_NAME = 'logixt_admin_session';
