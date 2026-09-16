figma.showUI(__html__, { width: 320, height: 280 });

const updateSelection = () => {
  const selection = figma.currentPage.selection;
  figma.ui.postMessage({
    type: "response-is-frame-selected",
    isFrameSelected: selection.length === 1 && selection[0].type === "FRAME"
  });
};

figma.on("selectionchange", updateSelection);
figma.on("currentpagechange", updateSelection);
updateSelection();

let exportInProgress = false;

/**
 * Calls to `parent.postMessage` inside `ui.html` will trigger this callback.
 * The callback will be passed the `pluginMessage` property of the posted message.
 * @param {Object} pluginMessage - The message from the HTML page, of the shape { type: string }
 */
figma.ui.onmessage = async (pluginMessage) => {
  if (!pluginMessage || typeof pluginMessage.type !== "string") return;
  if (pluginMessage.type === "request-cancel") {
    figma.closePlugin();
    return;
  }
  if (pluginMessage.type === "request-selection-state") {
    updateSelection();
    return;
  }
  if (!["request-json", "request-images", "request-fonts", "request-zip"].includes(pluginMessage.type)) return;

  const requestId = pluginMessage.requestId;
  if (exportInProgress) {
    figma.ui.postMessage({ type: "response-error", requestId, message: "An export is already in progress." });
    return;
  }
  exportInProgress = true;
  try {
    // Capture the scope before awaiting: changing the selection must not split a ZIP across frames.
    const exportType = pluginMessage.exportType || "project";
    const page = figma.currentPage;
    const selection = page.selection;
    let exportNode;
    if (exportType === "project") {
      exportNode = figma.root;
      await figma.loadAllPagesAsync();
    } else if (exportType === "page") {
      exportNode = page;
    } else if (exportType === "frame") {
      if (selection.length !== 1 || selection[0].type !== "FRAME") {
        throw new Error("Select exactly one frame before exporting.");
      }
      exportNode = selection[0];
    } else {
      throw new Error("Unknown export type.");
    }

    const response = { type: pluginMessage.type.replace("request-", "response-"), requestId };
    if (pluginMessage.type === "request-json" || pluginMessage.type === "request-zip") {
      response.jsonString = await getLayoutJSON(exportType, page, exportNode);
    }
    if (pluginMessage.type === "request-images" || pluginMessage.type === "request-zip") {
      response.images = await getImages(exportNode);
    }
    if (pluginMessage.type === "request-fonts" || pluginMessage.type === "request-zip") {
      response.batchScript = getFontDownloaderBatchScript(getFontList(exportNode));
    }
    figma.ui.postMessage(response);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error("Figma to Godot export failed:", error);
    figma.ui.postMessage({ type: "response-error", requestId, message });
  } finally {
    exportInProgress = false;
  }
};



/** BEGIN HELPER FUNCTIONS */



const excludedNodeProperties = new Set([
  "__proto__",
  "parent", "children", "removed", "masterComponent", "mainComponent", "instances",
  "constrainProportions", "horizontalPadding", "verticalPadding",
  // Editor state and other live node references are not layout data.
  "selection", "selectedTextRange", "focusedNode", "stuckNodes", "attachedConnectors", "exposedInstances"
]);

/** Serialize layout data while resolving component relations asynchronously. */
const getObjectFromNode = async (node, withoutRelations = false, ancestors = new Set()) => {
  const obj = { id: node.id, type: node.type, name: node.name };
  // Shallow page wrappers still need their document parent for Godot importers.
  const parent = node.parent;
  if (parent) obj.parent = { id: parent.id, type: parent.type };
  if (ancestors.has(node.id)) return obj;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(node.id);
  const seen = new Set();
  for (let proto = Object.getPrototypeOf(node); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [name, prop] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!prop.get || excludedNodeProperties.has(name)) continue;
      try {
        const value = prop.get.call(node);
        obj[name] = typeof value === "symbol" ? "Mixed" : value;
      } catch (error) {
        // Some getters only apply to specific node configurations.
      }
    }
  }
  if (withoutRelations) return obj;
  if ("children" in node) {
    obj.children = [];
    for (const child of node.children) {
      obj.children.push(await getObjectFromNode(child, false, nextAncestors));
    }
  }
  if (node.type === "INSTANCE") {
    const mainComponent = await node.getMainComponentAsync();
    if (mainComponent) {
      // Keep the export schema used by the Godot importer, but use the current Figma API.
      obj.masterComponent = await getObjectFromNode(mainComponent, false, nextAncestors);
    }
  }
  return obj;
};

