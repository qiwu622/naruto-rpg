[CmdletBinding()]
param(
  [ValidateSet('staging', 'production')]
  [string]$Mode = 'staging',
  [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
  [string]$ReleaseVersion = '',
  [switch]$ConfirmProduction,
  [switch]$DryRun,
  [switch]$SkipBuild,
  [switch]$KeepPackage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# CMD, Node and desktop launchers can inherit PowerShell 7 module paths. The
# Windows PowerShell 5.1 entry must use its own Utility functions, including
# Import-PowerShellDataFile and Get-FileHash, rather than a bundled PS7 module.
if ($PSVersionTable.PSVersion.Major -le 5) {
  Import-Module ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -Force
}

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageJsonPath = Join-Path $ProjectDir 'package.json'
$PackageMetadata = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
$PackageVersion = [string]$PackageMetadata.version
if ([string]::IsNullOrWhiteSpace($ReleaseVersion)) {
  $ReleaseVersion = $PackageVersion
} elseif ($ReleaseVersion -ne $PackageVersion) {
  throw "发布版本与 package.json 不一致：参数=$ReleaseVersion, package.json=$PackageVersion"
}
$Version = Get-Date -Format 'yyMMddHHmm'
$DeploymentId = "v$ReleaseVersion-$Version-$PID"
$TempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$WorkDir = Join-Path $TempBase "naruto-rpg-deploy-$Mode-$DeploymentId"
$PayloadDir = Join-Path $WorkDir 'payload'
$StaticDir = Join-Path $PayloadDir 'static'
$ArchiveExtension = if ($DryRun) { '.tar' } else { '.tar.gz' }
$ArchivePath = Join-Path $TempBase "naruto-rpg-$Mode-$DeploymentId$ArchiveExtension"
$LocalConfigPath = Join-Path $ProjectDir 'deploy.local.psd1'
$LocalConfig = if (Test-Path -LiteralPath $LocalConfigPath) {
  Import-PowerShellDataFile -LiteralPath $LocalConfigPath
} else { @{} }
$Server = if (-not [string]::IsNullOrWhiteSpace($env:NARUTO_DEPLOY_SERVER)) {
  $env:NARUTO_DEPLOY_SERVER
} elseif ($LocalConfig.ContainsKey('Server')) {
  [string]$LocalConfig.Server
} else { '' }
$SshKey = if (-not [string]::IsNullOrWhiteSpace($env:NARUTO_DEPLOY_SSH_KEY)) {
  $env:NARUTO_DEPLOY_SSH_KEY
} elseif ($LocalConfig.ContainsKey('SshKey')) {
  [string]$LocalConfig.SshKey
} else {
  Join-Path $HOME '.ssh\id_ed25519'
}
if ($SshKey.StartsWith('~\') -or $SshKey.StartsWith('~/')) {
  $SshKey = Join-Path $HOME $SshKey.Substring(2)
}
$Utf8NoBom = New-Object Text.UTF8Encoding($false)

$Targets = @{
  staging = @{
    TargetDir = '/var/www/naruto-rpg-staging'
    PublicUrl = 'https://www.qiwu.asia:8080/'
    VerifyUrl = 'https://www.qiwu.asia:8080/login.html'
    VerifyResolve = 'www.qiwu.asia:8080:127.0.0.1'
    # 生产与测试站共享同一个后端（/opt/naruto-rpg + naruto-rpg.service，:3000）。
    # 必须重启后端，否则测试站后端永远停留在旧代码（API 白名单等改动不生效）。
    RestartBackend = $true
  }
  production = @{
    TargetDir = '/var/www/naruto-rpg'
    PublicUrl = 'https://www.qiwu.asia/'
    VerifyUrl = 'https://www.qiwu.asia/login.html'
    VerifyResolve = 'www.qiwu.asia:443:127.0.0.1'
    RestartBackend = $true
  }
}
$Target = $Targets[$Mode]

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit $LASTEXITCODE)"
  }
}

