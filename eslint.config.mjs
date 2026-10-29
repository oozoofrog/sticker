import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const typescriptFiles = ["**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "test-results/**",
      "playwright-report/**",
      "test-results-local-owner/**",
      "playwright-report-local-owner/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  {
    files: [
      "server/**/*.{js,mjs,cjs}",
      "scripts/**/*.{js,mjs,cjs}",
      "tests/**/*.{js,mjs,cjs}",
      "*.{js,mjs,cjs}",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["client/**/*.{js,jsx,mjs}"],
    languageOptions: { globals: globals.browser },
  },
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    files: typescriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["client/**/*.{ts,tsx}", "tests/ui/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
);
