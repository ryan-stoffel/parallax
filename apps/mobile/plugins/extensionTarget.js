// What the app's extensions share: a target made from a folder of files, embedded in the app, with
// the one keychain group the app shares with them (0100).
const fs = require("node:fs");
const path = require("node:path");

/** The group they share (`sharedGroup` in src/push.ts). A literal team, so an unsigned simulator build has it too. */
const keyGroup = (config) => `${config.ios.appleTeamId}.${config.ios.bundleIdentifier}.pushKeys`;

/** Where the files extensions compile beside their own live: `shared` of `addExtension`. */
const SHARED = path.join(__dirname, "..", "modules", "thread-status", "ios");

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

/**
 * Compiles `file` in a target an older prebuild made without it, so a prebuild without `--clean`
 * still builds. A target's group has a path or not, by when it was made.
 */
function addMissingSource(project, target, file) {
  const targets = project.pbxNativeTargetSection();
  const uuid = Object.keys(targets).find((key) => targets[`${key}_comment`] === target);
  if (project.pbxSourcesBuildPhaseObj(uuid).files.some((f) => f.comment === `${file} in Sources`)) return;
  const group = project.findPBXGroupKey({ name: target });
  const inGroup = project.getPBXGroupByKey(group).path ? file : `${target}/${file}`;
  project.addSourceFile(inGroup, { target: uuid }, group);
}

/**
 * Adds the extension `target`, bundle id `<app>.<target>`, built from `<source>/<swift>`,
 * `<source>/Info.plist`, and the files named in `shared`. `deployment` is its lowest iOS, by default
 * the app's. Call from a `withXcodeProject` mod, passing its `c`.
 */
function addExtension(c, config, { target, source, swift, shared, deployment }) {
  const project = c.modResults;
  const plist = "Info.plist";
  const entitlementsFile = `${target}.entitlements`;

  // Copied even when the target exists, so a later prebuild picks up changes to these files.
  const folder = path.join(c.modRequest.platformProjectRoot, target);
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(path.join(source, swift), path.join(folder, swift));
  for (const file of shared) fs.copyFileSync(path.join(SHARED, file), path.join(folder, file));
  fs.copyFileSync(path.join(source, plist), path.join(folder, plist));
  fs.writeFileSync(path.join(folder, entitlementsFile), entitlements(keyGroup(config)));

  if (project.pbxTargetByName(target)) {
    for (const file of shared) addMissingSource(project, target, file);
    return;
  }

  const lowest = deployment ?? appSetting(project, "IPHONEOS_DEPLOYMENT_TARGET");

  // addTarget assumes these sections exist; a template with one target has neither.
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};

  const bundleId = `${config.ios.bundleIdentifier}.${target}`;
  // Also adds the app's dependency on it, and the phase that embeds it in PlugIns/.
  const added = project.addTarget(target, "app_extension", target, bundleId);
  // Paths from the project's root: xcode reuses a file it has seen at the same path, which two
  // targets' copies of ThreadStatus.swift would otherwise share.
  const inFolder = (file) => `${target}/${file}`;
  const group = project.addPbxGroup([swift, ...shared, plist, entitlementsFile].map(inFolder), target);
  delete group.pbxGroup.path;
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  project.addBuildPhase([swift, ...shared].map(inFolder), "PBXSourcesBuildPhase", "Sources", added.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", added.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", added.uuid);

  const sections = project.pbxXCBuildConfigurationSection();
  for (const [, section] of Object.entries(sections)) {
    if (section.buildSettings?.PRODUCT_NAME !== `"${target}"`) continue;
    Object.assign(section.buildSettings, {
      CODE_SIGN_ENTITLEMENTS: `"${target}/${entitlementsFile}"`,
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: config.ios.buildNumber,
      DEVELOPMENT_TEAM: config.ios.appleTeamId,
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: `"${target}/${plist}"`,
      IPHONEOS_DEPLOYMENT_TARGET: lowest,
      MARKETING_VERSION: config.version,
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: '"1"',
    });
  }
}

module.exports = { addExtension, keyGroup };
