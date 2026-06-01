$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$EnvPath = Join-Path $Root "backend\.env.local"

if (-not (Test-Path $EnvPath)) {
  Write-Host "ERROR: backend\.env.local not found."
  exit 1
}

$text = Get-Content -Raw -Path $EnvPath

function Get-EnvValue([string]$Name, [string]$DefaultValue) {
  $m = [regex]::Match($text, "(?m)^" + [regex]::Escape($Name) + "\s*=\s*(.+?)\s*$")
  if ($m.Success) {
    return $m.Groups[1].Value.Trim()
  }
  return $DefaultValue
}

$BaseUrl = Get-EnvValue "TIME_BACKWARD_BASE_URL" "https://gen.pollinations.ai/v1"
$ApiKey = Get-EnvValue "TIME_BACKWARD_API_KEY" "none"
$Model = Get-EnvValue "PPT_MODEL" (Get-EnvValue "CHAT_MODEL" "openai")

$Url = $BaseUrl.TrimEnd("/") + "/chat/completions"

$BodyObject = [ordered]@{
  model = $Model
  messages = @(
    [ordered]@{
      role = "user"
      content = "Please reply with exactly: PPT API OK"
    }
  )
  max_tokens = 50
}

$BodyJson = $BodyObject | ConvertTo-Json -Depth 10 -Compress
$TmpJson = Join-Path $env:TEMP ("pollinations_ppt_test_" + [guid]::NewGuid().ToString("N") + ".json")

# Important: Windows PowerShell 5.1 Set-Content -Encoding UTF8 writes a BOM.
# Pollinations rejects JSON bodies that start with a BOM, so write UTF-8 without BOM.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($TmpJson, $BodyJson, $utf8NoBom)

Write-Host "Testing Pollinations text API..."
Write-Host "URL: $Url"
Write-Host "MODEL: $Model"

$args = @("-sS", "-X", "POST", $Url, "-H", "Content-Type: application/json")
if (-not [string]::IsNullOrWhiteSpace($ApiKey) -and $ApiKey -ne "none") {
  $args += @("-H", "Authorization: Bearer $ApiKey")
}
$args += @("--data-binary", "@$TmpJson")

try {
  & curl.exe @args
  Write-Host ""
} finally {
  Remove-Item $TmpJson -Force -ErrorAction SilentlyContinue
}
