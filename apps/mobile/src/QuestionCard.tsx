// An agent's questions for the user (PLX-1280), as the desktop's Question.tsx: one at a time over the
// composer, with Back and Next when there are several, and answers that go back through
// `agent/approve`. Question text is untrusted, so it renders only as text. The question and its
// options scroll under a max height. The typed answer and the buttons stay below them, so neither
// the keyboard nor a long question can push them away.
import * as Haptics from "expo-haptics";
import { t } from "i18next";
import { Check, ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";

import type { AgentApproveParams } from "../../desktop/src/protocol/generated/protocol";
import { fill, isAnswered, SKIPPED, type Choice, type Question, type QuestionOption } from "../../desktop/src/renderer/questions";
import type { ApprovalRequest } from "../../desktop/src/renderer/transcript";
import { showAlert } from "./dialogStore";
import { nextOpen, toggled, typedIn } from "./questionLogic";
import { Button, Icon, T, useColors } from "./ui";

const unanswered: Choice = { picked: [], typed: "" };

// How tall the question and its options may be while the keyboard is up. The thread's
// KeyboardAvoidingView lifts the card and the composer together, and on the smallest iPhone this
// leaves room for both over the keyboard.
const heightOverKeyboard = 72;

/** Whether the keyboard is up, or going up. */
function useKeyboardUp() {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setUp(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return up;
}

/** One option's row: its radio or checkbox mark, its label, a recommended mark, and what it means. */
function OptionRow({
  option,
  multiple,
  on,
  disabled,
  onPress,
}: {
  option: QuestionOption;
  multiple: boolean;
  on: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole={multiple ? "checkbox" : "radio"}
      accessibilityState={{ checked: on }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.option, (on || pressed) && { backgroundColor: c.hover }]}
    >
      <View
        style={[
          styles.mark,
          { borderRadius: multiple ? 6 : 10 },
          on ? { backgroundColor: c.accent, borderColor: c.accent } : { borderColor: c.faintForeground },
        ]}
      >
        {on && <Icon icon={Check} size={12} color="#ffffff" />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.label}>
          <T style={{ fontSize: 14, lineHeight: 20, flexShrink: 1 }}>{option.label}</T>
          {option.recommended && (
            <View style={[styles.recommended, { backgroundColor: c.hover }]}>
              <T style={{ fontSize: 12, lineHeight: 16, color: c.accent }}>{t("Recommended")}</T>
            </View>
          )}
        </View>
        {!!option.description && (
          <T muted style={{ fontSize: 12.5, lineHeight: 17 }}>
            {option.description}
          </T>
        )}
      </View>
    </Pressable>
  );
}

/** Back or Next among a request's questions. */
function Step({ icon, label, disabled, onPress }: { icon: LucideIcon; label: string; disabled: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.step, (pressed || disabled) && { opacity: 0.4 }]}
    >
      <Icon icon={icon} size={18} color={c.mutedForeground} />
    </Pressable>
  );
}

/**
 * The oldest request's questions as a form, one at a time. The arrows step through them. Picking a
 * single choice or pressing Next goes to the next one not yet answered, and once none is left, Send
 * sends them all. Skip answers none.
 */
