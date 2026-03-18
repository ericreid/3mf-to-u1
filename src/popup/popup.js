/**
 * Filament mapping popup UI.
 * Handles the full pipeline: load from IndexedDB → analyze → map → convert → download.
 * Runs in a popup window with full DOM access (DOMParser, XMLSerializer, URL.createObjectURL).
 */

const PHYSICAL_SLOTS = self.MWU1.PHYSICAL_SLOTS;
let outputSlots = [];
let slotMapping = {};
let inputFilaments = [];
let availableFilamentTypes = self.MWU1.FILAMENT_PROFILES || [];

// Parsed state for conversion
let parsedZip = null;
let hasSupport = false;
let originalName = 'model';
let isManualMode = false; // true when user picked a local file (vs intercepted download)

const btnConvert = document.getElementById('btn-convert');
const btnOriginal = document.getElementById('btn-original');
const convertIcon = document.getElementById('convert-icon');
const convertLabel = document.getElementById('convert-label');
const loadingText = document.getElementById('loading-text');

/** Resize the popup window to fit its content. */
function resizeToFit() {
  requestAnimationFrame(() => {
    const width = 560;
    const height = Math.min(document.documentElement.scrollHeight + 40, screen.availHeight - 100);
    chrome.windows.getCurrent((win) => {
      chrome.windows.update(win.id, { width, height });
    });
  });
}

/** Escape a string for safe HTML text insertion. */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Download a blob as a file, waiting for completion before returning. */
async function downloadBlob(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  if (chrome.downloads) {
    // Register listener BEFORE starting download to avoid race where
    // download completes before listener is attached
    let downloadId = null;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      }, 60000);
      function listener(delta) {
        if (downloadId !== null && delta.id !== downloadId) return;
        if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        }
      }
      chrome.downloads.onChanged.addListener(listener);
      chrome.downloads.download({ url: blobUrl, filename, saveAs: false }).then(id => {
        downloadId = id;
      });
    });
  } else {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise(r => setTimeout(r, 5000));
  }
  URL.revokeObjectURL(blobUrl);
}

// Track whether we loaded an intercepted file (to clean up on close)
let loadedInterceptedFile = false;
window.addEventListener('beforeunload', () => {
  if (loadedInterceptedFile) {
    chrome.runtime.sendMessage({ action: 'conversion_complete' });
  }
});

// ---- Initialize: check for pending file or show drop zone ----
(async function init() {
  // Check if there's a pending intercepted download in IndexedDB
  const fileData = await self.MWU1.loadFile();
  if (fileData) {
    loadedInterceptedFile = true;
    await processArrayBuffer(fileData.arrayBuffer, fileData.metadata?.originalName || 'model');
  } else {
    // No pending download — show the drop zone for manual file selection
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('drop-zone-state').classList.remove('hidden');
    resizeToFit();
  }
})();

// Cached analysis for "adjust anyway" flow
let cachedAnalysis = null;

/** Process an ArrayBuffer (from either intercepted download or manual file pick). */
async function processArrayBuffer(arrayBuffer, name) {
  try {
    document.getElementById('drop-zone-state').classList.add('hidden');
    document.getElementById('loading-state').classList.remove('hidden');
    loadingText.textContent = 'Analyzing filaments...';

    originalName = name || 'model';

    const analysis = await self.MWU1.analyze(arrayBuffer);
    parsedZip = analysis.zip;
    hasSupport = analysis.hasSupport;
    cachedAnalysis = analysis;

    if (analysis.filaments.length === 0) throw new Error('No filaments found in this file');

    // If already U1, show the "no changes needed" state
    if (analysis.isAlreadyU1) {
      document.getElementById('loading-state').classList.add('hidden');
      document.getElementById('already-u1-state').classList.remove('hidden');
      // Show download button when file came from a website (not manual mode)
      if (!isManualMode) {
        document.getElementById('btn-u1-download').classList.remove('hidden');
      }
      resizeToFit();
      return;
    }

    showMappingUI(analysis.filaments);
  } catch (err) {
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('error-state').classList.remove('hidden');
    document.getElementById('error-message').textContent = err.message || 'Failed to process file';
  }
}

/** Show the mapping UI with filament data. */
function showMappingUI(filaments) {
  renderMappingUI(filaments);
  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('already-u1-state').classList.add('hidden');
  document.getElementById('mapping-ui').classList.remove('hidden');

  if (isManualMode) {
    btnOriginal.classList.add('hidden');
    convertLabel.textContent = 'Convert';
  }
  resizeToFit();
}

