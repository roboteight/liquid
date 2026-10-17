import { Injectable, computed, signal } from '@angular/core';
import { BodyPosition, HORIZON_ALTITUDE, Sky, SunTimes, describeSky, estimateLocation, sky, sunTimes } from './solar';

export const BAND_COUNT = 4;

/** Whether the system asks for less motion; it sets the default of "Calm motion". */
const PREFERS_REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;


export interface SettingDef {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
/** Where we guess the user is until they share their location (see estimateLocation). */
const ESTIMATE = estimateLocation();

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

  def('Current', 'currentSpeed', 'Speed (px/s, − = left)', [-300, 300, 5], 70),
  def('Current', 'currentGusts', 'Gustiness', [0, 1, 0.05], 0.3),
  def('Current', 'currentWaves', 'Driven surface waves', [0, 3, 0.1], 1),
  def('Current', 'currentDepth', 'Depth falloff (px)', [100, 1000, 10], 350),
  def('Current', 'currentLetters', 'Drag on letters', [0, 2, 0.1], 1),
  def('Current', 'currentParticles', 'Visible flow streaks', [0, 1, 0.05], 0.6),
  def('Current', 'currentStreakLength', 'Streak length', [0.3, 3, 0.1], 1),
  def('Current', 'currentStreakBlur', 'Streak size / softness', [0.3, 3, 0.1], 1),

  def('Look', 'calm', 'Calm motion: stop ambient movement (0 = off)', [0, 1, 1], PREFERS_REDUCED_MOTION ? 1 : 0),
  def('Look', 'themeAuto', 'Theme follows time of day (0 = manual)', [0, 1, 1], 1),
  def('Look', 'waterHue', 'Water hue', [150, 280, 1], 197),
  def('Look', 'depthDarkness', 'Depth darkness', [0, 1, 0.05], 0.5),
  def('Look', 'surfaceGlow', 'Surface glow', [0, 1, 0.05], 0.5),
  def('Look', 'lightRays', 'Light rays', [0, 1, 0.05], 0.5),
  def('Look', 'rayCount', 'Light ray count', [2, 16, 1], 8),
  def('Look', 'raySoftness', 'Light ray softness (px)', [0, 30, 1], 12),
  def('Look', 'backgroundGlow', 'Background glow', [0, 1, 0.05], 0.7),
  def('Look', 'backgroundSpeed', 'Background speed', [0, 3, 0.1], 1),
  def('Look', 'backgroundSpread', 'Background colour spread', [0, 2, 0.05], 1),
  def('Look', 'cloudsShow', 'Show clouds (0 = off)', [0, 1, 1], 1),
  def('Look', 'cloudOpacity', 'Cloud opacity', [0, 1, 0.05], 0.6),
  def('Look', 'cloudCover', 'Cloud cover', [0, 1, 0.05], 0.7),
  def('Look', 'cloudSpeed', 'Cloud speed', [0, 4, 0.1], 1),
  def('Look', 'cloudSize', 'Cloud size', [0.5, 2, 0.05], 1),
  def('Look', 'cloudAltitude', 'Cloud altitude (− higher)', [-0.2, 0.2, 0.01], 0),
  def('Look', 'cloudFrontDensity', 'Front cloud density (blocks light)', [0, 1.4, 0.05], 1),
  def('Look', 'landHeight', 'Mountain height (px, 0 = off)', [0, 260, 1], 100),
  def('Look', 'landLayers', 'Mountain layers', [1, 6, 1], 5),
  def('Look', 'landParallax', 'Mountain sideways parallax', [0, 2, 0.1], 1),
  def('Look', 'landParallaxY', 'Mountain vertical parallax', [0, 2, 0.1], 0.3),
  def('Look', 'landLight', 'Mountain lighting', [0, 2, 0.05], 1),
  def('Look', 'landJagged', 'Mountain jaggedness', [0, 1, 0.05], 0.6),
  def('Look', 'landSeed', 'Mountain shape (seed)', [0, 60, 1], 7),
  def('Look', 'landDarkness', 'Mountain darkness', [0, 1, 0.05], 0.92),
  def('Look', 'vignette', 'Edge vignette', [0, 1, 0.05], 0.5),

