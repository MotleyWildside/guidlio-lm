import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

export default [
	{
		ignores: ["dist/**", "node_modules/**", ".npm-cache/**"],
	},
	js.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
			},
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
			prettier: prettierPlugin,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			"prettier/prettier": "error",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
		},
	},
	prettierConfig,
];
