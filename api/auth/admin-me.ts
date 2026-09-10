import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../../lib/tenant';
import { ok, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const ctx = await requireAdmin(req, res);
  if (!ctx) return; // requireAdmin ya respondió { authenticated } implícito vía error
  return ok(res, { authenticated: true, admin: ctx.admin });
}