function Invoke-NativeWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage,
    [int]$Attempts = 3,
    [int]$InitialDelaySeconds = 4,
    [int]$MaxDelaySeconds = 30,
    [string[]]$FinalAttemptPrefixArguments = @()
  )

  if ($Attempts -lt 1) { throw '重试次数必须至少为 1' }
  if ($InitialDelaySeconds -lt 1) { throw '初始重试间隔必须至少为 1 秒' }
  if ($MaxDelaySeconds -lt 1) { throw '最大重试间隔必须至少为 1 秒' }

  $LastNativeExitCode = 1
  for ($Attempt = 1; $Attempt -le $Attempts; $Attempt += 1) {
    $AttemptArguments = @()
    $UsesFallback = $Attempt -eq $Attempts -and $FinalAttemptPrefixArguments.Count -gt 0
    if ($UsesFallback) {
      Write-Warning '常规 SFTP 上传连续失败，最后一次改用兼容 SCP 协议。'
      $AttemptArguments += $FinalAttemptPrefixArguments
    }
    $AttemptArguments += $Arguments

    Write-Output "TRANSFER_ATTEMPT=$Attempt/$Attempts"
    & $Command @AttemptArguments
    $LastNativeExitCode = $LASTEXITCODE
    if ($LastNativeExitCode -eq 0) { return }

    if ($Attempt -lt $Attempts) {
      $DelaySeconds = [Math]::Min($InitialDelaySeconds * $Attempt, $MaxDelaySeconds)
      Write-Warning "$FailureMessage (exit $LastNativeExitCode)，$DelaySeconds 秒后重试。"
      Start-Sleep -Seconds $DelaySeconds
    }
  }

  throw "$FailureMessage (exit $LastNativeExitCode，已尝试 $Attempts 次)"
}

function Resolve-CommandPath {
  param([Parameter(Mandatory = $true)][string[]]$Names)

  foreach ($Name in $Names) {
    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -ne $Command) { return $Command.Source }
  }
  throw "缺少命令：$($Names -join ' / ')"
}

function Resolve-TarCommand {
  # Windows 自带的 System32\tar.exe（bsdtar）原生支持 "C:\..." 本地路径。
  # PATH 里的 GNU tar（例如 Git 的 usr\bin\tar.exe）会把盘符冒号解释成
  # 远程主机（"Cannot connect to C: resolve failed"），必须加 --force-local。
  $SystemTar = Join-Path ([Environment]::GetFolderPath('System')) 'tar.exe'
  if (Test-Path -LiteralPath $SystemTar -PathType Leaf) {
    return @{ Command = $SystemTar; ExtraArguments = @() }
  }
  $Command = Resolve-CommandPath @('tar.exe', 'tar')
  $VersionText = [string](& $Command --version 2>$null | Select-Object -First 1)
  $ExtraArguments = if ($VersionText -match 'GNU tar') { @('--force-local') } else { @() }
  return @{ Command = $Command; ExtraArguments = $ExtraArguments }
}

function Remove-SafeTemporaryPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return }
  $Resolved = [IO.Path]::GetFullPath($Path)
  if (-not $Resolved.StartsWith($TempBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理非临时路径：$Resolved"
  }
  Remove-Item -LiteralPath $Resolved -Recurse -Force
}

function Set-PayloadCacheVersion {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "部署包缺少缓存入口：$Path"
  }
  $Source = [IO.File]::ReadAllText($Path)
  $Updated = [Text.RegularExpressions.Regex]::Replace($Source, '\?v=[0-9]+', "?v=$Version")
  if ($Updated -eq $Source) {
    throw "缓存版本号未更新：$Path"
  }
  [IO.File]::WriteAllText($Path, $Updated, $Utf8NoBom)
}

