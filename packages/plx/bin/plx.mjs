#!/usr/bin/env node
// @ts-check
// plx: Parallax's command line (src/cli.mjs).

import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
