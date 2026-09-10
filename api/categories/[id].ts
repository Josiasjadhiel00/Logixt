import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireTenant, logEvent } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireTenant(req, res);
  if (!ctx) return;

  const id = req.query.id as string;
  const { rows: existing } = await sql`SELECT id FROM categorias WHERE id = ${id} AND empresa_id = ${ctx.empresa.id}`;
  if (existing.length === 0) return fail(res, 404, 'NO_ENCONTRADA', 'Categoría no encontrada.');

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as { nombre?: string; descripcion?: string; imagenUrl?: string };
    const { rows } = await sql`
      UPDATE categorias SET
        nombre = COALESCE(${body.nombre ?? null}, nombre),
        descripcion = COALESCE(${body.descripcion ?? null}, descripcion),
        imagen_url = COALESCE(${body.imagenUrl ?? null}, imagen_url),
        updated_at = now()
      WHERE id = ${id} AND empresa_id = ${ctx.empresa.id}
      RETURNING id, nombre, codigo, descripcion, imagen_url
    `;
    await logEvent({ empresaId: ctx.empresa.id, usuarioId: ctx.usuario.id, tipoEvento: 'CATEGORIA_EDITADA', detalle: { categoriaId: id } });
    return ok(res, { categoria: rows[0] });
  }

  if (req.method === 'DELETE') {
    const { rows: enUso } = await sql`
      SELECT COUNT(*)::int AS total FROM productos WHERE categoria_id = ${id} AND empresa_id = ${ctx.empresa.id} AND activo = true
    `;
    if (enUso[0].total > 0) {
      return fail(res, 409, 'CATEGORIA_EN_USO', 'No puedes eliminar una categoría con productos activos asignados.');
    }
    await sql`DELETE FROM categorias WHERE id = ${id} AND empresa_id = ${ctx.empresa.id}`;
    await logEvent({ empresaId: ctx.empresa.id, usuarioId: ctx.usuario.id, tipoEvento: 'CATEGORIA_ELIMINADA', detalle: { categoriaId: id } });
    return ok(res, { success: true });
  }

  return methodNotAllowed(res, ['PATCH', 'DELETE']);
}
