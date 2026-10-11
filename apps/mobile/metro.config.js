// The app shares the desktop renderer's client code (0065): the generated protocol, WebHost, the
// threads and transcript hooks. Metro watches that folder, and resolves its packages from this
// app's node_modules, so both sides run one React.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const shared = path.resolve(__dirname, "../desktop/src");

config.watchFolders = [shared];
config.resolver.resolveRequest = (context, name, platform) => {
  const fromShared = context.originModulePath.startsWith(shared) && !name.startsWith(".");
  const from = fromShared
    ? { ...context, originModulePath: path.join(__dirname, "index.ts") }
    : context;
  return context.resolveRequest(from, name, platform);
};

module.exports = config;
