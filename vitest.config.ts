import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({ test: { environment: "node", exclude: ["tests/e2e/**","node_modules/**"], coverage: { reporter: ["text","html"] } }, resolve: { alias: { "@": path.resolve(__dirname,"src") } } });