async function getLayoutJSON(exportType, page, exportNode) {
  const json = await getObjectFromNode(figma.root, exportType !== "project");
  if (exportType === "page") {
    json.children = [await getObjectFromNode(page)];
  } else if (exportType === "frame") {
    const pageJSON = await getObjectFromNode(page, true);
    pageJSON.children = [await getObjectFromNode(exportNode)];
    json.children = [pageJSON];
  }
  json.exportType = exportType.toUpperCase();
  return JSON.stringify(json, (key, value) => typeof value === "symbol" ? "Mixed" : value);
}

/**
 * Retrieves images from the requested scope, including fills on the root frame.
 * @returns {Promise<Array<{ data: Uint8Array, filename: string }>>}
 */
async function getImages(exportNode) {
  const imageHashes = new Set();

  const nodes = [exportNode, ...exportNode.findAll(node => 'fills' in node)];

  // Export all image nodes
  const images = [];
  for (const node of nodes) {
    if ('fills' in node) {
      let fills = node.fills;
      if (!Array.isArray(fills) && node.type === "TEXT") {
        fills = node.getStyledTextSegments(["fills"]).reduce((all, segment) => all.concat(segment.fills), []);
      }
      const imageFills = (Array.isArray(fills) ? fills : []).filter(fill => 
        fill.type === 'IMAGE' && 
        fill.visible !== false && fill.imageHash
      );

      for (const fill of imageFills) {
        if (imageHashes.has(fill.imageHash)) {
          continue;
        }
        imageHashes.add(fill.imageHash);
        const imageData = await node.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: 1 }
        });
        images.push({
          data: imageData,
          filename: `${fill.imageHash}.png`
        });
      }
    }
  }

  return images;
}

/**
 * Creates a list of all fonts used in the Figma file.
 * @returns {Array<{ family: string, style: string }>} The fonts used in the requested scope.
 */
const getFontList = (exportNode) => {
  const fonts = new Set();
  const fontNames = new Set();

  const traverse = (node) => {
    if (node.type === "TEXT" && node.characters.length > 0) {
        // Get font names from text node
        node.getRangeAllFontNames(0, node.characters.length).forEach(font => {
          if (fontNames.has(`${font.family} ${font.style}`)) return;
          fontNames.add(`${font.family} ${font.style}`);
          fonts.add(font);
        });
    }

    // Traverse children if they exist
    if ("children" in node) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  };

  traverse(exportNode);
  return Array.from(fonts);
};

/**
 * Converts a Figma font style to a Google Fonts font weight.
 * @param {string} style - The Figma font style.
 * @returns {number|null} The weight, or null when the style cannot be mapped safely.
 */
function getFontWeight(style) {
  const weightMap = {
    thin: 100, hairline: 100, extralight: 200, ultralight: 200,
    light: 300, regular: 400, normal: 400, book: 400,
    medium: 500, semibold: 600, demibold: 600, bold: 700,
    extrabold: 800, ultrabold: 800, black: 900, heavy: 900
  };
  const name = style.toLowerCase().replace(/italic|oblique/g, '').replace(/[\s_-]/g, '') || 'regular';
  return weightMap[name] || null;
}

/**
 * Emit a self-contained BAT with a readable PowerShell payload. Font names are
 * serialized as data, never interpolated into cmd.exe or PowerShell commands.
 */
function getFontDownloaderBatchScript(fonts) {
  const requests = fonts.map(font => {
    const familyKey = font.family.toLowerCase().replace(/[\s_-]/g, '');
    const alibaba = familyKey === 'alibabapuhuiti' || font.family === '阿里巴巴普惠体';
    const alibabaStyle = ['Light', 'Regular', 'Medium', 'Bold', 'Heavy']
      .find(style => style.toLowerCase() === font.style.toLowerCase());
    const face = `Alibaba-PuHuiTi-${alibabaStyle}`;
    return {
      family: font.family, style: font.style,
      // This is the naming convention in godot-figma-importer's create_font().
      filename: `${font.family.replace(/ /g, '')}_${font.style.replace(/ /g, '')}.ttf`,
      weight: getFontWeight(font.style), italic: /italic|oblique/i.test(font.style),
      url: alibaba && alibabaStyle ? `https://fonts.alibabadesign.com/AlibabaPuHuiTi/${face}/${face}.ttf` : null,
      manualUrl: /alibaba|普惠/i.test(font.family) ? 'https://www.alibabafonts.com/' : 'https://fonts.google.com/'
    };
  });
  // Keep the payload ASCII so Windows code pages cannot corrupt Chinese font names.
  const fontJSON = JSON.stringify(requests).replace(/[\u007f-\uffff]/g, char =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).replace(/'/g, "''");
  return String.raw`@echo off
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
$requests = ConvertFrom-Json -InputObject '${fontJSON}'
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
`.replace(/\r?\n/g, '\r\n');
}
