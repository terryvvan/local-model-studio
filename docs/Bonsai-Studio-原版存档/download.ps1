# Download Ternary Bonsai 2 27B (GGUF) + OrcaBonsai LoRA adapter + PrismML llama.cpp CUDA build
# ASCII only on purpose (PowerShell 5.1 mangles non-ASCII without BOM)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = 'F:\v\project\dsh-test\bonsai'
$models = Join-Path $root 'models'
$llama = Join-Path $root 'llamacpp'
$lora = Join-Path $root 'lora'

$jobs = @(
    @{ n = 'PTQ1_0 model (5.3 GiB)'
       u = 'https://hf-mirror.com/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-PTQ1_0.gguf'
       o = (Join-Path $models 'Ternary-Bonsai-2-27B-PTQ1_0.gguf') },
    @{ n = 'mmproj Q8_0 (vision, 572 MiB)'
       u = 'https://hf-mirror.com/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'
       o = (Join-Path $models 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf') },
    @{ n = 'OrcaBonsai LoRA adapter (9 MiB)'
       u = 'https://raw.githubusercontent.com/Continuum-AI-Corp/OrcaBonsai-27B-Uncensored/main/gguf/bonsai-abliterate-lora.gguf'
       o = (Join-Path $lora 'bonsai-abliterate-lora.gguf') },
    # CUDA 13.3 Windows builds are known to print the banner and exit silently
    # (PrismML KNOWN_ISSUES, issue #222). Use the CUDA 12.4 Windows build instead.
    @{ n = 'llama.cpp PrismML win-cuda-12.4-x64'
       u = 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10743-adfffbe/llama-prism-b10743-adfffbe-bin-win-cuda-12.4-x64.zip'
       o = (Join-Path $llama 'llama-prism-win-cuda-12.4-x64.zip') },
    @{ n = 'cudart win-cuda-12.4-x64'
       u = 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10743-adfffbe/cudart-llama-bin-win-cuda-12.4-x64.zip'
       o = (Join-Path $llama 'cudart-llama-bin-win-cuda-12.4-x64.zip') }
)

foreach ($j in $jobs) {
    Write-Output ('==> ' + $j.n)
    Write-Output ('    ' + $j.o)
    # -C - resumes a partial file instead of restarting a multi-GB transfer
    # --ssl-no-revoke: Windows schannel cannot reach the CRL/OCSP servers here and
    # aborts with CRYPT_E_NO_REVOCATION_CHECK (0x80092012).
    & curl.exe -L --fail --retry 5 --retry-delay 3 --retry-all-errors --ssl-no-revoke -C - `
        -A 'Mozilla/5.0' --connect-timeout 20 --speed-time 60 --speed-limit 1024 `
        -o $j.o $j.u
    if ($LASTEXITCODE -ne 0) { Write-Output ('!!! curl exit ' + $LASTEXITCODE + ' for ' + $j.n) }
    else {
        $len = (Get-Item $j.o).Length
        Write-Output ('    done, bytes = ' + $len)
    }
}
Write-Output 'ALL DOWNLOADS FINISHED'
