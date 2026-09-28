# Sets up key-based `ssh localhost` on a disposable GitHub-hosted Windows runner, for #95's
# check-ssh-attach, through Windows' own OpenSSH server (Win32-OpenSSH), the one wisp's Windows
# hosts run (0023). It starts the image's sshd service, authorizes a throwaway key for the
# runner's user, and points a `Host localhost` block in ~/.ssh/config at that key and a throwaway
# known_hosts, as scripts/ci/ssh-localhost does on macOS and Linux. An image without the sshd
# service (the Windows arm64 one) gets Win32-OpenSSH's pinned MSI instead, since installing the
# Windows capability there takes longer than the job allows. The ssh client it used goes in
# WISP_E2E_SSH for the next steps.
#
# Never runs outside a GitHub-hosted runner, and never fails the build on its own: it writes
# WISP_E2E_SSH_READY=true or =false plus a reason to <status-file>, and the caller decides whether
# that is a skip or, with WISP_E2E_REQUIRE_SSH=1, a failure. Readiness is proven by running
# `ssh localhost`.
param([Parameter(Mandatory = $true)][string] $StatusFile)

$ErrorActionPreference = 'Stop'
$openssh = Join-Path $env:SystemRoot 'System32\OpenSSH'

# Win32-OpenSSH 10.0.0.0p2, with the SHA-256 GitHub lists for each asset.
$msiRelease = 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview'
$msi = @{
    'X64'   = @('OpenSSH-Win64-v10.0.0.0.msi', 'ddec9c53864280759cf9f74791cefd387100e3946aa849a1c138a4ed1b96b7d9')
    'ARM64' = @('OpenSSH-ARM64-v10.0.0.0.msi', '7a17d0e22d004fb47ca4bfd8fef926fa305de4ebf70a6f3c7a29c39aabef0023')
}

function Write-Status([string] $Ready, [string] $Reason = '') {
    $lines = @("WISP_E2E_SSH_READY=$Ready")
    if ($Reason) { $lines += "WISP_E2E_SSH_REASON=$($Reason -replace '\r?\n', ' ')" }
    Set-Content -Path $StatusFile -Value $lines -Encoding ascii
}

function Skip([string] $Reason) {
    Write-Host "ssh-localhost: skipping: $Reason"
    Write-Status 'false' $Reason
    exit 0
}

if ($env:GITHUB_ACTIONS -ne 'true') { Skip 'not running in GitHub Actions' }
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { Skip 'not a GitHub-hosted runner' }

try {
    if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
        $name, $sha256 = $msi[$env:RUNNER_ARCH]
        $file = Join-Path $env:RUNNER_TEMP $name
        Invoke-WebRequest -Uri "$msiRelease/$name" -OutFile $file -MaximumRetryCount 3
        if ((Get-FileHash -Algorithm SHA256 $file).Hash -ne $sha256) { Skip "$name's SHA-256 doesn't match" }
        $install = Start-Process msiexec -ArgumentList "/i `"$file`" /qn ADDLOCAL=Client,Server" -Wait -PassThru
        if ($install.ExitCode -ne 0) { Skip "installing $name failed ($($install.ExitCode))" }
        $openssh = Join-Path $env:ProgramFiles 'OpenSSH'
    }
    Set-Service sshd -StartupType Manual
    Start-Service sshd
} catch {
    Skip "could not start Windows' sshd: $_"
}

$state = Join-Path $env:RUNNER_TEMP 'wisp-e2e-ssh'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$identity = Join-Path $state 'id_ed25519'
$knownHosts = Join-Path $state 'known_hosts'
Remove-Item -Force -ErrorAction SilentlyContinue $identity, "$identity.pub"
& "$openssh\ssh-keygen.exe" -t ed25519 -N '' -f $identity -C wisp-e2e-ci -q
if ($LASTEXITCODE -ne 0) { Skip 'ssh-keygen failed' }
# Win32-OpenSSH refuses a private key that anyone but its owner can read.
icacls $identity /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null

# The runner's user is an administrator, and Windows' sshd_config reads administrators' keys
# from one file, which must grant only Administrators and SYSTEM.
$authorized = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
Get-Content "$identity.pub" | Add-Content -Path $authorized -Encoding ascii
icacls $authorized /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null

$keys = ''
foreach ($attempt in 1..20) {
    $keys = & "$openssh\ssh-keyscan.exe" -t ed25519 localhost 2>$null
    if ($keys) { break }
    Start-Sleep -Milliseconds 250
}
if (-not $keys) { Skip 'ssh-keyscan got no host key from localhost:22' }
Set-Content -Path $knownHosts -Value $keys -Encoding ascii

$sshDir = Join-Path $env:USERPROFILE '.ssh'
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
$slash = { param($path) $path -replace '\\', '/' }
Add-Content -Path (Join-Path $sshDir 'config') -Encoding ascii -Value @(
    '# wisp-e2e-ci: throwaway localhost ssh for #95, added by scripts/ci/ssh-localhost.ps1',
    'Host localhost',
    "    IdentityFile $(& $slash $identity)",
    '    IdentitiesOnly yes',
    "    UserKnownHostsFile $(& $slash $knownHosts)",
    '    StrictHostKeyChecking yes',
    '    BatchMode yes'
)

$probe = & "$openssh\ssh.exe" -T -o ConnectTimeout=5 -o ControlPath=none localhost 'echo ready' 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "ssh-localhost: ready (Windows OpenSSH in $openssh, port 22)"
    if ($env:GITHUB_ENV) { Add-Content -Path $env:GITHUB_ENV -Value "WISP_E2E_SSH=$openssh\ssh.exe" }
    Write-Status 'true'
} else {
    Skip "ssh localhost (probe) failed: $probe"
}
