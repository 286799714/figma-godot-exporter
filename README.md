# Figma to Godot

<img width="232" alt="image" src="https://github.com/user-attachments/assets/d10d72c2-548a-4dc2-863d-aabdac7591d7" />

This plugin exports a Figma project (or page, or frame) as a collection of Godot-ready assets.

These assets can be used alongside the [Godot Figma Importer](https://github.com/morganwalkup/godot-figma-importer) to create in-game UI.

Exported assets include:
- Project or page structure as a JSON file.
- All images in the project or page as PNG files.
- A batch script to download all fonts used in the project or page.

## Get started

No install or build steps are required. ZIP export loads the fflate library from unpkg.com and needs an internet connection.

1. Clone this repository to your local machine.
1. Open the Figma desktop app.
1. Go to `Plugins > Development > Import plugin from manifest...`
1. Select the `manifest.json` file in this repository.
1. Click `Import`.
1. To run the plugin, go to `Plugins > Development > Figma to Godot`.

## Using the plugin

1. Choose an export type of "Project", "Page", or "Frame". Select exactly one frame to enable "Frame"; the plugin tracks selection changes while it is open.
1. Click one of the export buttons - "Export all as ZIP", "JSON only", "Images only", or "Fonts only".
1. If you chose "Export all as ZIP", unzip the file and move the contents to your Godot project.
1. To get font files on Windows, run `figma_download_fonts.bat`. It checks installed TTF fonts by their family and style, including system fonts, per-user fonts, and registered font paths. Missing Alibaba PuHuiTi 1.0 fonts download from Alibaba's official font server; other supported fonts use Google Fonts.

If an export fails, the plugin shows the error below the buttons and lets you retry. If the ZIP library cannot load, reopen the plugin with an internet connection or use the individual export buttons. Layouts with no images can still be exported as ZIP files.

After updating the plugin files, close and reopen the plugin in Figma. No build is needed.

## Get fonts into Godot

The batch script uses Windows PowerShell and saves a `fonts` folder beside itself, regardless of the terminal's working directory. Move that folder into your Godot project and select it in the importer. Filenames follow the importer's convention: `Alibaba PuHuiTi` / `Bold` becomes `AlibabaPuHuiTi_Bold.ttf`.

The script prints ready/missing counts and writes `fonts/font-download-report.json`. It returns a nonzero exit code if any font is missing. For unattended use, run:

```bat
figma_download_fonts.bat --no-pause
```

If a font cannot be downloaded, get the exact family, version, and weight from its publisher, place the TTF in the script's `fonts` folder, and run the script again. It recognizes the font metadata even when the original filename differs. The [Alibaba font site](https://www.alibabafonts.com/) provides PuHuiTi; versions 1.0, 2.0, and 3.0 are not interchangeable.

Only matching TrueType files are accepted. Web-font subsets, HTML error pages, WOFF files, and OTF/CFF files are not renamed to `.ttf`. Fonts unavailable on Google Fonts are reported as missing with a source link instead of a success message.

## Run regression checks

With Node.js 18 or newer, run:

```sh
node --test tests/export.test.cjs tests/font-downloader.test.cjs
```

These tests simulate the Figma API and UI message flow. They cover dynamic-page component reads, export scopes, mixed fills, empty ZIP exports, selection changes, and retry behavior. On Windows, they also run the generated PowerShell and BAT scripts to check font matching, consecutive downloads with mocked network responses, missing-font reports, and paths containing Chinese characters. No network is needed for the tests. They do not replace a manual export in Figma.

## Notes

- Credit goes to [mightymochi](https://github.com/mightymochi) for the original [Godot to Figma plugin](https://github.com/mightymochi/figma-to-godot-experiment).
- Component reads use Figma's [dynamic-page async API](https://developers.figma.com/docs/plugins/migrating-to-dynamic-loading/). Exported JSON keeps the `masterComponent` field expected by the Godot importer.
