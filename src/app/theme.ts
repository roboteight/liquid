import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { LiquidSettings } from './liquid-settings';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'liquid-theme';

/** How long the switch between light and dark takes; the stylesheet fades its colours over the same time. */
const TRANSITION_SECONDS = 1.4;

export const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

/** A manual choice, remembered together with the stretch of day or night it was made in. */
interface SavedChoice {
  mode: ThemeMode;
  period: string;
}

/**
 * Light or dark mode.
 *
 * The default is set by the sun: light while it is above the horizon at the user's location (sunrise to sunset),
 * dark at night, so it also follows the time-of-day slider and the season. Choosing a mode by hand (the toggle, or switching "Theme
 * follows time of day" off) overrides that, but only until the next sunrise or sunset: the choice is saved
 * with the period it was made in and is dropped once that period ends, so the clock decides again. The mode
 * is written to <html data-theme>, where the stylesheets pick up their colours; the canvases read `dark()`.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly settings = inject(LiquidSettings);
  private readonly saved = this.readSaved();
  readonly mode = signal<ThemeMode>(this.saved?.mode ?? (this.settings.sceneIsDay() ? 'light' : 'dark'));
  readonly dark = computed(() => this.mode() === 'dark');

  /**
   * How dark the scene is right now: 0 is fully light, 1 fully dark. It eases toward the current mode over
   * TRANSITION_SECONDS, so everything drawn on a canvas cross-fades between the two looks instead of switching.
   * A plain number (not a signal): the canvases read it every frame.
   */
  darkness = this.mode() === 'dark' ? 1 : 0;
  private fadeFrame = 0;

  /** `darkness` eased in and out, for drawing, so the fade starts and ends gently like the CSS one. */
  get tone(): number {
    const d = this.darkness;
    return d * d * (3 - 2 * d);
  }

  constructor() {
    // A still-valid manual choice means automatic mode was switched off earlier in this period.
    if (this.saved) this.settings.set('themeAuto', 0);

    effect(() => {
      document.documentElement.dataset['theme'] = this.mode();
    });
    effect(() => {
      const target = this.dark() ? 1 : 0;
      untracked(() => this.fadeTo(target));
    });
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.fadeFrame));

    // Automatic mode follows the clock (and the time scrubber); manual mode remembers its choice. Only these
    // few values are tracked, not the whole settings object: other settings change constantly (the sun's
    // position every couple of seconds), and re-saving the choice each time would stop it from ever expiring.
    const auto = computed(() => this.settings.values()['themeAuto']);
    const clock = computed(() => this.settings.values()['lightClock']);
    // Where and when the sun is: a new location or season changes which side of sunrise it is.
    const place = computed(() => {
      const v = this.settings.values();
      return `${v['latitude']}|${v['longitude']}|${v['dayOffset']}`;
    });
    effect(() => {
      const isAuto = auto();
      void clock();
      void place();
      void this.mode();
      untracked(() => (isAuto ? this.applyAuto() : this.saveChoice()));
    });

    // Every 30 seconds: follow the clock if automatic, or hand control back once a manual choice has expired,
    // so the page changes over at sunrise and sunset.
    const timer = setInterval(() => {
      if (this.settings.values()['themeAuto']) this.applyAuto();
      else if (!this.readSaved()) this.settings.set('themeAuto', 1);
    }, 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** Moves `darkness` toward the target over TRANSITION_SECONDS; a change of mind part-way simply turns it around. */
  private fadeTo(target: number): void {
    cancelAnimationFrame(this.fadeFrame);
    if (this.darkness === target) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.darkness = target; // no animation for people who asked for less motion
      return;
    }
    let last = performance.now();
    const step = (now: number) => {
      const move = (now - last) / 1000 / TRANSITION_SECONDS;
      last = now;
      this.darkness = target > this.darkness ? Math.min(this.darkness + move, target) : Math.max(this.darkness - move, target);
      if (this.darkness !== target) this.fadeFrame = requestAnimationFrame(step);
    };
    this.fadeFrame = requestAnimationFrame(step);
  }

  /** Manual switch: overrides the clock until the next sunrise or sunset. */
  toggle(): void {
    this.settings.set('themeAuto', 0);
    this.mode.set(this.dark() ? 'light' : 'dark');
  }

  /**
   * Identifies the current stretch of day (sunrise to sunset) or night on the user's real clock. The night before
   * dawn belongs to the previous date, so a night is one period. A manual choice only lasts for its period.
   */
  private currentPeriod(now = new Date()): string {
    const day = this.settings.isDayAt(now);
    const dawn = this.settings.sunTimesFor(now, 0).rise ?? 6;
    const date = new Date(now);
    if (!day && now.getHours() + now.getMinutes() / 60 < dawn) date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${day ? 'day' : 'night'}`;
  }

  private applyAuto(): void {
    this.mode.set(this.settings.sceneIsDay() ? 'light' : 'dark');
    try {
      localStorage.removeItem(STORAGE_KEY); // automatic again: forget any manual choice
    } catch {
      // ignore
    }
  }

  private saveChoice(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: this.mode(), period: this.currentPeriod() } satisfies SavedChoice));
    } catch {
      // Storage can be blocked; the choice then just lasts for this visit.
    }
  }

  /** The saved manual choice, if it was made in the current period; anything older (or malformed) is dropped. */
  private readSaved(): SavedChoice | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return null;
      const choice = JSON.parse(raw) as Partial<SavedChoice>;
      if ((choice.mode === 'light' || choice.mode === 'dark') && choice.period === this.currentPeriod()) {
        return choice as SavedChoice;
      }
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      try {
        localStorage.removeItem(STORAGE_KEY); // malformed, e.g. saved by an older version
      } catch {
        // ignore
      }
    }
    return null;
  }
}