  def('Light', 'lightShow', 'Show light (0 = off)', [0, 1, 1], 1),
  def('Light', 'lightHue', 'Light colour (hue)', [0, 360, 1], 32),
  def('Light', 'lightOrbSize', 'Orb size (px)', [10, 240, 1], 110),
  def('Light', 'lightFollowTime', 'Follow time of day (0 = manual)', [0, 1, 1], 1),
  def('Light', 'lightClock', 'Time of day (h, -1 = real clock)', [-1, 24, 0.1], -1),
  def('Light', 'lightRadius', 'Radius (px)', [80, 1400, 5], 480),
  def('Light', 'lightIntensity', 'Glow intensity', [0, 1, 0.05], 0.7),
  def('Light', 'lightCloudGlow', 'Cloud glow', [0, 2, 0.05], 1),
  def('Light', 'lightDarkness', 'Vignette darkness', [0, 1, 0.05], 0.6),
  def('Light', 'lightSoftness', 'Edge softness', [0.05, 1, 0.05], 0.7),
  def('Light', 'lightX', 'Position X', [0, 1, 0.005], 0.2),
  def('Light', 'lightY', 'Position Y', [0, 1, 0.005], 0.4),

  def('Location', 'latitude', 'Latitude (° north, − = south)', [-85, 85, 0.1], round1(ESTIMATE.latitude)),
  def('Location', 'longitude', 'Longitude (° east, − = west)', [-180, 180, 0.1], round1(ESTIMATE.longitude)),
  def('Location', 'dayOffset', 'Season: days from today', [-182, 182, 1], 0),

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

/** Where the sun or moon is on screen and how it should look, for one moment. */
export interface Body {
  kind: 'sun' | 'moon';
  altitude: number;
  azimuth: number;
  /** 0..1: how brightly it lights the scene (fades through twilight; a thin moon is dim). */
  brightness: number;
}

const STORAGE_LOCATION = 'liquid-location';
/** Pauses before each automatic retry of a location that could not be found yet. */
const LOCATE_RETRY_DELAYS = [5_000, 15_000, 45_000];
const STORAGE_SUN = 'liquid-sun';
const DAY_MS = 86_400_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Tunable simulation values, shared by the canvas and the controls drawer. */
@Injectable({ providedIn: 'root' })
export class LiquidSettings {
  /** Viewport y of the water surface, published every frame by the canvas so other layers can sit above it. */
  waterline = Infinity;

  /**
   * How the light looks right now, set by the sky (see applyTimeOfDay) rather than by a slider: a multiplier
   * on its brightness, the saturation of the disc (a moon is paler than a sun), and its size.
   */
  daylight = 1;
  lightSat = 100;
  lightScale = 1;
  /** Whether the light is currently standing in for the sun or the moon (read by the tooltip). */
  body: 'sun' | 'moon' = 'sun';

  readonly values = signal<Record<string, number>>({ ...DEFAULTS });
  readonly isDefault = computed(() => SETTING_DEFS.every((d) => this.values()[d.key] === d.default));

  /** Where the latitude and longitude came from: a time-zone guess, the device, or the user's own sliders. */
  readonly locationSource = signal<'estimate' | 'device' | 'manual'>('estimate');
  /** Last thing to say about finding the location (shown briefly, and announced to screen readers). */
  readonly locationMessage = signal('');
  /** True while the device's location is being looked for (including between automatic retries). */
  readonly locating = signal(false);
  private locateRetry?: ReturnType<typeof setTimeout>;
  /** The same message while it is on screen (cleared after a few seconds); other things can move out of its way. */
  readonly locationNote = signal('');
  private noteTimer?: ReturnType<typeof setTimeout>;

  private sunTimesCache?: { key: string; times: SunTimes };

