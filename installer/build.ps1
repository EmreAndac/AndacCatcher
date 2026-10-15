
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

foreach ($file in @(
    'desktop\target\release\video_downloader.exe',
    'vendor\ffmpeg.exe',
    'vendor\ffprobe.exe',
    'extension\manifest.json'
)) {
    if (-not (Test-Path (Join-Path $root $file))) {
        throw "Eksik dosya: $file"
    }
}

# Inno Setup 7 ve 6 kurulum yollarini kontrol et
$possiblePaths = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 7\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
)

$iscc = $possiblePaths |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1

if (-not $iscc) {
    throw "Inno Setup bulunamadi."
}

Write-Host "Inno Setup bulundu: $iscc" -ForegroundColor Green
Write-Host "AndacCatcher kurulumu derleniyor..." -ForegroundColor Cyan

& $iscc (Join-Path $PSScriptRoot 'AndacCatcher.iss')

if ($LASTEXITCODE -ne 0) {
    throw "Installer derlemesi basarisiz."
}

Write-Host "AndacCatcher kurulum derlemesi tamamlandi!" -ForegroundColor Green
