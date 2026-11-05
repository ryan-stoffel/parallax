# Adds this computer to Parallax on Windows: defines Connect-Parallax, which runs `plx connect` with
# any arguments given, as Add a computer's command does (`irm ... | iex; Connect-Parallax`). That
# reads this file as text, so the execution policy that blocks script files doesn't apply, in cmd or
# in PowerShell. Keep that form: Defender blocks `[scriptblock]::Create((irm ...))` as malicious.
# It uses Node.js 20 or newer if that's here, or else downloads Node.js to
# %USERPROFILE%\.parallax-plxd\node and checks it against nodejs.org's SHA-256 list. With no
# terminal it still runs, for a script to set up a computer: see plx's README.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Test-Node {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $false }
  if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) { return $false }
  # Windows PowerShell strips double quotes from a native command's arguments.
  $version = (& node.exe --version) -replace '^v(\d+).*$', '$1'
  return [int]$version -ge 20
}

function Connect-Parallax {
  if (-not (Test-Node)) {
    $dir = Join-Path $env:USERPROFILE '.parallax-plxd\node'
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'node.exe'))) {
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
      $base = 'https://nodejs.org/dist/latest-v22.x'
      $list = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
      $text = if ($list -is [byte[]]) { [Text.Encoding]::ASCII.GetString($list) } else { $list }
      $line = $text -split "`n" | Where-Object { $_ -match "  node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
      if (-not $line) { throw "nodejs.org lists no Node.js for Windows $arch." }
      $expected, $name = $line -split '\s+'
      'Downloading Node.js, which Parallax''s setup runs on'
      # Beside its final place, so moving it there is one rename and can't leave part of it behind.
      New-Item -ItemType Directory -Force -Path (Split-Path $dir) | Out-Null
      $tmp = "$dir." + [IO.Path]::GetRandomFileName()
      New-Item -ItemType Directory -Force -Path $tmp | Out-Null
      try {
        $zip = Join-Path $tmp $name
        Invoke-WebRequest -Uri "$base/$name" -OutFile $zip -UseBasicParsing
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower() -ne $expected) {
          throw "The Node.js download's SHA-256 isn't the one nodejs.org lists, so it wasn't used."
        }
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp
        Remove-Item -Recurse -Force -LiteralPath $dir -ErrorAction SilentlyContinue
        Move-Item -LiteralPath (Join-Path $tmp ($name -replace '\.zip$', '')) -Destination $dir
      } finally {
        Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
      }
    }
    $env:PATH = "$dir;$env:PATH"
  }

  # npm's upgrade notice would read as something to do.
  $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  # Named because this script can reach users before a plx-cli that defaults to nightly does. The
  # last --channel wins, so one given to Connect-Parallax overrides it.
  # Found first, under 'Stop': past here a missing npx would leave nothing to fail the exit code.
  $npx = (Get-Command npx.cmd).Source
  # When a caller captures stderr, Windows PowerShell makes each of a command's stderr lines an
  # error, and 'Stop' would end setup at npm's first warning.
  $ErrorActionPreference = 'Continue'
  & $npx -y plx-cli@latest connect --channel nightly @args
  exit $LASTEXITCODE
}
