import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/drizzle/postgres-v3.ts",
  out: "./drizzle/postgres",
});
