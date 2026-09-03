import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// The four-layer boundary described in docs/DEVELOPMENT.md is enforced here instead of
// by review alone: renderer never reaches Node or the main process, shared stays loadable
// in both processes, and main never depends on renderer internals.
const rendererForbidden = [
  { group: ['electron', 'node:*'], message: 'renderer 只能通过 preload 的类型化契约访问系统能力。' },
  { group: ['**/main/**', '**/preload/**'], message: 'renderer 不得直接引用主进程或 preload 实现，请使用 src/shared 契约。' },
];

const sharedForbidden = [
  { group: ['electron', 'node:*'], message: 'src/shared 同时被 renderer 加载，不能依赖 Electron 或 Node 内建模块。' },
  { group: ['**/main/**', '**/renderer/**', '**/preload/**'], message: 'src/shared 是被依赖的底层，不得反向引用任何进程层。' },
];

export default tseslint.config(
  // Mirrors the build/local directories excluded by .gitignore so a stray local
  // checkout or backup under .local/ never becomes a lint failure.
  {
    ignores: [
      '.webpack/', 'out/', 'dist/', 'coverage/', 'test-results/', 'output/', 'node_modules/',
      '.local/', '.tools/', '.npm-cache/', '.playwright-cli/', '.agents/', '.codex/',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Path and filter validation deliberately rejects C0 control characters; flagging
      // those literals as suspicious is a false positive across this codebase.
      'no-control-regex': 'off',
      // Async methods that satisfy an async interface without awaiting are intentional
      // (probe/sanitize implementations, test doubles), so this rule is pure noise here.
      '@typescript-eslint/require-await': 'off',
      // A leading underscore already marks a deliberately unused binding for
      // tsconfig's noUnusedLocals / noUnusedParameters; keep both checkers aligned.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Application source: strictest. No console anywhere in src is an existing invariant
  // (diagnostics go through src/main/infrastructure/diagnostics), so keep it that way.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': ['error', { patterns: rendererForbidden }],
      // Reported as warnings on purpose. These flag real React issues (effect-driven
      // setState, incomplete dependency lists, refs read during render) in code that
      // currently passes the packaged E2E suite. Resolving them changes render timing,
      // so they belong to a dedicated pass with E2E re-verification rather than to a
      // blanket autofix. Tracked in docs/DEVELOPMENT.md#已知的-react-hooks-待办.
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },

  {
    files: ['src/shared/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: sharedForbidden }] },
  },

  {
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/renderer/**'], message: '主进程不得引用 renderer 实现。' }] },
      ],
    },
  },

  {
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/main/**', '**/renderer/**'], message: 'preload 只桥接 src/shared 契约，不引用两侧实现。' },
          ],
        },
      ],
    },
  },

  // Tests, build scripts and E2E drivers legitimately use Node, the console, loose typing
  // and detached method references on test doubles.
  {
    files: ['tests/**/*.{ts,mts,mjs}', 'scripts/**/*.{cjs,mjs}', '*.{ts,mts,mjs}'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // CommonJS build scripts are not part of the TypeScript program. disableTypeChecked only
  // switches the rules off, so projectService must be disabled too or the parser fails
  // trying to locate these files in tsconfig.
  {
    files: ['**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      sourceType: 'commonjs',
      parserOptions: { projectService: false, project: null },
      globals: globals.node,
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // These files are CommonJS by design; require() is the module system, not a lapse.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Plain ESM helpers (E2E drivers, this config) are likewise outside the typed program.
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false, project: null },
      globals: globals.node,
    },
  },
);
