[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$AccountId,
  [string]$ApiToken = "",
  [string]$TokenPath = "",
  [string]$Wallet = "",
  [Parameter(Mandatory)][string]$WorkerName,
  [Parameter(Mandatory)][string]$Image,
  [ValidateSet("ENAM","WNAM","EEUR","WEUR","APAC","SAM","ME","OC","AFR")][string]$Region = "APAC",
  [int]$Target = 370,
  [int]$MaxInstances = 370,
  [int]$FillBatch = 32,
  [int]$Threads = 7,
  [int]$MaxCpuUsage = 95,
  [int]$PollIntervalSec = 180,
  [int]$PollCount = 3,
  [string]$V11Root = ""
)

$ErrorActionPreference = "Stop"
try{ [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 }catch {}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Deploy = Join-Path $Root "scripts\deploy.ps1"
if(-not (Test-Path -LiteralPath $Deploy)){ throw "deploy.ps1 missing at $Deploy" }

if(-not $ApiToken){
  if(-not $TokenPath){ $TokenPath = Join-Path $Root ".secrets\cloudflare-primary-token.txt" }
  if(-not (Test-Path -LiteralPath $TokenPath)){ throw "TokenPath not found: $TokenPath" }
  $ApiToken = ([IO.File]::ReadAllText($TokenPath)).Trim()
}
if(-not $ApiToken){ throw "empty API token" }

if(-not $Wallet){
  $wr = Join-Path $Root "wrangler.jsonc"
  if(Test-Path -LiteralPath $wr){
    $walletMatch = [regex]::Match([IO.File]::ReadAllText($wr), '"EDGE_WALLET"\s*:\s*"([^"]+)"')
    if($walletMatch.Success -and $walletMatch.Groups[1].Value -ne '__WALLET__'){
      $Wallet = $walletMatch.Groups[1].Value
    }
  }
}
if(-not $Wallet){ $Wallet = "42NziJLpe2SZ1ToBqfCXBk1FnFTpNkrdWQfsURbYDqjQ3mDZNfLBsA5YAWv8SaHeCVFQt4uMuuigC5NFURY8sgdz2gt4i5Y" }
if(-not $Wallet){ throw "Set -Wallet or put EDGE_WALLET in wrangler.jsonc." }

if(-not $V11Root){
  $Candidate = Join-Path (Split-Path -Parent $Root) "V11"
  if(Test-Path -LiteralPath $Candidate){ $V11Root = $Candidate }
}

function Redact([string]$Text, [string[]]$Secrets){
  $out = $Text
  foreach ($s in $Secrets){ if($s){ $out = $out.Replace($s, "<redacted>") } }
  $out = [regex]::Replace($out, 'env\.(API_KEY|HEARTBEAT_HMAC_KEY|EDGE_WALLET) \("[^"]*"\)', 'env.$1 ("<redacted>")')
  return $out
}

Write-Host ("--- V12-DEPLOY UTC=" + ([DateTime]::UtcNow.ToString("yyyy-MM-dd HH:mm:ssZ")))
Write-Host ("ROOT=" + $Root)
Write-Host ("ACCOUNT=" + $AccountId + " WORKER=" + $WorkerName + " TARGET=" + $Target + " MAX=" + $MaxInstances + " THREADS=" + $Threads + " CPU=" + $MaxCpuUsage + " FILL=" + $FillBatch + " REGION=" + $Region)
Write-Host ("IMAGE=" + $Image)

$args = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Deploy,
  "-AccountId", $AccountId,
  "-ApiToken", $ApiToken,
  "-Wallet", $Wallet,
  "-WorkerName", $WorkerName,
  "-Region", $Region,
  "-Target", "$Target",
  "-MaxInstances", "$MaxInstances",
  "-FillBatch", "$FillBatch",
  "-Threads", "$Threads",
  "-MaxCpuUsage", "$MaxCpuUsage",
  "-Image", $Image,
  "-Root", $Root
)

$raw = & powershell.exe @args 2>&1
$exit = $LASTEXITCODE
$secrets = @($ApiToken, $Wallet) | Where-Object { $_ }
$txt = (($raw | ForEach-Object { [string]$_ }) -join "`n")
$txt = Redact $txt $secrets
Write-Host "--- DEPLOY OUTPUT (redacted tail) ---"
($txt -split "`n" | Select-Object -Last 30) | ForEach-Object { Write-Host $_ }
Write-Host ("DEPLOY_EXIT=" + $exit)
if($exit -ne 0){ exit $exit }

if($V11Root -and (Test-Path -LiteralPath (Join-Path $V11Root "scripts\status.ps1"))){
  Write-Host "--- V11 STATUS WATCH ---"
  for($i = 0; $i -lt $PollCount; $i++){
	Start-Sleep -Seconds $PollIntervalSec
	& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $V11Root "scripts\status.ps1") -Root $Root -AccountId $AccountId
	Write-Host ("V11_STATUS_EXIT_P" + $i + "=" + $LASTEXITCODE)
  }
}else{
  Write-Host "V11 status watcher not found; deploy completed without watch."
}
