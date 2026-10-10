// tauri::generate_context! embeds apps/desktop/dist at compile time, so
// `cargo clippy` / `cargo test` fail if the frontend was never built.
// Create a placeholder index.html when dist/ is missing. A real
// `pnpm build` (run by `tauri build` / `tauri dev`) overwrites it.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "apps", "desktop", "dist");
const index = join(dist, "index.html");

if (!existsSync(index)) {
  mkdirSync(dist, { recursive: true });
  writeFileSync(index, "<!doctype html><title>placeholder</title>\n");
  console.log("ensure-dist: created placeholder apps/desktop/dist/index.html");
}
