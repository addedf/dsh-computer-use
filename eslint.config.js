import js from '@eslint/js'
import globals from 'globals'

const javascriptFiles = ['**/*.{js,mjs,cjs}']

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', 'artifacts/**'],
  },
  {
    files: javascriptFiles,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      ...js.configs.recommended.rules,
      // Cleanup and optional diagnostics deliberately ignore some failures.
      // Empty non-catch blocks remain errors.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: javascriptFiles,
    ignores: ['chrome-extension/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['chrome-extension/**/*.js'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
  {
    // These functions are serialized into the page by Playwright. Keep DOM
    // names out of unrelated Node modules so no-undef still detects mistakes.
    files: ['lib/browser-playwright.js', 'lib/browser-observation.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        innerWidth: 'readonly',
        innerHeight: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
  },
  {
    files: ['lib/browser-observation.js'],
    languageOptions: { globals: { Node: 'readonly', NodeFilter: 'readonly' } },
  },
  {
    files: [
      'tests/browser-companion-background.integration.mjs',
      'tests/chrome-bridge-popup.integration.mjs',
      'tests/browser-write-verification.test.mjs',
    ],
    languageOptions: { globals: { window: 'readonly' } },
  },
  {
    files: ['tests/browser-companion-background.integration.mjs'],
    languageOptions: { globals: { document: 'readonly' } },
  },
]
