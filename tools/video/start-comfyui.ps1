# Start the local ComfyUI render engine (loopback only).
# --disable-pinned-memory: on 32GB RAM + small pagefile, pinned host buffers (~13GB) plus the
# H3 DiT/TE staging exceeded the Windows commit limit (MemoryError / HostBuffer.read_file_slice
# failed on the 3rd consecutive render). Disk-backed dynamic loading (--fast-disk) is kept.
param(
  [string]$ComfyRoot = 'C:/AI/StoryAlter/ComfyUI',
  [int]$Port = 8188,
  [string[]]$Extra = @()
)
$py = Join-Path $ComfyRoot '.venv/Scripts/python.exe'
& $py (Join-Path $ComfyRoot 'main.py') --listen 127.0.0.1 --port $Port --disable-auto-launch `
  --fast-disk --disable-pinned-memory @Extra
