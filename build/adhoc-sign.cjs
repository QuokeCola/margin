// Ad-hoc sign the macOS app before the DMG is made. Without any signature, Apple-silicon Macs
// report downloaded Electron apps as "damaged". This is not notarization: users still approve
// the first launch (right-click → Open, or System Settings → Privacy & Security → Open Anyway).
const {execFileSync} = require('node:child_process');
exports.default = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], {stdio: 'inherit'});
};