function Write-ReleaseManifest {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Manifest = [ordered]@{
    version = $ReleaseVersion
    build = $Version
    deployed_at = [DateTime]::UtcNow.ToString('o')
    environment = $Mode
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($Path, $Manifest, $Utf8NoBom)
}

function Assert-StaticPayloadMirror {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  $SourcePrefix = [IO.Path]::GetFullPath($Source).TrimEnd('\') + '\'
  $SourceFiles = @(Get-ChildItem -LiteralPath $Source -Recurse -File)
  $DestinationFiles = @(Get-ChildItem -LiteralPath $Destination -Recurse -File)
  if ($SourceFiles.Count -ne $DestinationFiles.Count) {
    throw "静态镜像文件数不一致：source=$($SourceFiles.Count), payload=$($DestinationFiles.Count)"
  }

  foreach ($SourceFile in $SourceFiles) {
    $Relative = $SourceFile.FullName.Substring($SourcePrefix.Length)
    $DestinationFile = Join-Path $Destination $Relative
    if (-not (Test-Path -LiteralPath $DestinationFile -PathType Leaf)) {
      throw "静态镜像缺少文件：$Relative"
    }
    if ($SourceFile.Length -ne (Get-Item -LiteralPath $DestinationFile).Length) {
      throw "静态镜像文件大小不一致：$Relative"
    }
  }
}

function Copy-ProductionBackendSources {
  param([Parameter(Mandatory = $true)][string]$Destination)

  $ServerRoot = Join-Path $ProjectDir 'server'
  $ServerRootPrefix = [IO.Path]::GetFullPath($ServerRoot).TrimEnd('\') + '\'
  $DestinationServer = Join-Path $Destination 'server'
  New-Item -ItemType Directory -Force -Path $DestinationServer | Out-Null

  foreach ($File in Get-ChildItem -LiteralPath $ServerRoot -Recurse -File) {
    $Relative = $File.FullName.Substring($ServerRootPrefix.Length).Replace('\', '/')

    if ($File.Extension -notin @('.js', '.sql')) { continue }

    # Never package server\data or runtime records under server\db.
    $IsRuntimeData = $Relative.StartsWith('data/', [StringComparison]::OrdinalIgnoreCase) -or
      $Relative -match '^db/(?:users|favorites|saves_index|login_log)\.json$' -or
      $Relative -match '^db/saves/' -or
      $Relative -match '^db/.*\.(?:tmp|db|db-journal|db-wal)$'
    if ($IsRuntimeData) { continue }

    $DestinationFile = Join-Path $DestinationServer ($Relative.Replace([char]47, [char]92))
    $DestinationFolder = Split-Path -Parent $DestinationFile
    New-Item -ItemType Directory -Force -Path $DestinationFolder | Out-Null
    Copy-Item -LiteralPath $File.FullName -Destination $DestinationFile -Force
  }

  foreach ($PackageFile in @('package.json', 'package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $ProjectDir $PackageFile) -Destination (Join-Path $Destination $PackageFile) -Force
  }

  # The save API reuses the browser-safe timeline validator. Package its complete
  # relative import chain at the same paths expected from server/api/saves.js.
  foreach ($SharedModule in @(
    'js/core/timeline-save-schema.js',
    'js/core/shinobi-daily.js',
    'js/core/narrative-artifact.js',
    'js/core/image-studio/contracts.js',
    'js/core/continuity-ledger.js',
    'js/systems/opening-draft.js',
    'js/systems/combat-level.js',
    'js/multiplayer/opening-draft-bridge.js',
    'js/utils/format.js'
  )) {
    $SourceFile = Join-Path $ProjectDir $SharedModule
    $DestinationFile = Join-Path $Destination $SharedModule
    $DestinationFolder = Split-Path -Parent $DestinationFile
    New-Item -ItemType Directory -Force -Path $DestinationFolder | Out-Null
    Copy-Item -LiteralPath $SourceFile -Destination $DestinationFile -Force
  }
  # Package the complete shared source tree: multiplayer also imports canon
  # data/worldbook modules, and future relative imports must remain resolvable.
  Copy-Item -LiteralPath (Join-Path $ProjectDir 'js') -Destination $Destination -Recurse -Force
}

function Assert-PackageContents {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Tar,
    [Parameter(Mandatory = $true)][string]$Archive
  )

  $ListFlag = if ($DryRun) { '-tf' } else { '-tzf' }
  $RawEntries = & $Tar.Command @($Tar.ExtraArguments + @($ListFlag, $Archive))
  if ($LASTEXITCODE -ne 0) { throw '无法读取部署包目录' }
  $Entries = @($RawEntries | ForEach-Object {
    $NormalizedEntry = $_.Replace([char]92, [char]47)
    $NormalizedEntry -replace '^(?:\./|/)+', ''
  })

  $RequiredAssets = @(
    'static/index.html',
    'static/login.html',
    'static/announcements.html',
    'static/js/app.js',
    'static/version.json',
    'static/js/data/generated/canon-runtime-data.js',
    'static/img/logo.png',
    'static/img/bg-home-pc.png',
    'static/img/login-bg.png',
    'static/assets/map.jpg'
  )
  foreach ($Required in $RequiredAssets) {
    if ($Entries -notcontains $Required) { throw "部署包缺少资源：$Required" }
  }
  if ($Entries | Where-Object { $_ -match '(^|/)\.env(?:$|\.)' }) {
    throw '部署包禁止包含 .env'
  }

  if ($Mode -eq 'staging') {
    if ($Entries -notcontains 'ops/nginx/naruto-rpg-staging.conf') {
      throw '测试站部署包缺少 Nginx 配置'
    }
  }
  # 生产与测试站共享同一个后端(/opt/naruto-rpg)，两种模式都必须包含后端文件。
  foreach ($Required in @(
    'backend/server/index.js',
    'backend/package.json',
    'backend/package-lock.json',
    'backend/js/core/timeline-save-schema.js',
    'backend/js/core/shinobi-daily.js',
    'backend/js/core/narrative-artifact.js',
    'backend/js/core/image-studio/contracts.js',
    'backend/js/core/continuity-ledger.js',
    'backend/js/systems/opening-draft.js',
    'backend/js/systems/combat-level.js',
    'backend/js/multiplayer/opening-draft-bridge.js',
    'backend/js/utils/format.js',
    'backend/js/data/worldbook/runtime-resolver.js',
    'backend/server/multiplayer/persistence/migrations/0001-initial-schema.sql',
    'backend/server/multiplayer/persistence/migrations/0008-room-opening-drafts.sql',
    'ops/systemd/naruto-rpg.service.d/limits.conf',
    'ops/systemd/naruto-rpg.service.d/runtime.conf',
    'ops/systemd/naruto-rpg.service.d/cloud-slots.conf',
    'ops/apply-release.py',
    'release-manifest.json',
    'ops/sysctl/90-naruto-rpg-memory.conf'
  )) {
    if ($Entries -notcontains $Required) { throw "部署包缺少后端文件：$Required" }
  }
  $RuntimeEntries = @($Entries | Where-Object {
    $_ -match '^backend/server/data/' -or
    $_ -match '^backend/server/db/(?:users|favorites|saves_index|login_log)\.json$' -or
    $_ -match '^backend/server/db/saves/' -or
    $_ -match '^backend/server/db/.*\.(?:tmp|db|db-journal|db-wal)$'
  })
  if ($RuntimeEntries.Count -gt 0) {
    throw "部署包混入运行数据：$($RuntimeEntries -join ', ')"
  }
  Write-Output 'RUNTIME_DATA_EXCLUDED=true'

  Write-Output 'PACKAGE_ASSETS_OK=true'
}

if ($Mode -eq 'production' -and -not $DryRun -and -not $ConfirmProduction) {
  throw '正式站部署已拒绝：必须显式传入 -ConfirmProduction'
}
if (-not $DryRun -and [string]::IsNullOrWhiteSpace($Server)) {
  throw '缺少部署服务器配置：请设置 NARUTO_DEPLOY_SERVER 或 deploy.local.psd1'
}

Write-Output '========================================'
Write-Output "忍者手记部署器 · $Mode"
Write-Output "目标：$($Target.PublicUrl)"
Write-Output "发布版本：v$ReleaseVersion"
Write-Output "构建版本：$Version"
if ($DryRun) { Write-Output '模式：DryRun（不会连接服务器）' }
Write-Output '========================================'

$Succeeded = $false
$ExitCode = 1
try {
  Set-Location $ProjectDir

  if (-not $SkipBuild) {
    $BuildTask = if ($Mode -eq 'staging') { 'build:deploy' } else { 'build' }
    if ($ProjectDir -match '^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)$') {
      $TaskDistro = $Matches[1]
      $TaskLinuxPath = $Matches[2].Replace('\', '/')
      Invoke-NativeChecked 'wsl.exe' @('-d', $TaskDistro, '--cd', $TaskLinuxPath, 'npm', 'run', $BuildTask) 'WSL 项目构建失败'
    } else {
      $NpmCommand = Resolve-CommandPath @('npm.cmd', 'npm')
      Invoke-NativeChecked $NpmCommand @('run', $BuildTask) '部署构建失败'
    }
  }

  New-Item -ItemType Directory -Force -Path $StaticDir | Out-Null
  Copy-Item -Path (Join-Path $ProjectDir 'public\*') -Destination $StaticDir -Recurse -Force
  Assert-StaticPayloadMirror (Join-Path $ProjectDir 'public') $StaticDir
  Set-PayloadCacheVersion (Join-Path $StaticDir 'index.html')
  Set-PayloadCacheVersion (Join-Path $StaticDir 'login.html')
  Write-ReleaseManifest (Join-Path $StaticDir 'version.json')

  # 生产与测试站共享同一个后端(/opt/naruto-rpg)，两种模式都打包后端与系统调优文件。
  $BackendDir = Join-Path $PayloadDir 'backend'
  New-Item -ItemType Directory -Force -Path $BackendDir | Out-Null
  Copy-ProductionBackendSources $BackendDir

  $SystemdPayloadDir = Join-Path $PayloadDir 'ops\systemd\naruto-rpg.service.d'
  $SysctlPayloadDir = Join-Path $PayloadDir 'ops\sysctl'
  New-Item -ItemType Directory -Force -Path $SystemdPayloadDir, $SysctlPayloadDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $ProjectDir 'deploy\systemd\naruto-rpg.service.d\limits.conf') -Destination $SystemdPayloadDir -Force
  Copy-Item -LiteralPath (Join-Path $ProjectDir 'deploy\systemd\naruto-rpg.service.d\runtime.conf') -Destination $SystemdPayloadDir -Force
  Copy-Item -LiteralPath (Join-Path $ProjectDir 'deploy\systemd\naruto-rpg.service.d\cloud-slots.conf') -Destination $SystemdPayloadDir -Force
  Copy-Item -LiteralPath (Join-Path $ProjectDir 'deploy\apply-release.py') -Destination (Join-Path $PayloadDir 'ops\apply-release.py') -Force
  Copy-Item -LiteralPath (Join-Path $ProjectDir 'deploy\sysctl\90-naruto-rpg-memory.conf') -Destination $SysctlPayloadDir -Force

  $NginxPayloadDir = Join-Path $PayloadDir 'ops\nginx'
  New-Item -ItemType Directory -Force -Path $NginxPayloadDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $ProjectDir 'deploy\nginx\naruto-rpg-android-download.conf') -Destination $NginxPayloadDir -Force

  if ($Mode -eq 'staging') {
    $NginxPayloadDir = Join-Path $PayloadDir 'ops\nginx'
    New-Item -ItemType Directory -Force -Path $NginxPayloadDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $ProjectDir 'deploy\nginx\naruto-rpg-staging.conf') -Destination $NginxPayloadDir -Force
  }

  $NodeCommand = Resolve-CommandPath @('node.exe', 'node')
  Invoke-NativeChecked $NodeCommand @((Join-Path $ProjectDir 'scripts\deploy-manifest.mjs'), $PayloadDir, $Mode, $Version, $DeploymentId) '部署清单或源码同步校验失败'
  $Tar = Resolve-TarCommand
  $CreateFlag = if ($DryRun) { '-cf' } else { '-czf' }
  Invoke-NativeChecked $Tar.Command ($Tar.ExtraArguments + @($CreateFlag, $ArchivePath, '-C', $PayloadDir, '.')) '创建部署包失败'
  Assert-PackageContents $Tar $ArchivePath
  Write-Output ('PACKAGE_MB={0:N2}' -f ((Get-Item -LiteralPath $ArchivePath).Length / 1MB))

  if ($DryRun) {
    $Succeeded = $true
    $ExitCode = 0
    Write-Output "DRY_RUN_OK=$Mode"
  } else {

  if (-not (Test-Path -LiteralPath $SshKey -PathType Leaf)) {
    throw "SSH 密钥不存在：$SshKey"
  }
  $ScpCommand = Resolve-CommandPath @('scp.exe', 'scp')
  $SshCommand = Resolve-CommandPath @('ssh.exe', 'ssh')
  $SshOptions = @(
    '-i', $SshKey,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'ConnectionAttempts=3',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'IPQoS=none'
  )
  $RemoteArchive = "/tmp/naruto-rpg-$Mode-$DeploymentId.tar.gz"
  $RemoteArchivePart = "$RemoteArchive.part"
  $RemoteRelease = "/tmp/naruto-rpg-release-$Mode-$DeploymentId"
  $ArchiveSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  Invoke-NativeChecked $NodeCommand @((Join-Path $ProjectDir 'scripts\deploy-manifest.mjs'), '--check-source', $PayloadDir) '打包之后源码已变化，请重新构建发布'

  Invoke-NativeWithRetry `
    -Command $ScpCommand `
    -Arguments ($SshOptions + @($ArchivePath, "${Server}:$RemoteArchivePart")) `
    -FailureMessage '上传部署包失败' `
    -Attempts 6 `
    -InitialDelaySeconds 10 `
    -MaxDelaySeconds 30 `
    -FinalAttemptPrefixArguments @('-O')

  $FinalizeRemoteUpload = "set -eu; if test -f '$RemoteArchivePart'; then printf '%s  %s\n' '$ArchiveSha256' '$RemoteArchivePart' | sha256sum -c -; mv -f '$RemoteArchivePart' '$RemoteArchive'; else test -f '$RemoteArchive'; printf '%s  %s\n' '$ArchiveSha256' '$RemoteArchive' | sha256sum -c -; fi"
  # Give sshd time to release the upload connection before the single
  # verification/deployment session is opened.
  Start-Sleep -Seconds 12

  $RemoteSteps = @(
    'set -eu',
    $FinalizeRemoteUpload,
    "mkdir -p '$RemoteRelease'",
    "if test ! -s '$RemoteRelease/release-manifest.json'; then tar xzf '$RemoteArchive' -C '$RemoteRelease'; fi",
    "python3 '$RemoteRelease/ops/apply-release.py' --mode '$Mode' --build '$Version'"
  )
  # The server throttles rapid consecutive SSH sessions. Keep the verified
  # archive until one complete deployment attempt is acknowledged so retries
  # remain idempotent after an authentication-time disconnect.
  $RemoteDeployCommand = $RemoteSteps -join '; '
  Invoke-NativeWithRetry `
    -Command $SshCommand `
    -Arguments ($SshOptions + @($Server, $RemoteDeployCommand)) `
    -FailureMessage '远端部署或验证失败' `
    -Attempts 6 `
    -InitialDelaySeconds 10 `
    -MaxDelaySeconds 30
  Write-Output "UPLOAD_SHA256=$ArchiveSha256"

  # Keep receipt/log/manifest for recovery and uncertain SSH outcomes.
  $RemoteCleanupCommand = "python3 '$RemoteRelease/ops/apply-release.py' --mode '$Mode' --build '$Version' --cleanup && rm -f '$RemoteArchive' '$RemoteArchivePart'"
  Start-Sleep -Seconds 12
  try {
    Invoke-NativeWithRetry `
      -Command $SshCommand `
      -Arguments ($SshOptions + @($Server, $RemoteCleanupCommand)) `
      -FailureMessage '远端临时文件清理失败' `
      -Attempts 3 `
      -InitialDelaySeconds 10 `
      -MaxDelaySeconds 30
  } catch {
    Write-Warning "远端临时文件清理失败，不影响已完成部署：$($_.Exception.Message)"
  }

  $Succeeded = $true
  $ExitCode = 0
  Write-Output "DEPLOY_OK=$($Target.PublicUrl)"
  Write-Output "RELEASE_VERSION=$ReleaseVersion"
  Write-Output "BUILD_VERSION=$Version"
  Write-Output "VERIFY_URL=$($Target.VerifyUrl)"
  }
} catch {
  $ExitCode = 1
  Write-Error "部署失败：$($_.Exception.Message)" -ErrorAction Continue
} finally {
  Set-Location $ProjectDir
  if ($KeepPackage) { Write-Output "PACKAGE_DIRECTORY=$WorkDir" }
  else { Remove-SafeTemporaryPath $WorkDir }
  if (-not $KeepPackage -and (Test-Path -LiteralPath $ArchivePath)) {
    Remove-SafeTemporaryPath $ArchivePath
  }
  if (-not $Succeeded) {
    Write-Warning '部署未完成；正式站与测试站不会因本地清理而被再次操作。'
  }
}
exit $ExitCode
