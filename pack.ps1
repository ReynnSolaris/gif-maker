# Builds dist/gif-maker-<version>.crx (signed with gif-maker.pem) and a Web Store zip.
# Usage: powershell -File .\pack.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw "Chrome/Brave not found" }

$version = (Get-Content "$root\manifest.json" -Raw | ConvertFrom-Json).version
$stageParent = Join-Path $env:TEMP "gif-maker-pack"
$stage = Join-Path $stageParent "gif-maker"
if (Test-Path $stageParent) { Remove-Item $stageParent -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item "$root\manifest.json", "$root\*.js", "$root\*.html", "$root\*.css" $stage
Copy-Item "$root\icons" "$stage\icons" -Recurse

$packArgs = @("`"--pack-extension=$stage`"", "--no-message-box")
$pem = "$root\gif-maker.pem"
if (Test-Path $pem) { $packArgs += "`"--pack-extension-key=$pem`"" }
Start-Process -FilePath $chrome -ArgumentList $packArgs -Wait
# Chrome may hand off to an already-running instance; give it a moment to write the file.
for ($i = 0; $i -lt 30 -and -not (Test-Path "$stage.crx"); $i++) { Start-Sleep -Seconds 1 }
if (-not (Test-Path "$stage.crx")) { throw "Chrome did not produce $stage.crx" }

New-Item -ItemType Directory -Force "$root\dist" | Out-Null
Move-Item "$stage.crx" "$root\dist\gif-maker-$version.crx" -Force
if (-not (Test-Path $pem)) { Move-Item "$stage.pem" $pem }
Compress-Archive -Path "$stage\*" -DestinationPath "$root\dist\gif-maker-$version.zip" -Force
Write-Host "Built dist\gif-maker-$version.crx and .zip"
