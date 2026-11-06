// Adds the notification service extension that opens a closed app's sealed push (0100), sharing one
// keychain group with the app. The app lists its own group first, so its other keychain items stay
// where the extensions can't read them.
const path = require("node:path");
const { withEntitlementsPlist, withXcodeProject } = require("expo/config-plugins");
const { addExtension, keyGroup } = require("./extensionTarget");

module.exports = (config) => {
  if (!config.ios?.appleTeamId) throw new Error("withNotificationService: app.json needs ios.appleTeamId");
  config = withEntitlementsPlist(config, (c) => {
    c.modResults["keychain-access-groups"] = [
      `${config.ios.appleTeamId}.${config.ios.bundleIdentifier}`,
      keyGroup(config),
    ];
    return c;
  });
  return withXcodeProject(config, (c) => {
    addExtension(c, config, {
      target: "NotificationService",
      source: path.join(__dirname, "notification-service"),
      swift: "NotificationService.swift",
      shared: ["ThreadStatus.swift"],
    });
    return c;
  });
};
