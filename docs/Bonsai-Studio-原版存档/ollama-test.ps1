# Can the Ollama install on this machine load the Prism ternary pack?
#
# Expected answer is NO, and the point of running it is to capture the exact error text
# (the failure mode is the useful part: it tells us whether the blocker is the private
# ternary tensor types or the LoRA route). Ollama's own docs claim adapters are gone and
# stock llama.cpp has no Hadamard runtime, but "expected" is not "measured".
# ASCII only (PowerShell 5.1 mangles non-ASCII source without BOM).
param(
    [string]$Ollama = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
    [string]$Model = 'F:\v\project\dsh-test\bonsai\models\Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    [string]$OutDir = 'F:\v\project\dsh-test\bonsai\results',
    [string]$Name = 'bonsai-test',
    [string]$Port = '11434'
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$env:OLLAMA_HOST = "127.0.0.1:$Port"
$env:OLLAMA_MODELS = "$env:USERPROFILE\.ollama\models"

if (-not (Test-Path $Ollama)) { throw "ollama.exe not found at $Ollama" }

Write-Host "=== starting ollama serve (background) ==="
$srv = Start-Process -FilePath $Ollama -ArgumentList 'serve' -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $OutDir 'ollama-serve.log') `
    -RedirectStandardError (Join-Path $OutDir 'ollama-serve.err.log')

$sw = [Diagnostics.Stopwatch]::StartNew()
$up = $false
while ($sw.Elapsed.TotalSeconds -lt 120) {
    try {
        $v = Invoke-RestMethod "http://127.0.0.1:$Port/api/version" -TimeoutSec 5
        Write-Host ("api up: version {0}" -f $v.version)
        $up = $true
        break
    } catch { Start-Sleep -Seconds 2 }
}
if (-not $up) {
    Write-Host "ollama api never came up; stderr tail:"
    Get-Content (Join-Path $OutDir 'ollama-serve.err.log') -ErrorAction SilentlyContinue | Select-Object -Last 20
    if (-not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }
    return
}

Write-Host ""
Write-Host "=== version / list before ==="
(& $Ollama --version 2>&1) | Select-Object -Last 1
(& $Ollama list 2>&1) | Select-Object -Last 5

$mf = Join-Path $OutDir 'Modelfile.bonsai-test'
@(
    "FROM $Model",
    'PARAMETER num_ctx 8192',
    'PARAMETER temperature 0.7'
) | Set-Content $mf -Encoding ASCII
Write-Host ""
Write-Host "=== Modelfile ($mf) ==="
Get-Content $mf

Write-Host ""
Write-Host "=== ollama create $Name  (this is the actual test) ==="
$log = Join-Path $OutDir 'ollama-create.log'
$job = Start-Process -FilePath $Ollama -ArgumentList @('create', $Name, '-f', $mf) -PassThru -NoNewWindow `
    -RedirectStandardOutput $log -RedirectStandardError (Join-Path $OutDir 'ollama-create.err.log')
$t = [Diagnostics.Stopwatch]::StartNew()
while (-not $job.HasExited -and $t.Elapsed.TotalSeconds -lt 900) {
    Start-Sleep -Seconds 10
    $tail = (Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Last 1)
    Write-Host ("  [{0,4:N0}s] {1}" -f $t.Elapsed.TotalSeconds, $tail)
}
if (-not $job.HasExited) {
    Write-Host "still running after 15 min -> killing"
    Stop-Process -Id $job.Id -Force
} else {
    Write-Host ("create exited with code {0}" -f $job.ExitCode)
}

Write-Host ""
Write-Host "=== create log tail ==="
Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Last 25
Write-Host "=== create stderr tail ==="
Get-Content (Join-Path $OutDir 'ollama-create.err.log') -ErrorAction SilentlyContinue | Select-Object -Last 25

Write-Host ""
Write-Host "=== list after ==="
(& $Ollama list 2>&1) | Select-Object -Last 10

if (-not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }
Write-Host "ollama serve stopped"
