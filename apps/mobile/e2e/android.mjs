#!/usr/bin/env node
// The phone app on an Android emulator (PLX-1370), run by scripts/ci/android-e2e once the debug APK
// is built and an emulator is up. Runs pinned-tls's tests on the emulator, then installs the app and
// drives it through adb, leaving screenshots in ANDROID_E2E_OUT.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobile = dirname(dirname(fileURLToPath(import.meta.url)));
const out = process.env.ANDROID_E2E_OUT ?? join(mobile, "e2e/out");
mkdirSync(out, { recursive: true });
const APP = "dev.parallax.mobile";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adb = (...args) => execFileSync("adb", args, { maxBuffer: 64 << 20 });

function gradle(...args) {
  execFileSync(
    "./gradlew",
    ["--console=plain", "-PreactNativeArchitectures=x86_64", ...args],
    { cwd: join(mobile, "android"), stdio: "inherit" },
  );
}

/** The screen's elements now: each one's text or description, and where its center is. */
function screen() {
  const xml = adb("exec-out", "uiautomator", "dump", "/dev/tty").toString();
  return [...xml.matchAll(/<node [^>]*?>/g)].map(([node]) => {
    const attribute = (name) => node.match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? "";
    const [, x1, y1, x2, y2] = attribute("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/) ?? [];
    return {
      label: attribute("text") || attribute("content-desc"),
      x: (Number(x1) + Number(x2)) >> 1,
      y: (Number(y1) + Number(y2)) >> 1,
    };
  });
}

function shot(name) {
  writeFileSync(join(out, `${name}.png`), adb("exec-out", "screencap", "-p"));
}

/** Waits for an element whose label `matches` to show, and returns it. */
async function waitFor(matches, timeoutMs = 60_000) {
  const test = typeof matches === "string" ? (label) => label === matches : (label) => matches.test(label);
  const deadline = Date.now() + timeoutMs;
  let last = [];
  for (;;) {
    try {
      last = screen();
      const found = last.find((element) => test(element.label));
      if (found) return found;
    } catch {
      // uiautomator fails while the screen is changing.
    }
    if (Date.now() > deadline) {
      shot("failed");
      throw new Error(`no ${matches} on screen: ${last.map((e) => e.label).filter(Boolean).join(" | ")}`);
    }
    await sleep(1000);
  }
}

// The pin check on the emulator's own TLS: Conscrypt, as a phone has, not the JVM's.
gradle(":pinned-tls:connectedDebugAndroidTest");

adb("install", "-r", join(mobile, "android/app/build/outputs/apk/debug/app-debug.apk"));
adb("reverse", "tcp:8081", "tcp:8081");
const metro = spawn("pnpm", ["exec", "expo", "start", "--port", "8081"], {
  cwd: mobile,
  stdio: "inherit",
  detached: true,
  env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
});
let failed = true;
try {
  adb("shell", "am", "start", "-n", `${APP}/.MainActivity`);
  await waitFor("Sign in", 300_000);
  shot("sign-in");
  failed = false;
} finally {
  if (failed) {
    try {
      shot("failed");
      writeFileSync(join(out, "logcat.txt"), adb("logcat", "-d"));
    } catch {}
  }
  process.kill(-metro.pid, "SIGTERM");
}
