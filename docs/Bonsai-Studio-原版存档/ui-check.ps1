# Does THIS build's llama-server ship a usable web UI?
# The PrismML fork is a llama.cpp fork, so it should carry the built-in single-page chat
# front end. If it does, that is the zero-extra-download answer to "is there a UI".
# ASCII only (PowerShell 5.1 mangles non-ASCII source without BOM).
param(
    [string]$Model = 'F:\v\project\dsh-test\bonsai\models\Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    [string]$Lora = 'F:\v\project\dsh-test\bonsai\lora\bonsai-abliterate-lora.gguf',
    [string]$Bin = 'F:\v\project\dsh-test\bonsai\llamacpp\bin',
    [string]$OutDir = 'F:\v\project\dsh-test\bonsai\results',
    [int]$Ctx = 16384,
    [int]$Port = 8090,
    [switch]$NoLora
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$env:PATH = $Bin + ';' + $env:PATH
$argv = @('-m', $Model, '--no-mmap', '-ngl', '99', '-fa', 'on', '-c', "$Ctx",
          '-np', '1', '--cache-ram', '4096', '--reasoning-effort', 'medium',
          '--host', '127.0.0.1', '--port', "$Port")
if (-not $NoLora) { $argv += @('--lora-init-without-apply', '--lora', $Lora) }

$proc = Start-Process -FilePath (Join-Path $Bin 'llama-server.exe') -ArgumentList $argv `
    -RedirectStandardOutput (Join-Path $OutDir "server-ui.log") `
    -RedirectStandardError (Join-Path $OutDir "server-ui.err.log") -PassThru -WindowStyle Hidden
Write-Host ("launched pid {0}" -f $proc.Id)

$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 600) {
    if ($proc.HasExited) { throw "server exited early; see $OutDir\server-ui.err.log" }
    try { if ((Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5).status -eq 'ok') { break } } catch { Start-Sleep -Seconds 2 }
}
Write-Host ("health ok in {0:N0}s" -f $sw.Elapsed.TotalSeconds)

Write-Host ""
Write-Host "=== HTTP surface on http://127.0.0.1:$Port ==="
foreach ($path in '/', '/index.html', '/props', '/v1/models', '/slots') {
    try {
        $r = Invoke-WebRequest ("http://127.0.0.1:$Port" + $path) -TimeoutSec 30 -UseBasicParsing
        $len = $r.Content.Length
        $ctype = $r.Headers['Content-Type']
        $snip = ([string]$r.Content).Substring(0, [Math]::Min(90, $len)) -replace '\s+', ' '
        "{0,-14} {1,4} {2,-28} {3,8} bytes | {4}" -f $path, $r.StatusCode, $ctype, $len, $snip
    } catch {
        "{0,-14} FAILED: {1}" -f $path, $_.Exception.Message
    }
}

Write-Host ""
Write-Host "=== server-side sampling defaults (from /props) ==="
try {
    $p = Invoke-RestMethod "http://127.0.0.1:$Port/props" -TimeoutSec 30
    "model_path : {0}" -f $p.model_path
    "n_ctx      : {0}" -f $p.default_generation_settings.n_ctx
    "samplers   : {0}" -f ($p.default_generation_settings.samplers -join ', ')
    "modalities : {0}" -f (($p.modalities | ConvertTo-Json -Compress))
} catch { "props failed: $($_.Exception.Message)" }

Write-Host ""
Write-Host ("server left RUNNING on port {0} (pid {1}) -- open it in a browser" -f $Port, $proc.Id)
