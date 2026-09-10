import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../lib/db';
import { requireTenant, logEvent } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireTenant(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    // SIEMPRE filtrado por empresa_id — nunca confiar en query params del cliente para esto.
    const { rows } = await sql`
      SELECT p.id, p.nombre, p.codigo, p.codigo_barras, p.qr_code, p.categoria_id,
             c.nombre AS categoria_nombre, p.descripcion, p.almacen_id, a.nombre AS almacen_nombre,
             p.pasillo, p.estante, p.nivel,
             p.stock, p.stock_minimo, p.unidad, p.estado, p.activo, p.imagen_url,
             p.created_at, p.updated_at
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN almacenes a ON a.id = p.almacen_id
      WHERE p.empresa_id = ${ctx.empresa.id}
      ORDER BY p.created_at DESC
    `;
    return ok(res, { productos: rows });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as {
      nombre?: string; codigo?: string; codigoBarras?: string; qrCode?: string;
      categoriaId?: string; descripcion?: string; almacenId?: string;
      pasillo?: string; estante?: string; nivel?: string;
      stock?: number; stockMinimo?: number; unidad?: string; imagenUrl?: string;
    };
    if (!body.nombre || !body.codigo) {
      return fail(res, 400, 'DATOS_INCOMPLETOS', 'Nombre y código son requeridos.');
    }

    const { rows: dup } = await sql`
      SELECT id FROM productos WHERE empresa_id = ${ctx.empresa.id} AND codigo = ${body.codigo}
    `;
    if (dup.length > 0) {
      return fail(res, 409, 'CODIGO_DUPLICADO', 'Ya existe un producto con ese código en tu empresa.');
    }

    const stock = body.stock ?? 0;
    const stockMinimo = body.stockMinimo ?? 0;
    const estado = stock === 0 ? 'agotado' : stock <= stockMinimo ? 'stock_bajo' : 'disponible';

    const { rows } = await sql`
      INSERT INTO productos (
        empresa_id, nombre, codigo, codigo_barras, qr_code, categoria_id, descripcion,
        almacen_id, pasillo, estante, nivel, stock, stock_minimo, unidad, estado, imagen_url
      ) VALUES (
        ${ctx.empresa.id}, ${body.nombre}, ${body.codigo}, ${body.codigoBarras ?? null},
        ${body.qrCode ?? `QR-${body.codigo}`}, ${body.categoriaId ?? null}, ${body.descripcion ?? null},
        ${body.almacenId ?? null}, ${body.pasillo ?? null}, ${body.estante ?? null}, ${body.nivel ?? null},
        ${stock}, ${stockMinimo}, ${body.unidad ?? 'unidades'}, ${estado}, ${body.imagenUrl ?? null}
      )
      RETURNING id, nombre, codigo, codigo_barras, qr_code, stock, stock_minimo, unidad, estado, activo
    `;

    await logEvent({
      empresaId: ctx.empresa.id, usuarioId: ctx.usuario.id,
      tipoEvento: 'PRODUCTO_CREADO', detalle: { productoId: rows[0].id, codigo: body.codigo },
    });

    return ok(res, { producto: rows[0] }, 201);
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}
