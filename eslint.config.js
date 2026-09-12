// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * JavaScript Standard Style, transcribed by hand from `eslint-config-standard`
 * v17.1.0's `.eslintrc.json` (https://unpkg.com/eslint-config-standard@17.1.0/.eslintrc.json)
 * — verified against ESLint 10.8.0, which still runs every one of these core
 * rule names (formally frozen/deprecated by the ESLint team since 8.53, not
 * removed).
 *
 * `ts-standard` (the TypeScript build of this) is deprecated; its official
 * successor, `eslint-config-love`, requires `eslint@^9.35.0` — a real
 * ERESOLVE conflict with this project's `eslint@10.8.0` (verified via
 * `npm install --dry-run`). Transcribing by hand avoids downgrading ESLint
 * or force-installing an unverified peer combination.
 *
 * Prettier has been removed entirely (previously used for `.ts`/`.js`
 * formatting): Standard's `space-before-function-paren: always` — the
 * `function foo (x)` convention — is a genuine, undisable-in-Prettier
 * conflict (`eslint-config-prettier` turns this exact rule off, confirming
 * it; verified locally that Prettier v3 always strips the space back out
 * on named functions/methods). Rather than add a third-party Prettier
 * plugin just to work around Prettier's own opinion, ESLint's `--fix` (via
 * `npm run format`) is now the sole formatter for `.ts`/`.js`/`.mjs` — the
 * same model `standard`/`ts-standard` themselves use. Non-JS files
 * (`package.json`, `action.yml`, workflow YAML, `README.md`,
 * `tsconfig.json`) are no longer auto-formatted by anything; Standard has
 * no opinion on them and it wasn't worth keeping Prettier around solely
 * for that scope.
 *
 * Deliberate deviations from the transcribed config:
 * - `import/*`, `n/*`, `promise/*` rules skipped — they need
 *   `eslint-plugin-import`/`eslint-plugin-n`/`eslint-plugin-promise`, three
 *   new devDependencies not worth adding just for style parity.
 * - `no-undef` skipped — typescript-eslint's own docs recommend against it
 *   on TS files: the type checker already catches this, and the rule
 *   false-positives on TS-only globals/ambient types.
 * - `no-void` keeps `allowAsStatement: true` (Standard has no exceptions
 *   here) — `void run()` as a top-level statement (`src/index.ts`) is the
 *   idiomatic way to mark an intentionally-unawaited promise.
 * - No rule needs `parserOptions.project` (type-aware linting) — kept out
 *   for lint speed; e.g. `@typescript-eslint/only-throw-error` was tried
 *   and reverted for exactly this reason (throws without type info).
 */
