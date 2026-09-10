import { sql } from '@vercel/postgres';

// Re-exportado desde un solo lugar para que toda la app use el mismo cliente
// y sea fácil sustituirlo (por ejemplo en tests) en el futuro.
export { sql };
