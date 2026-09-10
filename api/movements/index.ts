import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '@vercel/postgres';
import { sql } from '../../lib/db';
import { requireTenant, logEvent } from '../../lib/tenant';
import { ok, fail, methodNotAllowed } from '../../lib/response';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireTenant(req, res);
  if (!ctx) return;

  if (req.method === 'GET') {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await sql`
      SELECT m.id, m.producto_id, p.nombre AS producto_nombre, p.codigo AS producto_codigo,
             m.tipo, m.cantidad, m.stock_anterior, m.stock_nuevo, m.destino_origen, m.notas,
             m.referencia_doc, m.created_at, u.nombre AS usuario_nombre
      FROM movimientos m
      JOIN productos p ON p.id = m.producto_id
      LEFT JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.empresa_id = ${ctx.empresa.id}
      ORDER BY m.created_at DESC
      LIMIT ${limit}
    `;
    return ok(res, { movimientos: rows });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as {
      productoId?: string; tipo?: 'INGRESO' | 'DESPACHO' | 'AJUSTE'; cantidad?: number;
      destinoOrigen?: string; notas?: string; referenciaDoc?: string;
    };

    if (!body.productoId || !body.tipo || !body.cantidad || body.cantidad <= 0) {
      return fail(res, 400, 'DATOS_INCOMPLETOS', 'Producto, tipo y cantidad (positiva) son requeridos.');
    }
    if (!['INGRESO', 'DESPACHO', 'AJUSTE'].includes(body.tipo)) {
      return fail(res, 400, 'TIPO_INVALIDO', 'Tipo de movimiento no válido.');
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // FOR UPDATE bloquea la fila del producto hasta el COMMIT: si dos
      // despachos del mismo producto llegan a la vez, el segundo espera
      // y ve el stock ya actualizado por el primero — nunca se vende de
      // más por una condición de carrera.
      const productResult = await client.query(
        `SELECT id, stock, stock_minimo, nombre, unidad FROM productos
         WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
        [body.productoId, ctx.empresa.id]
      );
      const producto = productResult.rows[0];
      if (!producto) {
        await client.query('ROLLBACK');
        return fail(res, 404, 'PRODUCTO_NO_ENCONTRADO', 'Producto no encontrado.');
      }

      const stockAnterior = producto.stock as number;
      let stockNuevo: number;
      if (body.tipo === 'DESPACHO') {
        if (body.cantidad > stockAnterior) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'STOCK_INSUFICIENTE', `Stock insuficiente. Disponible: ${stockAnterior} ${producto.unidad}.`);
        }
        stockNuevo = stockAnterior - body.cantidad;
      } else if (body.tipo === 'INGRESO') {
        stockNuevo = stockAnterior + body.cantidad;
      } else {
        // AJUSTE: cantidad representa el nuevo stock absoluto.
        stockNuevo = body.cantidad;
      }

      const nuevoEstado = stockNuevo === 0 ? 'agotado' : stockNuevo <= producto.stock_minimo ? 'stock_bajo' : 'disponible';

      await client.query(
        `UPDATE productos SET stock = $1, estado = $2, updated_at = now() WHERE id = $3`,
        [stockNuevo, nuevoEstado, producto.id]
      );

      const movResult = await client.query(
        `INSERT INTO movimientos (
           empresa_id, producto_id, tipo, cantidad, stock_anterior, stock_nuevo,
           usuario_id, destino_origen, notas, referencia_doc
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, tipo, cantidad, stock_anterior, stock_nuevo, created_at`,
        [
          ctx.empresa.id, producto.id, body.tipo, body.cantidad, stockAnterior, stockNuevo,
          ctx.usuario.id, body.destinoOrigen ?? null, body.notas ?? null, body.referenciaDoc ?? null,
        ]
      );

      await client.query('COMMIT');

      await logEvent({
        empresaId: ctx.empresa.id, usuarioId: ctx.usuario.id,
        tipoEvento: `MOVIMIENTO_${body.tipo}`,
        detalle: { productoId: producto.id, cantidad: body.cantidad, stockNuevo },
      });

      return ok(res, {
        movimiento: movResult.rows[0],
        producto: { id: producto.id, nombre: producto.nombre, stock: stockNuevo, estado: nuevoEstado },
      }, 201);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error creando movimiento:', err);
      return fail(res, 500, 'ERROR_INTERNO', 'No se pudo registrar el movimiento.');
    } finally {
      client.release();
    }
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}