export function QuestionCard({
  hostId,
  runId,
  request,
  questions,
  count,
  onAnswered,
}: {
  hostId: string;
  runId: string;
  request: ApprovalRequest;
  /** What `request` asks, never empty. */
  questions: readonly Question[];
  /** How many requests wait, this one first. */
  count: number;
  onAnswered: () => void;
}) {
  const c = useColors();
  const { height } = useWindowDimensions();
  const keyboardUp = useKeyboardUp();
  const [step, setStep] = useState(0);
  const [choices, setChoices] = useState<readonly Choice[]>(() => questions.map(() => unanswered));
  const [busy, setBusy] = useState(false);
  const question = questions[step]!;
  const choice = choices[step] ?? unanswered;
  const open = nextOpen(choices, step);
  const ready = isAnswered(choice);
  const choose = (next: Choice) => setChoices(choices.map((one, i) => (i === step ? next : one)));

  async function answer(decision: Omit<AgentApproveParams, "runId" | "approvalId">) {
    setBusy(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const reply = await window.parallax.request(hostId, "agent/approve", {
      runId,
      approvalId: request.approvalId,
      ...decision,
    });
    setBusy(false);
    if (!("error" in reply)) return onAnswered();
    // Nothing waits on an answer anymore, so the card has nothing left to do.
    if (reply.error.data?.kind === "approvalNotFound") {
      showAlert(t("This question is no longer waiting"));
      return onAnswered();
    }
    showAlert(t("Your answer didn't reach the agent"), reply.error.message);
  }

  function pick(option: QuestionOption) {
    void Haptics.selectionAsync();
    const on = question.multiple ? !choice.picked.includes(option.value) : true;
    choose(toggled(choice, question, option.value, on));
    if (question.multiple) return;
    Keyboard.dismiss();
    if (open !== undefined) setStep(open);
  }

  /** Next or Send, by whether another question is still open. */
  function submit() {
    if (busy || !ready) return;
    if (open !== undefined) setStep(open);
    else void answer({ decision: "allow", ...fill(request, questions, choices) });
  }

  const hasOptions = question.options.length > 0;
  return (
    <View style={[styles.card, { borderColor: c.border, backgroundColor: c.surface }]}>
      {(!!question.header || question.multiple || count > 1) && (
        <View style={styles.meta}>
          <T faint numberOfLines={1} style={{ fontSize: 12, flex: 1 }}>
            {[question.header, question.multiple && t("Choose any")].filter(Boolean).join(" · ")}
          </T>
          {count > 1 && (
            <T faint style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}>
              {t("{{count}} more waiting", { count: count - 1 })}
            </T>
          )}
        </View>
      )}
      {/* Each question starts at its top. With the keyboard up, a tap on an option still lands. */}
      <ScrollView
        key={question.id}
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: keyboardUp ? heightOverKeyboard : height * 0.3 }}
        contentContainerStyle={{ gap: 6 }}
      >
        <T medium style={{ lineHeight: 20 }}>
          {question.text}
        </T>
        {question.options.map((option) => (
          <OptionRow
            key={option.value}
            option={option}
            multiple={question.multiple}
            on={choice.picked.includes(option.value)}
            disabled={busy}
            onPress={() => pick(option)}
          />
        ))}
      </ScrollView>
      {question.custom && (
        <TextInput
          key={`typed:${question.id}`}
          accessibilityLabel={hasOptions ? t("Your own answer") : question.text}
          secureTextEntry={question.secret}
          autoCapitalize={question.secret ? "none" : undefined}
          autoCorrect={!question.secret}
          editable={!busy}
          placeholder={hasOptions ? t("Something else") : t("Your answer")}
          placeholderTextColor={c.faintForeground}
          returnKeyType={open === undefined ? "send" : "next"}
          value={choice.typed}
          onChangeText={(typed) => choose(typedIn(choice, question, typed))}
          onSubmitEditing={submit}
          style={[styles.input, { borderColor: c.border, backgroundColor: c.code, color: c.foreground }]}
        />
      )}
      <View style={styles.foot}>
        {questions.length > 1 && (
          <View style={styles.steps}>
            <Step icon={ChevronLeft} label={t("Previous question")} disabled={step === 0} onPress={() => setStep(step - 1)} />
            <T muted style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}>
              {t("{{index}} of {{total}}", { index: step + 1, total: questions.length })}
            </T>
            <Step
              icon={ChevronRight}
              label={t("Next question")}
              disabled={step === questions.length - 1}
              onPress={() => setStep(step + 1)}
            />
          </View>
        )}
        <Button
          label={t("Skip")}
          style={{ flex: 1 }}
          disabled={busy}
          onPress={() => void answer({ decision: "deny", message: SKIPPED })}
        />
        <Button
          label={busy ? t("Sending…") : open === undefined ? t("Send") : t("Next")}
          primary
          style={{ flex: 1 }}
          disabled={busy || !ready}
          onPress={submit}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // As ThreadStrips' cards and its secret's field.
  card: { borderWidth: 1, borderRadius: 18, padding: 14, gap: 10 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  meta: { flexDirection: "row", alignItems: "center", gap: 8 },
  option: { flexDirection: "row", alignItems: "flex-start", gap: 10, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 7 },
  mark: { width: 20, height: 20, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  label: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  recommended: { borderRadius: 5, paddingHorizontal: 6 },
  foot: { flexDirection: "row", alignItems: "center", gap: 10 },
  steps: { flexDirection: "row", alignItems: "center", gap: 2 },
  step: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
});
