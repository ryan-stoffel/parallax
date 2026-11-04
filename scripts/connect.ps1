# Adds this computer to Parallax on Windows: runs `plx connect` with any arguments given, as Add a
# computer's command does. That command reads this file as text and runs it, so the execution policy
# that blocks script files doesn't apply, in cmd or in PowerShell. It uses Node.js 20 or newer if
# that's here, or else downloads Node.js to %USERPROFILE%\.parallax-plxd\node and checks it against
# nodejs.org's SHA-256 list.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Test-Node {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $false }
  $version = & node.exe -p 'process.versions.node.split(".")[0]'
  return [int]$version -ge 20
}

if (-not (Test-Node)) {
  $dir = Join-Path $env:USERPROFILE '.parallax-plxd\node'
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'node.exe'))) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $base = 'https://nodejs.org/dist/latest-v22.x'
    $list = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
    $text = if ($list -is [byte[]]) { [Text.Encoding]::ASCII.GetString($list) } else { $list }
    $line = $text -split "`n" | Where-Object { $_ -match "  node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
    $expected, $name = $line -split '\s+'
    'Downloading Node.js, which Parallax''s setup runs on'
    $tmp = Join-Path $env:TEMP ([IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
      $zip = Join-Path $tmp $name
      Invoke-WebRequest -Uri "$base/$name" -OutFile $zip -UseBasicParsing
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower() -ne $expected) {
        throw "The Node.js download's SHA-256 isn't the one nodejs.org lists, so it wasn't used."
      }
      Expand-Archive -LiteralPath $zip -DestinationPath $tmp
      New-Item -ItemType Directory -Force -Path (Split-Path $dir) | Out-Null
      Move-Item -LiteralPath (Join-Path $tmp ($name -replace '\.zip$', '')) -Destination $dir
    } finally {
      Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
  }
  $env:PATH = "$dir;$env:PATH"
}

# npm's upgrade notice would read as something to do.
$env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
& npx.cmd -y plx-cli@latest connect @args
exit $LASTEXITCODE
