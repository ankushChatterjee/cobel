/**
 * electron-builder's ad-hoc signing pass can leave the app executable and
 * `Electron Framework.framework` with signatures dyld rejects on recent macOS
 * ("different Team IDs"). The process exits immediately; macOS shows
 * "cannot be opened because of a problem".
 *
 * Deep ad-hoc re-sign unifies the bundle. Set SKIP_DEEP_ADHOC_SIGN=1 when
 * using a Developer ID identity + notarization and you handle signing yourself.
 */
const { execSync } = require('node:child_process')
const path = require('node:path')

module.exports = async function deepSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.SKIP_DEEP_ADHOC_SIGN === '1') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  console.log(`[afterSign] Deep ad-hoc codesign: ${appPath}`)
  execSync(`codesign --force --deep --sign - ${JSON.stringify(appPath)}`, { stdio: 'inherit' })
}
