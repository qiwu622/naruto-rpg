[CmdletBinding()]
param(
  [string]$JavaHome = $env:NARUTO_ANDROID_JAVA_HOME,
  [string]$SdkRoot = $env:ANDROID_SDK_ROOT,
  [string]$ToolsRoot = $env:NARUTO_ANDROID_TOOLS,
  [string]$OutputDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -le 5) {
  Import-Module ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -Force
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ToolsRoot) {
  $ToolsRoot = if (Test-Path -LiteralPath 'D:\Downloads\naruto-android-tools') {
    'D:\Downloads\naruto-android-tools'
  } else { Join-Path $env:PUBLIC 'NarutoRpg\android-tools' }
}
$ToolsRoot = [IO.Path]::GetFullPath($ToolsRoot)
if (-not $SdkRoot) { $SdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$SdkRoot = [IO.Path]::GetFullPath($SdkRoot)
if (-not (Test-Path -LiteralPath (Join-Path $SdkRoot 'platforms\android-35\android.jar'))) {
  throw 'Android SDK 35 is missing. Set ANDROID_SDK_ROOT or pass -SdkRoot.'
}

function Invoke-Checked {
  param([string]$Command, [string[]]$Arguments)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $Command" }
}

function Invoke-ProjectTask {
  param([string]$Task)
  if ($ProjectDir -match '^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)$') {
    $TaskDistro = $Matches[1]
    $TaskLinuxPath = $Matches[2].Replace('\', '/')
    Invoke-Checked 'wsl.exe' @('-d', $TaskDistro, '--cd', $TaskLinuxPath, 'npm', 'run', $Task)
  } else {
    Push-Location $ProjectDir
    try { Invoke-Checked 'npm.cmd' @('run', $Task) } finally { Pop-Location }
  }
}

function Copy-BuildSource {
  param([string]$Source, [string]$Destination)
  & (Join-Path $env:SystemRoot 'System32\robocopy.exe') $Source $Destination /E /XD build .gradle /XF local.properties /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) { throw "Source copy failed: $Source (exit $LASTEXITCODE)" }
}

function Get-ZipEntryHash {
  param($Entry)
  $Stream = $Entry.Open()
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $Hasher.Dispose(); $Stream.Dispose() }
}

