// @ts-check
// Finding a computer's OS, arch, and details, from what its shell answers.

/** @typedef {import("./releases.mjs").Os} Os */
/** @typedef {import("./releases.mjs").Arch} Arch */

/**
 * @typedef {object} Target What `add` and `setup` install for.
 * @property {Os} os
 * @property {Arch} arch
 * @property {string} label The Mac's model, or the computer's name elsewhere.
 * @property {string} version The OS and its version, e.g. `macOS 26.0` or `Ubuntu 24.04.1 LTS`.
 */

/**
 * The first command `add` runs over ssh. POSIX shells answer `Darwin arm64`. cmd.exe and
 * PowerShell, the shells OpenSSH on Windows starts, fail to find `uname`, and `2>&1` brings their
 * error to stdout in every one of these shells.
 */
export const UNAME_COMMAND = "uname -sm 2>&1";

/** Prints `key=value` lines for {@link parseDetails} on macOS and Linux. Run with `sh -s`. */
export const POSIX_DETAILS = `echo "arch=$(uname -m)"
echo "name=$(hostname 2>/dev/null || uname -n)"
if [ "$(uname -s)" = Darwin ]; then
  echo "version=macOS $(sw_vers -productVersion)"
  model=$(system_profiler SPHardwareDataType 2>/dev/null | sed -n 's/^ *Model Name: //p')
  echo "model=\${model:-$(sysctl -n hw.model)}"
else
  if [ -r /etc/os-release ]; then . /etc/os-release; fi
  echo "version=\${PRETTY_NAME:-Linux $(uname -r)}"
fi
`;

/** Prints `key=value` lines for {@link parseDetails} on Windows. Run with PowerShell. */
export const WINDOWS_DETAILS = `$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
"arch=$arch"
"name=$env:COMPUTERNAME"
"version=$((Get-CimInstance Win32_OperatingSystem).Caption)"
`;

/**
 * Parallax's name for a machine arch from `uname -m` or `PROCESSOR_ARCHITECTURE`, or undefined
 * for one Parallax isn't built for.
 * @param {string} machine
 * @returns {Arch | undefined}
 */
export function normalizeArch(machine) {
  const value = machine.trim().toLowerCase();
  if (value === "arm64" || value === "aarch64") return "arm64";
  if (value === "x86_64" || value === "amd64" || value === "x64") return "x64";
  return undefined;
}

/**
 * The OS from {@link UNAME_COMMAND}'s output and exit code. A failed `uname`, or a Windows
 * `uname` such as Git for Windows' (`MINGW64_NT-10.0 x86_64`), means Windows. Throws for an OS
 * Parallax doesn't run on.
 * @param {string} output
 * @param {number} code
 * @returns {Os}
 */
export function parseUname(output, code) {
  const text = output.trim();
  if (code !== 0 || /MINGW|MSYS|CYGWIN|Windows/i.test(text)) return "windows";
  const system = text.split(/\s+/)[0] ?? "";
  if (system === "Darwin") return "macos";
  if (system === "Linux") return "linux";
  throw new Error(`Parallax doesn't run on ${system || "this OS"}.`);
}

/**
 * The target's details from the `key=value` lines {@link POSIX_DETAILS} or
 * {@link WINDOWS_DETAILS} printed. Throws for an arch Parallax isn't built for.
 * @param {Os} os
 * @param {string} output
 * @returns {Target}
 */
export function parseDetails(os, output) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const machine = values["arch"] ?? "";
  const arch = normalizeArch(machine);
  if (!arch) throw new Error(`Parallax isn't built for ${machine || "this computer's"} processors.`);
  const name = values["name"] ?? "";
  const label = os === "macos" ? values["model"] || name : name;
  const version = (values["version"] ?? "").replace(/^Microsoft /, "");
  return { os, arch, label: label || "The computer", version: version || os };
}
