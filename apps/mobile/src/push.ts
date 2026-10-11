// Push (0065): permission and this phone's APNs token, for Parallax Relay to notify on approvals
// and finished turns. The relay (PLX-652) and Ryan's APNs key don't exist yet, so handing the token
// over is a stub.
import * as Notifications from "expo-notifications";

// A notification that arrives while the app is open still shows.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** Why push isn't on, for people, or undefined once the relay has this phone's token. */
export async function registerForPush(fingerprint: string): Promise<string | undefined> {
  const { granted } = await Notifications.requestPermissionsAsync();
  if (!granted) return "Notifications are off for Parallax in iOS Settings.";
  const token = await Notifications.getDevicePushTokenAsync().catch(() => undefined);
  if (!token) return "This build can't get a push token. It needs the App ID's push capability.";
  return sendToRelay(String(token.data), fingerprint);
}

/**
 * Registers `token` with Parallax Relay for the host whose certificate is `fingerprint`.
 * ponytail: a stub until PLX-652 ships the relay's registration endpoint and Ryan's APNs key.
 */
async function sendToRelay(token: string, fingerprint: string): Promise<string | undefined> {
  void token;
  void fingerprint;
  return "Push needs Parallax Relay, which isn't set up yet.";
}
