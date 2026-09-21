import { Pool } from "@neondatabase/serverless";

let pool: Pool | undefined;

// Lazily-created singleton pool. Never logs or throws the connection
// string itself — only "DATABASE_URL is not set" when missing.
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}
