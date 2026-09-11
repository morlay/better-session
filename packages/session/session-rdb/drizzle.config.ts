import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/drizzle/sqlite-v3.ts",
  out: "./drizzle/sqlite",
});
