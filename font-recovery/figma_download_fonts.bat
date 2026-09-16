@echo off
setlocal DisableDelayedExpansion
set "FIGMA_FONT_SCRIPT=%~f0"
powershell.exe -NoProfile -Command "$text = [IO.File]::ReadAllText($env:FIGMA_FONT_SCRIPT, [Text.Encoding]::UTF8); $body = ($text -split '(?m)^# POWERSHELL_START\r?$', 2)[1]; & ([scriptblock]::Create($body)) -OutputDirectory (Join-Path ([IO.Path]::GetDirectoryName($env:FIGMA_FONT_SCRIPT)) 'fonts')"
set "fontExitCode=%errorlevel%"
if /I not "%~1"=="--no-pause" pause
exit /b %fontExitCode%
# POWERSHELL_START
param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string[]]$FontDirectories,
  [switch]$Offline
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$requests = ConvertFrom-Json -InputObject '[{"family":"Alibaba PuHuiTi","style":"Bold","filename":"AlibabaPuHuiTi_Bold.ttf","weight":700,"italic":false,"url":"https://fonts.alibabadesign.com/AlibabaPuHuiTi/Alibaba-PuHuiTi-Bold/Alibaba-PuHuiTi-Bold.ttf","manualUrl":"https://www.alibabafonts.com/"},{"family":"Alibaba PuHuiTi","style":"Medium","filename":"AlibabaPuHuiTi_Medium.ttf","weight":500,"italic":false,"url":"https://fonts.alibabadesign.com/AlibabaPuHuiTi/Alibaba-PuHuiTi-Medium/Alibaba-PuHuiTi-Medium.ttf","manualUrl":"https://www.alibabafonts.com/"}]'
if ($null -eq $requests) { $requests = @() }

function Normalize-Name([string]$Name) {
  return ($Name -replace '[\s_-]', '').ToLowerInvariant()
}

function Get-FontFace([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    # A CSS error page, WOFF file, or OpenType/CFF file must not be saved as TTF.
    $stream = [IO.File]::OpenRead($Path)
    try {
      $header = New-Object byte[] 4
      $count = $stream.Read($header, 0, 4)
    } finally { $stream.Dispose() }
    if ($count -ne 4 -or [BitConverter]::ToString($header) -ne '00-01-00-00') {
      Write-Verbose ('Not a TTF header: ' + [BitConverter]::ToString($header))
      return $null
    }
    return New-Object Windows.Media.GlyphTypeface -ArgumentList ([Uri][IO.Path]::GetFullPath($Path))
  } catch {
    Write-Verbose ('Cannot read font metadata: ' + $_.Exception.Message)
    return $null
  }
}

function Test-FontMatch($Face, $Request) {
  if ($null -eq $Face) { return $false }
  $family = Normalize-Name $Request.family
  $combined = Normalize-Name ($Request.family + $Request.style)
  $families = @($Face.FamilyNames.Values) + @($Face.Win32FamilyNames.Values)
  if (-not ($families | Where-Object { (Normalize-Name $_) -in @($family, $combined) })) { return $false }
  $style = Normalize-Name $Request.style
  if (@($Face.FaceNames.Values) | Where-Object { (Normalize-Name $_) -eq $style }) { return $true }
  # Weight aliases apply only to known, non-condensed styles; never guess an unknown style.
  return ($null -ne $Request.weight -and $Face.Weight.ToOpenTypeWeight() -eq $Request.weight -and
    ($Face.Style.ToString() -ne 'Normal') -eq $Request.italic -and $Face.Stretch.ToString() -eq 'Normal')
}

function Get-LocalFontPaths {
  $paths = @()
  foreach ($directory in $script:searchDirectories) {
    if (Test-Path -LiteralPath $directory -PathType Container) {
      $paths += Get-ChildItem -LiteralPath $directory -Filter '*.ttf' -File | Select-Object -ExpandProperty FullName
    }
  }
  if ($script:includeRegistry) {
    foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts', 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts')) {
      if (-not (Test-Path -LiteralPath $key)) { continue }
      foreach ($property in (Get-ItemProperty -LiteralPath $key).PSObject.Properties) {
        if ($property.Name -like 'PS*' -or $property.Value -isnot [string]) { continue }
        $value = [Environment]::ExpandEnvironmentVariables($property.Value)
        if ([IO.Path]::GetExtension($value) -ine '.ttf') { continue }
        if ([IO.Path]::IsPathRooted($value)) { $paths += $value }
        else {
          foreach ($directory in $script:searchDirectories) { $paths += Join-Path $directory $value }
        }
      }
    }
  }
  return $paths | Sort-Object -Unique
}

