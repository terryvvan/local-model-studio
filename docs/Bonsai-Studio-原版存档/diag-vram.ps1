# Diagnostic: run ONE arm of the suite while sampling VRAM + host RAM against wall-clock,
# then correlate the sample series with llama-server's own per-task timings.
# Hypothesis under test: with the extra ~1 GB the LoRA costs, the 8 GB card goes over
# budget and WDDM pages weights into system memory, so every token is slower until the
# working set is resident again.
# ASCII only on purpose (PowerShell 5.1 mangles non-ASCII without BOM).
param(
    [string]$Model = 'F:\v\project\dsh-test\bonsai\models\Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    [string]$Lora = 'F:\v\project\dsh-test\bonsai\lora\bonsai-abliterate-lora.gguf',
    [string]$Bin = 'F:\v\project\dsh-test\bonsai\llamacpp\bin',
    [string]$Prompts = 'F:\v\project\dsh-test\bonsai\prompts.json',
    [string]$OutDir = 'F:\v\project\dsh-test\bonsai\results',
    [string]$Tag = 'diag-abl1',
    [string]$Mode = 'abl1',            # orig | abl1 | abl2
    [int]$Ctx = 16384,
    [int]$Port = 8085,
    [int]$SampleMs = 2000,
    [string]$Ctk = '',                 # KV cache type for K, e.g. q8_0 (empty = build default f16)
    [string]$Ctv = '',                 # KV cache type for V
    [double]$LoraScale = 1.0,          # applied at runtime via POST /lora-adapters
    [double]$AltScale = 0              # if >0, a second full sweep runs at this scale on
                                       # the SAME server (removes cross-run VRAM noise)
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$cfg = Get-Content $Prompts -Raw -Encoding UTF8 | ConvertFrom-Json
$sys = $cfg.system
$mt = if ($cfg.max_tokens) { [int]$cfg.max_tokens } else { 1024 }

# NOTE: --lora-scaled <path>:<scale> CANNOT carry a Windows path: the build splits
# FNAME:SCALE on the last colon and the drive letter "F:" is what it finds, so it
# aborts with 'lora-scaled format: FNAME:SCALE'. Load with --lora-init-without-apply
# and set the scale at runtime instead.
$extra = switch ($Mode) {
    'orig' { @() }
    'abl1' { @('--lora', $Lora) }
    'abl2' { @('--lora-init-without-apply', '--lora', $Lora) }
    default { throw "unknown mode $Mode" }
}

$err = Join-Path $OutDir "server-$Tag.err.log"
$out = Join-Path $OutDir "server-$Tag.log"
$argv = @('-m', $Model, '--no-mmap', '-ngl', '99', '-fa', 'on', '-c', "$Ctx",
          '-np', '1', '--cache-ram', '4096', '--temp', '0', '--top-k', '1',
          '--min-p', '0', '--repeat-penalty', '1.0', '--reasoning-effort', 'medium',
          '--host', '127.0.0.1', '--port', "$Port")
if ($Ctk) { $argv += @('-ctk', $Ctk) }
if ($Ctv) { $argv += @('-ctv', $Ctv) }
$argv += $extra

$proc = Start-Process -FilePath (Join-Path $Bin 'llama-server.exe') -ArgumentList $argv `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden

$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 900) {
    if ($proc.HasExited) { throw "server exited early; see $err" }
    try { if ((Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5).status -eq 'ok') { break } } catch { Start-Sleep -Seconds 3 }
}
Write-Host ("mode {0}: server up in {1:N0}s (pid {2})" -f $Mode, $sw.Elapsed.TotalSeconds, $proc.Id)

function Set-LoraScale {
    # MUST stay above the adapter-detection block that calls it: PowerShell resolves
    # a function at the point of CALL, not at parse time.
    param([double]$Scale)
    # Hand-built body on purpose: ConvertTo-Json collapses a 1-element array into a
    # bare object, and the endpoint answers 400 "Request body must be an array".
    $b = '[{"id":' + $aid + ',"scale":' + $Scale.ToString([Globalization.CultureInfo]::InvariantCulture) + '}]'
    $r = Invoke-RestMethod "http://127.0.0.1:$Port/lora-adapters" -Method Post `
        -ContentType 'application/json' -Body $b -TimeoutSec 30
    if (-not $r.success) { throw "failed to set LoRA scale $Scale" }
    Write-Host ("lora scale -> {0}" -f $Scale)
}

# Runtime adapter scaling: the only way to drive a non-1.0 scale with a Windows path.
# NOTE: with exactly one adapter this build answers with a BARE OBJECT
# ({"id":0,"scale":1.0,...}) instead of the documented {"value":[...]} wrapper,
# so never index .value blindly.
if ($Mode -ne 'orig') {
    $cur = $null
    for ($i = 0; $i -lt 20 -and -not $cur; $i++) {
        $resp = Invoke-RestMethod "http://127.0.0.1:$Port/lora-adapters" -TimeoutSec 30
        $first = if ($resp -is [array]) { $resp[0] } else { $resp }
        # Single adapter: bare object in some responses, {"value":[obj]} in others.
        if ($first -and ($first.PSObject.Properties.Name -contains 'id')) { $cur = $first }
        elseif ($first -and ($first.PSObject.Properties.Name -contains 'value')) { $cur = @($first.value)[0] }
        if (-not $cur) { Start-Sleep -Seconds 3 }
    }
    if (-not $cur) { throw "no adapter loaded despite mode=$Mode" }
    $aid = if ($null -ne $cur.id) { [int]$cur.id } else { 0 }
    Write-Host ("adapter id {0}: {1} (start scale {2})" -f $aid, $cur.path, $cur.scale)
    Set-LoraScale -Scale $LoraScale
}

