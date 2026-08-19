/**
 * ESLint flat config.
 *
 * Next 16 removed the `next lint` command, and eslint-config-next 16 requires
 * ESLint 9, which reads eslint.config.* instead of .eslintrc.json. Both changes
 * land together or not at all, so this file replaces .eslintrc.json and
 * `npm run lint` now calls eslint directly.
 *
 * SCOPE IS DELIBERATE. `next lint` linted a fixed set of directories (app,
 * components, lib, pages, src) and silently ignored everything else. Flat
 * config has no such default: pointed at the repo root it would lint scripts/,
 * tests/, server/ and packages/ for the first time and report hundreds of
 * pre-existing problems in code nobody touched, which is how `npm run lint`
 * became unrunnable on a clean checkout once before (#8). The same three
 * directories are kept here so the command means what it meant yesterday.
 * Widening it is a separate change with its own cleanup.
 */
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    // Flat config has no .eslintignore. Without this, eslint walks build
    // output and node_modules.
    ignores: [
      '**/node_modules/**',
      '.next/**',
      '.next-build/**',
      'out/**',
      'build/**',
      'coverage/**',
      'public/**',
      'storage/**',
      'logs/**',
      'test-results/**',
      'packages/*/dist/**',
      'prisma/generated/**',
      'next-env.d.ts',
      // Generated tenant backends. This is user project code the platform
      // wrote, not repository source, and it is not ours to lint — a stray
      // parse error in one of them must never fail our build.
      'workspace/**',
    ],
  },
  ...nextCoreWebVitals,
  {
    /**
     * The React Compiler rules, demoted from error to warning.
     *
     * eslint-config-next 16 turns these on as ERRORS. They are new rules, not
     * new defects: on eslint-config-next 14 nothing checked any of this, and
     * every one of the 54 hits is pre-existing code that has been shipping.
     * Left as errors they fail `npm run lint`, which fails the `static` CI job,
     * which is precisely the "first command a new contributor runs fails on
     * code they never touched" problem that #8 was filed for and 5491a293
     * fixed.
     *
     * Warning rather than off, on purpose: these are real signals and stay
     * visible on every run. They are not fixable as part of a dependency bump
     * though. 43 of them are set-state-in-effect, and unpicking a setState out
     * of an effect changes render behaviour, so it needs its own change with
     * the UI actually exercised.
     *
     *   43  react-hooks/set-state-in-effect
     *    8  react-hooks/immutability
     *    2  react-hooks/purity
     *    1  react-hooks/refs
     *
     * Promote these back to 'error' as the count is worked down.
     */
    // Flat config requires the plugin to be declared in the same object that
    // sets its rules, so it is re-declared here rather than inherited.
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
]
