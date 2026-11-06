import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { sshSuggestions } from "./sshConfig";

test("suggestions follow Include, with globs, then known_hosts, each once, without patterns or hashed names", () => {
  const home = mkdtempSync(path.join(tmpdir(), "parallax-ssh-"));
  mkdirSync(path.join(home, ".ssh/conf.d"), { recursive: true });
  const write = (file: string, text: string) => writeFileSync(path.join(home, ".ssh", file), text);
  write(
    "config",
    "Include config.local conf.d/*.conf # mine\nHost github.com\nHost * !bastion web-?\n",
  );
  write("config.local", "Host mac-mini\n  HostName 100.74.190.83\nInclude config\n");
  write("conf.d/a.conf", 'host devbox office # at work\nHost "quoted"\n');
  write("conf.d/b.txt", "Host ignored\n");
  const known = [
    "github.com,140.82.112.3 ssh-ed25519 AAAA",
    "[mini.local]:2222 ssh-ed25519 AAAA",
    "|1|abc=|def= ssh-ed25519 AAAA",
    "@cert-authority *.example.com ssh-rsa AAAA",
    "# a comment",
  ];
  write("known_hosts", `${known.join("\n")}\n`);
  expect(sshSuggestions(home)).toEqual([
    "github.com",
    "mac-mini",
    "devbox",
    "office",
    "quoted",
    "140.82.112.3",
    "mini.local",
  ]);
  // No ~/.ssh at all is no suggestions.
  expect(sshSuggestions(mkdtempSync(path.join(tmpdir(), "parallax-ssh-")))).toEqual([]);
});
