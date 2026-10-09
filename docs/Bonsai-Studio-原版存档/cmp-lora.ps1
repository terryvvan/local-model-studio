# Definitive A/B: does attaching the OrcaBonsai LoRA really cost ~30% of decode speed,
# or was the earlier 16.7 t/s an artifact of cross-run GPU contention?
#
# Design choice that makes this trustworthy: the server is started WITHOUT any adapter,
# the whole suite is swept, and only THEN is the adapter attached through the
# `-lora-init-without-apply` + POST /lora-adapters route -- so both legs run inside one
# server process, minutes apart, with no reload and no second CUDA context. Weights stay
# byte-identical (scale 0 contributions are the same weights multiplied by zero), so the
# only thing that changes between legs is whether the LoRA matmuls are added to the graph.
#
# ASCII only (PowerShell 5.1 mangles non-ASCII source without BOM).
param(
    [string]$Model = 'F:\v\project\dsh-test\bonsai\models\Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    [string]$Lora = 'F:\v\project\dsh-test\bonsai\lora\bonsai-abliterate-lora.gguf',
    [string]$Bin = 'F:\v\project\dsh-test\bonsai\llamacpp\bin',
    [string]$Prompts = 'F:\v\project\dsh-test\bonsai\prompts.json',
    [string]$OutDir = 'F:\v\project\dsh-test\bonsai\results',
    [string]$Tag = 'cmp-lora',
    [int]$Ctx = 16384,
    [int]$Port = 8086,
    [int]$SampleMs = 2000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$cfg = Get-Content $Prompts -Raw -Encoding UTF8 | ConvertFrom-Json
$sys = $cfg.system
$mt = if ($cfg.max_tokens) { [int]$cfg.max_tokens } else { 1024 }

# --- the LoRA must NOT be in the launch line; it is attached later at runtime ---
$argv = @('-m', $Model, '--no-mmap', '-ngl', '99', '-fa', 'on', '-c', "$Ctx",
          '-np', '1', '--cache-ram', '4096', '--temp', '0', '--top-k', '1',
          '--min-p', '0', '--repeat-penalty', '1.0', '--reasoning-effort', 'medium',
          '--lora-init-without-apply', '--lora', $Lora,
          '--host', '127.0.0.1', '--port', "$Port")

$err = Join-Path $OutDir "server-$Tag.err.log"
$out = Join-Path $OutDir "server-$Tag.log"
$proc = Start-Process -FilePath (Join-Path $Bin 'llama-server.exe') -ArgumentList $argv `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden

$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 900) {
    if ($proc.HasExited) { throw "server exited early; see $err" }
    try { if ((Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5).status -eq 'ok') { break } } catch { Start-Sleep -Seconds 3 }
}
Write-Host ("server up in {0:N0}s (pid {1})" -f $sw.Elapsed.TotalSeconds, $proc.Id)

# --- find the adapter id; the response shape is NOT stable (bare object vs {"value":[]}) ---
$aid = $null
for ($i = 0; $i -lt 20 -and ($null -eq $aid); $i++) {
    $resp = Invoke-RestMethod "http://127.0.0.1:$Port/lora-adapters" -TimeoutSec 30
    $first = if ($resp -is [array]) { $resp[0] } else { $resp }
    if ($first -and ($first.PSObject.Properties.Name -contains 'id')) { $aid = [int]$first.id }
    elseif ($first -and ($first.PSObject.Properties.Name -contains 'value')) { $aid = [int]@($first.value)[0].id }
    if ($null -eq $aid) { Start-Sleep -Seconds 3 }
}
if ($null -eq $aid) { throw "no adapter loaded despite --lora" }
Write-Host ("adapter id {0}" -f $aid)

function Set-LoraScale {
    param([double]$Scale)
    # Hand-built body: ConvertTo-Json collapses a 1-element array into a bare object
    # and the endpoint answers 400 "Request body must be an array".
    $b = '[{"id":' + $aid + ',"scale":' + $Scale.ToString([Globalization.CultureInfo]::InvariantCulture) + '}]'
    $r = Invoke-RestMethod "http://127.0.0.1:$Port/lora-adapters" -Method Post `
        -ContentType 'application/json' -Body $b -TimeoutSec 30
    if (-not $r.success) { throw "failed to set LoRA scale $Scale" }
    Write-Host ("lora scale -> {0}" -f $Scale)
}

function Ask {
    param([string]$Text)
    $body = @{ messages = @(@{ role = 'system'; content = $sys }, @{ role = 'user'; content = $Text })
               max_tokens = $mt; reasoning_effort = 'medium'; cache_prompt = $false } | ConvertTo-Json -Depth 6 -Compress
    Invoke-RestMethod "http://127.0.0.1:$Port/v1/chat/completions" -Method Post `
        -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 3600
}

function Invoke-Sweep {
    param([string]$Label)
    $rows = @()
    Write-Host ""
    Write-Host ("--- sweep: {0} ---" -f $Label)
    foreach ($p in $cfg.prompts) {
        $stop = [Diagnostics.Stopwatch]::StartNew()
        $r = Ask -Text $p.text
        $stop.Stop()
        $vnow = [int](((& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''))
        $row = [pscustomobject]@{
            id     = $p.id
            kind   = $p.kind
            label  = $Label
            tps    = [math]::Round($r.timings.predicted_per_second, 2)
            gen_tok = $r.usage.completion_tokens
            wall_s = [math]::Round($stop.Elapsed.TotalSeconds, 1)
            vram_used = $vnow
        }
        $rows += $row
        Write-Host ("{0,-14} {1,6:N1} t/s  {2,5} tok  {3,6:N1}s  vram {4} MiB" -f $row.id, $row.tps, $row.gen_tok, $row.wall_s, $row.vram_used)
    }
    return ,$rows
}

$legs = @()
try {
    # Leg 1: adapter present but dormant (scale 0 -> no matmul contribution).
    Set-LoraScale -Scale 0
    $legs += [pscustomobject]@{ label = 'lora-off'; rows = (Invoke-Sweep -Label 'lora-off') }

    # Leg 2: same process, LoRA now applied at scale 1.
    Set-LoraScale -Scale 1
    $legs += [pscustomobject]@{ label = 'lora-on'; rows = (Invoke-Sweep -Label 'lora-on') }
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}

$res = [pscustomobject]@{ tag = $Tag; ctx = $Ctx; legs = $legs }
$res | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $OutDir "cmp-$Tag.json") -Encoding UTF8

Write-Host ""
Write-Host "=== decode speed by leg ==="
foreach ($l in $legs) {
    $haz = $l.rows | Where-Object { $_.kind -eq 'hazard' }
    $all = $l.rows
    "leg {0,-9} all {1,5:N2} t/s | hazard {2,5:N2} t/s | gen_tok {3}..{4} | vram {5}..{6} MiB" -f `
        $l.label,
        ($all | Measure-Object tps -Average).Average,
        ($haz | Measure-Object tps -Average).Average,
        ($all | Measure-Object gen_tok -Minimum).Minimum,
        ($all | Measure-Object gen_tok -Maximum).Maximum,
        ($all | Measure-Object vram_used -Minimum).Minimum,
        ($all | Measure-Object vram_used -Maximum).Maximum
}
$off = $legs[0].rows; $on = $legs[1].rows
$offAvg = ($off | Measure-Object tps -Average).Average
$onAvg = ($on | Measure-Object tps -Average).Average
Write-Host ""
"delta: {0:N2} -> {1:N2} t/s = {2:N1}%" -f $offAvg, $onAvg, (100 * ($onAvg - $offAvg) / $offAvg)
