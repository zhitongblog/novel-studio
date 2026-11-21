# Download MiniMax H3 (official ComfyUI i2v route) from ModelScope (China mirror).
# Resumable (curl -C -) and verified against ModelScope SHA256. Never deletes existing files
# except a download that fails checksum (renamed to *.bad for manual review).
param(
  [string]$Dest = 'D:/AI/models/minimax-h3',
  [string]$Repo = 'Comfy-Org/MiniMax-H3',
  [switch]$IncludeRef2V
)
$ErrorActionPreference = 'Stop'

$files = @(
  'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  'vae/minimax_h3_video_vae_int8_convrot.safetensors',
  'vae/minimax_h3_audio_vae_fp32.safetensors',
  'loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors'
)
if ($IncludeRef2V) {
  $files += 'diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors'
  $files += 'loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'
}

$meta = (Invoke-RestMethod "https://modelscope.cn/api/v1/models/$Repo/repo/files?Recursive=true" -TimeoutSec 60).Data.Files
$log = Join-Path $Dest 'download.log'
New-Item -ItemType Directory -Force $Dest | Out-Null
function Log($m) { $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Write-Host $line; Add-Content $log $line }

foreach ($f in $files) {
  $info = $meta | Where-Object { $_.Path -eq $f }
  if (-not $info) { throw "Not found on ModelScope: $f" }
  $out = Join-Path $Dest $f
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  if ((Test-Path $out) -and (Get-Item $out).Length -eq $info.Size -and (Test-Path "$out.sha256ok")) { Log "skip (verified) $f"; continue }

  $url = "https://modelscope.cn/models/$Repo/resolve/master/$f"
  for ($i = 1; $i -le 20; $i++) {
    Log "download $f attempt $i ($([math]::Round($info.Size/1GB,2))GB)"
    & curl.exe -L --fail -C - --retry 5 --retry-delay 10 --speed-limit 102400 --speed-time 120 -o $out $url
    if ((Test-Path $out) -and (Get-Item $out).Length -eq $info.Size) { break }
    Start-Sleep 10
  }
  if ((Get-Item $out).Length -ne $info.Size) { throw "Size mismatch after retries: $f" }

  Log "sha256 $f"
  $sha = (& certutil -hashfile $out SHA256 | Select-Object -Index 1).Trim().Replace(' ', '').ToLower()
  if ($info.Sha256 -and $sha -ne $info.Sha256.ToLower()) {
    Rename-Item $out "$out.bad"; throw "SHA256 mismatch: $f expected $($info.Sha256) got $sha"
  }
  Set-Content "$out.sha256ok" $sha
  Log "ok $f"
}
Log 'all files verified'
