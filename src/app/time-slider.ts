import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { LiquidSettings } from './liquid-settings';
import { HORIZON_ALTITUDE, describeSky, sky } from './solar';

/** How long the bar stays visible after load before it fades out. */
const PEEK_MS = 4500;

/** Width of the native slider thumb in px (see the stylesheet) and the keyboard step in hours (the input's `step`). */
const THUMB_WIDTH = 22;
const KEY_STEP = 0.1;

/** The track is drawn in this coordinate space and stretched to fit; the thumb is placed in CSS percentages. */
const W = 960;
const HORIZON = 26; // y of the horizon line: the middle of the picture, so the sun's path can dip below it at night
const EXTENT = 22; // how far the arcs reach above and below the line
/** The track is the 52px picture plus a row of labels; this is where the horizon line sits above its bottom. */
const TRACK_HEIGHT = 76;
const HORIZON_FROM_BOTTOM = TRACK_HEIGHT - HORIZON;

/**
 * Height of a path (px above the horizon line; negative is below it) for an altitude, given that body's highest
 * altitude that day. Above the line it is to scale. Below it the curve is eased (tanh) so the deepest part of the
 * night is rounded, not squashed flat against the bottom.
 */
const lift = (altitude: number, peak: number) => {
  const v = altitude / Math.min(Math.max(peak, 25), 75);
  return (v >= 0 ? Math.min(v, 1.15) : -Math.tanh(-v)) * EXTENT;
};

interface Point {
  x: number;
  y: number;
  on: boolean;
}

/**
 * Draws a line through the points flagged `on`. Each piece is joined to its neighbours on both ends, so a curve
 * that crosses the horizon (solid above it, dashed below) meets itself there without a gap.
 */
function trace(points: Point[]): string {
  const at = (p: Point) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  let d = '';
  let open = false;
  points.forEach((p, i) => {
    if (p.on) {
      d += open ? `L${at(p)}` : i > 0 ? `M${at(points[i - 1])}L${at(p)}` : `M${at(p)}`;
      open = true;
    } else if (open) {
      d += `L${at(p)}`;
      open = false;
    }
  });
  return d;
}

/**
 * A slider along the bottom of the screen that shows the path the sun really takes across the sky at the user's
 * location and date (above the line by day, dipping below it at night) and the moon's arc,  with a thumb that rides along it. Dragging it sets the time and
 * puts the light back on that path, wherever it had been dragged to, and sets light or dark mode to match the
 * time (and switches the light on if it was off); dragging the light itself still lets it go anywhere. A pin at its
 * left asks the device for its location, so the path and the sunrise and sunset times are accurate. On devices with a pointer the whole bar fades out when idle and back in when it is hovered or
 * focused. Dragging (or arrowing) past either end wraps round, so the sun can go round and round its path.
 */
