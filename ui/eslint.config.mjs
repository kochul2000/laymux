import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Terminal escape sequences use control characters legitimately
      "no-control-regex": "off",
      // eslint-plugin-react-hooks v7 introduced strict ref rules that flag
      // established patterns (e.g. writing to `*Ref.current` during render
      // for snapshotting latest props). The existing TerminalView code
      // relies on this pattern extensively. Downgrade to a warning until
      // the refactor lands in a dedicated PR; errors here would block every
      // unrelated change touching TerminalView.tsx.
      "react-hooks/refs": "warn",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "react-hooks/rules-of-hooks": "off",
    },
  },
  eslintConfigPrettier,
);
