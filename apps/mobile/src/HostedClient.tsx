// The hosted browser client's two sheets (0108): Browser link, a computer's link and QR code
// for a browser to take it from, and Share with guest, a link that shows one thread to one browser
// for 24 hours.
import * as Clipboard from "expo-clipboard";
import { t } from "i18next";
import { Copy, Share as ShareIcon, X } from "lucide-react-native";
import qrcode from "qrcode-generator";
import { useEffect, useMemo, useRef, useState } from "react";
import { Share, StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import {
  ALREADY_SHARED,
  guestLinksOf,
  HOSTED_OFF,
  readGuestLinks,
  setGuestLinks,
  useGuestLinks,
} from "../../desktop/src/renderer/guestLinks";
import { useFleet, type Computer } from "./fleet";
import { GlassButton } from "./Glass";
import { forgetGuestLink, guestLinkUrl } from "./guestShare";
import { Section, SwitchRow } from "./SettingsParts";
import { Sheet, sheetTitle } from "./Sheet";
import { Button, Icon, Row, T, useColors } from "./ui";

/** A QR code's quiet zone, in modules, as the standard asks. */
const QUIET = 4;

/** `value` as a QR code: black on a white tile in both appearances, so a camera reads it on dark. */
function QrCode({ value, label, size }: { value: string; label: string; size: number }) {
  const { side, path } = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(value);
    code.make();
    const count = code.getModuleCount();
    let path = "";
    for (let row = 0; row < count; row++)
      for (let column = 0; column < count; column++)
        if (code.isDark(row, column)) path += `M${column + QUIET} ${row + QUIET}h1v1h-1z`;
    return { side: count + QUIET * 2, path };
  }, [value]);
  return (
    <Svg accessible accessibilityRole="image" accessibilityLabel={label} width={size} height={size} viewBox={`0 0 ${side} ${side}`}>
      <Rect width={side} height={side} rx={2} fill="#ffffff" />
      <Path d={path} fill="#000000" />
    </Svg>
  );
}

/** A sheet's title with its close button, as the app's sheets have them. */
function Head({ title, onClose }: { title: string; onClose: () => void }) {
  const c = useColors();
  return (
    <View style={styles.head}>
      <T style={sheetTitle}>{title}</T>
      <GlassButton label={t("Close")} size={40} onPress={onClose}>
        <Icon icon={X} size={20} color={c.foreground} />
      </GlassButton>
    </View>
  );
}

/**
 * Browser link: `link`, a computer's host id in a URL's fragment and no secret, as a QR code
 * and as text to copy or share. It says what does let the browser in: Allow, on a device that
 * already uses the computer, once all six digits match.
 */
export function BrowserLinkSheet({ link, onClose }: { link: string | undefined; onClose: () => void }) {
  // Kept while the sheet slides down, so it doesn't empty on the way.
  const shown = useRef(link);
  if (link) shown.current = link;
  const url = shown.current;
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [link]);
  return (
    <Sheet open={!!link} onClose={onClose} head={<Head title={t("Browser link")} onClose={onClose} />}>
      {url && (
        <View style={styles.body}>
          <T muted style={styles.note}>
            {t(
              "Scan this code, or open the link, in the browser you want to use. The browser then shows a 6-digit code. Allow it here only if all six digits match.",
            )}
          </T>
          <View style={{ alignItems: "center" }}>
            <QrCode value={url} label={t("QR code for the link")} size={200} />
          </View>
          <T selectable muted style={{ ...styles.note, textAlign: "center" }}>
            {url}
          </T>
          <View style={styles.buttons}>
            <Button
              label={copied ? t("Copied") : t("Copy link")}
              icon={Copy}
              style={{ flex: 1 }}
              onPress={() => void Clipboard.setStringAsync(url).then(() => setCopied(true))}
            />
            <Button label={t("Share…")} icon={ShareIcon} style={{ flex: 1 }} onPress={() => void Share.share({ message: url })} />
          </View>
        </View>
      )}
    </Sheet>
  );
}

/** A time as the sheet says it, with its date. */
const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Share with guest, for thread `runId` on `computer`. It says what a guest sees before anything is
 * made. Until plxd has said whether the thread has a live link and whether its `hostedClient` is
 * on, it offers nothing: a new link ends a live one, and none can be made with the switch off,
 * which it says. With no live link it offers "can suggest messages", off, and Create link. With one, it
 * shows when it expires and whether and when it was opened, Copy link and Share, and Stop sharing.
 *
 * The link's secret isn't in this sheet's state. `guestShare` holds it from Create link until Copy
 * link or Share hands it over, or until the sheet closes or its screen goes, and nothing can show
 * it again.
 */