@Component({
  selector: 'app-time-slider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './time-slider.css',
  template: `
    <div #bar class="bar" role="region" aria-label="Time of day" [class.show]="peek() || !!note()">
      @if (note()) {
        <p #noteEl class="note" aria-hidden="true">{{ note() }}</p>
      }
      <!-- Asks the device for its location, so the sun's path and the sunrise and sunset times are accurate. -->
      <button
        type="button"
        class="pin"
        [class.on]="source() === 'device'"
        [class.busy]="locating()"
        [attr.aria-pressed]="source() === 'device'"
        [attr.aria-busy]="locating()"
        aria-label="Use my location"
        [title]="locationTitle()"
        (click)="useLocation()"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path
            d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"
            fill="currentColor"
            [attr.fill-opacity]="source() === 'device' ? 1 : 0.15"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
          />
          <circle cx="12" cy="9.5" r="2.4" [attr.fill]="source() === 'device' ? 'var(--thumb-on)' : 'currentColor'" />
        </svg>
      </button>
      <div class="track" [class.manual]="manual()">
        <svg viewBox="0 0 960 52" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path class="horizon" [attr.d]="horizon" />
          <path class="below" [attr.d]="paths().sunBelow" />
          <path class="night" [attr.d]="paths().moon" />
          <path class="day" [attr.d]="paths().sun" />
        </svg>
        @for (mark of marks(); track mark.label) {
          <span class="mark" [style.--at]="mark.at" aria-hidden="true">{{ mark.label }}</span>
        }

        <!-- The sun or moon riding the path. -->
        <span
          class="thumb"
          aria-hidden="true"
          [class.moon]="thumb().kind === 'moon'"
          [style.--at]="hour() / 24"
          [style.bottom.px]="horizonFromBottom + thumb().lift"
        ></span>

        <!-- The real control: a native range input laid over the picture, so keyboard and screen readers get a slider. -->
        <input
          type="range"
          min="0"
          max="24"
          step="0.1"
          aria-label="Time of day"
          [attr.aria-valuetext]="valueText()"
          [attr.aria-describedby]="manual() ? 'time-slider-sky time-slider-wrap time-slider-manual' : 'time-slider-sky time-slider-wrap'"
          [value]="hour()"
          (input)="scrub($event)"
          (keydown)="keyDown($event)"
          (pointerdown)="pointerDown($event)"
          (pointermove)="pointerMove($event)"
          (pointerup)="pointerUp($event)"
          (pointercancel)="pointerUp($event)"
        />
      </div>
      <div class="readout">
        <p class="time" aria-hidden="true">{{ timeText() }}</p>
        <!-- Always laid out (just invisible until the time or the light has been changed), so nothing shifts under a drag. -->
        <button
          type="button"
          class="now"
          [class.hidden]="!showNow()"
          [attr.inert]="showNow() ? null : ''"
          aria-label="Return to the current time"
          (click)="now()"
        >
          Now
        </button>
      </div>
      <p class="sr-only" role="status" aria-live="polite">{{ settings.locationMessage() }}</p>
      <p id="time-slider-sky" class="sr-only">{{ skyText() }}</p>
      <p id="time-slider-wrap" class="sr-only">The slider wraps around: past the end it carries on from the start.</p>
      <p id="time-slider-manual" class="sr-only">
        The light has been moved by hand. Use this slider to put it back on the sun's path.
      </p>
    </div>
  `,
})
export class TimeSlider {
  protected readonly settings = inject(LiquidSettings);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly horizon = `M0 ${HORIZON} H${W}`;
  protected readonly horizonFromBottom = HORIZON_FROM_BOTTOM;

  /** The hour on show: the scrubbed time, or the real clock, which is re-read every couple of seconds. */
  protected readonly hour = signal(this.settings.hourOfDay());
  protected readonly scrubbed = computed(() => this.settings.values()['lightClock'] >= 0);
  /** True once the light has been dragged off its path. */
  protected readonly manual = computed(() => this.settings.values()['lightFollowTime'] === 0);
  /** "Now" is there whenever something is off the real sun: a scrubbed time, or a light dragged by hand. */
  protected readonly showNow = computed(() => this.scrubbed() || this.manual());
  protected readonly source = this.settings.locationSource;
  protected readonly locating = this.settings.locating;
  /** The location message while it is on screen (the timing lives in LiquidSettings so other parts can react). */
  protected readonly note = this.settings.locationNote;
  /** The bar is shown for a few seconds after load so people notice it, then it fades until hovered or focused. */
  protected readonly peek = signal(true);
  private peekTimer?: ReturnType<typeof setTimeout>;
  private readonly bar = viewChild.required<ElementRef<HTMLElement>>('bar');
  private readonly noteEl = viewChild<ElementRef<HTMLElement>>('noteEl');

  protected readonly locationTitle = computed(() => {
    if (this.locating()) return 'Finding your location…';
    const v = this.settings.values();
    const where = `${Math.abs(v['latitude']).toFixed(1)}° ${v['latitude'] >= 0 ? 'N' : 'S'}, ${Math.abs(v['longitude']).toFixed(1)}° ${v['longitude'] >= 0 ? 'E' : 'W'}`;
    switch (this.source()) {
      case 'device':
        return `Using your location (${where}). Click to refresh it.`;
      case 'manual':
        return `Using the latitude and longitude you set (${where}). Click to use your device location instead.`;
      default:
        return `Approximate location (${where}), guessed from your time zone. Click to use your device location for accurate sunrise and sunset.`;
    }
  });

