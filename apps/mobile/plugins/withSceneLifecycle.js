// iOS 27 ends an app at launch unless it adopts the scene life cycle, and Expo 57's template still
// starts React Native from the app delegate. This hands the window to Expo's own scene delegate
// (ExpoAppSceneDelegate), which starts React Native in it: the app delegate only makes the factory.
// Drop it once Expo's template does this itself.
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

/** Replaces `from` in `text`, or fails the prebuild when the template changed under it. */
function replace(text, from, to) {
  if (!text.match(from)) throw new Error(`withSceneLifecycle: AppDelegate has no ${from}`);
  return text.replace(from, to);
}

module.exports = (config) => {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "EXExpoAppSceneDelegate",
          },
        ],
      },
    };
    return c;
  });
  return withAppDelegate(config, (c) => {
    let s = c.modResults.contents;
    if (s.includes("ExpoReactNativeFactoryProvider")) return c;
    s = replace(s, "class AppDelegate: ExpoAppDelegate {", "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {");
    s = replace(s, /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow[\s\S]*?#endif\n/, "");
    c.modResults.contents = s;
    return c;
  });
};