const STANDARD_STYLE_RULES = {
  'no-var': 'error',
  'object-shorthand': ['error', 'properties'],

  'accessor-pairs': ['error', { setWithoutGet: true, enforceForClassMembers: true }],
  'array-bracket-spacing': ['error', 'never'],
  'array-callback-return': ['error', { allowImplicit: false, checkForEach: false }],
  'arrow-spacing': ['error', { before: true, after: true }],
  'block-spacing': ['error', 'always'],
  'brace-style': ['error', '1tbs', { allowSingleLine: true }],
  camelcase: ['error', { allow: ['^UNSAFE_'], properties: 'never', ignoreGlobals: true }],
  'comma-dangle': [
    'error',
    { arrays: 'never', objects: 'never', imports: 'never', exports: 'never', functions: 'never' }
  ],
  'comma-spacing': ['error', { before: false, after: true }],
  'comma-style': ['error', 'last'],
  'computed-property-spacing': ['error', 'never', { enforceForClassMembers: true }],
  'constructor-super': 'error',
  curly: ['error', 'multi-line'],
  'default-case-last': 'error',
  'dot-location': ['error', 'property'],
  'dot-notation': ['error', { allowKeywords: true }],
  'eol-last': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'func-call-spacing': ['error', 'never'],
  'generator-star-spacing': ['error', { before: true, after: true }],
  indent: [
    'error',
    2,
    {
      SwitchCase: 1,
      VariableDeclarator: 1,
      outerIIFEBody: 1,
      MemberExpression: 1,
      FunctionDeclaration: { parameters: 1, body: 1 },
      FunctionExpression: { parameters: 1, body: 1 },
      CallExpression: { arguments: 1 },
      ArrayExpression: 1,
      ObjectExpression: 1,
      ImportDeclaration: 1,
      flatTernaryExpressions: false,
      ignoreComments: false,
      offsetTernaryExpressions: true
    }
  ],
  'key-spacing': ['error', { beforeColon: false, afterColon: true }],
  'keyword-spacing': ['error', { before: true, after: true }],
  'lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
  'multiline-ternary': ['error', 'always-multiline'],
  'new-cap': ['error', { newIsCap: true, capIsNew: false, properties: true }],
  'new-parens': 'error',
  'no-array-constructor': 'error',
  'no-async-promise-executor': 'error',
  'no-caller': 'error',
  'no-case-declarations': 'error',
  'no-class-assign': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': 'error',
  'no-const-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-control-regex': 'error',
  'no-debugger': 'error',
  'no-delete-var': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-useless-backreference': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-empty-character-class': 'error',
  'no-empty-pattern': 'error',
  'no-eval': 'error',
  'no-ex-assign': 'error',
  'no-extend-native': 'error',
  'no-extra-bind': 'error',
  'no-extra-boolean-cast': 'error',
  'no-extra-parens': ['error', 'functions'],
  'no-fallthrough': 'error',
  'no-floating-decimal': 'error',
  'no-func-assign': 'error',
  'no-global-assign': 'error',
  'no-implied-eval': 'error',
  'no-import-assign': 'error',
  'no-invalid-regexp': 'error',
  'no-irregular-whitespace': 'error',
  'no-iterator': 'error',
  'no-labels': ['error', { allowLoop: false, allowSwitch: false }],
  'no-lone-blocks': 'error',
  'no-loss-of-precision': 'error',
  'no-misleading-character-class': 'error',
  'no-prototype-builtins': 'error',
  'no-useless-catch': 'error',
  'no-mixed-operators': [
    'error',
    {
      groups: [
        ['==', '!=', '===', '!==', '>', '>=', '<', '<='],
        ['&&', '||'],
        ['in', 'instanceof']
      ],
      allowSamePrecedence: true
    }
  ],
  'no-mixed-spaces-and-tabs': 'error',
  'no-multi-spaces': 'error',
  'no-multi-str': 'error',
  'no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
  'no-new': 'error',
  'no-new-func': 'error',
  'no-new-object': 'error',
  'no-new-symbol': 'error',
  'no-new-wrappers': 'error',
  'no-obj-calls': 'error',
  'no-octal': 'error',
  'no-octal-escape': 'error',
  'no-proto': 'error',
  'no-redeclare': ['error', { builtinGlobals: false }],
  'no-regex-spaces': 'error',
  'no-return-assign': ['error', 'except-parens'],
  'no-self-assign': ['error', { props: true }],
  'no-self-compare': 'error',
  'no-sequences': 'error',
  'no-shadow-restricted-names': 'error',
  'no-sparse-arrays': 'error',
  'no-tabs': 'error',
  'no-template-curly-in-string': 'error',
  'no-this-before-super': 'error',
  'no-throw-literal': 'error',
  'no-trailing-spaces': 'error',
  'no-undef-init': 'error',
  'no-unexpected-multiline': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-unneeded-ternary': ['error', { defaultAssignment: false }],
  'no-unreachable': 'error',
  'no-unreachable-loop': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unused-expressions': [
    'error',
    { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true }
  ],
  'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
  'no-useless-call': 'error',
  'no-useless-computed-key': 'error',
  'no-useless-constructor': 'error',
  'no-useless-escape': 'error',
  'no-useless-rename': 'error',
  'no-useless-return': 'error',
  'no-void': ['error', { allowAsStatement: true }],
  'no-whitespace-before-property': 'error',
  'no-with': 'error',
  'object-curly-newline': ['error', { multiline: true, consistent: true }],
  'object-curly-spacing': ['error', 'always'],
  'object-property-newline': ['error', { allowMultiplePropertiesPerLine: true }],
  'one-var': ['error', { initialized: 'never' }],
  'operator-linebreak': ['error', 'after', { overrides: { '?': 'before', ':': 'before' } }],
  'padded-blocks': ['error', { blocks: 'never', switches: 'never', classes: 'never' }],
  'prefer-const': ['error', { destructuring: 'all' }],
  'prefer-promise-reject-errors': 'error',
  'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],
  'quote-props': ['error', 'as-needed'],
  quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: false }],
  'rest-spread-spacing': ['error', 'never'],
  semi: ['error', 'never'],
  'semi-spacing': ['error', { before: false, after: true }],
  'space-before-blocks': ['error', 'always'],
  'space-before-function-paren': ['error', 'always'],
  'space-in-parens': ['error', 'never'],
  'space-infix-ops': 'error',
  'space-unary-ops': ['error', { words: true, nonwords: false }],
  'spaced-comment': [
    'error',
    'always',
    {
      line: { markers: ['*package', '!', '/', ',', '='] },
      block: {
        balanced: true,
        markers: ['*package', '!', ',', ':', '::', 'flow-include'],
        exceptions: ['*']
      }
    }
  ],
  'symbol-description': 'error',
  'template-curly-spacing': ['error', 'never'],
  'template-tag-spacing': ['error', 'never'],
  'unicode-bom': ['error', 'never'],
  'use-isnan': ['error', { enforceForSwitchCase: true, enforceForIndexOf: true }],
  'valid-typeof': ['error', { requireStringLiterals: true }],
  'wrap-iife': ['error', 'any', { functionPrototypeMethods: true }],
  'yield-star-spacing': ['error', 'both'],
  yoda: ['error', 'never']
}

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.claude/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mjs', 'eslint.config.js'],
    rules: STANDARD_STYLE_RULES
  },
  {
    files: ['**/*.ts'],
    rules: {
      // Не чрезмерно строго на этапе 0 — цель tooling-каркас, а не
      // финальная строгость линта. Ужесточение — по мере роста кодовой базы.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'module'
    }
  }
)
