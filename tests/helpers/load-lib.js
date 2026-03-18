/**
 * Loads the extension's lib files into globalThis.MWU1
 * by evaluating them in dependency order, mimicking the browser's
 * script-tag loading in popup.html.
 */
import JSZip from 'jszip';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// jsdom sets globalThis.self = globalThis
globalThis.JSZip = JSZip;

const libFiles = [
  'src/lib/constants.js',
  'src/lib/color-utils.js',
  'src/lib/filament-profiles.js',
  'src/lib/template-settings.js',
  'src/lib/analyzer.js',
  'src/lib/converter.js',
];

for (const file of libFiles) {
  const code = readFileSync(path.join(ROOT, file), 'utf8');
  new Function('self', code)(globalThis);
}

export const MWU1 = globalThis.MWU1;
