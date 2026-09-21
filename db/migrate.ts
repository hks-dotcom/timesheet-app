// Applies db/schema.sql. Run with: npm run db:migrate
// Reads DIRECT_URL (falling back to DATABASE_URL) from the environment.
// Never logs the connection string.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "@neondatabase/serverless";

async function main() {
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DIRECT_URL or DATABASE_URL must be set");
  }

  const schemaPath = path.join(__dirname, "schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf8");

  const pool = new Pool({ connectionString });
  try {
    console.log(`Applying ${path.relative(process.cwd(), schemaPath)}...`);
    await pool.query(schemaSql);
    console.log("Schema applied.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
});