export function GuestShareSheet({
  computer,
  runId,
  open,
  onClose,
}: {
  computer: Computer;
  runId: string;
  open: boolean;
  onClose: () => void;
}) {
  const c = useColors();
  const id = computer.machine.id;
  const { shareWithGuest } = useFleet();
  const { links, read } = useGuestLinks(id, open && computer.connectedNow);
  const link = links.find((each) => each.threadId === runId);
  // The computer's `hostedClient`, once it answers, read each time the sheet opens.
  const [hosted, setHosted] = useState<boolean>();
  useEffect(() => {
    if (!open || !computer.connectedNow) return setHosted(undefined);
    void window.parallax.request(id, "host/settings/get", {}).then((answer) =>
      setHosted("result" in answer ? answer.result.hostedClient !== false : true),
    );
  }, [open, id, computer.connectedNow]);
  const known = read && hosted !== undefined;
  const [canSuggest, setCanSuggest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The link made here whose secret `guestShare` still holds, and whether it was handed over.
  const [ready, setReady] = useState<string>();
  const [copied, setCopied] = useState(false);
  const canCopy = !!link && ready === link.id;
  // The thread's screen can go while the sheet is up, which forgets an uncopied link too.
  const held = useRef<string>(undefined);
  held.current = ready;
  useEffect(
    () => () => {
      if (held.current) forgetGuestLink(held.current);
    },
    [],
  );

  // Closing forgets a link nobody copied.
  const close = () => {
    if (ready) forgetGuestLink(ready);
    setReady(undefined);
    setCopied(false);
    setError(undefined);
    onClose();
  };
  const create = async () => {
    setBusy(true);
    setError(undefined);
    // A new link ends the thread's live one, so one made elsewhere since the last read is shown
    // here, not replaced.
    await readGuestLinks(id);
    if (guestLinksOf(id).links.some((each) => each.threadId === runId)) {
      setBusy(false);
      return setError(t(ALREADY_SHARED));
    }
    const made = await shareWithGuest(id, runId, canSuggest);
    setBusy(false);
    if (typeof made === "string") return setError(made);
    setReady(made.id);
    setCopied(false);
    await readGuestLinks(id);
  };
  // Hands the link over with `give`, then forgets it, unless `give` says it didn't go anywhere.
  const handOver = async (give: (url: string) => Promise<boolean>) => {
    const url = ready && guestLinkUrl(ready);
    if (!ready || !url || !(await give(url))) return;
    forgetGuestLink(ready);
    setReady(undefined);
    setCopied(true);
  };
  const stop = async () => {
    if (!link) return;
    setBusy(true);
    setError(undefined);
    const answer = await window.parallax.request(id, "guest/revoke", { link: link.id });
    setBusy(false);
    if ("error" in answer) return setError(answer.error.message);
    forgetGuestLink(link.id);
    setReady(undefined);
    setCopied(false);
    setGuestLinks(id, answer.result);
  };

  return (
    <Sheet open={open} onClose={close} head={<Head title={t("Share with guest")} onClose={close} />}>
      <View style={styles.body}>
        <T muted style={styles.note}>
          {t(
            "A guest sees everything in this thread's transcript, including what the agent read or printed. The link works in one browser, for 24 hours.",
          )}
        </T>
        {!known ? null : link ? (
          <>
            <Section>
              <Row title={t("Expires")} right={<T muted>{when(link.expiresAt)}</T>} />
              <Row
                title={t("Opened")}
                right={<T muted>{link.boundAt ? when(link.boundAt) : t("Not yet")}</T>}
                last={!link.canSuggest}
              />
              {link.canSuggest && <Row title={t("Guest can suggest messages")} last />}
            </Section>
            <T faint style={styles.note}>
              {canCopy
                ? t("Copy the link now. Parallax doesn't keep it, and closing this forgets it.")
                : t("Parallax doesn't keep the link. To get one again, stop sharing and create a new one.")}
            </T>
            {(canCopy || copied) && (
              <View style={styles.buttons}>
                <Button
                  primary
                  label={copied ? t("Copied") : t("Copy link")}
                  icon={Copy}
                  disabled={!canCopy}
                  style={{ flex: 1 }}
                  onPress={() => void handOver((url) => Clipboard.setStringAsync(url))}
                />
                <Button
                  label={t("Share…")}
                  icon={ShareIcon}
                  disabled={!canCopy}
                  style={{ flex: 1 }}
                  onPress={() =>
                    void handOver(async (url) => (await Share.share({ message: url })).action !== Share.dismissedAction)
                  }
                />
              </View>
            )}
            <Button destructive label={t("Stop sharing")} disabled={busy} onPress={() => void stop()} />
          </>
        ) : !hosted ? (
          <T style={{ ...styles.note, color: c.warning }}>{t(HOSTED_OFF)}</T>
        ) : (
          <>
            <Section>
              <SwitchRow
                title={t("Guest can suggest messages")}
                detail={t("A suggested message waits in the thread until you send or dismiss it.")}
                value={canSuggest}
                onChange={setCanSuggest}
                last
              />
            </Section>
            <Button primary label={t("Create link")} disabled={busy || !computer.connectedNow} onPress={() => void create()} />
          </>
        )}
        {error && (
          <T style={{ ...styles.note, color: c.danger }} accessibilityRole="alert">
            {error}
          </T>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 14 },
  body: { paddingHorizontal: 16, gap: 14 },
  note: { fontSize: 14, lineHeight: 19 },
  buttons: { flexDirection: "row", gap: 10 },
});
