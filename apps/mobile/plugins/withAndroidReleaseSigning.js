// Signs the Android release build with the upload key the build's environment names (PLX-1608),
// so the key and its secrets are never in the repo: four variables, each PARALLAX_ANDROID_ and a
// name from `parallaxSigning` below. Without the keystore's, release keeps the template's debug
// key, which Google Play refuses.
const { withAppBuildGradle } = require("expo/config-plugins");

const SIGNING = `
def parallaxSigning = ["KEYSTORE", "KEYSTORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD"] // ggignore
def parallaxEnv = { name -> System.getenv("PARALLAX_ANDROID_" + name) }
if (parallaxEnv(parallaxSigning[0])) {
    android {
        signingConfigs {
            upload {
                storeFile file(parallaxEnv(parallaxSigning[0]))
                storePassword parallaxEnv(parallaxSigning[1]) // ggignore
                keyAlias parallaxEnv(parallaxSigning[2])
                keyPassword parallaxEnv(parallaxSigning[3]) // ggignore
            }
        }
        buildTypes.release.signingConfig = signingConfigs.upload
    }
}
`;

module.exports = (config) =>
  withAppBuildGradle(config, (c) => {
    if (!c.modResults.contents.includes("parallaxSigning")) c.modResults.contents += SIGNING;
    return c;
  });