  constructor() {
    void this.startLocation();
  }

  // ---------------------------------------------------------------- time

  /** The hour (0..24, fractional) the scene is set to: the scrubbed time, or else the user's local clock. */
  hourOfDay(now = new Date()): number {
    const clock = this.values()['lightClock'];
    return clock >= 0 ? clock : now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  }

  /** Local midnight at the start of the scene's day (today, moved by the "Season" slider). */
  dayStart(now = new Date(), offsetDays = this.values()['dayOffset']): Date {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  }

  /** The moment the scene is showing: the real instant, or the scrubbed hour of the chosen day. */
  instant(now = new Date()): Date {
    const v = this.values();
    if (v['lightClock'] < 0 && v['dayOffset'] === 0) return now;
    return new Date(this.dayStart(now).getTime() + this.hourOfDay(now) * 3600000);
  }

  /** An hour (0..24) of the scene's day as a moment, for drawing the whole day's path. */
  at(hour: number, now = new Date()): Date {
    return new Date(this.dayStart(now).getTime() + hour * 3600000);
  }

  // ---------------------------------------------------------------- the sky

  /** An hour of the day (0..24) as clock text in the user's own 12- or 24-hour format. */
  formatHour(hour: number): string {
    const whole = Math.floor(hour);
    return new Date(2000, 0, 1, whole % 24, Math.min(Math.floor((hour - whole) * 60), 59)).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  /** Where everything is in the sky at a moment. */
  skyAt(when: Date): Sky {
    const [lat, lng] = this.latLng();
    return sky(when, lat, lng);
  }

  /** The sky at the scene's moment, in words. */
  describeNow(now = new Date()): string {
    return describeSky(this.skyAt(this.instant(now)));
  }

  /** Sunrise, noon and sunset for the scene's day, in words (including the polar cases). */
  sunTimesText(now = new Date()): string {
    const t = this.sunTimesFor(now);
    if (t.rise === null || t.set === null) {
      return t.alwaysUp ? 'The sun does not set on this day.' : 'The sun does not rise on this day.';
    }
    return `Sunrise ${this.formatHour(t.rise)}, solar noon ${this.formatHour(t.noon)}, sunset ${this.formatHour(t.set)}.`;
  }

  private latLng(): [number, number] {
    const v = this.values();
    return [v['latitude'], v['longitude']];
  }

  /** The body that lights the scene at a moment: the sun until it is well below the horizon, then the moon. */
  bodyAt(when: Date): Body {
    const [lat, lng] = this.latLng();
    const s = sky(when, lat, lng);
    if (s.sun.altitude > -12) {
      // The sun fades out through twilight, reaching nothing 10 degrees below the horizon.
      return { kind: 'sun', ...pick(s.sun), brightness: clamp((s.sun.altitude + 10) / 10, 0, 1) };
    }
    // At night the moon, as bright as its phase and fading as it sinks below the horizon.
    const phase = 0.3 + 0.5 * s.moonIllumination;
    return { kind: 'moon', ...pick(s.moon), brightness: phase * clamp((s.moon.altitude + 8) / 8, 0, 1) };
  }

  /** Whether the sun is above the horizon at a moment. */
  isDayAt(when: Date): boolean {
    const [lat, lng] = this.latLng();
    return sky(when, lat, lng).sun.altitude > HORIZON_ALTITUDE;
  }

  /** Whether it is daytime in the scene right now (scrubbed time and season included). */
  sceneIsDay(now = new Date()): boolean {
    return this.isDayAt(this.instant(now));
  }

  /** Whether it is day at an hour of the scene's day. */
  isDay(hour: number, now = new Date()): boolean {
    return this.isDayAt(this.at(hour, now));
  }

  /** Sunrise, sunset and solar noon for the scene's day (cached; recomputed when the place or day changes). */
  sunTimesFor(now = new Date(), offsetDays = this.values()['dayOffset']): SunTimes {
    const [lat, lng] = this.latLng();
    const start = this.dayStart(now, offsetDays);
    const key = `${start.getTime()}|${lat}|${lng}`;
    if (this.sunTimesCache?.key !== key) {
      const times = sunTimes(start, lat, lng);
      this.sunTimesCache = { key, times };
      if (offsetDays === 0) this.rememberSunTimes(start, times);
    }
    return this.sunTimesCache.times;
  }

  /** Saved so the page can pick light or dark mode correctly before anything has loaded (see index.html). */
  private rememberSunTimes(start: Date, times: SunTimes): void {
    try {
      const date = `${start.getFullYear()}-${start.getMonth() + 1}-${start.getDate()}`;
      localStorage.setItem(STORAGE_SUN, JSON.stringify({ date, rise: times.rise, set: times.set, alwaysUp: times.alwaysUp }));
    } catch {
      // ignore
    }
  }

  /**
   * Puts the light where the sun (or, at night, the moon) really is, from the user's latitude and longitude, the
   * date and the time. We look toward the equator, so in the northern hemisphere the sun rises on the left,
   * climbs to the south and sets on the right; in the southern hemisphere it crosses from right to left.
   * `lightClock` >= 0 overrides the real clock and "Season" shifts the date.
   */
  applyTimeOfDay(now = new Date()): void {
    const v = this.values();
    if (!v['lightFollowTime']) {
      this.daylight = 1;
      this.lightSat = 100;
      this.lightScale = 1;
      return;
    }
    const body = this.bodyAt(this.instant(now));
    const horizon = Number.isFinite(this.waterline) ? Math.min(this.waterline / innerHeight, 0.95) : 0.43;

    // Azimuth to screen x: centred on due south (due north in the southern hemisphere), 240 degrees across.
    const facing = v['latitude'] >= 0 ? 180 : 0;
    const offset = ((body.azimuth - facing + 540) % 360) - 180;
    const x = clamp(0.5 + (offset / 240) * 0.88, 0.02, 0.98);
    // Altitude to screen y: the horizon is the waterline, 75 degrees reaches near the top; below the horizon
    // it sinks into the water, where the landscape hides it.
    const y = horizon - (clamp(body.altitude, -20, 90) / 75) * (horizon - 0.2);
    const hue = body.kind === 'sun' ? 22 + 26 * clamp(body.altitude / 40, 0, 1) : 212;

    this.body = body.kind;
    this.daylight = body.brightness;
    this.lightSat = body.kind === 'sun' ? 100 : 45;
    this.lightScale = body.kind === 'sun' ? 1 : 0.6;
    const changed = (key: string, to: number) => Math.abs(v[key] - to) > 1e-4;
    if (changed('lightX', x) || changed('lightY', y) || changed('lightHue', hue)) {
      this.values.update((all) => ({ ...all, lightX: x, lightY: y, lightHue: hue }));
    }
  }

  // ---------------------------------------------------------------- location

  /**
   * On load, asks for the device's location (which shows the browser's permission prompt the first time). A
   * previously found location is used straight away while that happens. If permission is denied or blocked, the
   * sun uses the estimate from the time zone instead.
   */
  private async startLocation(): Promise<void> {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_LOCATION) ?? 'null');
      if (saved && Number.isFinite(saved.latitude) && Number.isFinite(saved.longitude)) {
        this.setPlace(saved.latitude, saved.longitude, 'device');
      }
    } catch {
      // keep the estimate
    }

