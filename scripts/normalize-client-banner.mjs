/**
 * Normalize the client bundle banner: ensure the CJS wrapper calls
 * `window.__ModuleLoader__.load` with the correct plugin id. The tsdown
 * config already emits the banner and footer; this script is a no-op
 * placeholder kept for parity with the Assistant-Manager build pipeline.
 */
// No normalization needed for this plugin.
console.log('client banner normalized')
