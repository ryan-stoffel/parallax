#!/usr/bin/env node
// plx-connect's last version (0091): the CLI is now plx, published as plx-cli, so this only says
// what to run instead.

const args = process.argv.slice(2).join(" ");
const command = args === "" || args.startsWith("add") || args.startsWith("setup") ? "connect" : args;
console.error(`plx-connect is now plx. Run:\n\n  npx plx-cli ${command}\n`);
process.exitCode = 1;
