# Remove the two throwaway models ollama-test.ps1 / ollama-test2.ps1 imported and report
# what actually got freed. 'ollama rm' with no server running makes the CLI try to spawn
# one and time out (measured: hung past 120 s), so start 'ollama serve' first.
# ASCII only (PowerShell 5.1 mangles non-ASCII source without BOM).
param(
    [string]$Ollama = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
    [string[]]$Names = @('bonsai-lora-test', 'bonsai-test'),
    [string]$OutDir = 'F:\v\project\dsh-test\bonsai\results',
    [string]$Port = '11434'
)

$ErrorActionPreference = 'Continue'
$env:OLLAMA_HOST = "127.0.0.1:$Port"

function Get-StoreSize {
    $s = (Get-ChildItem "$env:USERPROFILE\.ollama" -Recurse -File -ErrorAction SilentlyContinue |
          Measure-Object Length -Sum).Sum
    if (-not $s) { return 0 }
    return $s
}

$before = Get-StoreSize
Write-Host ("store before: {0:N2} GB" -f ($before / 1GB))

$srv = Start-Process -FilePath $Ollama -ArgumentList 'serve' -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $OutDir 'ollama-rm.log') `
    -RedirectStandardError (Join-Path $OutDir 'ollama-rm.err.log')
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 120) {
    try { [void](Invoke-RestMethod "http://127.0.0.1:$Port/api/version" -TimeoutSec 5); break } catch { Start-Sleep -Seconds 2 }
}
Write-Host "server up"

Write-Host ""
Write-Host "models before:"
(& $Ollama list 2>&1) | Select-Object -Skip 0

foreach ($m in $Names) {
    $out = & $Ollama rm $m 2>&1
    Write-Host ("rm {0} -> {1}" -f $m, (($out | Select-Object -Last 1) -replace "\x1b\[[0-9;?]*[a-zA-Z]", ''))
}

Write-Host ""
Write-Host "models after:"
(& $Ollama list 2>&1)

if (-not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }

$after = Get-StoreSize
Write-Host ""
Write-Host ("store after:  {0:N2} GB  (freed {1:N2} GB)" -f ($after / 1GB), (($before - $after) / 1GB))
Write-Host ("C: free now:  {0:N1} GB" -f ((Get-PSDrive C).Free / 1GB))
