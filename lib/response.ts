import type { VercelResponse } from '@vercel/node';

export function ok(res: VercelResponse, data: unknown, status = 200) {
  return res.status(status).json(data);
}

export function fail(res: VercelResponse, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

export function methodNotAllowed(res: VercelResponse, allowed: string[]) {
  res.setHeader('Allow', allowed.join(', '));
  return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Método no permitido en esta ruta.');
}
