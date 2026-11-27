// app.json is the store build: "Parallax" with the release icon (PLX-1614). A nightly build, such
// as one for TestFlight that should read as a nightly on the home screen and in Settings > About,
// sets PARALLAX_VARIANT=nightly when it runs `expo prebuild`:
//
//     PARALLAX_VARIANT=nightly corepack pnpm exec expo prebuild --platform ios
//
// Only the name and icon change. The bundle id stays, since TestFlight and the App Store share one
// app record, so a nightly replaces the store build on a phone and can't sit beside it.
const NIGHTLY_ICON = "../../design/icon/masters/Parallax-nightly-full-1024.png";

module.exports = ({ config }) =>
  process.env.PARALLAX_VARIANT === "nightly"
    ? { ...config, name: "Parallax (Nightly)", icon: NIGHTLY_ICON, ios: { ...config.ios, icon: NIGHTLY_ICON } }
    : config;