$JavaCandidates = @()
if ($JavaHome) { $JavaCandidates += $JavaHome }
else {
  if ($env:JAVA_HOME) { $JavaCandidates += $env:JAVA_HOME }
  if (Test-Path -LiteralPath $ToolsRoot) {
    $JavaCandidates += @(Get-ChildItem -LiteralPath $ToolsRoot -Directory -Filter 'jdk-21*' | Sort-Object Name -Descending | ForEach-Object FullName)
  }
}
$JavaHome = ''
foreach ($Candidate in $JavaCandidates) {
  $JavaExe = Join-Path $Candidate 'bin\java.exe'
  if (-not (Test-Path -LiteralPath $JavaExe)) { continue }
  $JavaVersion = (& $JavaExe --version 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0 -and $JavaVersion -match '(?m)^(?:openjdk|java) 21\.') { $JavaHome = $Candidate; break }
}
if (-not $JavaHome) { throw 'Java 21 is required. Set NARUTO_ANDROID_JAVA_HOME or pass -JavaHome. See docs/android-app.md.' }
$Gradle = Join-Path $ToolsRoot 'gradle-8.11.1\bin\gradle.bat'
$BuildId = Get-Date -Format 'yyyyMMdd-HHmmss'
$BuildRoot = Join-Path $ToolsRoot 'build'
$WorkDir = [IO.Path]::GetFullPath((Join-Path $BuildRoot "$BuildId-$PID"))
if ($WorkDir -match '[^\x20-\x7e]') { throw 'Use an ASCII-only -ToolsRoot path for Android native build tools.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $ProjectDir "reports\android\$BuildId" }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$PreviousJavaHome = $env:JAVA_HOME
$PreviousGradleHome = $env:GRADLE_USER_HOME
$PreviousPath = $env:Path
$Succeeded = $false
try {
  Invoke-ProjectTask 'test:android-app'
  Invoke-ProjectTask 'android:sync'
  New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
  $AndroidDir = Join-Path $WorkDir 'android'
  Copy-BuildSource (Join-Path $ProjectDir 'android') $AndroidDir
  Copy-BuildSource (Join-Path $ProjectDir 'node_modules\@capacitor\android') (Join-Path $WorkDir 'node_modules\@capacitor\android')
  # java.util.Properties uses ISO-8859-1. Escape Unicode SDK paths explicitly.
  $SdkProperty = $SdkRoot.Replace('\', '/').Replace(':', '\:')
  $SdkProperty = [regex]::Replace($SdkProperty, '[^\x20-\x7e]', { param($Match) '\u{0:x4}' -f [int][char]$Match.Value })
  [IO.File]::WriteAllText((Join-Path $AndroidDir 'local.properties'), "sdk.dir=$SdkProperty`n", [Text.Encoding]::ASCII)
  $env:JAVA_HOME = $JavaHome
  $env:GRADLE_USER_HOME = Join-Path $ToolsRoot 'gradle-home'
  $env:Path = (Join-Path $JavaHome 'bin') + ';' + $PreviousPath
  if (-not (Test-Path -LiteralPath $Gradle)) { $Gradle = Join-Path $AndroidDir 'gradlew.bat' }
  Invoke-Checked $Gradle @('-p', $AndroidDir, '--no-daemon', '--console=plain', '--max-workers=2', ':app:assembleDebug', ':app:testDebugUnitTest', ':app:assembleDebugAndroidTest')
  $Apk = Join-Path $AndroidDir 'app\build\outputs\apk\debug\app-debug.apk'
  if (-not (Test-Path -LiteralPath $Apk)) { throw 'Gradle did not produce the expected APK.' }

  $Zip = [IO.Compression.ZipFile]::OpenRead($Apk)
  $SharedFiles = @()
  try {
    $Forbidden = @($Zip.Entries | Where-Object { $_.FullName -match '(^|/)(\.env(?:\..*)?|server|node_modules|\.git|deploy\.local[^/]*)(/|$)|\.(?:db|jks|keystore)$' })
    if ($Forbidden.Count) { throw "Private/server files found in APK: $($Forbidden.FullName -join ', ')" }
    $CanonicalFiles = @('index.html', 'manifest.json', 'sw.js', 'announcements.html')
    foreach ($Directory in @('js', 'css', 'img', 'assets', 'app')) {
      $CanonicalFiles += @(Get-ChildItem -LiteralPath (Join-Path $ProjectDir $Directory) -Recurse -File | ForEach-Object {
        $_.FullName.Substring($ProjectDir.Length + 1).Replace('\', '/')
      })
    }
    foreach ($Relative in $CanonicalFiles) {
      $Entry = $Zip.GetEntry("assets/public/$Relative")
      if ($null -eq $Entry) { throw "Shared project file is missing from APK: $Relative" }
      $SourceHash = (Get-FileHash -LiteralPath (Join-Path $ProjectDir $Relative) -Algorithm SHA256).Hash.ToLowerInvariant()
      if ((Get-ZipEntryHash $Entry) -ne $SourceHash) { throw "Stale or different shared code in APK: $Relative" }
      $SharedFiles += @{ path = $Relative; sha256 = $SourceHash }
    }
    $PackagedConfigStream = $Zip.GetEntry('assets/capacitor.config.json').Open()
    $ConfigReader = New-Object IO.StreamReader($PackagedConfigStream)
    try { $PackagedConfig = $ConfigReader.ReadToEnd() | ConvertFrom-Json }
    finally { $ConfigReader.Dispose() }
    if ($PackagedConfig.appId -ne 'asia.qiwu.narutorpg' -or $PackagedConfig.server.PSObject.Properties['url']) {
      throw 'APK must use the local shared project assets, with no remote server.url.'
    }
  } finally { $Zip.Dispose() }

  $BuildTools = Get-ChildItem -LiteralPath (Join-Path $SdkRoot 'build-tools') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'apksigner.bat') } | Sort-Object Name -Descending | Select-Object -First 1
  if ($null -eq $BuildTools) { throw 'Android apksigner is missing.' }
  $SignatureOutput = & (Join-Path $BuildTools.FullName 'apksigner.bat') verify --verbose $Apk
  if ($LASTEXITCODE -ne 0) { throw 'APK signature validation failed.' }
  $ManifestOutput = & (Join-Path $BuildTools.FullName 'aapt.exe') dump badging $Apk
  if ($LASTEXITCODE -ne 0 -or -not ($ManifestOutput -match "package: name='asia.qiwu.narutorpg'")) { throw 'APK manifest validation failed.' }

  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  [IO.File]::WriteAllLines((Join-Path $OutputDirectory 'signature.txt'), [string[]]$SignatureOutput)
  [IO.File]::WriteAllLines((Join-Path $OutputDirectory 'manifest.txt'), [string[]]$ManifestOutput)
  $PackageBadging = $ManifestOutput | Where-Object { $_ -match '^package: ' } | Select-Object -First 1
  if (-not ($PackageBadging -match "\bversionCode='(\d+)'\s+versionName='([^']+)'")) { throw 'APK version metadata is missing.' }
  $AppVersionCode = [int]$Matches[1]
  $AppVersion = $Matches[2]
  $FinalApk = Join-Path $OutputDirectory "naruto-rpg-$AppVersion-debug.apk"
  Copy-Item -LiteralPath $Apk -Destination $FinalApk
  Copy-Item -LiteralPath (Join-Path $AndroidDir 'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk') -Destination (Join-Path $OutputDirectory 'native-tests.apk')
  Copy-BuildSource (Join-Path $AndroidDir 'app\build\test-results\testDebugUnitTest') (Join-Path $OutputDirectory 'native-unit-tests')
  $Receipt = @{
    builtAt = (Get-Date).ToString('o'); version = $AppVersion; versionCode = $AppVersionCode; variant = 'debug'; apk = $FinalApk
    sha256 = (Get-FileHash -LiteralPath $FinalApk -Algorithm SHA256).Hash.ToLowerInvariant()
    sharedFileCount = $SharedFiles.Count; sharedFiles = $SharedFiles; privateFilesExcluded = $true
    signatureVerified = $true; nativeUnitTestsPassed = $true; deviceTestsRun = $false
  }
  $ReceiptJson = $Receipt | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText((Join-Path $OutputDirectory 'verification.json'), $ReceiptJson, (New-Object Text.UTF8Encoding($false)))
  Write-Output "APK=$FinalApk"
  Write-Output "SHARED_FILES_VERIFIED=$($SharedFiles.Count)"
  Write-Output "SHA256=$($Receipt.sha256)"
  Write-Output 'BUILD_OK=true; DEVICE_TESTS_RUN=false'
  $Succeeded = $true
} finally {
  $env:JAVA_HOME = $PreviousJavaHome
  $env:GRADLE_USER_HOME = $PreviousGradleHome
  $env:Path = $PreviousPath
  if ($Succeeded) {
    $VerifiedRoot = [IO.Path]::GetFullPath($BuildRoot).TrimEnd('\') + '\'
    if (-not $WorkDir.StartsWith($VerifiedRoot, [StringComparison]::OrdinalIgnoreCase) -or $WorkDir -eq $VerifiedRoot.TrimEnd('\')) {
      throw 'Refusing to delete a workspace outside the owned Android build root.'
    }
    Remove-Item -LiteralPath $WorkDir -Recurse -Force
  } elseif (Test-Path -LiteralPath $WorkDir) { Write-Warning "Build diagnostics preserved at $WorkDir" }
}