// ---- Already U1 actions ----
document.getElementById('btn-close-u1').addEventListener('click', () => window.close());
document.getElementById('btn-adjust-anyway').addEventListener('click', () => {
  if (cachedAnalysis) showMappingUI(cachedAnalysis.filaments);
});
document.getElementById('btn-u1-download').addEventListener('click', async () => {
  const btn = document.getElementById('btn-u1-download');
  if (!parsedZip || btn.disabled) return;
  btn.disabled = true;
  try {
    const blob = await parsedZip.generateAsync({ type: 'blob', mimeType: 'application/octet-stream' });
    await downloadBlob(blob, `${originalName}.3mf`);
    window.close();
  } finally {
    btn.disabled = false;
  }
});

// ---- Manual file selection (drop zone) ----
const dropZone = document.getElementById('drop-zone');
const fileUpload = document.getElementById('file-upload');

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('drag-over'); });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleLocalFile(e.dataTransfer.files[0]);
});
fileUpload.addEventListener('change', (e) => handleLocalFile(e.target.files[0]));

function handleLocalFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.3mf')) {
    document.getElementById('drop-zone-state').classList.add('hidden');
    document.getElementById('error-state').classList.remove('hidden');
    document.getElementById('error-message').textContent = 'Only .3mf files are supported';
    return;
  }
  const name = file.name.replace(/\.3mf$/i, '');
  const reader = new FileReader();
  reader.onload = () => { isManualMode = true; processArrayBuffer(reader.result, name); };
  reader.onerror = () => {
    document.getElementById('error-state').classList.remove('hidden');
    document.getElementById('error-message').textContent = 'Failed to read file';
  };
  reader.readAsArrayBuffer(file);
}

// ---- Error close / Cancel ----
document.getElementById('btn-close-error').addEventListener('click', () => window.close());
document.getElementById('btn-cancel').addEventListener('click', () => window.close());

// Download original (unconverted) file
btnOriginal.addEventListener('click', async () => {
  if (!parsedZip || btnOriginal.disabled) return;
  btnOriginal.disabled = true;
  try {
    const blob = await parsedZip.generateAsync({ type: 'blob', mimeType: 'application/octet-stream' });
    await downloadBlob(blob, `${originalName}.3mf`);
  } finally {
    btnOriginal.disabled = false;
  }
});

// Inline conversion error
function showConvertError(msg) {
  const el = document.getElementById('convert-error');
  document.getElementById('convert-error-msg').textContent = msg;
  el.classList.add('visible');
}
document.getElementById('convert-error-dismiss').addEventListener('click', () => {
  document.getElementById('convert-error').classList.remove('visible');
});

function setConverting(active) {
  btnConvert.disabled = active;
  btnOriginal.disabled = active;
  if (active) {
    convertIcon.className = 'fa-solid fa-circle-notch fa-spin';
    convertLabel.textContent = 'Converting\u2026';
  } else {
    convertIcon.className = 'fa-solid fa-bolt';
    convertLabel.textContent = isManualMode ? 'Convert' : 'Convert & Download';
  }
}

// ---- Custom color picker popover ----
const PRESET_COLORS = [
  '#FFFFFF', '#F5F5F5', '#CCCCCC', '#AAAAAA', '#888888', '#555555', '#333333', '#000000',
  '#FF0000', '#CC0000', '#880000', '#FF4444', '#FF6B6B', '#E74C3C', '#C0392B', '#8B0000',
  '#FF6600', '#FF8800', '#FFAA00', '#FFD700', '#FFFF00', '#FFC107', '#F39C12', '#E67E22',
  '#00FF00', '#00CC00', '#008800', '#27AE60', '#2ECC71', '#1ABC9C', '#006400', '#228B22',
  '#00FFFF', '#00CCFF', '#0088FF', '#0000FF', '#0000CC', '#000088', '#3498DB', '#2980B9',
  '#FF00FF', '#FF69B4', '#FF1493', '#E91E63', '#9B59B6', '#8E44AD', '#4B0082', '#800080',
  '#8B4513', '#A0522D', '#D2691E', '#CD853F', '#DEB887', '#C9A84C', '#B8860B', '#DAA520',
];
let colorPop = null;
let activeColorSlot = null;
let activeColorSwatch = null;

function closeColorPop() {
  if (colorPop) { colorPop.remove(); colorPop = null; }
  activeColorSlot = null;
  activeColorSwatch = null;
}

