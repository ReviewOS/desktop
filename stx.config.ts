/**
 * stx configuration.
 *
 * The component library registers itself through its own plugin shim rather
 * than a hardcoded `componentsDir`: that setting takes a single directory, and
 * the library's tags live under two sibling roots inside the package.
 */
export default {
  plugins: ['@stacksjs/components/stx-plugin'],
  componentsDir: 'src/views/components',
}