function Get-DownloadSource($Request) {
  if ($Request.url) {
    return @{ Url = $Request.url; Headers = @{ Referer = 'https://www.alibabafonts.com/'; 'User-Agent' = 'Mozilla/5.0' } }
  }
  if ($Request.manualUrl -eq 'https://www.alibabafonts.com/') {
    throw 'This Alibaba family/style has no automatic source. Get the exact version from the official font site.'
  }
  if ($null -eq $Request.weight) { throw 'This style has no automatic weight mapping. Supply the exact TTF locally.' }
  $family = [Uri]::EscapeDataString($Request.family)
  $axis = ':wght@' + $Request.weight
  if ($Request.italic) { $axis = ':ital,wght@1,' + $Request.weight }
  $cssUrl = 'https://fonts.googleapis.com/css2?family=' + $family + $axis
  try {
    $css = (Invoke-WebRequest -Uri $cssUrl -UseBasicParsing -UserAgent 'Mozilla/5.0' -TimeoutSec 30).Content
  } catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 400) {
      throw 'Google Fonts does not provide this family/style. Supply the exact TTF from its publisher.'
    }
    throw
  }
  $urls = @([regex]::Matches($css, 'url\(([^)]+)\)') | ForEach-Object { $_.Groups[1].Value.Trim('"', "'") } | Select-Object -Unique)
  if ($urls.Count -ne 1 -or $css -match 'unicode-range\s*:') {
    throw 'Google returned font subsets. Download a complete TTF from the publisher instead.'
  }
  $uri = [Uri]$urls[0]
  if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'fonts.gstatic.com') { throw 'Unexpected Google font URL.' }
  return @{ Url = $uri.AbsoluteUri; Headers = @{ 'User-Agent' = 'Mozilla/5.0' } }
}

try {
  Add-Type -AssemblyName PresentationCore
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
  [IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
  $script:includeRegistry = -not $PSBoundParameters.ContainsKey('FontDirectories')
  $script:searchDirectories = @($OutputDirectory)
  if ($script:includeRegistry) {
    $script:searchDirectories += Join-Path $env:WINDIR 'Fonts'
    $script:searchDirectories += Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
  } else { $script:searchDirectories += $FontDirectories }
  $localPaths = @(Get-LocalFontPaths)
  $faceCache = @{}
  $results = @()
  $usedFilenames = @{}
  Write-Host 'Font Downloader for Godot'
  Write-Host ('Output: ' + $OutputDirectory)
  foreach ($request in $requests) {
    $temporaryPath = $null
    $temporaryDirectory = $null
    $result = [ordered]@{ family = $request.family; style = $request.style; filename = $request.filename; status = 'missing'; source = ''; message = ''; manualUrl = $request.manualUrl }
    Write-Host ('Checking ' + $request.family + ' ' + $request.style + '...')
    try {
      if ($request.filename.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) { throw 'Font name contains invalid filename characters.' }
      if ($usedFilenames.ContainsKey($request.filename)) { throw 'Two requested fonts map to the same output filename.' }
      $usedFilenames[$request.filename] = $true
      $destination = Join-Path $OutputDirectory $request.filename
      $local = $null
      foreach ($path in $localPaths) {
        if (-not $faceCache.ContainsKey($path)) { $faceCache[$path] = Get-FontFace $path }
        if (Test-FontMatch $faceCache[$path] $request) { $local = $path; break }
      }
      if ($local) {
        if ([IO.Path]::GetFullPath($local) -ine $destination) { [IO.File]::Copy($local, $destination, $true) }
        $result.status = 'copied'
        $result.source = $local
      } else {
        if ($Offline) { throw 'No matching local TTF found; offline mode is enabled.' }
        $source = Get-DownloadSource $request
        Write-Host ('Downloading from ' + ([Uri]$source.Url).Host + '...')
        # WPF caches font collections by directory. A new directory per download
        # avoids stale metadata when a later font is created in the same process.
        $temporaryDirectory = Join-Path $OutputDirectory ('.figma-font-' + [Guid]::NewGuid().ToString())
        [IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
        $temporaryPath = Join-Path $temporaryDirectory 'download.ttf'
        Invoke-WebRequest -Uri $source.Url -Headers $source.Headers -UseBasicParsing -TimeoutSec 60 -OutFile $temporaryPath
        $face = Get-FontFace $temporaryPath
        if ($null -eq $face) { throw 'Download is not a readable TrueType font; it was not saved.' }
        if (-not (Test-FontMatch $face $request)) {
          throw ('Downloaded font does not match: ' + ($face.FamilyNames.Values -join ', ') + ' / ' + ($face.FaceNames.Values -join ', '))
        }
        [IO.File]::Copy($temporaryPath, $destination, $true)
        $result.status = 'downloaded'
        $result.source = $source.Url
      }
      Write-Host ('OK: ' + $request.filename)
    } catch {
      $result.message = $_.Exception.Message
      Write-Host ('MISSING: ' + $request.family + ' ' + $request.style + ' - ' + $result.message)
      Write-Host ('Font source: ' + $request.manualUrl)
    } finally {
      if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) { Remove-Item -LiteralPath $temporaryPath -Force }
      if ($temporaryDirectory -and (Test-Path -LiteralPath $temporaryDirectory)) { [IO.Directory]::Delete($temporaryDirectory) }
    }
    $results += [pscustomobject]$result
  }
  $reportPath = Join-Path $OutputDirectory 'font-download-report.json'
  ConvertTo-Json -InputObject @($results) -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  $missing = @($results | Where-Object { $_.status -eq 'missing' }).Count
  Write-Host ('Ready: ' + ($results.Count - $missing) + '; Missing: ' + $missing + '. Report: ' + $reportPath)
  if ($missing -gt 0) { exit 1 }
  exit 0
} catch {
  Write-Host ('Font export failed: ' + $_.Exception.Message)
  exit 1
}
