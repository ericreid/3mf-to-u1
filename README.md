# 3MF to U1

Browser extension (Chrome + Firefox) that converts `.3mf` files to Snapmaker U1 format. Keeps your multi-color painting and filament assignments intact.

You can use it two ways:
- **Automatic**: Download a `.3mf` from any site and the extension intercepts it, converts it, saves the U1 version
- **Manual**: Click the extension icon, drop in a `.3mf` you already have on disk

Works with files from MakerWorld, Printables, Thingiverse, wherever. Handles Bambu Lab, PrusaSlicer, and standard 3MF formats. Everything runs locally in your browser, nothing gets sent anywhere.

## Features

- Intercepts `.3mf` downloads from any website and converts them before they hit disk
- Click the extension icon to convert local files via drag-and-drop
- Auto-detects Bambu Lab/OrcaSlicer, PrusaSlicer/SuperSlicer, and standard 3MF basematerials
- Recognizes files already configured for U1 and skips the conversion
- Filament mapping UI with color picker (56 presets + hex input) and drag-and-drop slot reordering
- Enables Tree Supports automatically if the original model uses them
- Preserves the original filename (`Model Name-U1.3mf`)
- Option to download the original unconverted file alongside the conversion
- Handles any number of filaments, maps them to the U1's 4 slots
- Client-side only, your files stay on your machine

## How It Works

### Automatic (download interception)

1. Browse models on any 3D printing site
2. Click download on a `.3mf` file
3. The extension catches it and opens the converter
4. Check the filament colors and types (auto-matched to U1 profiles)
5. Hit **Convert & Download**
6. Open the result in Snapmaker Orca for slicing

If the file is already set up for U1, the extension tells you. You can download it as-is or adjust colors if you want.

### Manual (local files)

1. Click the extension icon in the toolbar
2. Drop a `.3mf` onto the drop zone, or click to browse
3. Adjust the filament mapping
4. Hit **Convert**

## Installation

### Chrome

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/3mf-to-u1/doldcglleomcokhogkmlmdgfbcnaaenk), or grab the Chrome ZIP from the [Releases page](https://github.com/ericreid/3mf-to-u1/releases/latest) and load it manually:

1. Unzip it
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the unzipped folder

### Firefox

Install from [Firefox Add-ons](https://addons.mozilla.org/addon/3mf-to-u1-converter/), or grab the Firefox ZIP from the [Releases page](https://github.com/ericreid/3mf-to-u1/releases/latest) and load it manually:

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the downloaded ZIP file

### From Source

```bash
git clone https://github.com/ericreid/3mf-to-u1.git
npm run build  # produces dist/3mf-to-u1-chrome-vX.X.X.zip and dist/3mf-to-u1-firefox-vX.X.X.zip
```

### Permissions

| Permission | Why |
|------------|-----|
| `downloads` | Intercept `.3mf` downloads and save converted files |
| `storage` | Persist your preferences |
| `<all_urls>` | Fetch `.3mf` files from any site's CDN (the service worker needs this to bypass CORS) |

## Configuration

Right-click the extension icon, then **Options**:

- **Interception Mode**: Auto (recommended), Click Intercept, or Post-Process
- **Default Filament Type**: PLA, PETG-HF, ABS, or TPU
- **Auto-convert**: Skip the mapping UI for single-color files

## Supported Formats

| Source Slicer | How it's detected |
|---------------|-----------------|
| Bambu Lab / OrcaSlicer | `slice_info.config` XML or `project_settings.config` JSON |
| PrusaSlicer / SuperSlicer | `Slic3r_PE.config` or `PrusaSlicer.config` INI files |
| Standard 3MF | `<basematerials>` in `3D/3dmodel.model` |
| Unknown / Generic | Falls back to single white PLA filament |

Files already targeting U1 are detected automatically and you'll get a heads up instead of a redundant conversion.

## Technical Details

### What the converter does

A `.3mf` file is a ZIP archive. The extension modifies three metadata files inside it:

1. **`slice_info.config`**: Updates printer model to Snapmaker U1, remaps filament entries
2. **`model_settings.config`**: Remaps extruder assignments to match the new filament slots
3. **`project_settings.config`**: Replaces with the U1 printer profile (0.20mm Standard), sets filament colors/types/profiles

All geometry, color painting data, and other files stay untouched.

### Architecture

```
Service Worker (src/service-worker.js)
  └── Intercepts .3mf downloads from any site
  └── Fetches files (CORS-exempt)
  └── Stores file data in IndexedDB
  └── Opens popup window

Popup (src/popup/)
  ├── Drop zone for manual file selection (when no intercepted download)
  ├── Reads intercepted file data from IndexedDB
  ├── Detects if file is already Snapmaker U1
  ├── Analyzes filaments (src/lib/analyzer.js)
  ├── Shows mapping UI
  ├── Converts metadata (src/lib/converter.js)
  └── Downloads the converted file via blob URL

Content Script (src/content-script.js)
  └── Optional: intercepts download button clicks on supported sites
```

### Project Structure

```
3mf-to-u1/
├── manifest.json              # WebExtension Manifest V3
├── src/
│   ├── service-worker.js      # Background: download interception + file fetching
│   ├── content-script.js      # Click interception on supported sites
│   ├── lib/
│   │   ├── analyzer.js        # Multi-format filament parser (Bambu, Prusa, 3MF standard)
│   │   ├── converter.js       # 3-phase conversion engine
│   │   ├── file-store.js      # IndexedDB helper for SW ↔ popup data transfer
│   │   ├── color-utils.js     # Color normalization utilities
│   │   ├── constants.js       # Shared constants
│   │   ├── tokens.css         # Shared design tokens (CSS variables)
│   │   ├── template-settings.js  # U1 printer profile (auto-generated)
│   │   └── filament-profiles.js  # Available filament types (auto-generated)
│   ├── popup/                 # Filament mapping UI + drop zone
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   └── options/               # Extension settings
│       ├── options.html
│       ├── options.css
│       └── options.js
├── vendor/
│   └── jszip.min.js           # JSZip v3.10.1 (ZIP read/write)
└── icons/                     # Extension icons + promo banner
```

## Limitations

- The U1 has 4 physical filament slots. Files with more filaments work fine, you use the mapping UI to pick which colors go where.
- You still need to slice the converted file in Snapmaker Orca before printing.
- Slicer-specific features like ironing or fuzzy skin get replaced with the U1's 0.20mm Standard profile.

## Derived From

This started as a client-side port of [bl2u1](https://github.com/josuanbn/bl2u1) by [@josuanbn](https://github.com/josuanbn), which is a Flask web app that does the same conversion server-side. I ported the core conversion logic from Python to JavaScript and expanded it to handle non-Bambu slicer formats.

## License

Licensed under **GPLv3**. See [LICENSE](LICENSE) for details.

This is a derivative work of [bl2u1](https://github.com/josuanbn/bl2u1), which is also GPLv3.

## Support

If this saves you time, [buy me a coffee](https://buymeacoffee.com/ericreid).

## Contributing

PRs and issues are welcome.

Things that could use attention:
- Testing with more slicer formats and model sites
- Edge port
