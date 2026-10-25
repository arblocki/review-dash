import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/web/**'], languageOptions: { globals: globals.browser } },
  { files: ['**/*.{js,ts}'], ignores: ['src/web/**'], languageOptions: { globals: globals.node } },
  prettier,
);
