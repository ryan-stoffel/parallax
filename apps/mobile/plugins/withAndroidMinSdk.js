// Android 10 (API 29) is the first with TLS 1.3, which an account computer's connection requires
// (0091): an older phone could never reach one, so it doesn't install at all.
const { withGradleProperties } = require("expo/config-plugins");

module.exports = (config) =>
  withGradleProperties(config, (c) => {
    c.modResults.push({ type: "property", key: "android.minSdkVersion", value: "29" });
    return c;
  });
