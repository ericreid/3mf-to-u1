import { describe, it, expect } from 'vitest';
import {
  buildBambuSliceInfoZip,
  buildBambuSettingsZip,
  buildPrusaZip,
  build3mfZip,
  buildEmptyZip,
} from '../helpers/zip-builder.js';

const { analyze } = globalThis.MWU1;

describe('analyzer', () => {
  describe('Bambu Lab via slice_info.config', () => {
    it('parses filaments from XML', async () => {
      const buf = await buildBambuSliceInfoZip([
        { id: '1', color: '#FF0000FF', type: 'PLA' },
        { id: '2', color: '#00ff00ff', type: 'PETG' },
      ]);
      const result = await analyze(buf);

      expect(result.filaments).toHaveLength(2);
      expect(result.filaments[0]).toEqual({ id: '1', color: '#FF0000', type: 'PLA' });
      expect(result.filaments[1]).toEqual({ id: '2', color: '#00FF00', type: 'PETG' });
      expect(result.zip).toBeTruthy();
    });
  });

  describe('Bambu Lab via project_settings.config fallback', () => {
    it('parses filaments from JSON when slice_info has no filament nodes', async () => {
      const buf = await buildBambuSettingsZip([
        { color: '#FF0000FF', type: 'PLA' },
        { color: '#0000FFFF', type: 'ABS' },
      ]);
      const result = await analyze(buf);

      expect(result.filaments).toHaveLength(2);
      expect(result.filaments[0].color).toBe('#FF0000');
      expect(result.filaments[0].type).toBe('PLA');
      expect(result.filaments[1].color).toBe('#0000FF');
      expect(result.filaments[1].type).toBe('ABS');
    });

    it('detects support from different_settings_to_system', async () => {
      const buf = await buildBambuSettingsZip(
        [{ color: '#FF0000FF', type: 'PLA' }],
        { hasSupport: true }
      );
      const result = await analyze(buf);
      expect(result.hasSupport).toBe(true);
    });

    it('returns hasSupport false when no support settings', async () => {
      const buf = await buildBambuSettingsZip([{ color: '#FF0000FF', type: 'PLA' }]);
      const result = await analyze(buf);
      expect(result.hasSupport).toBe(false);
    });
  });

  describe('PrusaSlicer', () => {
    it('parses filaments from INI-style config', async () => {
      const buf = await buildPrusaZip(
        ['#FF0000', '#00FF00', '#0000FF'],
        ['PLA', 'PETG', 'ABS']
      );
      const result = await analyze(buf);

      expect(result.filaments).toHaveLength(3);
      expect(result.filaments[0]).toEqual({ id: '1', color: '#FF0000', type: 'PLA' });
      expect(result.filaments[1]).toEqual({ id: '2', color: '#00FF00', type: 'PETG' });
      expect(result.filaments[2]).toEqual({ id: '3', color: '#0000FF', type: 'ABS' });
    });

    it('prefers extruder_colour over filament_colour', async () => {
      const buf = await buildPrusaZip(
        ['#FF8000', '#FF8000', '#FF8000'],
        ['PLA', 'PLA', 'PLA'],
        { extruderColors: ['#000000', '#4BFC1F', '#FFFFFF'] }
      );
      const result = await analyze(buf);

      expect(result.filaments).toHaveLength(3);
      expect(result.filaments[0].color).toBe('#000000');
      expect(result.filaments[1].color).toBe('#4BFC1F');
      expect(result.filaments[2].color).toBe('#FFFFFF');
    });

    it('falls back to filament_colour when extruder_colour is absent', async () => {
      const buf = await buildPrusaZip(
        ['#FF0000', '#00FF00'],
        ['PLA', 'PETG']
      );
      const result = await analyze(buf);

      expect(result.filaments).toHaveLength(2);
      expect(result.filaments[0].color).toBe('#FF0000');
      expect(result.filaments[1].color).toBe('#00FF00');
    });

    it('detects support from support_material setting', async () => {
      const buf = await buildPrusaZip(['#FF0000'], ['PLA'], { hasSupport: true });
      const result = await analyze(buf);
      expect(result.hasSupport).toBe(true);
    });
  });

  describe('Standard 3MF basematerials', () => {
    it('parses filaments from basematerials in model XML', async () => {
      const buf = await build3mfZip([
        { name: 'Generic PLA', color: '#FF0000' },
        { name: 'Generic ABS', color: '#00FF00' },
      ]);
      const result = await analyze(buf);

      expect(result.filaments).toHaveLength(2);
      expect(result.filaments[0].color).toBe('#FF0000');
      expect(result.filaments[0].type).toBe('PLA');
      expect(result.filaments[1].type).toBe('ABS');
    });

    it('infers filament type from material name', async () => {
      const buf = await build3mfZip([
        { name: 'Polymaker PETG', color: '#FFFFFF' },
        { name: 'Flexible TPU', color: '#000000' },
        { name: 'Unknown Material', color: '#888888' },
      ]);
      const result = await analyze(buf);

      expect(result.filaments[0].type).toBe('PETG-HF');
      expect(result.filaments[1].type).toBe('TPU');
      expect(result.filaments[2].type).toBe('PLA'); // default
    });
  });

  describe('Fallback', () => {
    it('returns single PLA filament when no metadata found', async () => {
      const buf = await buildEmptyZip();
      const result = await analyze(buf);

      expect(result.filaments).toHaveLength(1);
      expect(result.filaments[0]).toEqual({ id: '1', color: '#FFFFFF', type: 'PLA' });
      expect(result.hasSupport).toBe(false);
    });
  });

  describe('U1 detection', () => {
    it('detects files already targeting Snapmaker U1', async () => {
      const buf = await buildBambuSliceInfoZip(
        [{ id: '1', color: '#FF0000', type: 'PLA' }],
        { printerModel: 'Snapmaker U1' }
      );
      const result = await analyze(buf);
      expect(result.isAlreadyU1).toBe(true);
    });

    it('returns false for non-U1 files', async () => {
      const buf = await buildBambuSliceInfoZip(
        [{ id: '1', color: '#FF0000', type: 'PLA' }],
        { printerModel: 'Bambu Lab X1 Carbon' }
      );
      const result = await analyze(buf);
      expect(result.isAlreadyU1).toBe(false);
    });
  });

  describe('ZIP bomb protection', () => {
    it('throws on ZIP with too many entries', async () => {
      const JSZip = globalThis.JSZip;
      const zip = new JSZip();
      for (let i = 0; i < 2001; i++) {
        zip.file(`file_${i}.txt`, 'x');
      }
      const buf = await zip.generateAsync({ type: 'arraybuffer' });
      await expect(analyze(buf)).rejects.toThrow('too many entries');
    });
  });
});
