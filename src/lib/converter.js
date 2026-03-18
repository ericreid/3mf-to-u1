self.MWU1 = self.MWU1 || {};

/** Serialize XML doc, ensuring exactly one XML declaration. */
function serializeXML(doc) {
  let xml = new XMLSerializer().serializeToString(doc);
  // Strip any existing declaration that XMLSerializer preserved from the parsed input
  xml = xml.replace(/^<\?xml[^?]*\?>\s*/i, '');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
}

/**
 * Convert a Bambu Lab .3mf to Snapmaker U1 format.
 * Port of the /convert route from app.py:280-402.
 *
 * @param {Object} params
 * @param {JSZip} params.zip - Pre-parsed JSZip instance (from analyze)
 * @param {Array<{color: string, type: string}>} params.outputSlots - User-configured output slots
 * @param {Object<string, number>} params.mapping - Input filament ID → output slot index
 * @param {boolean} params.hasSupport - Whether the original file uses supports
 * @returns {Promise<Blob>} The converted .3mf file
 */
self.MWU1.convert = async function({ zip, outputSlots, mapping, hasSupport }) {
  const { MIN_FILAMENTS, DUMMY_SLOT_COLOR, DUMMY_SLOT_TYPE } = self.MWU1;

  // Build id_mapping: input filament ID → new 1-based ID string
  const idMapping = {};
  for (const [fid, slotIdx] of Object.entries(mapping)) {
    idMapping[fid] = String(slotIdx + 1);
  }

  // Run XML transformations in parallel (independent file reads)
  const [newSliceInfo, newModelSettings] = await Promise.all([
    modifySliceInfo(zip, outputSlots, mapping, MIN_FILAMENTS, DUMMY_SLOT_COLOR, DUMMY_SLOT_TYPE),
    modifyModelSettings(zip, idMapping),
  ]);
  const newProjectSettings = buildProjectSettings(outputSlots, hasSupport);

  // Build output ZIP — copy entries in parallel, substitute modified files
  // Only include substitutions for files that existed and were successfully modified
  const substitutions = {};
  if (newSliceInfo !== null) substitutions['Metadata/slice_info.config'] = newSliceInfo;
  if (newModelSettings !== null) substitutions['Metadata/model_settings.config'] = newModelSettings;
  substitutions['Metadata/project_settings.config'] = newProjectSettings;

  const entries = Object.entries(zip.files).filter(([path, file]) => {
    if (file.dir) return false;
    const safe = path.replace(/\\/g, '/');
    return !safe.startsWith('..') && !safe.startsWith('/');
  });

  // Process entries sequentially to avoid holding all decompressed buffers in memory at once
  const output = new JSZip();
  for (const [path, file] of entries) {
    if (path in substitutions) {
      output.file(path, substitutions[path]);
    } else {
      output.file(path, await file.async('uint8array'));
    }
  }

  return output.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/octet-stream' });
};

/**
 * Modify slice_info.config XML.
 * Port of app.py:284-337.
 */
