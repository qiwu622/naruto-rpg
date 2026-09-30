[CmdletBinding()]
param([string]$Source = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$ProjectDir = Split-Path -Parent $PSScriptRoot
if (-not $Source) { $Source = Join-Path $ProjectDir 'artwork\app-identity\naruto-mark-20260930.png' }
$Master = [Drawing.Bitmap]::FromFile($Source)

# Derive Android density resources from the original artwork without redrawing it.
function Write-Icon {
  param([string]$Path, [int]$Width, [int]$Height, [double]$Scale, [switch]$Transparent, [switch]$Round)
  $Canvas = New-Object Drawing.Bitmap($Width, $Height)
  $Graphics = [Drawing.Graphics]::FromImage($Canvas)
  $Clip = New-Object Drawing.Drawing2D.GraphicsPath
  $Brush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(16, 18, 26))
  try {
    $Graphics.Clear([Drawing.Color]::Transparent)
    $Graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $Graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $Graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    if ($Round) {
      $Clip.AddEllipse(0, 0, $Width, $Height)
      $Graphics.SetClip($Clip)
      $Graphics.FillEllipse($Brush, 0, 0, $Width, $Height)
    } elseif (-not $Transparent) { $Graphics.Clear($Brush.Color) }
    $Side = [Math]::Min($Width, $Height) * $Scale
    $Graphics.DrawImage($Master, [single](($Width - $Side) / 2), [single](($Height - $Side) / 2), [single]$Side, [single]$Side)
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $Canvas.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
  } finally { $Brush.Dispose(); $Clip.Dispose(); $Graphics.Dispose(); $Canvas.Dispose() }
}

try {
  Write-Icon (Join-Path $ProjectDir 'img\app-mark.png') 512 512 1.0 -Transparent
  $Res = Join-Path $ProjectDir 'android\app\src\main\res'
  foreach ($Density in @(
    @{Name='mdpi';Icon=48;Foreground=108}, @{Name='hdpi';Icon=72;Foreground=162},
    @{Name='xhdpi';Icon=96;Foreground=216}, @{Name='xxhdpi';Icon=144;Foreground=324},
    @{Name='xxxhdpi';Icon=192;Foreground=432}
  )) {
    $Folder = Join-Path $Res ('mipmap-' + $Density.Name)
    Write-Icon (Join-Path $Folder 'ic_launcher.png') $Density.Icon $Density.Icon 0.90
    Write-Icon (Join-Path $Folder 'ic_launcher_round.png') $Density.Icon $Density.Icon 0.82 -Round
    # Foreground has transparent padding inside the adaptive icon safe area.
    Write-Icon (Join-Path $Folder 'ic_launcher_foreground.png') $Density.Foreground $Density.Foreground 0.74 -Transparent
  }
  foreach ($Splash in Get-ChildItem -LiteralPath $Res -Recurse -File -Filter 'splash.png') {
    $Previous = [Drawing.Image]::FromFile($Splash.FullName)
    $Width = $Previous.Width; $Height = $Previous.Height
    $Previous.Dispose()
    Write-Icon $Splash.FullName $Width $Height 0.32
  }
  Write-Output 'ANDROID_ICONS_GENERATED=true'
} finally { $Master.Dispose() }
