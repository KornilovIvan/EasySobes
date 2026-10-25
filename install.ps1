# EasySobes installer for Windows 10/11. Run it in PowerShell with:
#   irm https://raw.githubusercontent.com/KornilovIvan/EasySobes/main/install.ps1 | iex
#
# What it does, all inside %USERPROFILE%\.easysobes (no admin rights, nothing system-wide):
#   1. uses your Node.js 20+ if you have it, otherwise downloads a private copy (checksum verified)
#   2. downloads EasySobes and installs Electron
#   3. adds the `sobes` command to your PATH
#   4. runs `sobes setup` (API key, profile, resume) unless you already did it
# Running it again updates EasySobes and keeps your settings.

function Install-EasySobes {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads ~10x slower in Windows PowerShell
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = if ($env:SOBES_REPO) { $env:SOBES_REPO } else { 'KornilovIvan/EasySobes' }
  $Branch = if ($env:SOBES_BRANCH) { $env:SOBES_BRANCH } else { 'main' }
  $SobesHome = if ($env:SOBES_HOME) { $env:SOBES_HOME } else { Join-Path $HOME '.easysobes' }
  $App = Join-Path $SobesHome 'app'
  $Bin = Join-Path $SobesHome 'bin'
  $NodeHome = Join-Path $SobesHome 'node'

  function Step($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }

  if (-not [Environment]::Is64BitOperatingSystem) { throw 'EasySobes needs 64-bit Windows.' }
  $Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  Write-Host ''
  Write-Host "Installing EasySobes (Windows, $Arch)" -ForegroundColor White
  if ([Environment]::OSVersion.Version.Build -lt 19041) {
    Write-Host 'Warning: Windows 10 version 2004 or newer is needed to hide EasySobes from screen shares.' -ForegroundColor Yellow
  }
  New-Item -ItemType Directory -Force $SobesHome | Out-Null

  # 1. Node.js
  $Node = $null
  $sys = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($sys) {
    $major = 0
    [int]::TryParse((& $sys.Source -p "process.versions.node.split('.')[0]"), [ref]$major) | Out-Null
    if ($major -ge 20) { $Node = $sys.Source }
  }
  if (-not $Node -and (Test-Path (Join-Path $NodeHome 'node.exe'))) { $Node = Join-Path $NodeHome 'node.exe' }
  if (-not $Node) {
    Step 'Downloading Node.js (a private copy just for EasySobes)...'
    $base = 'https://nodejs.org/dist/latest-v24.x'
    $sums = Invoke-RestMethod "$base/SHASUMS256.txt"
    $m = [regex]::Match($sums, "([0-9a-f]{64})\s+(node-v[\d.]+-win-$Arch\.zip)")
    if (-not $m.Success) { throw 'Could not find a Node.js download. Check your internet and try again.' }
    $zip = Join-Path $env:TEMP $m.Groups[2].Value
    Invoke-WebRequest "$base/$($m.Groups[2].Value)" -OutFile $zip -UseBasicParsing
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $m.Groups[1].Value) {
      throw 'The Node.js download was corrupted. Try again.'
    }
    $tmp = Join-Path $env:TEMP "easysobes-node-$(Get-Random)"
    Expand-Archive $zip $tmp -Force
    if (Test-Path $NodeHome) { Remove-Item $NodeHome -Recurse -Force }
    Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $NodeHome
    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $Node = Join-Path $NodeHome 'node.exe'
  }
  $NodeDir = Split-Path $Node
  $env:Path = "$NodeDir;$env:Path"
  Step "Using Node.js $(& $Node -v)"

  # 2. EasySobes itself. Copying over the old copy keeps node_modules, so updates are quick.
  Step 'Downloading EasySobes...'
  New-Item -ItemType Directory -Force $App | Out-Null
  if ($env:SOBES_SOURCE) {
    $src = $env:SOBES_SOURCE # local folder instead of GitHub, for testing this installer
  } else {
    $zip = Join-Path $env:TEMP "easysobes-$(Get-Random).zip"
    Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP "easysobes-src-$(Get-Random)"
    Expand-Archive $zip $tmp -Force
    $src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
  }
  robocopy $src $App /E /XD node_modules dist .git /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying EasySobes failed (robocopy code $LASTEXITCODE)." }
  if (-not $env:SOBES_SOURCE) { Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue }

  Step 'Installing Electron (about 150 MB the first time, a minute or two)...'
  # npm.cmd, not npm: the npm.ps1 shim is blocked where PowerShell scripts are disabled.
  $npm = Join-Path $NodeDir 'npm.cmd'
  Push-Location $App
  try {
    & $npm install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Check your internet and run the installer again.' }
    # Electron 44+ fetches its binary on first use; do it now so the first `sobes` starts right away.
    & $Node -e "require('electron')" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not download Electron. Check your internet and run the installer again.' }
  } finally { Pop-Location }

  # 3. The `sobes` command: a .cmd file works in cmd and in PowerShell, whatever the script policy.
  New-Item -ItemType Directory -Force $Bin | Out-Null
  $sobesCmd = Join-Path $Bin 'sobes.cmd'
  $script = "@echo off`r`nset `"PATH=$NodeDir;%PATH%`"`r`n`"$Node`" `"$App\bin\sobes.js`" %*`r`n"
  [IO.File]::WriteAllText($sobesCmd, $script)
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $Bin)) {
    $newPath = if ($userPath) { "$userPath;$Bin" } else { $Bin }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  }
  $env:Path = "$Bin;$env:Path"
  Step 'Added the sobes command'

  # 4. Setup wizard
  & $sobesCmd setup --if-needed
  Write-Host ''
  $answer = Read-Host 'Start EasySobes now? [Y/n]'
  if ($answer -notmatch '^[nN]') { & $sobesCmd }

  Write-Host ''
  Write-Host 'Done! From now on, open PowerShell or Command Prompt and type:  sobes' -ForegroundColor Green
  Write-Host '   sobes setup    change your API key, profile or resume'
  Write-Host '   sobes update   get the latest version'
}

# Wrapped in a function so an error never closes your PowerShell window (this runs through `iex`).
try { Install-EasySobes } catch { Write-Host "x $($_.Exception.Message)" -ForegroundColor Red }