async function modifySliceInfo(zip, outputSlots, mapping, MIN_FILAMENTS, DUMMY_COLOR, DUMMY_TYPE) {
  const sliceFile = zip.file('Metadata/slice_info.config');
  if (!sliceFile) return null; // file doesn't exist — caller will skip substitution
  let xmlStr = await sliceFile.async('string');

  // Replace printer model ID (raw string, before parsing)
  xmlStr = xmlStr.replace(
    /key="printer_model_id" value="[^"]*"/,
    'key="printer_model_id" value="Snapmaker U1"'
  );

  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
  const parent = doc.querySelector('plate') || doc.documentElement;

  // Get direct <filament> children only (not descendants)
  const existingNodes = Array.from(parent.children).filter(n => n.tagName === 'filament');

  const seenSlots = new Set();
  for (const node of existingNodes) {
    const oldId = node.getAttribute('id');
    if (!(oldId in mapping)) {
      parent.removeChild(node);
      continue;
    }
    const slotIdx = mapping[oldId];
    if (seenSlots.has(slotIdx)) {
      parent.removeChild(node); // duplicate
      continue;
    }
    seenSlots.add(slotIdx);
    const slot = outputSlots[slotIdx];
    node.setAttribute('id', String(slotIdx + 1));
    node.setAttribute('color', slot.color);
    node.setAttribute('type', slot.type);
  }

  // Add nodes for output slots without corresponding input
  for (let i = 0; i < outputSlots.length; i++) {
    if (seenSlots.has(i)) continue;
    const el = doc.createElement('filament');
    el.setAttribute('id', String(i + 1));
    el.setAttribute('type', outputSlots[i].type);
    el.setAttribute('color', outputSlots[i].color);
    el.setAttribute('used_m', '0');
    el.setAttribute('used_g', '0');
    parent.appendChild(el);
  }

  // Pad to MIN_FILAMENTS with dummy entries
  let counter = outputSlots.length + 1;
  while (counter <= MIN_FILAMENTS) {
    const dummy = doc.createElement('filament');
    dummy.setAttribute('id', String(counter));
    dummy.setAttribute('type', DUMMY_TYPE);
    dummy.setAttribute('color', DUMMY_COLOR);
    dummy.setAttribute('used_m', '0');
    dummy.setAttribute('used_g', '0');
    parent.appendChild(dummy);
    counter++;
  }

  return serializeXML(doc);
}

/**
 * Modify model_settings.config XML.
 * Port of app.py:339-350.
 */
async function modifyModelSettings(zip, idMapping) {
  const modelFile = zip.file('Metadata/model_settings.config');
  if (!modelFile) return null;
  const xmlStr = await modelFile.async('string');
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');

  for (const meta of doc.querySelectorAll('metadata[key="extruder"]')) {
    const oldVal = meta.getAttribute('value');
    if (oldVal in idMapping) {
      meta.setAttribute('value', idMapping[oldVal]);
    }
  }

  return serializeXML(doc);
}

/**
 * Build new project_settings.config JSON.
 * Port of app.py:352-386.
 */
function buildProjectSettings(outputSlots, hasSupport) {
  const { MIN_FILAMENTS, DEFAULT_FILAMENT_PROFILE, DUMMY_SLOT_COLOR, DUMMY_SLOT_TYPE,
          BASE_TEMPLATE, SUPPORT_DELTA, FILAMENT_PROFILES, toRGBA } = self.MWU1;

  // Deep clone base template
  const combined = JSON.parse(JSON.stringify(BASE_TEMPLATE));

  // Apply support delta if needed
  if (hasSupport) {
    Object.assign(combined, JSON.parse(JSON.stringify(SUPPORT_DELTA)));
  }

  const newColors = [];
  const newTypes = [];

  for (const slot of outputSlots) {
    newColors.push(toRGBA(slot.color));
    newTypes.push(slot.type);
  }

  // Pad to MIN_FILAMENTS
  while (newColors.length < MIN_FILAMENTS) {
    newColors.push(DUMMY_SLOT_COLOR);
    newTypes.push(DUMMY_SLOT_TYPE);
  }

  const numFilaments = Math.max(outputSlots.length, MIN_FILAMENTS);

  combined.filament_colour = newColors;
  combined.filament_type = newTypes;

  // Build filament_settings_id from profiles
  const profileMap = {};
  for (const p of FILAMENT_PROFILES) {
    profileMap[p.type] = p.settings_id;
  }
  const defaultProfile = FILAMENT_PROFILES[0]?.settings_id || DEFAULT_FILAMENT_PROFILE;
  combined.filament_settings_id = newTypes.map(t => profileMap[t] || defaultProfile);

  // Normalize ALL filament_* arrays to match filament count
  for (const [key, val] of Object.entries(combined)) {
    if (key.startsWith('filament_') && Array.isArray(val) && val.length > 0 && val.length !== numFilaments) {
      if (val.length < numFilaments) {
        while (val.length < numFilaments) val.push(val[val.length - 1]);
      } else {
        combined[key] = val.slice(0, numFilaments);
      }
    }
  }

  return JSON.stringify(combined, null, 4);
}
