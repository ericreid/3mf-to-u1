self.MWU1 = self.MWU1 || {};

/**
 * Analyze a .3mf file to extract filament info and support status.
 * Supports multiple slicer formats:
 *   - Bambu Lab / OrcaSlicer (slice_info.config, project_settings.config)
 *   - PrusaSlicer / SuperSlicer (Metadata/Slic3r_PE*.config)
 *   - Standard 3MF (basematerials in 3D model XML)
 *   - Generic fallback (single filament)
 *
 * @param {ArrayBuffer} arrayBuffer - Raw .3mf file bytes
 * @returns {Promise<{filaments: Array<{id: string, color: string, type: string}>, hasSupport: boolean, zip: JSZip}>}
 */
self.MWU1.analyze = async function(arrayBuffer) {
  const MAX_UNCOMPRESSED = 500 * 1024 * 1024;
  const MAX_ENTRIES = 2000;

  const zip = await JSZip.loadAsync(arrayBuffer);

  // ZIP bomb protection
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new Error(`ZIP has too many entries (${entries.length})`);
  const totalUncompressed = entries.reduce((s, f) => s + (f._data?.uncompressedSize ?? 0), 0);
  if (totalUncompressed > MAX_UNCOMPRESSED) throw new Error('ZIP uncompressed size exceeds safety limit');

  const normalizeColor = self.MWU1.normalizeColor;
  let filaments = [];
  let hasSupport = false;

  // Check if the file already targets Snapmaker U1
  const isAlreadyU1 = await detectU1Target(zip);

  // ---- Strategy 1: Bambu Lab / OrcaSlicer ----
  filaments = await parseBambuFilaments(zip, normalizeColor);
  if (filaments.length > 0) {
    hasSupport = await detectBambuSupport(zip);
    return { filaments, hasSupport, isAlreadyU1, zip };
  }

  // ---- Strategy 2: PrusaSlicer / SuperSlicer ----
  filaments = await parsePrusaFilaments(zip, normalizeColor);
  if (filaments.length > 0) {
    hasSupport = await detectPrusaSupport(zip);
    return { filaments, hasSupport, isAlreadyU1, zip };
  }

  // ---- Strategy 3: Standard 3MF basematerials ----
  filaments = await parse3mfBaseMaterials(zip, normalizeColor);
  if (filaments.length > 0) {
    return { filaments, hasSupport: false, isAlreadyU1, zip };
  }

  // ---- Strategy 4: Fallback — single default filament ----
  filaments = [{ id: '1', color: '#FFFFFF', type: 'PLA' }];
  return { filaments, hasSupport: false, isAlreadyU1, zip };
};

/**
 * Parse filaments from Bambu Lab / OrcaSlicer metadata.
 * Checks slice_info.config XML first, then project_settings.config JSON.
 */
async function parseBambuFilaments(zip, normalizeColor) {
  const filaments = [];

  // Try slice_info.config XML
  const sliceInfoFile = zip.file('Metadata/slice_info.config');
  if (sliceInfoFile) {
    const xmlStr = await sliceInfoFile.async('string');
    const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
    for (const fil of doc.querySelectorAll('filament')) {
      filaments.push({
        id: fil.getAttribute('id'),
        color: normalizeColor(fil.getAttribute('color') || ''),
        type: fil.getAttribute('type') || 'PLA',
      });
    }
    if (filaments.length > 0) return filaments;
  }

  // Try project_settings.config JSON
  const settingsFile = zip.file('Metadata/project_settings.config');
  if (settingsFile) {
    try {
      const cfg = JSON.parse(await settingsFile.async('string'));
      const colors = cfg.filament_colour || [];
      const types = cfg.filament_type || [];
      if (colors.length > 0) {
        colors.forEach((color, i) => {
          filaments.push({
            id: String(i + 1),
            color: normalizeColor(color),
            type: types[i] || 'PLA',
          });
        });
      }
    } catch {}
  }

  return filaments;
}

/** Detect support settings from Bambu metadata. */
async function detectBambuSupport(zip) {
  const settingsFile = zip.file('Metadata/project_settings.config');
  if (!settingsFile) return false;
  try {
    const cfg = JSON.parse(await settingsFile.async('string'));
    const diff = cfg.different_settings_to_system || [];
    return diff.some(s => typeof s === 'string' && s.includes('enable_support'));
  } catch {
    return false;
  }
}

/**
 * Parse filaments from PrusaSlicer / SuperSlicer config files.
 * These slicers store config as INI-style key=value pairs in Metadata/Slic3r_PE*.config
 * or Metadata/PrusaSlicer.config.
 */
