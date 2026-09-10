-- ============================================================
-- LOGIXT SaaS — Esquema de base de datos (PostgreSQL / Neon)
-- ============================================================
-- Ejecutar una sola vez contra la base de datos de Vercel Postgres.
-- Convención: todas las tablas propiedad de una empresa (tenant)
-- tienen una columna empresa_id y TODAS las consultas del backend
-- deben filtrar por ella. Nunca confiar en el frontend para esto.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1. PLANES (definidos por el propietario de la plataforma)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL,
  precio NUMERIC(10,2) NOT NULL DEFAULT 0,
  periodo TEXT NOT NULL DEFAULT 'MENSUAL' CHECK (periodo IN ('MENSUAL','ANUAL')),
  max_usuarios INT NOT NULL DEFAULT 5,
  max_almacenes INT NOT NULL DEFAULT 1,
  funciones JSONB NOT NULL DEFAULT '{}'::jsonb,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2. ADMINISTRADORES DE LA PLATAFORMA (dueño del software)
--    Independiente de los usuarios de cada empresa.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 3. EMPRESAS (tenants)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS empresas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  telefono TEXT,
  logo TEXT,
  estado TEXT NOT NULL DEFAULT 'ACTIVA' CHECK (estado IN ('ACTIVA','SUSPENDIDA','INACTIVA')),
  plan_id UUID REFERENCES planes(id),
  periodo_gracia_dias INT NOT NULL DEFAULT 5,
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 4. SUSCRIPCIONES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suscripciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES planes(id),
  estado TEXT NOT NULL DEFAULT 'TRIALING' CHECK (estado IN ('ACTIVE','TRIALING','PAST_DUE','CANCELED','SUSPENDED')),
  fecha_inicio TIMESTAMPTZ NOT NULL DEFAULT now(),
  fecha_proximo_pago TIMESTAMPTZ,
  fecha_cancelacion TIMESTAMPTZ,
  -- Reservado para cuando se integre un proveedor de pagos automatizado.
  -- Con pagos por transferencia manual, estos quedan NULL.
  payment_customer_id TEXT,
  payment_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suscripciones_empresa ON suscripciones(empresa_id);

-- ------------------------------------------------------------
-- 5. USUARIOS (del sistema de almacén, pertenecen a una empresa)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'ALMACENERO' CHECK (rol IN ('ADMINISTRADOR','ALMACENERO')),
  estado TEXT NOT NULL DEFAULT 'Activo' CHECK (estado IN ('Activo','Inactivo')),
  avatar TEXT,
  ultimo_acceso TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(empresa_id, username)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
CREATE INDEX IF NOT EXISTS idx_usuarios_empresa ON usuarios(empresa_id);

-- ------------------------------------------------------------
-- 6. ALMACENES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS almacenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  codigo TEXT NOT NULL,
  ciudad TEXT,
  direccion TEXT,
  es_principal BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_almacenes_empresa ON almacenes(empresa_id);

-- ------------------------------------------------------------
-- 7. CATEGORÍAS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categorias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  codigo TEXT NOT NULL,
  descripcion TEXT,
  imagen_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(empresa_id, codigo)
);
CREATE INDEX IF NOT EXISTS idx_categorias_empresa ON categorias(empresa_id);

-- ------------------------------------------------------------
-- 8. PRODUCTOS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS productos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  codigo TEXT NOT NULL,
  codigo_barras TEXT,
  qr_code TEXT,
  categoria_id UUID REFERENCES categorias(id),
  descripcion TEXT,
  almacen_id UUID REFERENCES almacenes(id),
  pasillo TEXT,
  estante TEXT,
  nivel TEXT,
  stock INT NOT NULL DEFAULT 0,
  stock_minimo INT NOT NULL DEFAULT 0,
  unidad TEXT NOT NULL DEFAULT 'unidades',
  estado TEXT NOT NULL DEFAULT 'disponible' CHECK (estado IN ('disponible','stock_bajo','agotado')),
  activo BOOLEAN NOT NULL DEFAULT true,
  imagen_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(empresa_id, codigo)
);
CREATE INDEX IF NOT EXISTS idx_productos_empresa ON productos(empresa_id);

-- ------------------------------------------------------------
-- 9. MOVIMIENTOS (ingresos / despachos / ajustes)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS movimientos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  producto_id UUID NOT NULL REFERENCES productos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('INGRESO','DESPACHO','AJUSTE')),
  cantidad INT NOT NULL,
  stock_anterior INT NOT NULL,
  stock_nuevo INT NOT NULL,
  usuario_id UUID REFERENCES usuarios(id),
  destino_origen TEXT,
  notas TEXT,
  referencia_doc TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movimientos_empresa ON movimientos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_producto ON movimientos(producto_id);

-- ------------------------------------------------------------
-- 10. TRANSFERENCIAS DE PAGO (proceso manual)
--     El cliente reporta una transferencia; el admin la aprueba o
--     rechaza. Nunca se guardan datos sensibles de tarjetas/cuentas.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transferencias_pago (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  suscripcion_id UUID REFERENCES suscripciones(id),
  monto NUMERIC(10,2) NOT NULL,
  referencia TEXT,
  banco_origen TEXT,
  comprobante_url TEXT,
  estado TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','APROBADO','RECHAZADO')),
  notas_admin TEXT,
  revisado_por UUID REFERENCES admins(id),
  revisado_en TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transferencias_empresa ON transferencias_pago(empresa_id);
CREATE INDEX IF NOT EXISTS idx_transferencias_estado ON transferencias_pago(estado);

-- ------------------------------------------------------------
-- 11. LOG DE EVENTOS (auditoría)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eventos_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id) ON DELETE SET NULL,
  usuario_id UUID,
  admin_id UUID,
  tipo_evento TEXT NOT NULL,
  detalle JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eventos_empresa ON eventos_log(empresa_id);
CREATE INDEX IF NOT EXISTS idx_eventos_tipo ON eventos_log(tipo_evento);

-- ============================================================
-- SEED: planes por defecto
-- ============================================================
INSERT INTO planes (nombre, precio, periodo, max_usuarios, max_almacenes, funciones)
VALUES
  ('BÁSICO', 19.99, 'MENSUAL', 3, 1, '{"scanner": true, "alertas": true, "categorias": true}'::jsonb),
  ('PROFESIONAL', 49.99, 'MENSUAL', 10, 3, '{"scanner": true, "alertas": true, "categorias": true, "reportes": true}'::jsonb),
  ('EMPRESA', 129.99, 'MENSUAL', 50, 10, '{"scanner": true, "alertas": true, "categorias": true, "reportes": true, "soporte_prioritario": true}'::jsonb)
ON CONFLICT DO NOTHING;
