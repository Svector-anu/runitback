import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "docs", "node_modules", "e2e/.artifacts", "src/platform/denoise/vendor"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
);