# --- VRAM sampler: runs on its own runspace-free job via a script block thread ---
$script:samples = [System.Collections.Generic.List[object]]::new()
$sampler = Start-Job -ArgumentList $proc.Id, $SampleMs -ScriptBlock {
    param($targetPid, $every)
    $t0 = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
        if (-not $p) { break }
        $g = (& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''
        $ws = [math]::Round($p.WorkingSet64 / 1MB, 0)
        [pscustomobject]@{ t = [math]::Round($t0.Elapsed.TotalSeconds, 1); vram = [int]$g; wsMB = [int]$ws }
        Start-Sleep -Milliseconds $every
    }
}

function Ask {
    param([string]$Text)
    $body = @{ messages = @(@{ role = 'system'; content = $sys }, @{ role = 'user'; content = $Text })
               max_tokens = $mt; reasoning_effort = 'medium'; cache_prompt = $false } | ConvertTo-Json -Depth 6 -Compress
    $r = Invoke-RestMethod "http://127.0.0.1:$Port/v1/chat/completions" -Method Post `
        -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 3600
    return $r
}

function Invoke-Sweep {
    param([double]$Scale)
    if ($Mode -ne 'orig') { Set-LoraScale -Scale $Scale }
    Write-Host ""
    Write-Host ("--- sweep at lora scale {0} ---" -f $Scale)
    $out = @()
    foreach ($p in $cfg.prompts) {
        $stop = [Diagnostics.Stopwatch]::StartNew()
        $r = Ask -Text $p.text
        $stop.Stop()
        $vnow = [int](((& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) -join ''))
        # Keep the first 600 chars of the answer so the refusal verdict can be
        # re-checked by hand afterwards (the classifier only looks at the opening).
        $txt = [string]$r.choices[0].message.content
        if ($txt.Length -gt 600) { $txt = $txt.Substring(0, 600) }
        $row = [pscustomobject]@{
            id        = $p.id
            kind      = $p.kind
            scale     = $Scale
            tps       = [math]::Round($r.timings.predicted_per_second, 2)
            gen_tok   = $r.usage.completion_tokens
            wall_s    = [math]::Round($stop.Elapsed.TotalSeconds, 1)
            vram_used = $vnow
            finish    = [string]$r.choices[0].finish_reason
            reasoning_chars = ([string]$r.choices[0].message.reasoning_content).Length
            head      = $txt
        }
        $out += $row
        Write-Host ("{0,-14} {1,6:N1} t/s  {2,5} tok  {3,6:N1}s  vram {4} MiB" -f $row.id, $row.tps, $row.gen_tok, $row.wall_s, $row.vram_used)
    }
    return ,$out
}

$sets = @()
$rows = $null
try {
    $rows = Invoke-Sweep -Scale $LoraScale
    $sets += [pscustomobject]@{ scale = $LoraScale; tag = $Tag; rows = $rows }
    if ($AltScale -gt 0) {
        $rowsAlt = Invoke-Sweep -Scale $AltScale
        $sets += [pscustomobject]@{ scale = $AltScale; tag = ($Tag + '-alt'); rows = $rowsAlt }
    }
} finally {
    Stop-Job $sampler -ErrorAction SilentlyContinue
    $script:samples = Receive-Job $sampler -ErrorAction SilentlyContinue
    Remove-Job $sampler -Force -ErrorAction SilentlyContinue
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}

foreach ($s in $sets) {
    $res = [pscustomobject]@{ mode = $Mode; loraScale = $s.scale; prompts = $s.rows; vramSamples = $script:samples }
    $res | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $OutDir "diag-$($s.tag).json") -Encoding UTF8
}

Write-Host ""
"=== VRAM over time (MiB) ==="
$v = $script:samples | Select-Object -ExpandProperty vram
if ($v.Count) {
    "min {0} / max {1} / first {2} / last {3}" -f ($v | Measure-Object -Minimum).Minimum, ($v | Measure-Object -Maximum).Maximum, $v[0], $v[-1]
    $script:samples | ForEach-Object { "{0,7:N1}s  vram {1,5} MiB  ws {2,6} MB" -f $_.t, $_.vram, $_.wsMB }
}
foreach ($s in $sets) {
    Write-Host ""
    "=== per-prompt speed (scale $($s.scale)) ==="
    $s.rows | Format-Table id, kind, tps, gen_tok, wall_s, vram_used -AutoSize | Out-String -Width 200 | Write-Host
    $firstHalf = $s.rows | Select-Object -First ([int]($s.rows.Count / 2))
    $secondHalf = $s.rows | Select-Object -Skip ([int]($s.rows.Count / 2))
    "scale {0}: first half {1:N2} t/s | second half {2:N2} t/s | all {3:N2} t/s" -f `
        $s.scale, ($firstHalf | Measure-Object tps -Average).Average, `
        ($secondHalf | Measure-Object tps -Average).Average, ($s.rows | Measure-Object tps -Average).Average
}
