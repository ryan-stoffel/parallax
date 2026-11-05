// Adds the widget extension that draws the home screen widget and the Live Activity (0100). It needs
// iOS 17 for its widget background, and the app keeps its lower minimum: an older phone just has no
// widget.
const path = require("node:path");
const { withXcodeProject } = require("expo/config-plugins");
const { addExtension } = require("./extensionTarget");

module.exports = (config) =>
  withXcodeProject(config, (c) => {
    addExtension(c, config, {
      target: "ThreadWidget",
      source: path.join(__dirname, "thread-widget"),
      swift: "ThreadWidget.swift",
      shared: ["ThreadStatus.swift", "ThreadActivity.swift"],
      deployment: "17.0",
    });
    return c;
  });
