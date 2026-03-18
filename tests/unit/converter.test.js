import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  buildBambuSliceInfoZip,
  buildBambuSettingsZip,
  buildTraversalZip,
} from '../helpers/zip-builder.js';

const { analyze, convert } = globalThis.MWU1;

/** Convert Blob to ArrayBuffer (jsdom's Blob lacks .arrayBuffer()). */
function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

async function convertFixture(buf, outputSlots, mapping, hasSupport = false) {
  const analysis = await analyze(buf);
  const blob = await convert({
    zip: analysis.zip,
    outputSlots,
    mapping,
    hasSupport: hasSupport || analysis.hasSupport,
  });
  const outputBuf = await blobToArrayBuffer(blob);
  const outputZip = await JSZip.loadAsync(outputBuf);
  return outputZip;
}

describe('converter', () => {
  describe('slice_info.config transformation', () => {
    it('replaces printer_model_id with Snapmaker U1', async () => {
      const buf = await buildBambuSliceInfoZip([
        { id: '1', color: '#FF0000', type: 'PLA' },
      ]);
      const output = await convertFixture(
        buf,
        [{ color: '#FF0000', type: 'PLA' }],
        { '1': 0 }
      );

      const xml = await output.file('Metadata/slice_info.config').async('string');
      expect(xml).toContain('Snapmaker U1');
      expect(xml).not.toContain('Bambu Lab');
    });

    it('remaps filament colors and types', async () => {
      const buf = await buildBambuSliceInfoZip([
        { id: '1', color: '#FF0000', type: 'PLA' },
        { id: '2', color: '#00FF00', type: 'PLA' },
      ]);
      const output = await convertFixture(
        buf,
        [{ color: '#0000FF', type: 'ABS' }, { color: '#FFFF00', type: 'TPU' }],
        { '1': 0, '2': 1 }
      );

      const xml = await output.file('Metadata/slice_info.config').async('string');
      expect(xml).toContain('#0000FF');
      expect(xml).toContain('ABS');
      expect(xml).toContain('#FFFF00');
      expect(xml).toContain('TPU');
    });
  });

  describe('model_settings.config transformation', () => {
    it('remaps extruder values', async () => {
      const buf = await buildBambuSliceInfoZip([
        { id: '1', color: '#FF0000', type: 'PLA' },
        { id: '2', color: '#00FF00', type: 'PLA' },
      ]);
      // Map filament 1 → slot 1, filament 2 → slot 0 (swap)
      const output = await convertFixture(
        buf,
        [{ color: '#00FF00', type: 'PLA' }, { color: '#FF0000', type: 'PLA' }],
        { '1': 1, '2': 0 }
      );

      const xml = await output.file('Metadata/model_settings.config').async('string');
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const extruders = [...doc.querySelectorAll('metadata[key="extruder"]')].map(
        m => m.getAttribute('value')
      );
      // Original id 1 mapped to slot index 1 → extruder "2"
      // Original id 2 mapped to slot index 0 → extruder "1"
      expect(extruders).toContain('1');
      expect(extruders).toContain('2');
    });
  });

  describe('project_settings.config transformation', () => {
    it('sets correct filament colours as RGBA', async () => {
      const buf = await buildBambuSliceInfoZip([
        { id: '1', color: '#FF0000', type: 'PLA' },
      ]);
      const output = await convertFixture(
        buf,
        [{ color: '#FF0000', type: 'PLA' }],
        { '1': 0 }
      );

      const json = JSON.parse(await output.file('Metadata/project_settings.config').async('string'));
      expect(json.filament_colour[0]).toBe('#FF0000FF');
    });

    it('maps filament types to correct settings IDs', async () => {
      const buf = await buildBambuSliceInfoZip([
        { id: '1', color: '#FF0000', type: 'PLA' },
      ]);
      const output = await convertFixture(
        buf,
        [{ color: '#FF0000', type: 'PLA' }],
        { '1': 0 }
      );

      const json = JSON.parse(await output.file('Metadata/project_settings.config').async('string'));
      expect(json.filament_settings_id[0]).toBe('Snapmaker PLA SnapSpeed @U1');
    });

    it('applies support delta when hasSupport is true', async () => {
      const buf = await buildBambuSettingsZip(
        [{ color: '#FF0000FF', type: 'PLA' }],
        { hasSupport: true }
      );
      const output = await convertFixture(
        buf,
        [{ color: '#FF0000', type: 'PLA' }],
        { '1': 0 },
        true
      );

      const json = JSON.parse(await output.file('Metadata/project_settings.config').async('string'));
      expect(json.enable_support).toBe('1');
    });
  });

  describe('ZIP assembly', () => {
    it('preserves geometry files unchanged', async () => {
      const buf = await buildBambuSliceInfoZip([
        { id: '1', color: '#FF0000', type: 'PLA' },
      ]);
      const output = await convertFixture(
        buf,
        [{ color: '#FF0000', type: 'PLA' }],
        { '1': 0 }
      );

      const model = await output.file('3D/3dmodel.model').async('string');
      expect(model).toBe('<model />');
    });

    it('excludes path traversal entries', async () => {
      const buf = await buildTraversalZip();
      const analysis = await analyze(buf);
      const blob = await convert({
        zip: analysis.zip,
        outputSlots: [{ color: '#FF0000', type: 'PLA' }],
        mapping: { '1': 0 },
        hasSupport: false,
      });

      const outputZip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
      const paths = Object.keys(outputZip.files);
      expect(paths).not.toContain('../evil.txt');
      expect(paths).not.toContain('/absolute.txt');
    });

    it('has exactly one XML declaration per file', async () => {
      const buf = await buildBambuSliceInfoZip([
        { id: '1', color: '#FF0000', type: 'PLA' },
      ]);
      const output = await convertFixture(
        buf,
        [{ color: '#FF0000', type: 'PLA' }],
        { '1': 0 }
      );

      const sliceInfo = await output.file('Metadata/slice_info.config').async('string');
      const declarations = sliceInfo.match(/<\?xml/g) || [];
      expect(declarations).toHaveLength(1);

      const modelSettings = await output.file('Metadata/model_settings.config').async('string');
      const declarations2 = modelSettings.match(/<\?xml/g) || [];
      expect(declarations2).toHaveLength(1);
    });
  });

  describe('missing metadata files', () => {
    it('handles missing slice_info.config without crashing', async () => {
      const zip = new JSZip();
      zip.file('Metadata/project_settings.config', JSON.stringify({
        filament_colour: ['#FF0000FF'],
        filament_type: ['PLA'],
        filament_settings_id: ['Generic PLA'],
      }));
      zip.file('Metadata/model_settings.config', '<?xml version="1.0"?><config></config>');
      zip.file('3D/3dmodel.model', '<model />');
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      const analysis = await analyze(buf);
      const blob = await convert({
        zip: analysis.zip,
        outputSlots: [{ color: '#FF0000', type: 'PLA' }],
        mapping: { '1': 0 },
        hasSupport: false,
      });

      expect(blob).toBeInstanceOf(Blob);
    });
  });
});
