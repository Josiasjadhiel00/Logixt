import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireTenant, logEvent } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireTenant(req, res);
  if (!ctx) return;

  const id = req.query.id as string;

  // Cláusula empresa_id en TODAS las consultas: es lo único que impide
  // que la Empresa A alcance un recurso de la Empresa B adivinando el id.
  const { rows: existing } = await sql`
    SELECT id FROM productos WHERE id = ${id} AND empresa_id = ${ctx.empresa.id}
  `;
  if (existing.length === 0) return fail(res, 404, 'NO_ENCONTRADO', 'Producto no encontrado.');

  if (req.method === 'GET') {
    const { rows } = await sql`
      SELECT p.*, c.nombre AS categoria_nombre, a.nombre AS almacen_nombre
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN almacenes a ON a.id = p.almacen_id
      WHERE p.id = ${id} AND p.empresa_id = ${ctx.empresa.id}
    `;
    return ok(res, { producto: rows[0] });
  }

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const { rows: currentRows } = await sql`SELECT stock, stock_minimo FROM productos WHERE id = ${id}`;
    const stock = (body.stock as number | undefined) ?? currentRows[0].stock;
    const stockMinimo = (body.stockMinimo as number | undefined) ?? currentRows[0].stock_minimo;
    const estado = stock === 0 ? 'agotado' : stock <= stockMinimo ? 'stock_bajo' : 'disponible';

    const { rows } = await sql`
      UPDATE productos SET
        nombre = COALESCE(${(body.nombre as string) ?? null}, nombre),
        codigo_barras = COALESCE(${(body.codigoBarras as string) ?? null}, codigo_barras),
        qr_code = COALESCE(${(body.qrCode as string) ?? null}, qr_code),
        categoria_id = COALESCE(${(body.categoriaId as string) ?? null}, categoria_id),
        descripcion = COALESCE(${(body.descripcion as string) ?? null}, descripcion),
        almacen_id = COALESCE(${(body.almacenId as string) ?? null}, almacen_id),
        pasillo = COALESCE(${(body.pasillo as string) ?? null}, pasillo),
        estante = COALESCE(${(body.estante as string) ?? null}, estante),
        nivel = COALESCE(${(body.nivel as string) ?? null}, nivel),
        stock = ${stock},
        stock_minimo = ${stockMinimo},
        unidad = COALESCE(${(body.unidad as string) ?? null}, unidad),
        estado = ${estado},
        activo = COALESCE(${(body.activo as boolean) ?? null}, activo),
        imagen_url = COALESCE(${(body.imagenUrl as string) ?? null}, imagen_url),
        updated_at = now()
      WHERE id = ${id} AND empresa_id = ${ctx.empresa.id}
      RETURNING id, nombre, codigo, stock, stock_minimo, estado, activo
    `;

    await logEvent({
      empresaId: ctx.empresa.id, usuarioId: ctx.usuario.id,
      tipoEvento: 'PRODUCTO_EDITADO', detalle: { productoId: id },
    });

    return ok(res, { producto: rows[0] });
  }

  if (req.method === 'DELETE') {
    // Baja lógica: nunca se borra el historial de movimientos asociado.
    await sql`UPDATE productos SET activo = false, updated_at = now() WHERE id = ${id} AND empresa_id = ${ctx.empresa.id}`;
    await logEvent({ empresaId: ctx.empresa.id, usuarioId: ctx.usuario.id, tipoEvento: 'PRODUCTO_DESACTIVADO', detalle: { productoId: id } });
    return ok(res, { success: true });
  }

  return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
}
