/**
 * Script de una sola vez: crea el primer administrador de la plataforma.
 *
 * Uso (después de correr schema.sql contra la base de datos):
 *   POSTGRES_URL="..." node schema/seed-admin.mjs "Nombre Admin" admin@correo.com "ContraseñaSegura123"
 *
 * No exponer este script como endpoint HTTP. Es solo para bootstrap inicial.
 */
import { sql } from '@vercel/postgres';
import bcrypt from 'bcryptjs';

const [, , nombre, email, password] = process.argv;

if (!nombre || !email || !password) {
  console.error('Uso: node schema/seed-admin.mjs "Nombre" "email@correo.com" "password"');
  process.exit(1);
}

if (password.length < 8) {
  console.error('La contraseña debe tener al menos 8 caracteres.');
  process.exit(1);
}

const passwordHash = await bcrypt.hash(password, 12);

const existing = await sql`SELECT id FROM admins WHERE email = ${email}`;
if (existing.rows.length > 0) {
  console.error(`Ya existe un administrador con el email ${email}.`);
  process.exit(1);
}

const result = await sql`
  INSERT INTO admins (nombre, email, password_hash)
  VALUES (${nombre}, ${email}, ${passwordHash})
  RETURNING id, nombre, email, created_at
`;

console.log('Administrador de la plataforma creado:');
console.log(result.rows[0]);
process.exit(0);