function applyColor(hex) {
  if (activeColorSlot === null) return;
  const color = hex.startsWith('#') ? hex : '#' + hex;
  outputSlots[activeColorSlot].color = color;
  if (activeColorSwatch) activeColorSwatch.style.background = color;
  document.querySelectorAll(`.slot-dot-btn[data-slot="${activeColorSlot}"] .slot-dot-inner`).forEach(dot => {
    dot.style.background = color;
  });
  if (colorPop) {
    colorPop.querySelector('.color-pop-preview').style.background = color;
    const inp = colorPop.querySelector('.color-pop-input');
    if (document.activeElement !== inp) inp.value = color.replace('#', '');
    colorPop.querySelectorAll('.color-pop-preset').forEach(p => {
      p.classList.toggle('active', p.dataset.color.toUpperCase() === color.toUpperCase());
    });
  }
}

function openColorPicker(slotIdx, swatchEl) {
  closeColorPop();
  activeColorSlot = slotIdx;
  activeColorSwatch = swatchEl;
  const currentColor = outputSlots[slotIdx].color;

  const pop = document.createElement('div');
  pop.className = 'color-pop';

  const preview = document.createElement('div');
  preview.className = 'color-pop-preview';
  preview.style.background = currentColor;
  pop.appendChild(preview);

  const hexRow = document.createElement('div');
  hexRow.className = 'color-pop-hex-row';
  hexRow.innerHTML = `<span class="color-pop-hash">#</span><input type="text" class="color-pop-input" maxlength="6" spellcheck="false">`;
  hexRow.querySelector('.color-pop-input').value = currentColor.replace('#', '');
  pop.appendChild(hexRow);

  const hexInput = hexRow.querySelector('.color-pop-input');
  hexInput.addEventListener('input', () => {
    const v = hexInput.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
    if (v.length === 6) applyColor('#' + v);
  });
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') closeColorPop();
  });

  const presets = document.createElement('div');
  presets.className = 'color-pop-presets';
  PRESET_COLORS.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'color-pop-preset' + (c.toUpperCase() === currentColor.toUpperCase() ? ' active' : '');
    btn.style.background = c;
    btn.dataset.color = c;
    btn.title = c;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyColor(c);
      hexInput.value = c.replace('#', '');
    });
    presets.appendChild(btn);
  });
  pop.appendChild(presets);

  document.body.appendChild(pop);
  colorPop = pop;

  // Position and clamp to viewport in a single rAF
  const rect = swatchEl.getBoundingClientRect();
  pop.style.top = (rect.bottom + 6) + 'px';
  pop.style.left = rect.left + 'px';

  requestAnimationFrame(() => {
    const popRect = pop.getBoundingClientRect();
    if (popRect.right > window.innerWidth - 8) {
      pop.style.left = (window.innerWidth - popRect.width - 8) + 'px';
    }
    if (popRect.bottom > window.innerHeight - 8) {
      pop.style.top = (rect.top - popRect.height - 6) + 'px';
    }
    hexInput.focus();
    hexInput.select();
  });
}

document.addEventListener('mousedown', (e) => {
  if (colorPop && !colorPop.contains(e.target) && !e.target.closest('.slot-color-trigger')) {
    closeColorPop();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && colorPop) closeColorPop();
});

// ---- Filament type mapping ----
function mapFilamentType(original) {
  if (!original || availableFilamentTypes.length === 0) return availableFilamentTypes[0]?.type || 'PLA';
  const up = original.toUpperCase();
  for (const ft of availableFilamentTypes) {
    if (up.includes(ft.type.toUpperCase().replace(/-HF$/, '').replace(/-/g, ''))) return ft.type;
  }
  return availableFilamentTypes[0]?.type || 'PLA';
}

// ---- Mapping UI ----
function renderMappingUI(filaments) {
  inputFilaments = filaments;
  outputSlots = filaments.map(f => ({ color: f.color, type: mapFilamentType(f.type) }));
  slotMapping = {};
  filaments.forEach((f, i) => { slotMapping[f.id] = i; });

  const hint = document.getElementById('route-hint');
  if (filaments.length > PHYSICAL_SLOTS) {
    hint.textContent = '\u2014 click a dot to route each color to a printer slot';
  } else {
    hint.textContent = '';
  }

  btnConvert.disabled = false;

  const strip = document.getElementById('slots-strip');
  const list = document.getElementById('input-list');
  strip.classList.add('animate-in');
  list.classList.add('animate-in');
  rebuildDOM();
  setTimeout(() => { strip.classList.remove('animate-in'); list.classList.remove('animate-in'); }, 500);
}

function getUsedSlots() {
  const used = new Set();
  for (const fid in slotMapping) used.add(slotMapping[fid]);
  return used;
}

