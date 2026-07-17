/** @type {import('prettier').Config} */
export default {
  semi: false,
  singleQuote: true,
  arrowParens: 'avoid',
  tabWidth: 2,
  trailingComma: 'none',
  endOfLine: 'lf',
  useTabs: false,
  plugins: ['@ianvs/prettier-plugin-sort-imports'],
  importOrder: [
    '<BUILTIN_MODULES>',
    '<THIRD_PARTY_MODULES>',
    '^@clanker/(.*)$',
    '^[./]'
  ]
}
