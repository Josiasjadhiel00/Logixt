import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildClearCookie, TENANT_COOKIE_NAME } from '../../lib/auth';
import { ok, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  res.setHeader('Set-Cookie', buildClearCookie(TENANT_COOKIE_NAME));
  return ok(res, { success: true });
}
