/** @type {import('prettier').Config} */
export default {
  semi: true,
  singleQuote: true,
  arrowParens: 'always',
  tabWidth: 2,
  trailingComma: 'all',
  endOfLine: 'lf',
  useTabs: false,
  plugins: ['@ianvs/prettier-plugin-sort-imports'],
  importOrder: [
    '<BUILTIN_MODULES>',
    '<THIRD_PARTY_MODULES>',
    '^@clanker/(.*)$',
    '^[./]',
  ],
};
