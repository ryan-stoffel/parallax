// Adds the notification service extension that opens a closed app's sealed push (0100): a target
// made from notification-service/, embedded in the app, sharing one keychain group with it. The app
// lists its own group first, so its other keychain items stay where the extension can't read them.
const fs = require("node:fs");
const path = require("node:path");
const { withEntitlementsPlist, withXcodeProject } = require("expo/config-plugins");

const TARGET = "NotificationService";
const SOURCE = path.join(__dirname, "notification-service");
const SWIFT = `${TARGET}.swift`;
const PLIST = "Info.plist";
const ENTITLEMENTS = `${TARGET}.entitlements`;

/** The group both read (`pushKeys` in src/push.ts). A literal team, so an unsigned simulator build has it too. */
const keyGroup = (config) => `${config.ios.appleTeamId}.${config.ios.bundleIdentifier}.pushKeys`;

const entitlements = (group) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>keychain-access-groups</key>
	<array>
		<string>${group}</string>
	</array>
</dict>
</plist>
`;

/** A build setting of the app's first configuration. */
function appSetting(project, name) {
  const app = project.getFirstTarget().firstTarget;
  const list = project.pbxXCConfigurationList()[app.buildConfigurationList];
  const first = project.pbxXCBuildConfigurationSection()[list.buildConfigurations[0].value];
  return first.buildSettings[name];
}

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
    const project = c.modResults;

    // Copied even when the target exists, so a later prebuild picks up changes to these files.
    const folder = path.join(c.modRequest.platformProjectRoot, TARGET);
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(path.join(SOURCE, SWIFT), path.join(folder, SWIFT));
    fs.copyFileSync(path.join(SOURCE, PLIST), path.join(folder, PLIST));
    fs.writeFileSync(path.join(folder, ENTITLEMENTS), entitlements(keyGroup(config)));

    if (project.pbxTargetByName(TARGET)) return c;

    // Read before the new target joins, while the app's are the only build settings of a target.
    const deployment = appSetting(project, "IPHONEOS_DEPLOYMENT_TARGET");

    // addTarget assumes these sections exist; a template with one target has neither.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};

    const bundleId = `${config.ios.bundleIdentifier}.${TARGET}`;
    // Also adds the app's dependency on it, and the phase that embeds it in PlugIns/.
    const target = project.addTarget(TARGET, "app_extension", TARGET, bundleId);
    const group = project.addPbxGroup([SWIFT, PLIST, ENTITLEMENTS], TARGET, TARGET);
    project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    project.addBuildPhase([SWIFT], "PBXSourcesBuildPhase", "Sources", target.uuid);
    project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

    const sections = project.pbxXCBuildConfigurationSection();
    for (const [, section] of Object.entries(sections)) {
      if (section.buildSettings?.PRODUCT_NAME !== `"${TARGET}"`) continue;
      Object.assign(section.buildSettings, {
        CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${ENTITLEMENTS}"`,
        CODE_SIGN_STYLE: "Automatic",
        CURRENT_PROJECT_VERSION: config.ios.buildNumber,
        DEVELOPMENT_TEAM: config.ios.appleTeamId,
        GENERATE_INFOPLIST_FILE: "NO",
        INFOPLIST_FILE: `"${TARGET}/${PLIST}"`,
        IPHONEOS_DEPLOYMENT_TARGET: deployment,
        MARKETING_VERSION: config.version,
        SWIFT_VERSION: "5.0",
        TARGETED_DEVICE_FAMILY: '"1"',
      });
    }
    return c;
  });
};
