# Installs the newest Parallax nightly on Windows (x64, arm64) (PLX-891):
#   irm https://raw.githubusercontent.com/ryan-stoffel/parallax/develop/scripts/install.ps1 | iex
# Downloads the nightly's installer and runs it. It installs for this user, with no admin
# prompt, and the app's own updater keeps it current. Like install.sh, this takes the newest
# release with a nightly installer for this arch, since GitHub's /releases/latest skips
# prereleases.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
  'X64' { 'x64' }
  'Arm64' { 'arm64' }
  default { throw "No Parallax build for Windows $_." }
}

$releases = Invoke-RestMethod 'https://api.github.com/repos/ryan-stoffel/parallax/releases?per_page=20'
$asset = $releases.assets | Where-Object { $_.name -like "*-nightly-win-$arch.exe" } | Select-Object -First 1
if (-not $asset) { throw "No nightly found for win-$arch at https://github.com/ryan-stoffel/parallax/releases." }

$installer = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name)"
Invoke-WebRequest $asset.browser_download_url -OutFile $installer -UseBasicParsing
Start-Process $installer -Wait
Remove-Item $installer
Write-Host 'Installed Parallax. Open it from the Start menu.'