function syncUsedState() {
  const used = getUsedSlots();

  document.querySelectorAll('.printer-slot').forEach(el => {
    const si = +el.querySelector('.slot-color-trigger')?.dataset.slot;
    if (isNaN(si)) return;
    const isUnused = !used.has(si);
    el.classList.toggle('slot-unused', isUnused);
    if (isUnused) {
      el.title = 'No file colors routed here \u2014 this slot will be excluded from the output';
    } else if (si >= PHYSICAL_SLOTS) {
      el.title = 'The U1 has 4 physical slots \u2014 this exceeds that limit';
    } else {
      el.title = '';
    }
    const tag = el.querySelector('.slot-unused-tag');
    if (isUnused && !tag) {
      const t = document.createElement('span');
      t.className = 'slot-unused-tag';
      t.textContent = 'Unused';
      el.appendChild(t);
    } else if (!isUnused && tag) {
      tag.remove();
    }
  });

  document.querySelectorAll('.slot-dot-btn').forEach(d => {
    const si = +d.dataset.slot;
    const isActive = d.classList.contains('active');
    d.classList.toggle('unused', !isActive && !used.has(si));
  });
}

function reorderSlot(fromIdx, toIdx) {
  const [moved] = outputSlots.splice(fromIdx, 1);
  outputSlots.splice(toIdx, 0, moved);

  for (const fid in slotMapping) {
    const old = slotMapping[fid];
    if (old === fromIdx) {
      slotMapping[fid] = toIdx;
    } else if (fromIdx < toIdx && old > fromIdx && old <= toIdx) {
      slotMapping[fid] = old - 1;
    } else if (fromIdx > toIdx && old >= toIdx && old < fromIdx) {
      slotMapping[fid] = old + 1;
    }
  }

  rebuildDOM();
}

function rebuildDOM() {
  buildSlotsStrip();
  buildInputList();
}

// ---- Printer Slots strip ----
function buildSlotsStrip() {
  const strip = document.getElementById('slots-strip');
  strip.innerHTML = '';
  const usedSlots = getUsedSlots();

  outputSlots.forEach((slot, i) => {
    const typeOpts = availableFilamentTypes.map(ft =>
      `<option value="${escapeHtml(ft.type)}"${ft.type === slot.type ? ' selected' : ''}>${escapeHtml(ft.type)}</option>`
    ).join('');

    const isOver = i >= PHYSICAL_SLOTS;
    const isUnused = !usedSlots.has(i);
    const classes = ['printer-slot'];
    if (isOver) classes.push('slot-warn');
    if (isUnused) classes.push('slot-unused');

    const el = document.createElement('div');
    el.className = classes.join(' ');
    el.draggable = true;
    el.dataset.slotIdx = i;
    if (isUnused) el.title = 'No file colors routed here \u2014 this slot will be excluded from the output';
    else if (isOver) el.title = 'The U1 has 4 physical slots \u2014 this exceeds that limit';
    el.innerHTML = `
      <div class="slot-top">
        <span class="slot-num">${i + 1}</span>
        <button class="slot-remove ${outputSlots.length <= 1 ? 'gone' : ''}" data-slot="${i}" aria-label="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
      <button class="color-well-swatch slot-color-trigger" style="background:${escapeHtml(slot.color)}" data-slot="${i}" aria-label="Slot ${i + 1} color"></button>
      <select class="type-select slot-type" data-slot="${i}" aria-label="Slot ${i + 1} type">${typeOpts}</select>
      ${isUnused ? '<span class="slot-unused-tag">Unused</span>' : ''}`;
    strip.appendChild(el);
  });

  // Drag & drop reorder
  strip.querySelectorAll('.printer-slot').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', el.dataset.slotIdx);
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      strip.querySelectorAll('.printer-slot').forEach(s => s.classList.remove('drag-over-left', 'drag-over-right'));
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragIdx = +strip.querySelector('.dragging')?.dataset.slotIdx;
      const targetIdx = +el.dataset.slotIdx;
      if (targetIdx === dragIdx || isNaN(dragIdx)) return;
      el.classList.remove('drag-over-left', 'drag-over-right');
      el.classList.add(dragIdx < targetIdx ? 'drag-over-right' : 'drag-over-left');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over-left', 'drag-over-right');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over-left', 'drag-over-right');
      const dragIdx = +e.dataTransfer.getData('text/plain');
      const targetIdx = +el.dataset.slotIdx;
      if (isNaN(dragIdx) || dragIdx === targetIdx) return;
      reorderSlot(dragIdx, targetIdx);
    });
  });

  // Add button
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-add-slot';
  addBtn.setAttribute('aria-label', 'Add slot');
  addBtn.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
  addBtn.title = 'Add slot';
  strip.appendChild(addBtn);

  // Events — color swatch click + keyboard
  strip.querySelectorAll('.slot-color-trigger').forEach(el => {
    el.addEventListener('click', () => {
      openColorPicker(+el.dataset.slot, el);
    });
  });
  strip.querySelectorAll('.slot-type').forEach(el => {
    el.addEventListener('change', (e) => { outputSlots[+e.target.dataset.slot].type = e.target.value; });
  });
  strip.querySelectorAll('.slot-remove').forEach(el => {
    el.addEventListener('click', (e) => {
      const idx = +e.currentTarget.dataset.slot;
      outputSlots.splice(idx, 1);
      for (const fid in slotMapping) {
        if (slotMapping[fid] === idx) slotMapping[fid] = 0;
        else if (slotMapping[fid] > idx) slotMapping[fid]--;
      }
      rebuildDOM();
    });
  });
  addBtn.addEventListener('click', () => {
    outputSlots.push({ color: '#FFFFFF', type: availableFilamentTypes[0]?.type || 'PLA' });
    rebuildDOM();
  });
}

