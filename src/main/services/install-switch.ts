import { posix, win32 } from "node:path";

export const BREW_CASK = "decoy-dev/tap/visual-omp";
export const PACKAGE_REPOSITORY = "https://github.com/decoy-dev/visual-omp";

/** Adoption fails closed if the destination differs or another copy appears before installation. */
export function brewSwitchCommand(brew: string, target: string): string {
	const binary = `'${brew.replaceAll("'", `'\\''`)}'`;
	const appdir = `'${`--appdir=${posix.dirname(target)}`.replaceAll("'", `'\\''`)}'`;
	return `HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ASK=1 ${binary} install --cask --adopt ${appdir} ${BREW_CASK}`;
}

function psString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** Search all known roots before choosing where to install, including all-user copies. */
export function scoopRoots(env: Record<string, string | undefined>, home: string, configuredGlobal?: string): string[] {
	const paths = [
		env.SCOOP,
		win32.join(env.USERPROFILE || home, "scoop"),
		configuredGlobal,
		env.SCOOP_GLOBAL,
		win32.join(env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData", "scoop"),
		...(env.PATH ?? env.Path ?? "").split(";")
			.map(path => path.replace(/^"|"$/g, ""))
			.filter(path => win32.isAbsolute(path) && win32.basename(path).toLowerCase() === "shims")
			.map(path => win32.dirname(path)),
	];
	const seen = new Set<string>();
	return paths.filter((path): path is string => {
		if (!path || !win32.isAbsolute(path)) return false;
		const key = win32.normalize(path).toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export interface ScoopSwitchOptions {
	scoop: string;
	roots: string[];
	executable: string;
	uninstaller?: string;
	profile: string;
	pendingFile: string;
	resultFile: string;
	from: string;
	pid: number;
}

/** The same post-exit script is used by the app and the standalone VM generator. */
export function scoopSwitchScript(options: ScoopSwitchOptions): string {
	return `param([switch]$DryLaunch)
$ErrorActionPreference = 'Stop'
$scoop = ${psString(options.scoop)}
$original = ${psString(options.executable)}
$installDir = ${psString(win32.dirname(options.executable))}
$uninstaller = ${psString(options.uninstaller ?? win32.join(win32.dirname(options.executable), "Uninstall visual-omp.exe"))}
$profile = ${psString(options.profile)}
$pending = ${psString(options.pendingFile)}
$resultFile = ${psString(options.resultFile)}
$logFile = $resultFile + '.log'
$from = ${psString(options.from)}
$roots = @(${options.roots.map(psString).join(", ")})
$managerRoot = Split-Path (Split-Path $scoop -Parent) -Parent
$env:Path = (Join-Path $managerRoot 'shims') + ';' + $env:Path
$record = [ordered]@{
  method = 'scoop'; operation = 'switch'; from = $from; to = $from
  at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  phase = 'waiting'; failure = $null; failureKind = $null
  verified = $false; removed = $false; launch = 'pending'; target = $null
  profile = $profile; log = $logFile
}
function Write-Log([string]$message) {
  $line = '[' + (Get-Date -Format o) + '] ' + $message
  Write-Host $line
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 } catch { Write-Warning ('Could not write log: ' + $_.Exception.Message) }
}
function Save-Result([switch]$PendingOutcome) {
  $json = $record | ConvertTo-Json -Depth 5
  try { $json | Set-Content -LiteralPath $resultFile -Encoding UTF8 } catch { Write-Log ('Could not write result: ' + $_.Exception.Message) }
  if ($PendingOutcome) {
    try { $json | Set-Content -LiteralPath $pending -Encoding UTF8 } catch { Write-Log ('Could not write restart outcome: ' + $_.Exception.Message) }
  }
}
function Set-Phase([string]$phase) {
  $record.phase = $phase
  Write-Log ('Phase: ' + $phase)
  Save-Result
}
function Invoke-Scoop([string[]]$Arguments) {
  $global:LASTEXITCODE = 0
  & $scoop @Arguments *>&1 | ForEach-Object { Write-Log "$_" }
  if (-not $? -or $LASTEXITCODE -ne 0) { throw ('Scoop failed: ' + ($Arguments -join ' ')) }
}
$target = $null
$temporaryUninstaller = $null
try {
  Set-Phase 'waiting'
  $deadline = (Get-Date).AddMinutes(1)
  do {
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Id -eq ${options.pid} -or ($_.Path -and $_.Path.StartsWith($installDir + '\\', [StringComparison]::OrdinalIgnoreCase))
    })
    if ($running.Count -eq 0) { break }
    if ((Get-Date) -ge $deadline) { throw 'visual-omp is still running. Close every copy and try again.' }
    Start-Sleep -Milliseconds 250
  } while ($true)
  Set-Phase 'discovering'
  # Recheck after exit, including roots added since the in-app probe.
  $roots += @($env:SCOOP, (Join-Path $env:USERPROFILE 'scoop'), $env:SCOOP_GLOBAL, (Join-Path $env:ProgramData 'scoop'))
  # Scoop reads global_path from XDG_CONFIG_HOME/scoop/config.json, or ~/.config/scoop/config.json.
  $configHome = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $env:USERPROFILE '.config' }
  try {
    $config = Get-Content -Raw -LiteralPath (Join-Path $configHome 'scoop\\config.json') -ErrorAction Stop | ConvertFrom-Json
    if ($config.global_path -is [string] -and $config.global_path -and [IO.Path]::IsPathRooted($config.global_path)) {
      $roots += $config.global_path
    }
  } catch {
    # As in the in-app reader, an absent or unreadable Scoop config has no configured global root.
  }
  $roots = @($roots | Where-Object { $_ } | Select-Object -Unique)
  $existingRoot = $roots | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'apps\\visual-omp') -PathType Container } | Select-Object -First 1
  $root = if ($existingRoot) { $existingRoot } else { $managerRoot }
  $current = Join-Path $root 'apps\\visual-omp\\current'
  $expected = $null
  if (-not $existingRoot) {
    Set-Phase 'installing'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Scoop needs Git. Run scoop install git in PowerShell, then try again. The installer copy has been kept.' }
    $bucket = Join-Path $managerRoot 'buckets\\decoy-dev'
    if (-not (Test-Path -LiteralPath $bucket -PathType Container)) {
      Invoke-Scoop -Arguments @('bucket', 'add', 'decoy-dev', '${PACKAGE_REPOSITORY}')
    }
    $bucketManifest = Join-Path $bucket 'bucket\\visual-omp.json'
    $expected = (Get-Content -Raw -LiteralPath $bucketManifest | ConvertFrom-Json).version
    if (-not $expected) { throw 'The Scoop bucket did not report a version. The installer copy has been kept.' }
    Invoke-Scoop -Arguments @('install', 'decoy-dev/visual-omp')
  }
  Set-Phase 'verifying'
  $target = Join-Path $current 'visual-omp.exe'
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'The Scoop executable is missing. The installer copy has been kept.' }
  $receipt = @('scoop-install.json', 'install.json') | ForEach-Object { Join-Path $current $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $receipt) { throw 'Scoop has no install record for visual-omp. The installer copy has been kept.' }
  $null = Get-Content -Raw -LiteralPath $receipt | ConvertFrom-Json
  $manifest = @('scoop-manifest.json', 'manifest.json') | ForEach-Object { Join-Path $current $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $manifest) { throw 'Scoop has no installed manifest for visual-omp. The installer copy has been kept.' }
  $version = (Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).version
  if (-not $version -or ($expected -and $version -ne $expected)) { throw 'The installed Scoop manifest version does not match. The installer copy has been kept.' }
  $actualVersion = (Get-Item -LiteralPath $target).VersionInfo.ProductVersion
  if ($actualVersion -ne $version -and $actualVersion -ne ($version + '.0')) { throw 'The Scoop executable version does not match its manifest. The installer copy has been kept.' }
  $target = (Resolve-Path -LiteralPath $target -ErrorAction Stop).ProviderPath
  if (-not [IO.Path]::IsPathRooted($target) -or $target.StartsWith($installDir + '\\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The Scoop app path does not resolve to a separate copy. The installer copy has been kept.' }
  $record.to = $version
  $record.target = $target
  $record.verified = $true
  Set-Phase 'removing'
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'The old uninstaller is missing. Open the Scoop copy; the installer copy could not be removed.' }
  $mode = '/currentuser'
  foreach ($key in @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')) {
    $machineCopy = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue | Where-Object { $_.InstallLocation -and $_.InstallLocation.TrimEnd('\\') -eq $installDir.TrimEnd('\\') }
    if ($machineCopy) { $mode = '/allusers' }
  }
  # Match electron-builder installUtil.nsh: execute a temp copy, keep data, and put _?= last.
  # --updated also protects profiles if deleteAppDataOnUninstall is enabled in a future build.
  $temporaryUninstaller = Join-Path ([IO.Path]::GetTempPath()) ('visual-omp-uninstall-' + [Guid]::NewGuid().ToString('N') + '.exe')
  Copy-Item -LiteralPath $uninstaller -Destination $temporaryUninstaller -ErrorAction Stop
  try {
    $uninstall = Start-Process -FilePath $temporaryUninstaller -ArgumentList ('/S /KEEP_APP_DATA ' + $mode + ' --updated _?=' + $installDir) -Wait -PassThru -ErrorAction Stop
    if ($uninstall.ExitCode -ne 0) { throw ('The installer copy could not be removed (exit ' + $uninstall.ExitCode + ').') }
    if (Test-Path -LiteralPath $original -PathType Leaf) { throw 'The installer executable is still present after uninstall.' }
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) { throw 'The old uninstaller is still present after uninstall.' }
    $record.removed = $true
  } finally {
    try { Remove-Item -LiteralPath $temporaryUninstaller -Force -ErrorAction Stop } catch { Write-Log ('Could not remove temporary uninstaller: ' + $_.Exception.Message) }
  }
} catch {
  $record.failureKind = if ($record.verified) { 'cleanup' } else { 'install' }
  $record.failure = $_.Exception.Message
  Write-Log ($record.failureKind + ' failure: ' + $record.failure)
}
$launch = if ($record.verified) { $target } else { $original }
$record.launch = if ($DryLaunch) { 'skipped' } else { 'pending' }
Set-Phase 'launching'
Save-Result -PendingOutcome
if ($DryLaunch) {
  Write-Log ('DryLaunch: would start ' + $launch)
} else {
  try {
    Start-Process -FilePath $launch -ErrorAction Stop
    $record.launch = 'started'
    Write-Log ('Started process: ' + $launch + '. App readiness has not been checked.')
  } catch {
    $record.launch = 'failed'
    $record.failureKind = 'launch'
    $record.failure = (@($record.failure, $_.Exception.Message) | Where-Object { $_ }) -join ' '
    Write-Log ('Could not start app: ' + $record.failure)
    Save-Result -PendingOutcome
  }
}
Set-Phase 'finished'
if ($record.failure) {
  Write-Log ('Switch did not finish: ' + $record.failure)
  if ($record.verified) { Write-Log ('Scoop copy: ' + $target + '. The old copy may need removal in Windows Settings > Apps.') }
  if (-not $DryLaunch) { Read-Host 'Press Enter to close this window' }
}
`;
}
