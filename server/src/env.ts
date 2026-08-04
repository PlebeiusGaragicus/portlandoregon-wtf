// Load repo-root .env into process.env (no-op if absent). Imported first by index.ts.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootEnv = join(fileURLToPath(new URL(".", import.meta.url)), "../../.env");
try {
  process.loadEnvFile(rootEnv);
} catch {
  // .env not present — rely on real environment variables
}
