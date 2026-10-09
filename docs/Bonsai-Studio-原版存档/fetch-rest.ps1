# Fetch the remaining pieces:
#   - OrcaBonsai refusal-ablation LoRA adapter (9,682,464 bytes, sha256 f1669534...)
#   - PrismML llama.cpp Windows CUDA 12.4 build + cudart
# raw.githubusercontent.com returns 502 from this machine, so the LoRA is fetched
# through the GitHub API (base64 blob) with jsDelivr as a fallback.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$root  = 'F:\v\project\dsh-test\bonsai'
$lora  = Join-Path $root 'lora'
$llama = Join-Path $root 'llamacpp'
$TAG   = 'prism-b10743-adfffbe'
$REPO  = 'https://github.com/PrismML-Eng/llama.cpp/releases/download/' + $TAG

$loraOut = Join-Path $lora 'bonsai-abliterate-lora.gguf'
$want    = 'f1669534803d340a496015f5c45125f3437b4d13ec764f40e34488ce83967f42'

function Get-Sha256($p) {
    (Get-FileHash -Path $p -Algorithm SHA256).Hash.ToLower()
}

# ---------- 1. LoRA adapter ----------
if ((Test-Path $loraOut) -and (Get-Sha256 $loraOut) -eq $want) {
    Write-Output 'LoRA already present and correct'
} else {
    $done = $false

    # route A: GitHub API contents endpoint, base64 payload
    try {
        Write-Output 'LoRA route A: api.github.com blob'
        $u = 'https://api.github.com/repos/Continuum-AI-Corp/OrcaBonsai-27B-Uncensored/contents/gguf/bonsai-abliterate-lora.gguf?ref=main'
        $j = Invoke-RestMethod $u -Headers @{ 'User-Agent' = 'dsh-probe'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 60
        if ($j.content) {
            $bytes = [Convert]::FromBase64String(($j.content -replace '\s', ''))
            [System.IO.File]::WriteAllBytes($loraOut, $bytes)
            Write-Output ('  wrote ' + $bytes.Length + ' bytes')
            $done = $true
        } else {
            Write-Output ('  no inline content (size=' + $j.size + ', encoding=' + $j.encoding + ')')
        }
    } catch { Write-Output ('  route A failed: ' + $_.Exception.Message) }

    # route B: jsDelivr CDN mirror of the GitHub repo
    if (-not $done) {
        try {
            Write-Output 'LoRA route B: cdn.jsdelivr.net'
            $u = 'https://cdn.jsdelivr.net/gh/Continuum-AI-Corp/OrcaBonsai-27B-Uncensored@main/gguf/bonsai-abliterate-lora.gguf'
            & curl.exe -L --fail --ssl-no-revoke --connect-timeout 20 -A 'Mozilla/5.0' -o $loraOut $u
            if ($LASTEXITCODE -eq 0) { Write-Output ('  curl ok, ' + (Get-Item $loraOut).Length + ' bytes'); $done = $true }
            else { Write-Output ('  route B curl exit ' + $LASTEXITCODE) }
        } catch { Write-Output ('  route B failed: ' + $_.Exception.Message) }
    }

    # route C: GitHub API git/blobs endpoint
    if (-not $done) {
        try {
            Write-Output 'LoRA route C: api.github.com git/blobs'
            $u = 'https://api.github.com/repos/Continuum-AI-Corp/OrcaBonsai-27B-Uncensored/git/blobs/9787395dbf5a21d25461611d2db75514ce90cbbd'
            $j = Invoke-RestMethod $u -Headers @{ 'User-Agent' = 'dsh-probe'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 90
            $bytes = [Convert]::FromBase64String(($j.content -replace '\s', ''))
            [System.IO.File]::WriteAllBytes($loraOut, $bytes)
            Write-Output ('  wrote ' + $bytes.Length + ' bytes')
            $done = $true
        } catch { Write-Output ('  route C failed: ' + $_.Exception.Message) }
    }

    if ($done) {
        $got = Get-Sha256 $loraOut
        Write-Output ('LoRA sha256 = ' + $got)
        if ($got -eq $want) { Write-Output 'LoRA SHA256 MATCHES the published value' }
        else { Write-Output '!!! LoRA SHA256 MISMATCH, expected ' + $want }
    } else {
        Write-Output '!!! LoRA could not be fetched by any route'
    }
}

# ---------- 2. PrismML llama.cpp build + cudart ----------
$zips = @(
    @{ f = 'llama-prism-win-cuda-12.4-x64.zip';   n = 'llama.cpp CUDA 12.4 binaries' },
    @{ f = 'cudart-llama-bin-win-cuda-12.4-x64.zip'; n = 'CUDA 12.4 runtime DLLs' }
)
foreach ($z in $zips) {
    $out = Join-Path $llama $z.f
    if ((Test-Path $out) -and (Get-Item $out).Length -gt 10MB) { Write-Output ($z.n + ' already downloaded'); continue }
    Write-Output ('==> ' + $z.n)
    & curl.exe -L --fail --retry 6 --retry-delay 3 --retry-all-errors --ssl-no-revoke -C - `
        -A 'Mozilla/5.0' --connect-timeout 20 -o $out ($REPO + '/' + $z.f)
    if ($LASTEXITCODE -ne 0) { Write-Output ('!!! curl exit ' + $LASTEXITCODE) }
    else { Write-Output ('    ' + [math]::Round((Get-Item $out).Length / 1MB, 1) + ' MB') }
}
Write-Output 'FETCH ROUND FINISHED'
