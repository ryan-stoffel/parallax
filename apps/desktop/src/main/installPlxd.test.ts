import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { LOCATE_PLXD } from "./connection";
import { installPlxd } from "./installPlxd";

// A fake ssh runs the remote command here, as the host's login shell would, with its own HOME and
// a fake curl that serves `release/` in place of GitHub's release downloads.
const VERSION = "2610.10903.13317-nightly";
const target = `${process.platform === "darwin" ? "mac" : "linux"}-${process.arch}`;
const ASSET = `parallax-plxd-${VERSION}-${target}`;
const posix = process.platform !== "win32" && target !== "mac-x64";

let root: string;
let home: string;
let ssh: string;
const release = (name: string) => path.join(root, "release", name);
const installed = (name: string) => path.join(home, ".parallax-plxd", name);
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const script = (file: string, text: string) => {
  writeFileSync(file, `#!/bin/sh\n${text}\n`);
  chmodSync(file, 0o755);
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "plx-install-"));
  home = path.join(root, "home");
  for (const dir of ["home", "bin", "release"]) mkdirSync(path.join(root, dir));
  ssh = path.join(root, "bin", "ssh");
  script(
    ssh,
    `while [ "$1" != -- ]; do shift; done; shift 2
HOME='${home}' PATH='${root}/bin':$PATH exec sh -c "$*"`,
  );
  script(
    path.join(root, "bin", "curl"),
    `for a; do [ "$prev" = -o ] && out=$a; case $a in https://*) url=$a ;; esac; prev=$a; done
echo "$url" >> '${root}/urls'
cp '${root}/release/'"\${url##*/}" "$out" 2>/dev/null || exit 22`,
  );
  // plxd as released: it reports the version in the file beside it, and attach says it ran.
  script(
    release(ASSET),
    `case $1 in --version) echo "plxd $(cat "$(dirname "$0")/plxd.version")" ;; attach) echo "attached $0" ;; esac`,
  );
  writeFileSync(release("SHA256SUMS"), `${sha256(release(ASSET))}  ${ASSET}\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test.runIf(posix)("installs the release's plxd for the host, which attach then runs", async () => {
  expect(await installPlxd("mini", VERSION, ssh)).toBeUndefined();
  expect(readFileSync(path.join(root, "urls"), "utf8").trim().split("\n")).toEqual([
    `https://github.com/ryan-stoffel/parallax/releases/download/v${VERSION}/SHA256SUMS`,
    `https://github.com/ryan-stoffel/parallax/releases/download/v${VERSION}/${ASSET}`,
  ]);
  expect(readFileSync(installed("plxd.version"), "utf8")).toBe(`${VERSION}\n`);
  // Nothing left behind but plxd and its version.
  expect(spawnSync("ls", ["-A", path.join(home, ".parallax-plxd")]).stdout.toString()).toBe(
    "plxd\nplxd.version\n",
  );
  // Not plxd's data folder, which would move plxd off an older host's.
  expect(existsSync(path.join(home, ".parallax"))).toBe(false);
  const attach = spawnSync("sh", ["-c", LOCATE_PLXD.slice("sh -c '".length, -1)], {
    env: { ...process.env, HOME: home },
  });
  expect(attach.stdout.toString()).toBe(`attached ${installed("plxd")}\n`);
});

test.runIf(posix)("refuses plxd whose SHA256 isn't the release's", async () => {
  writeFileSync(release("SHA256SUMS"), `${"0".repeat(64)}  ${ASSET}\n`);
  expect(await installPlxd("mini", VERSION, ssh)).toBe(
    "plxd's SHA256 doesn't match the release's SHA256SUMS.",
  );
  // Nor a release that doesn't list it.
  writeFileSync(release("SHA256SUMS"), `${sha256(release(ASSET))}  parallax-plxd-other\n`);
  expect(await installPlxd("mini", VERSION, ssh)).toBe(
    "plxd's SHA256 doesn't match the release's SHA256SUMS.",
  );
  expect(spawnSync("ls", ["-A", path.join(home, ".parallax-plxd")]).stdout.toString()).toBe("");
});

test.runIf(posix)("says so when the release has no SHA256SUMS", async () => {
  rmSync(release("SHA256SUMS"));
  expect(await installPlxd("mini", VERSION, ssh)).toBe(
    `Couldn't download https://github.com/ryan-stoffel/parallax/releases/download/v${VERSION}/SHA256SUMS.`,
  );
  expect(existsSync(installed("plxd"))).toBe(false);
});

test.runIf(posix)(
  "updates an older plxd and stops its running serve",
  async () => {
    mkdirSync(path.join(home, ".parallax-plxd"));
    script(installed("plxd"), "trap 'kill $! 2>/dev/null; exit 0' TERM; sleep 30 & wait");
    writeFileSync(installed("plxd.version"), "2610.10704.12709-nightly\n");
    const serve = spawn("sh", [installed("plxd"), "serve"]);
    const exited = new Promise((resolve) => serve.on("exit", resolve));
    mkdirSync(path.join(home, ".parallax"));
    writeFileSync(path.join(home, ".parallax", "plxd.lock"), `${serve.pid}\n`);
    try {
      expect(await installPlxd("mini", VERSION, ssh)).toBeUndefined();
      expect(await exited).toBe(0); // Its SIGTERM trap ran.
      expect(readFileSync(installed("plxd.version"), "utf8")).toBe(`${VERSION}\n`);
      expect(sha256(installed("plxd"))).toBe(sha256(release(ASSET)));
    } finally {
      serve.kill();
    }
  },
  20_000,
);

test("ssh's own failures read as a connection's do, and a bad version never reaches the host", async () => {
  const fail = path.join(root, "bin", "fail");
  script(
    fail,
    `echo 'ssh: Could not resolve hostname mini: nodename nor servname provided' >&2; exit 255`,
  );
  if (posix)
    expect(await installPlxd("mini", VERSION, fail)).toBe(
      "Couldn't find mini. Check its name, or your ssh config.",
    );
  expect(await installPlxd("mini", "1.0; rm -rf ~", fail)).toBe(
    "1.0; rm -rf ~ isn't a release version.",
  );
});
