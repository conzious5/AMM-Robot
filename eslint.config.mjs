import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: [".next/**","node_modules/**","coverage/**","playwright-report/**","prisma/migrations/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["next-env.d.ts"], rules: { "@typescript-eslint/triple-slash-reference": "off" } },
  { rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }] } },
];
