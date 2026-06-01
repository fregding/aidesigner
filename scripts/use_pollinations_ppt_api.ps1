param(
  [string]$PollinationsKey = "",
  [string]$Model = "openai"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$EnvPath = Join-Path $Root "backend\.env.local"
$BackupPath = Join-Path $Root "backend\.env.local.bak_pollinations_ppt"

if (-not (Test-Path $EnvPath)) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Root "backend") | Out-Null
  New-Item -ItemType File -Force -Path $EnvPath | Out-Null
}

Copy-Item $EnvPath $BackupPath -Force

$text = Get-Content -Raw -Path $EnvPath -ErrorAction SilentlyContinue

if ([string]::IsNullOrWhiteSpace($PollinationsKey)) {
  $m = [regex]::Match($text, "(?m)^IMAGE_API_KEY\s*=\s*(.+?)\s*$")
  if ($m.Success -and -not [string]::IsNullOrWhiteSpace($m.Groups[1].Value)) {
    $PollinationsKey = $m.Groups[1].Value.Trim()
  }
}

if ([string]::IsNullOrWhiteSpace($PollinationsKey)) {
  $PollinationsKey = "none"
}

$keys = @(
  "ENABLE_PPT",
  "DISABLE_PPT",
  "PPT_PROVIDER",
  "ENABLE_LOCAL_PPT",
  "TIME_BACKWARD_BASE_URL",
  "TIME_BACKWARD_API_KEY",
  "CHAT_MODEL",
  "ASSISTANT_MODEL",
  "PPT_MODEL",
  "PPT_MASTER_ROOT",
  "PPT_MASTER_PYTHON",
  "PPT_GENERATE_IMAGES",
  "PPT_MAX_PAGES",
  "PPT_TIMEOUT_MS"
)

$lines = @()
if (-not [string]::IsNullOrEmpty($text)) {
  foreach ($line in ($text -split "\r?\n")) {
    $trim = $line.Trim()
    $skip = $false
    foreach ($key in $keys) {
      if ($trim -match ("^" + [regex]::Escape($key) + "\s*=")) {
        $skip = $true
        break
      }
    }
    if (-not $skip) {
      $lines += $line
    }
  }
}

$append = @(
  "",
  "# Pollinations Text API for PPT generation",
  "ENABLE_PPT=true",
  "DISABLE_PPT=false",
  "PPT_PROVIDER=openai-compatible",
  "ENABLE_LOCAL_PPT=false",
  "TIME_BACKWARD_BASE_URL=https://gen.pollinations.ai/v1",
  "TIME_BACKWARD_API_KEY=$PollinationsKey",
  "CHAT_MODEL=$Model",
  "ASSISTANT_MODEL=$Model",
  "PPT_MODEL=$Model",
  "PPT_MASTER_ROOT=../external/ppt-master",
  "PPT_MASTER_PYTHON=../external/ppt-master/venv/Scripts/python.exe",
  "PPT_GENERATE_IMAGES=false",
  "PPT_MAX_PAGES=6",
  "PPT_TIMEOUT_MS=900000"
)

$out = ($lines + $append) -join "`r`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($EnvPath, $out, $utf8NoBom)

Write-Host "Done."
Write-Host "Backup: backend\.env.local.bak_pollinations_ppt"
Write-Host "Pollinations model: $Model"
if ($PollinationsKey -eq "none") {
  Write-Host "Pollinations key: none"
} else {
  Write-Host "Pollinations key: configured"
}
