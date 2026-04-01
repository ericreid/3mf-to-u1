#!/usr/bin/env node
/**
 * Build script that produces Chrome and Firefox extension ZIPs from the same source.
 * Usage: node scripts/build.js [version]
 * Version defaults to manifest.json version if not specified.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Files/dirs to include in the extension ZIP
const INCLUDE = [
  'manifest.json',
  'src',
  'vendor',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

// Read base manifest
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = process.argv[2] || manifest.version;

// Firefox-specific manifest modifications
function buildFirefoxManifest(base) {
  const ff = { ...base };

  // Firefox uses background.scripts instead of service_worker
  ff.background = { scripts: ['src/lib/file-store.js', 'src/service-worker.js'] };

  // Add gecko settings
  ff.browser_specific_settings = {
    gecko: {
      id: '3mf-to-u1@ericreid.com',
      strict_min_version: '142.0',
      data_collection_permissions: {
        required: ["none"],
      },
    },
  };

  // Remove options_page (Chrome-only), use options_ui for Firefox
  delete ff.options_page;
  ff.options_ui = {
    page: 'src/options/options.html',
    open_in_tab: true,
  };

  return ff;
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      if (child === '.DS_Store') continue;
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function buildZip(name, manifestObj) {
  const tmp = path.join(DIST, '_tmp');
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });

  // Copy included files
  for (const item of INCLUDE) {
    if (item === 'manifest.json') continue; // handled separately
    const src = path.join(ROOT, item);
    const dest = path.join(tmp, item);
    if (fs.existsSync(src)) copyRecursive(src, dest);
  }

  // Write manifest
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifestObj, null, 2));

  // Zip
  const zipPath = path.join(DIST, name);
  execSync(`cd "${tmp}" && zip -r "${zipPath}" . -x "*.DS_Store"`, { stdio: 'inherit' });

  // Clean up
  fs.rmSync(tmp, { recursive: true });
  return zipPath;
}

function build() {
  if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  // Chrome
  const chromeZip = `3mf-to-u1-chrome-v${version}.zip`;
  console.log(`Building ${chromeZip}...`);
  buildZip(chromeZip, manifest);

  // Firefox
  const firefoxZip = `3mf-to-u1-firefox-v${version}.zip`;
  console.log(`Building ${firefoxZip}...`);
  buildZip(firefoxZip, buildFirefoxManifest(manifest));

  console.log(`\nDone. Output in dist/:`);
  console.log(`  ${chromeZip}`);
  console.log(`  ${firefoxZip}`);
}

build();
