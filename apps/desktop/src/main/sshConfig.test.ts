import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { configHosts, knownHosts, sshSuggestions } from "./sshConfig";

test("an ssh config's Host names, without patterns", () => {
  const text = [
    "Include ~/.ssh/config.local",
    "Host github-1password",
    "    HostName github.com",
    "host mini devbox  ",
    'Host "quoted"',
    "Host * !bastion web-?",
    "  Host *.example.com",
  ].join("\n");
  expect(configHosts(text)).toEqual(["github-1password", "mini", "devbox", "quoted"]);
});

test("known_hosts' plain names, skipping hashed, marked, and commented lines", () => {
  const text = [
    "100.87.92.42 ssh-ed25519 AAAA",
    "github.com,140.82.112.3 ssh-ed25519 AAAA",
    "[mini.local]:2222 ssh-ed25519 AAAA",
    "|1|abc=|def= ssh-ed25519 AAAA",
    "@cert-authority *.example.com ssh-rsa AAAA",
    "# a comment",
    "",
  ].join("\n");
  expect(knownHosts(text)).toEqual(["100.87.92.42", "github.com", "140.82.112.3", "mini.local"]);
});

test("suggestions follow Include, with globs, then known_hosts, each once", () => {
  const home = mkdtempSync(path.join(tmpdir(), "parallax-ssh-"));
  mkdirSync(path.join(home, ".ssh/conf.d"), { recursive: true });
  const write = (file: string, text: string) => writeFileSync(path.join(home, ".ssh", file), text);
  write("config", "Include config.local conf.d/*.conf\nHost github.com\n");
  write("config.local", "Host mac-mini\n  HostName 100.74.190.83\nInclude config\n");
  write("conf.d/a.conf", "Host devbox\n");
  write("conf.d/b.txt", "Host ignored\n");
  write("known_hosts", "github.com ssh-ed25519 AAAA\n100.87.92.42 ssh-ed25519 AAAA\n");
  expect(sshSuggestions(home)).toEqual(["github.com", "mac-mini", "devbox", "100.87.92.42"]);
  // No ~/.ssh at all is no suggestions.
  expect(sshSuggestions(mkdtempSync(path.join(tmpdir(), "parallax-ssh-")))).toEqual([]);
});