  /**
   * The sun's whole path across the day: solid while it is up, dashed as it continues below the horizon line at
   * night, so the curve is one smooth wave rather than a hump with flat lines either side. The moon's arc (dotted)
   * is drawn only while the moon is up. Each is scaled to its own body's highest point that day.
   */
  protected readonly paths = computed(() => {
    const v = this.settings.values();
    const now = new Date();
    const samples: { x: number; sun: number; moon: number }[] = [];
    let sunPeak = 0;
    let moonPeak = 0;
    for (let h = 0; h <= 24 + 1e-9; h += 0.1) {
      const s = sky(this.settings.at(Math.min(h, 24), now), v['latitude'], v['longitude']);
      samples.push({ x: (h / 24) * W, sun: s.sun.altitude, moon: s.moon.altitude });
      sunPeak = Math.max(sunPeak, s.sun.altitude);
      moonPeak = Math.max(moonPeak, s.moon.altitude);
    }
    const sunPoints = (up: boolean): Point[] =>
      samples.map((s) => ({ x: s.x, y: HORIZON - lift(s.sun, sunPeak), on: s.sun > HORIZON_ALTITUDE === up }));
    return {
      sun: trace(sunPoints(true)),
      sunBelow: trace(sunPoints(false)),
      moon: trace(samples.map((s) => ({ x: s.x, y: HORIZON - lift(s.moon, moonPeak), on: s.moon > 0 }))),
      sunPeak,
      moonPeak,
    };
  });

  /** Sunrise, solar noon and sunset along the track. */
  protected readonly marks = computed(() => {
    this.settings.values(); // recompute when the place or season changes
    const times = this.settings.sunTimesFor();
    const list: { at: number; label: string }[] = [];
    if (times.rise !== null) list.push({ at: times.rise / 24, label: this.format(times.rise) });
    list.push({ at: times.noon / 24, label: 'noon' });
    if (times.set !== null) list.push({ at: times.set / 24, label: this.format(times.set) });
    return list;
  });

  /**
   * Where the thumb sits: on the sun's path by day, on the moon's arc while the moon is up at night, and on the
   * sun's dashed path below the line otherwise. The icon is the sun or the moon, whichever lights the scene.
   */
  protected readonly thumb = computed(() => {
    const v = this.settings.values();
    const when = this.settings.at(this.hour());
    const body = this.settings.bodyAt(when);
    const s = sky(when, v['latitude'], v['longitude']);
    const { sunPeak, moonPeak } = this.paths();
    const onMoonArc = body.kind === 'moon' && s.moon.altitude > 0;
    return { kind: body.kind, lift: onMoonArc ? lift(s.moon.altitude, moonPeak) : lift(s.sun.altitude, sunPeak) };
  });

  /** Sunrise, noon and sunset, and where the sun or moon is at the time shown: read out with the slider's value. */
  protected readonly skyText = computed(() => {
    this.settings.values(); // recompute when the place or season changes
    const sky = this.settings.skyAt(this.settings.at(this.hour()));
    return `${this.settings.sunTimesText()} ${describeSky(sky)}`;
  });

  protected readonly daytime = computed(() => this.settings.isDay(this.hour()));
  protected readonly timeText = computed(() => this.format(this.hour()));
  protected readonly valueText = computed(() => `${this.format(this.hour())}, ${this.daytime() ? 'day' : 'night'}`);

