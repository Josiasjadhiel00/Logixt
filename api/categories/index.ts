import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireTenant, logEvent } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireTenant(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const { rows } = await sql`
      SELECT c.id, c.nombre, c.codigo, c.descripcion, c.imagen_url, c.created_at,
             (SELECT COUNT(*) FROM productos p WHERE p.categoria_id = c.id AND p.empresa_id = ${ctx.empresa.id}) AS total_productos,
             (SELECT COALESCE(SUM(p.stock), 0) FROM productos p WHERE p.categoria_id = c.id AND p.empresa_id = ${ctx.empresa.id}) AS total_unidades
      FROM categorias c
      WHERE c.empresa_id = ${ctx.empresa.id}
      ORDER BY c.nombre ASC
    `;
    return ok(res, { categorias: rows });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as { nombre?: string; codigo?: string; descripcion?: string; imagenUrl?: string };
    if (!body.nombre || !body.codigo) {
      return fail(res, 400, 'DATOS_INCOMPLETOS', 'Nombre y código son requeridos.');
    }
    const { rows: dup } = await sql`
      SELECT id FROM categorias WHERE empresa_id = ${ctx.empresa.id} AND codigo = ${body.codigo}
    `;
    if (dup.length > 0) return fail(res, 409, 'CODIGO_DUPLICADO', 'Ya existe una categoría con ese código.');

    const { rows } = await sql`
      INSERT INTO categorias (empresa_id, nombre, codigo, descripcion, imagen_url)
      VALUES (${ctx.empresa.id}, ${body.nombre}, ${body.codigo}, ${body.descripcion ?? null}, ${body.imagenUrl ?? null})
      RETURNING id, nombre, codigo, descripcion, imagen_url
    `;
    await logEvent({ empresaId: ctx.empresa.id, usuarioId: ctx.usuario.id, tipoEvento: 'CATEGORIA_CREADA', detalle: { categoriaId: rows[0].id } });
    return ok(res, { categoria: rows[0] }, 201);
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}
