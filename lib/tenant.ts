import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from './db';
import { verifyTenantSession, verifyAdminSession, TENANT_COOKIE_NAME, ADMIN_COOKIE_NAME } from './auth';
import { fail } from './response';

export interface TenantUser {
  id: string;
  empresaId: string;
  nombre: string;
  email: string;
  rol: 'ADMINISTRADOR' | 'ALMACENERO';
  estado: 'Activo' | 'Inactivo';
}

export interface Empresa {
  id: string;
  nombre: string;
  estado: 'ACTIVA' | 'SUSPENDIDA' | 'INACTIVA';
  planId: string | null;
  periodoGraciaDias: number;
}

export interface Suscripcion {
  id: string;
  estado: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED' | 'SUSPENDED';
  fechaProximoPago: string | null;
  enPeriodoGracia: boolean;
}

export interface TenantContext {
  usuario: TenantUser;
  empresa: Empresa;
  suscripcion: Suscripcion | null;
}

/**
 * Determina si, dado el estado de la suscripción y el período de gracia
 * configurado por la empresa, el acceso a funciones operativas debe
 * permitirse. Esta misma función la usa el cron de automatización para
 * decidir cuándo pasar una suscripción de PAST_DUE a SUSPENDED.
 */
export function isWithinGracePeriod(
  fechaProximoPago: string | null,
  periodoGraciaDias: number
): boolean {
  if (!fechaProximoPago) return false;
  const limite = new Date(fechaProximoPago);
  limite.setDate(limite.getDate() + periodoGraciaDias);
  return new Date() <= limite;
}

function readCookie(req: VercelRequest, name: string): string | null {
  const raw = (req.cookies as Record<string, string> | undefined)?.[name];
  return raw ?? null;
}

export interface TenantContextResult {
  /** Contexto completo cuando la autenticación fue exitosa (independiente de si el acceso operativo está bloqueado). */
  context: TenantContext | null;
  /** Error de autenticación (sesión ausente/inválida/usuario inactivo) — no hay contexto en absoluto. */
  authError: { status: number; code: string; message: string } | null;
  /** La empresa/suscripción existen y el usuario está autenticado, pero el acceso operativo debe bloquearse. */
  accessBlocked: { status: number; code: string; message: string } | null;
}

/**
 * Carga el contexto de tenant sin escribir ninguna respuesta HTTP.
 * Úsalo cuando la ruta necesita decidir por sí misma qué hacer con cada
 * tipo de bloqueo (por ejemplo /api/auth/me, que debe devolver el estado
 * de la suscripción en vez de solo fallar). Para el resto de las rutas,
 * usa `requireTenant`, que envuelve esto y ya escribe la respuesta.
 */
