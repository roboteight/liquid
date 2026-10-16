import { Injectable, computed, signal } from '@angular/core';

export const BAND_COUNT = 4;

export interface SettingDef {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

const def = (
  group: string,
  key: string,
  label: string,
  [min, max, step]: [number, number, number],
  value: number,
): SettingDef => ({ group, key, label, min, max, step, default: value });

/** Per-layer defaults: depth, follow, react, stiffness, drift. */
const LAYER_DEFAULTS = [
  [30, 0.45, 0.6, 0.03, 1.1],
  [75, 0.35, 0.45, 0.018, 0.7],
  [125, 0.25, 0.3, 0.01, 0.45],
  [180, 0.15, 0.2, 0.005, 0.25],
];

export const SETTING_DEFS: SettingDef[] = [
  def('Surface', 'level', 'Water level', [0.15, 0.8, 0.01], 0.38),
  def('Surface', 'tension', 'Tension (wave frequency)', [0.001, 0.05, 0.001], 0.012),
  def('Surface', 'damping', 'Damping (fade speed)', [0, 0.1, 0.001], 0.012),
  def('Surface', 'spread', 'Spread (wave speed)', [0.02, 0.4, 0.01], 0.3),
  def('Surface', 'swell', 'Ambient swell', [0, 4, 0.1], 1),

  def('Mouse', 'wavelength', 'Wavelength (px)', [40, 300, 5], 110),
  def('Mouse', 'wakeStrength', 'Wave strength', [0, 3, 0.1], 1),
  def('Mouse', 'mouseSplash', 'Surface-break splash', [0, 3, 0.1], 1),
  def('Mouse', 'hoverStrength', 'Hover strength', [0, 4, 0.1], 1),
  def('Mouse', 'layerPush', 'Underwater push', [0, 3, 0.1], 1),

  def('Letters', 'letterSize', 'Letter size', [0.5, 2, 0.05], 1),
  def('Letters', 'gravity', 'Gravity', [300, 3000, 50], 1400),
  def('Letters', 'splashForce', 'Splash force', [0, 3, 0.1], 1),
  def('Letters', 'droplets', 'Droplet amount', [0, 3, 0.1], 1),

  ...LAYER_DEFAULTS.flatMap(([depth, follow, react, stiffness, drift], b) => {
    const g = `Layer ${b + 1}`;
    return [
      def(g, `band${b}Depth`, 'Depth (px)', [0, 400, 5], depth),
      def(g, `band${b}Follow`, 'Follows surface', [0, 1, 0.01], follow),
      def(g, `band${b}React`, 'Mouse reaction', [0, 1.5, 0.01], react),
      def(g, `band${b}Stiffness`, 'Catch-up speed', [0.001, 0.08, 0.001], stiffness),
      def(g, `band${b}Drift`, 'Drift speed', [0, 2, 0.05], drift),
    ];
  }),
];

export const SETTING_GROUPS = [...new Set(SETTING_DEFS.map((d) => d.group))].map((name) => ({
  name,
  defs: SETTING_DEFS.filter((d) => d.group === name),
}));

const DEFAULTS: Record<string, number> = Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d.default]));

/** Tunable simulation values, shared by the canvas and the controls drawer. */
@Injectable({ providedIn: 'root' })
export class LiquidSettings {
  readonly values = signal<Record<string, number>>({ ...DEFAULTS });
  readonly isDefault = computed(() => SETTING_DEFS.every((d) => this.values()[d.key] === d.default));

  set(key: string, value: number): void {
    this.values.update((v) => ({ ...v, [key]: value }));
  }

  reset(): void {
    this.values.set({ ...DEFAULTS });
  }

  /** Underwater layer parameters, in depth order. */
  bands() {
    const v = this.values();
    return Array.from({ length: BAND_COUNT }, (_, b) => ({
      depth: v[`band${b}Depth`],
      follow: v[`band${b}Follow`],
      react: v[`band${b}React`],
      stiffness: v[`band${b}Stiffness`],
      drift: v[`band${b}Drift`],
    }));
  }
}