  constructor() {
    effect(() => {
      void this.settings.values()['lightClock'];
      untracked(() => this.hour.set(this.settings.hourOfDay()));
    });
    this.peekTimer = setTimeout(() => this.peek.set(false), PEEK_MS);

    // Other things that sit above the bar (the hint toast) need to know where its top edge is, which depends on the
    // screen size and on whether a message is showing. This publishes it as a CSS variable they can position from.
    afterNextRender(() => {
      const observer = new ResizeObserver(() => this.publishStackHeight());
      observer.observe(this.bar().nativeElement);
      this.publishStackHeight();
      this.destroyRef.onDestroy(() => {
        observer.disconnect();
        document.documentElement.style.removeProperty('--hint-bottom');
      });
    });
    effect(() => {
      this.note();
      untracked(() => setTimeout(() => this.publishStackHeight(), 0)); // after the message has rendered
    });
    const timer = setInterval(() => this.hour.set(this.settings.hourOfDay()), 2000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      clearTimeout(this.peekTimer);
    });
  }

  /**
   * Dragging sets the time and puts the light back on the sun's path, however it was positioned before. The
   * light or dark mode follows the sun again too (even after it was chosen by hand), so it turns dark as the
   * slider passes sunset and light again at sunrise.
   */
  protected scrub(event: Event): void {
    this.setHour(+(event.target as HTMLInputElement).value);
  }

  private setHour(value: number): void {
    // Anything past either end carries on from the other side (a full day is one lap of the sun's path).
    const hour = value < 0 || value > 24 ? ((value % 24) + 24) % 24 : value;
    this.settings.set('lightClock', hour);
    this.settings.set('lightFollowTime', 1);
    this.settings.set('themeAuto', 1);
    this.switchLightOn();
    this.hour.set(hour);
  }

  // ---- Dragging with the pointer. A native slider stops at its ends, so the drag is handled here: the thumb jumps
  // to where you press, then moves by how far the pointer travels (not by where it is), so you can keep dragging
  // past either end and the time wraps round. The pointer is captured, so this carries on beyond the track too.
  private drag?: { lastX: number; usable: number };

  protected pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const input = event.currentTarget as HTMLInputElement;
    event.preventDefault(); // stops the native thumb from also dragging
    input.focus({ preventScroll: true });
    input.setPointerCapture(event.pointerId);
    const box = input.getBoundingClientRect();
    const usable = Math.max(box.width - THUMB_WIDTH, 1); // the native thumb's travel is inset by half its width
    this.drag = { lastX: event.clientX, usable };
    this.setHour(Math.min(Math.max((event.clientX - box.left - THUMB_WIDTH / 2) / usable, 0), 1) * 24);
  }

  protected pointerMove(event: PointerEvent): void {
    if (!this.drag) return;
    const moved = event.clientX - this.drag.lastX;
    this.drag.lastX = event.clientX;
    this.setHour(this.hour() + (moved / this.drag.usable) * 24);
  }

  protected pointerUp(event: PointerEvent): void {
    this.drag = undefined;
    const input = event.currentTarget as HTMLInputElement;
    if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
  }

  /** The arrow keys wrap too: forward from the end goes to the start, and back from the start goes to the end. */
  protected keyDown(event: KeyboardEvent): void {
    const hour = this.hour();
    if ((event.key === 'ArrowRight' || event.key === 'ArrowUp') && hour >= 24 - KEY_STEP / 2) {
      event.preventDefault();
      this.setHour(0);
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowDown') && hour <= KEY_STEP / 2) {
      event.preventDefault();
      this.setHour(24 - KEY_STEP);
    }
  }

  /** Back to the real clock, with the light on its path and the mode following the sun. */
  protected now(): void {
    this.settings.set('lightClock', -1);
    this.settings.set('lightFollowTime', 1);
    this.settings.set('themeAuto', 1);
    this.switchLightOn();
    this.hour.set(this.settings.hourOfDay());
  }

  /** The slider is about where the light is in the sky, so using it turns the light on if it was off. */
  private switchLightOn(): void {
    if (this.settings.values()['lightShow'] <= 0) this.settings.set('lightShow', 1);
  }

  /** Sets `--hint-bottom`: how far above the bottom of the screen the bar and any message end, plus a gap. */
  private publishStackHeight(): void {
    const top = Math.min(this.bar().nativeElement.getBoundingClientRect().top, this.noteEl()?.nativeElement.getBoundingClientRect().top ?? Infinity);
    document.documentElement.style.setProperty('--hint-bottom', `${Math.round(innerHeight - top + 12)}px`);
  }

  protected useLocation(): void {
    void this.settings.useDeviceLocation();
  }

  private format(hour: number): string {
    const whole = Math.floor(hour);
    return new Date(2000, 0, 1, whole % 24, Math.min(Math.floor((hour - whole) * 60), 59)).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
}
