// Launch only on the disposable Linux PR runner. No inherited service credentials or proxy.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "plx-host-proof-"));
const bin = join(root,"bin"); mkdirSync(bin);
writeFileSync(join(bin,"tailscale"),"#!/bin/sh\nexit 1\n",{mode:0o700});
const env = Object.fromEntries(["PATH","RUSTUP_HOME","CARGO_HOME","RUSTUP_TOOLCHAIN","LD_LIBRARY_PATH","SYSTEMROOT"]
  .filter(k => process.env[k]).map(k => [k,process.env[k]]));
Object.assign(env,{RUSTUP_HOME:process.env.RUSTUP_HOME ?? join(homedir(),".rustup"),
  CARGO_HOME:process.env.CARGO_HOME ?? join(homedir(),".cargo"),PATH:`${bin}:${env.PATH}`,HOME:root,XDG_CONFIG_HOME:join(root,"config"),
  XDG_DATA_HOME:join(root,"data"),TMPDIR:root,WRANGLER_SEND_METRICS:"false",CI:"true",PLX_HOST_PROOF:"1"});
for (const delay of [0,20,50]) {
  console.log(JSON.stringify({hostProofLegDelayMs:delay}));
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath,["scripts/e2e.mjs", "cargo","test","-p","plxd","--test","server","--locked",
      "--features","host-routing-proof", "relay::host_proof::", "--", "--nocapture", "--test-threads=1"],
      {env:{...env,PLX_HOST_PROOF_DELAY_MS:String(delay)},stdio:"inherit"});
    child.on("exit", code => resolve(code ?? 1));
  });
  if (code !== 0) process.exit(code);
}