export async function loadTenantContext(req: VercelRequest): Promise<TenantContextResult> {
  const empty: TenantContextResult = { context: null, authError: null, accessBlocked: null };

  const token = readCookie(req, TENANT_COOKIE_NAME);
  if (!token) {
    return { ...empty, authError: { status: 401, code: 'NO_AUTENTICADO', message: 'Debes iniciar sesión.' } };
  }

  const payload = await verifyTenantSession(token);
  if (!payload) {
    return {
      ...empty,
      authError: {
        status: 401,
        code: 'SESION_INVALIDA',
        message: 'Tu sesión expiró o es inválida. Inicia sesión de nuevo.',
      },
    };
  }

  // Siempre releer desde la base de datos: nunca confiar en el estado
  // "congelado" dentro del JWT para decisiones de acceso, ya que la
  // empresa o el usuario pudieron cambiar de estado después de emitirlo.
  const { rows: userRows } = await sql`
    SELECT id, empresa_id, nombre, email, rol, estado
    FROM usuarios
    WHERE id = ${payload.sub} AND empresa_id = ${payload.empresaId}
  `;
  const userRow = userRows[0];
  if (!userRow || userRow.estado !== 'Activo') {
    return {
      ...empty,
      authError: {
        status: 401,
        code: 'USUARIO_INACTIVO',
        message: 'Tu usuario no está activo. Contacta a tu administrador.',
      },
    };
  }

  const { rows: empresaRows } = await sql`
    SELECT id, nombre, estado, plan_id, periodo_gracia_dias
    FROM empresas
    WHERE id = ${userRow.empresa_id}
  `;
  const empresaRow = empresaRows[0];
  if (!empresaRow) {
    return {
      ...empty,
      authError: {
        status: 401,
        code: 'EMPRESA_NO_ENCONTRADA',
        message: 'La empresa asociada a este usuario no existe.',
      },
    };
  }

  const usuario: TenantUser = {
    id: userRow.id,
    empresaId: userRow.empresa_id,
    nombre: userRow.nombre,
    email: userRow.email,
    rol: userRow.rol,
    estado: userRow.estado,
  };
  const empresa: Empresa = {
    id: empresaRow.id,
    nombre: empresaRow.nombre,
    estado: empresaRow.estado,
    planId: empresaRow.plan_id,
    periodoGraciaDias: empresaRow.periodo_gracia_dias,
  };

  if (empresa.estado !== 'ACTIVA') {
    return {
      context: { usuario, empresa, suscripcion: null },
      authError: null,
      accessBlocked: {
        status: 403,
        code: empresa.estado === 'SUSPENDIDA' ? 'EMPRESA_SUSPENDIDA' : 'EMPRESA_INACTIVA',
        message: 'Tu empresa no tiene acceso activo actualmente. Contacta al administrador de la plataforma.',
      },
    };
  }

  const { rows: subRows } = await sql`
    SELECT id, estado, fecha_proximo_pago
    FROM suscripciones
    WHERE empresa_id = ${empresa.id}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const subRow = subRows[0];

  let suscripcion: Suscripcion | null = null;
  if (subRow) {
    const enGracia =
      subRow.estado === 'PAST_DUE' &&
      isWithinGracePeriod(subRow.fecha_proximo_pago, empresa.periodoGraciaDias);

    suscripcion = {
      id: subRow.id,
      estado: subRow.estado,
      fechaProximoPago: subRow.fecha_proximo_pago,
      enPeriodoGracia: enGracia,
    };

    const bloqueado =
      subRow.estado === 'SUSPENDED' ||
      subRow.estado === 'CANCELED' ||
      (subRow.estado === 'PAST_DUE' && !enGracia);

    if (bloqueado) {
      return {
        context: { usuario, empresa, suscripcion },
        authError: null,
        accessBlocked: {
          status: 402,
          code: 'SUSCRIPCION_SUSPENDIDA',
          message: 'Tu suscripción no está activa actualmente. Contacta al administrador para renovar el servicio.',
        },
      };
    }
  }
  // Nota: si no existe ninguna fila de suscripción, no se bloquea aquí a
  // propósito (permite que una empresa recién creada por el admin sin
  // suscripción todavía asignada no quede huérfana), pero en la práctica
  // toda empresa creada por /api/companies recibe una suscripción TRIALING.

  return { context: { usuario, empresa, suscripcion }, authError: null, accessBlocked: null };
}

/**
 * Guard principal para TODAS las rutas /api/* operativas del sistema de
 * almacén (tenant). Si algo falla, escribe la respuesta de error y
 * retorna null — el llamador debe simplemente `return` en ese caso.
 */
export async function requireTenant(
  req: VercelRequest,
  res: VercelResponse
): Promise<TenantContext | null> {
  const { context, authError, accessBlocked } = await loadTenantContext(req);

  if (authError) {
    fail(res, authError.status, authError.code, authError.message);
    return null;
  }
  if (accessBlocked) {
    fail(res, accessBlocked.status, accessBlocked.code, accessBlocked.message);
    return null;
  }
  return context;
}

/** Verifica permisos por rol dentro de un contexto ya autenticado. */
export function requireRole(
  ctx: TenantContext,
  res: VercelResponse,
  roles: Array<'ADMINISTRADOR' | 'ALMACENERO'>
): boolean {
  if (!roles.includes(ctx.usuario.rol)) {
    fail(res, 403, 'PERMISO_DENEGADO', 'No tienes permiso para realizar esta acción.');
    return false;
  }
  return true;
}

export interface AdminContext {
  admin: { id: string; nombre: string; email: string };
}

/** Guard para las rutas /api/admin/* y de gestión de empresas/planes/pagos. */
export async function requireAdmin(
  req: VercelRequest,
  res: VercelResponse
): Promise<AdminContext | null> {
  const token = readCookie(req, ADMIN_COOKIE_NAME);
  if (!token) {
    fail(res, 401, 'NO_AUTENTICADO', 'Debes iniciar sesión como administrador.');
    return null;
  }
  const payload = await verifyAdminSession(token);
  if (!payload) {
    fail(res, 401, 'SESION_INVALIDA', 'Tu sesión de administrador expiró.');
    return null;
  }
  const { rows } = await sql`SELECT id, nombre, email FROM admins WHERE id = ${payload.sub}`;
  const admin = rows[0];
  if (!admin) {
    fail(res, 401, 'ADMIN_NO_ENCONTRADO', 'Administrador no encontrado.');
    return null;
  }
  return { admin };
}

/** Escribe un registro en el log de auditoría. Nunca debe tumbar la request si falla. */
export async function logEvent(params: {
  empresaId?: string | null;
  usuarioId?: string | null;
  adminId?: string | null;
  tipoEvento: string;
  detalle?: Record<string, unknown>;
}) {
  try {
    await sql`
      INSERT INTO eventos_log (empresa_id, usuario_id, admin_id, tipo_evento, detalle)
      VALUES (
        ${params.empresaId ?? null},
        ${params.usuarioId ?? null},
        ${params.adminId ?? null},
        ${params.tipoEvento},
        ${JSON.stringify(params.detalle ?? {})}
      )
    `;
  } catch (err) {
    console.error('No se pudo registrar evento de auditoría:', err);
  }
}
