$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') { throw 'Invalid version.' }
$name = "codex-feishu-bridge-v$version-windows"
$releaseDir = Join-Path $projectRoot 'releases'
$destination = Join-Path $releaseDir "$name.zip"
if (Test-Path -LiteralPath $destination) { throw 'Release already exists. Preserve the original and use a new version for a new release.' }
$buildRoot = Join-Path $projectRoot ('.cache\share-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $buildRoot $name
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$files = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'share-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (@($files | Select-Object -Unique).Count -ne $files.Count) { throw 'Duplicate manifest entry.' }

foreach ($file in $files) {
  if ($file -match '(^|[/\\])\.\.([/\\]|$)' -or [IO.Path]::IsPathRooted($file)) { throw 'Unsafe manifest path.' }
  $source = [IO.Path]::GetFullPath((Join-Path $projectRoot $file))
  if (-not $source.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source outside project.' }
  $item = Get-Item -LiteralPath $source -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected a regular source file.' }
  $parent = $item.Directory
  while ($parent.FullName -ne $projectRoot) {
    if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source parent is a link.' }
    $parent = $parent.Parent
  }
  $target = Join-Path $stage $file
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target
  # Keep Windows launchers compatible with cmd.exe, including when source uses LF.
  if ([IO.Path]::GetExtension($target) -eq '.cmd') {
    $body = [IO.File]::ReadAllText($target) -replace '\r?\n', "`r`n"
    [IO.File]::WriteAllText($target, $body, [Text.UTF8Encoding]::new($false))
  }
}

& node (Join-Path $PSScriptRoot 'verify-share.js') $stage
if ($LASTEXITCODE -ne 0) { throw 'Share content verification failed.' }

$hashes = [ordered]@{}
foreach ($file in $files) { $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $stage $file) -Algorithm SHA256).Hash.ToLowerInvariant() }
$manifest = [ordered]@{ version = $version; platform = 'Windows'; files = $hashes }
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $stage 'SHARE-MANIFEST.json'), ($manifest | ConvertTo-Json -Depth 6), $utf8)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$temporaryZip = Join-Path $buildRoot "$name.zip"
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $temporaryZip, [IO.Compression.CompressionLevel]::Optimal, $true)
$archive = [IO.Compression.ZipFile]::OpenRead($temporaryZip)
try {
  $expected = @($files) + @('SHARE-MANIFEST.json')
  if ($archive.Entries.Count -ne $expected.Count) { throw 'Unexpected archive entry count.' }
  $seen = @{}
  foreach ($entry in $archive.Entries) {
    $entryName = $entry.FullName.Replace('\', '/')
    if (-not $entryName.StartsWith($name + '/', [StringComparison]::Ordinal)) { throw 'Unexpected archive root.' }
    $localName = $entryName.Substring($name.Length + 1)
    if ($localName -notin $expected -or $seen.ContainsKey($localName)) { throw 'Unexpected or duplicate archive entry.' }
    $seen[$localName] = $true
    $stream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $entryHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $stage $localName) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($entryHash -ne $sourceHash) { throw 'Archive content hash mismatch.' }
  }
} finally { $archive.Dispose() }

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
[IO.File]::Copy($temporaryZip, $destination, $false)
$zipHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($destination + '.sha256'), ($zipHash + '  ' + [IO.Path]::GetFileName($destination) + "`n"), $utf8)
[ordered]@{ zip = $destination; bytes = (Get-Item -LiteralPath $destination).Length; fileCount = $files.Count + 1; sha256 = $zipHash } | ConvertTo-Json
