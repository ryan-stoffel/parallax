// An orchestrator's inbox (0043), as a sheet over its chat: what its threads report and the
// questions they ask, from the desktop's `useInbox`, with what waits on the user first and the rest
// under their day. Opening it reads what it shows, but for what waits on the user, and a row opens
// its thread. A question is answered in place, from its pick so far or typed. An item's text is
// plxd's line, which quotes what agents wrote, so it only ever renders as text.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { t } from "i18next";
import type { LucideIcon } from "lucide-react-native";
import { Circle, CircleAlert, CircleCheck, Lightbulb, MessageCircleQuestion, Scale } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import type { InboxItem } from "../../desktop/src/protocol/generated/protocol";
import { questionOf, useInbox } from "../../desktop/src/renderer/Inbox";
import { titleOf } from "../../desktop/src/renderer/threads";
import { showAlert } from "./dialogStore";
import { useComputer } from "./fleet";
import { inboxSections, readByOpening, waitsOnUser } from "./inboxLogic";
import { ago, useShow, type Screens } from "./nav";
import { Page } from "./SettingsParts";
import type { Colors } from "./theme";
import { Button, Input, Row, Section, T, useColors } from "./ui";

/** Each kind's word, icon, and color. */
const looks = (c: Colors): Record<string, { label: string; icon: LucideIcon; color: string }> => ({
  needsYou: { label: t("Needs you"), icon: MessageCircleQuestion, color: c.warning },
  done: { label: t("Done"), icon: CircleCheck, color: c.added },
  failed: { label: t("Failed"), icon: CircleAlert, color: c.danger },
  decided: { label: t("Decided"), icon: Scale, color: c.accent },
  learned: { label: t("Learned"), icon: Lightbulb, color: c.accent },
});

/** A question's answers: its pick so far, which a tap sends, and a field for any other. */
function QuestionBox({
  question,
  assumption,
  onAnswer,
}: {
  question: string;
  assumption: string;
  onAnswer: (text: string) => Promise<string | undefined>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(answer: string) {
    if (!answer.trim() || busy) return;
    setBusy(true);
    const failed = await onAnswer(answer.trim());
    setBusy(false);
    if (failed) showAlert(t("Couldn't send your answer"), failed);
    else setText("");
  }
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 8 }}>
      {!!assumption && <Button label={t("Its pick: {{assumption}}", { assumption })} disabled={busy} onPress={() => void send(assumption)} />}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Input
          accessibilityLabel={t("Answer: {{question}}", { question })}
          placeholder={assumption ? t("Something else") : t("Your answer")}
          value={text}
          editable={!busy}
          autoCapitalize="sentences"
          autoCorrect
          spellCheck
          returnKeyType="send"
          onChangeText={setText}
          onSubmitEditing={() => void send(text)}
          style={{ flex: 1 }}
        />
        <Button label={t("Send")} primary disabled={busy || !text.trim()} onPress={() => void send(text)} />
      </View>
    </View>
  );
}

export function OrchestratorInboxScreen({ route }: NativeStackScreenProps<Screens, "OrchestratorInbox">) {
  const { hostId, orchestrator } = route.params;
  const c = useColors();
  const show = useShow();
  const computer = useComputer(hostId);
  const state = computer?.view.state;
  const capabilities = computer?.view.capabilities ?? {};
  const connected = !!computer?.shownConnected;
  const { items, questions, seen, answer } = useInbox(
    hostId,
    orchestrator,
    connected && "inbox" in capabilities,
    connected && "questions" in capabilities,
  );

  // What this opening read, each once, new items as they arrive. They stay bright until it closes.
  const read = useRef(new Set<string>());
  useEffect(() => {
    const ids = readByOpening(items, questions).filter((id) => !read.current.has(id));
    if (ids.length === 0) return;
    for (const id of ids) read.current.add(id);
    void seen(ids);
  }, [items, questions, seen]);

  const look = looks(c);
  const titleFor = (run: string) => {
    const known = state?.runs[run];
    return state?.titles[run] ?? (known ? titleOf(known) : t("Thread"));
  };
  const row = (item: InboxItem, last: boolean) => {
    const question = questionOf(item, questions);
    const asking = waitsOnUser(item, questions) ? question : undefined;
    const answered = item.kind === "needsYou" && question?.status === "answered";
    // A newer plxd's kind shows as it's spelled.
    const kind = look[item.kind] ?? { label: item.kind, icon: Circle, color: c.faintForeground };
    const unread = !item.seenAt || read.current.has(item.id);
    return (
      <View key={item.id}>
        <Row
          icon={kind.icon}
          iconColor={unread ? kind.color : c.faintForeground}
          title={titleFor(item.run)}
          detail={`${answered ? t("Answered") : kind.label} · ${item.text}`}
          right={
            <T faint style={{ fontSize: 12 }}>
              {ago(item.createdAt)}
            </T>
          }
          chevron
          last={last || !!asking}
          onPress={() => show({ name: "Thread", params: { hostId, runId: item.run } })}
        />
        {asking && (
          <QuestionBox
            question={asking.question}
            assumption={asking.assumption}
            onAnswer={(text) => answer(item, asking, text)}
          />
        )}
      </View>
    );
  };

  const sections = inboxSections(items, questions);
  return (
    <Page>
      <T accessibilityRole="header" style={{ fontSize: 17, fontWeight: "600", textAlign: "center", lineHeight: 22 }}>
        {t("Inbox")}
      </T>
      {sections.length === 0 && (
        <T muted style={{ textAlign: "center" }}>
          {t("What this orchestrator's threads report shows here.")}
        </T>
      )}
      {sections.map((section) => (
        <Section key={section.title} title={section.title}>
          {section.items.map((item, i) => row(item, i === section.items.length - 1))}
        </Section>
      ))}
    </Page>
  );
}