// ---- File Colors (input rows) ----
function buildInputList() {
  const list = document.getElementById('input-list');
  list.innerHTML = '';
  const usedSlots = getUsedSlots();

  inputFilaments.forEach((fil) => {
    const row = document.createElement('div');
    row.className = 'input-row';

    const dotsHtml = outputSlots.map((s, si) => {
      const active = slotMapping[fil.id] === si;
      const unused = !active && !usedSlots.has(si);
      return `<button class="slot-dot-btn ${active ? 'active' : ''} ${unused ? 'unused' : ''}" data-fil-id="${escapeHtml(fil.id)}" data-slot="${si}" aria-label="Assign to slot ${si + 1}" title="Slot ${si + 1}">
        <span class="slot-dot-inner" style="background:${escapeHtml(s.color)}"></span>
      </button>`;
    }).join('');

    // Use textContent for fil.type to prevent XSS from crafted .3mf files
    row.innerHTML = `
      <span class="input-color-dot" style="background:${escapeHtml(fil.color)}"></span>
      <span class="input-label"></span>
      <i class="fa-solid fa-arrow-right input-arrow" aria-hidden="true"></i>
      <span class="slot-selector">${dotsHtml}</span>`;
    // Set label text safely via textContent (fil.type comes from untrusted ZIP XML)
    const label = row.querySelector('.input-label');
    const strong = document.createElement('strong');
    strong.textContent = fil.type || 'Unknown';
    label.appendChild(strong);
    // Show color hex for disambiguation when multiple filaments share the same type
    const hexSpan = document.createElement('span');
    hexSpan.textContent = ` ${fil.color}`;
    hexSpan.style.cssText = 'font-family:Source Code Pro,monospace;font-size:0.8rem;color:var(--text-dim);margin-left:0.25rem';
    label.appendChild(hexSpan);

    list.appendChild(row);
  });

  list.querySelectorAll('.slot-dot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const filId = btn.dataset.filId;
      const newSlot = +btn.dataset.slot;
      const oldSlot = slotMapping[filId];
      if (newSlot === oldSlot) return;

      slotMapping[filId] = newSlot;

      const row = btn.closest('.input-row');
      row.querySelectorAll('.slot-dot-btn').forEach(d => d.classList.remove('active'));
      btn.classList.add('active');

      syncUsedState();
    });
  });
}

// ---- Convert & Download ----
btnConvert.addEventListener('click', async () => {
  if (btnConvert.disabled || !parsedZip) return;
  if (outputSlots.length === 0) { showConvertError('Add at least one output slot.'); return; }

  // Filter out unused slots and remap indices
  const usedSlots = getUsedSlots();
  const filteredSlots = [];
  const oldToNew = {};
  outputSlots.forEach((s, i) => {
    if (usedSlots.has(i)) {
      oldToNew[i] = filteredSlots.length;
      filteredSlots.push(s);
    }
  });
  const filteredMapping = {};
  for (const fid in slotMapping) {
    const newIdx = oldToNew[slotMapping[fid]];
    if (newIdx !== undefined) {
      filteredMapping[fid] = newIdx;
    }
  }

  if (filteredSlots.length === 0) { showConvertError('No slots are in use.'); return; }

  setConverting(true);
  try {
    const blob = await self.MWU1.convert({
      zip: parsedZip,
      outputSlots: filteredSlots,
      mapping: filteredMapping,
      hasSupport,
    });

    await downloadBlob(blob, `${originalName}-U1.3mf`);
    setConverting(false);
    window.close();
  } catch (err) {
    showConvertError(err.message || 'Conversion failed.');
    setConverting(false);
  }
});