    let state: PermissionState = 'prompt';
    try {
      state = (await navigator.permissions.query({ name: 'geolocation' })).state;
    } catch {
      // No Permissions API: just ask.
    }
    if (state === 'denied') {
      // Blocked for this site (now, or since an earlier visit): the browser won't prompt, so fall back to the
      // time-zone estimate and forget any location saved before it was blocked.
      this.setPlace(round1(ESTIMATE.latitude), round1(ESTIMATE.longitude), 'estimate');
      try {
        localStorage.removeItem(STORAGE_LOCATION);
      } catch {
        // ignore
      }
      this.say('Location access is blocked, so the sun uses an estimate from your time zone.');
      return;
    }
    void this.useDeviceLocation(true);
  }

  /**
   * Asks the browser for the device's location (this is what shows the permission prompt). Called on load with
   * `automatic`, it is patient: a device can take a while to work out where it is (Wi-Fi positioning on a laptop
   * often needs longer than a few seconds), so it waits up to 20s and tries again in the background a few times
   * rather than giving up, and the pin lights by itself as soon as a fix arrives, with nothing to click. A place
   * the user has typed in by hand is never overwritten by an automatic fix.
   */
  useDeviceLocation(automatic = false): Promise<boolean> {
    clearTimeout(this.locateRetry);
    return this.locate(automatic, 0);
  }

  private locate(automatic: boolean, attempt: number): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (found: boolean) => {
        this.locating.set(false);
        resolve(found);
      };
      if (!('geolocation' in navigator)) {
        this.say('This browser cannot share a location, so the sun uses an estimate from your time zone.');
        finish(false);
        return;
      }
      // If a saved device location is already in use, refreshing it in the background is silent: no pulsing pin and
      // no messages (and no retries) unless the place has actually moved.
      const quiet = automatic && this.locationSource() === 'device';
      if (!quiet) this.locating.set(true);
      if (attempt === 0 && !quiet) this.say('Finding your location…');
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (automatic && this.locationSource() === 'manual') return finish(false); // keep the place they typed
          const { latitude, longitude } = position.coords;
          const before = `${this.values()['latitude']}|${this.values()['longitude']}`;
          this.setPlace(round1(clamp(latitude, -85, 85)), round1(longitude), 'device');
          try {
            localStorage.setItem(STORAGE_LOCATION, JSON.stringify({ latitude: this.values()['latitude'], longitude: this.values()['longitude'] }));
          } catch {
            // ignore
          }
          if (!quiet || before !== `${this.values()['latitude']}|${this.values()['longitude']}`) {
            this.say(`Using your location: ${this.values()['latitude']}°, ${this.values()['longitude']}°.`);
          }
          finish(true);
        },
        (error) => {
          if (quiet) return finish(false); // the saved location is still good; say nothing
          if (error.code === error.PERMISSION_DENIED) {
            this.say('Location access was declined, so the sun uses an estimate from your time zone.');
            return finish(false);
          }
          if (automatic && attempt < LOCATE_RETRY_DELAYS.length) {
            // Not found yet (timed out, or no signal for now): keep the estimate, and try again shortly.
            if (attempt === 0) {
              this.say('Still looking for your location. The sun uses an estimate from your time zone until it is found.');
            }
            this.locateRetry = setTimeout(() => void this.locate(true, attempt + 1).then(resolve), LOCATE_RETRY_DELAYS[attempt]);
            return;
          }
          this.say('Your location could not be found, so the sun uses an estimate from your time zone.');
          finish(false);
        },
        { maximumAge: 3_600_000, timeout: 20_000 },
      );
    });
  }

  /** Records a message about the location: spoken to screen readers, and shown on screen for a few seconds. */
  private say(message: string): void {
    this.locationMessage.set(message);
    this.locationNote.set(message);
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.locationNote.set(''), 6000);
  }

  private setPlace(latitude: number, longitude: number, source: 'estimate' | 'device' | 'manual'): void {
    this.values.update((v) => ({ ...v, latitude: clamp(latitude, -85, 85), longitude: clamp(longitude, -180, 180) }));
    this.locationSource.set(source);
  }

  // ---------------------------------------------------------------- settings

  set(key: string, value: number): void {
    this.values.update((v) => ({ ...v, [key]: value }));
  }

  reset(): void {
    this.values.set({ ...DEFAULTS });
    this.locationSource.set('estimate');
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

function pick(position: BodyPosition): BodyPosition {
  return { altitude: position.altitude, azimuth: position.azimuth };
}