async function parsePrusaFilaments(zip, normalizeColor) {
  // Find the Prusa/Slic3r config file
  const configNames = [
    'Metadata/Slic3r_PE.config',
    'Metadata/Slic3r_PE_model.config',
    'Metadata/PrusaSlicer.config',
  ];

  let configStr = null;
  for (const name of configNames) {
    const file = zip.file(name);
    if (file) {
      configStr = await file.async('string');
      break;
    }
  }
  if (!configStr) return [];

  // Parse INI-style config: look for colors and filament_type.
  // PrusaSlicer stores meaningful colors in extruder_colour, while filament_colour
  // is often a generic placeholder. SuperSlicer is the opposite — extruder_colour
  // is empty and filament_colour has the real values. Prefer extruder_colour.
  const filaments = [];
  const extruderColors = parseIniArray(configStr, 'extruder_colour');
  const filamentColors = parseIniArray(configStr, 'filament_colour');
  const colors = extruderColors.length > 0 ? extruderColors : filamentColors;
  const types = parseIniArray(configStr, 'filament_type');

  if (colors.length > 0) {
    colors.forEach((color, i) => {
      filaments.push({
        id: String(i + 1),
        color: normalizeColor(color),
        type: types[i] || 'PLA',
      });
    });
  } else if (types.length > 0) {
    // Has types but no colors — use defaults
    types.forEach((type, i) => {
      filaments.push({
        id: String(i + 1),
        color: '#FFFFFF',
        type: type || 'PLA',
      });
    });
  }

  return filaments;
}

/** Parse a semicolon-separated array value from INI-style config (PrusaSlicer format). */
function parseIniArray(configStr, key) {
  // Match lines like: filament_colour = #FF0000;#00FF00;#0000FF
  // SuperSlicer/PrusaSlicer prefix every line with "; " so account for that
  const regex = new RegExp('^;?\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*(.+)$', 'm');
  const match = configStr.match(regex);
  if (!match) return [];
  return match[1].split(';').map(s => s.trim()).filter(Boolean);
}

/** Detect support from PrusaSlicer config. */
async function detectPrusaSupport(zip) {
  const configNames = ['Metadata/Slic3r_PE.config', 'Metadata/PrusaSlicer.config'];
  for (const name of configNames) {
    const file = zip.file(name);
    if (!file) continue;
    try {
      const str = await file.async('string');
      const match = str.match(/^;?\s*support_material\s*=\s*(\d+)/m);
      if (match && match[1] !== '0') return true;
    } catch {}
  }
  return false;
}

/**
 * Parse filaments from standard 3MF basematerials in the model XML.
 * The 3MF spec defines <basematerials> with <base> children in the model file.
 */
async function parse3mfBaseMaterials(zip, normalizeColor) {
  // Find the 3D model file (usually 3D/3dmodel.model)
  const modelFile = zip.file('3D/3dmodel.model');
  if (!modelFile) return [];

  // Only read the first 100KB — basematerials are near the top, geometry is huge
  const fullStr = await modelFile.async('string');
  const headerStr = fullStr.slice(0, 100000);

  const doc = new DOMParser().parseFromString(headerStr, 'text/xml');

  // Look for <basematerials> > <base> elements
  const filaments = [];
  const bases = doc.querySelectorAll('basematerials base, basematerials Base');
  if (bases.length === 0) return [];

  bases.forEach((base, i) => {
    const color = base.getAttribute('displaycolor') || base.getAttribute('color') || '';
    const name = base.getAttribute('name') || 'PLA';
    // Try to extract filament type from the name (e.g., "Generic PLA" → "PLA")
    const type = inferTypeFromName(name);
    filaments.push({
      id: String(i + 1),
      color: normalizeColor(color),
      type,
    });
  });

  return filaments;
}

/**
 * Detect if the file already targets Snapmaker U1.
 * Checks for "Snapmaker" in printer model ID or filament settings IDs.
 */
async function detectU1Target(zip) {
  // Check slice_info.config for printer_model_id
  const sliceFile = zip.file('Metadata/slice_info.config');
  if (sliceFile) {
    try {
      const str = await sliceFile.async('string');
      if (str.includes('Snapmaker U1')) return true;
    } catch {}
  }

  // Check project_settings.config for Snapmaker filament profiles
  const settingsFile = zip.file('Metadata/project_settings.config');
  if (settingsFile) {
    try {
      const cfg = JSON.parse(await settingsFile.async('string'));
      const ids = cfg.filament_settings_id || [];
      if (ids.some(id => typeof id === 'string' && id.includes('Snapmaker'))) return true;
    } catch {}
  }

  return false;
}

/** Infer a filament type from a material name string. */
function inferTypeFromName(name) {
  const up = name.toUpperCase();
  if (up.includes('PETG')) return 'PETG-HF';
  if (up.includes('ABS')) return 'ABS';
  if (up.includes('TPU')) return 'TPU';
  if (up.includes('PLA')) return 'PLA';
  return 'PLA'; // default
}
