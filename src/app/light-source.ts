import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { LiquidSettings } from './liquid-settings';
import { compass } from './solar';

const MIN_RADIUS = 80;
const MAX_RADIUS = 1400;
const KEY_STEP = 0.02;

/**
 * A draggable light that dims everything outside a soft spotlight (a vignette) and 
 * Drag the orb to move it; scroll over it, drag the ring handle, or press +/- to change its size.
 */
@Component({
  selector: 'app-light-source',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './light-source.css',
  host: {
    '[hidden]': '!visible()',
    '[style.--lx]': 'x()',
    '[style.--ly]': 'y()',
    '[style.--lr]': 'radiusPx()',
    '[style.--dark]': 'darkness()',
    '[style.--inner]': 'inner()',
    '[style.--light-hue]': 'hue()',
    '[style.--orb-size]': 'orbSize()',
    '(window:resize)': 'onResize()',
    '(window:keydown.escape)': 'dismissTip()',
  },
  template: `
    <div role="region" aria-label="Light source">
    <div class="vignette" aria-hidden="true"></div>

    <!-- The sun itself is drawn in the water canvas, where mountains and water can hide it. These controls
         are just the transparent grab area, the resize ring and its handle. -->
    <div class="light" [class.active]="active()" [style.left.px]="px()" [style.top.px]="py()">
      <div class="ring" [style.width.px]="radius() * 2" [style.height.px]="radius() * 2"></div>
      <!-- Pointer-only: keyboard and screen-reader users resize the light with + and - on the orb below. -->
      <button
        type="button"
        class="handle"
        tabindex="-1"
        aria-hidden="true"
        [style.transform]="handleTransform()"
        (pointerdown)="startDrag($event, 'resize')"
        (pointermove)="drag($event)"
        (pointerup)="endDrag($event)"
        (pointercancel)="endDrag($event)"
        (pointerenter)="hover.set(true)"
        (pointerleave)="hover.set(false)"
        (wheel)="onWheel($event)"
      ></button>
      <button
        type="button"
        class="orb"
        aria-label="Light source position and size"
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + -"
        (pointerdown)="startDrag($event, 'move')"
        (pointermove)="drag($event)"
        (pointerup)="endDrag($event)"
        (pointercancel)="endDrag($event)"
        (pointerenter)="enterOrb()"
        (pointerleave)="leaveOrb()"
        (focus)="orbFocus.set(true); tipDismissed.set(false)"
        (blur)="orbFocus.set(false)"
        (wheel)="onWheel($event)"
        (keydown)="onKey($event)"
        [attr.aria-describedby]="following() ? 'light-where light-help light-time' : 'light-where light-help'"
      ></button>
    </div>

    <p id="light-where" class="sr-only">{{ where() }}</p>
    <p id="light-help" class="sr-only">
      Drag to move the light. With the keyboard, use the arrow keys to move it and plus and minus to resize it;
      scrolling over it also resizes. Moving it by hand stops it following the time of day.
    </p>
    <!-- Announces keyboard moves, since nothing else tells a screen reader where the light went. -->
    <p class="sr-only" role="status" aria-live="polite">{{ moved() }}</p>

    <!-- The time of day the light is showing: shown on hover or keyboard focus, above the sun (or below it
         when the sun is too close to the top of the screen). Hidden once the light has been moved by hand. -->
    <div
      id="light-time"
      class="tip"
      role="tooltip"
      [class.show]="showTip()"
      [class.below]="py() < 90"
      [style.left.px]="px()"
      [style.top.px]="py()"
      (pointerenter)="enterTip()"
      (pointerleave)="leaveOrb()"
    >
      {{ clockText() }}
    </div>
    </div>
  `,
})
export class LightSource {
  private readonly settings = inject(LiquidSettings);
  protected readonly viewport = signal<[number, number]>([innerWidth, innerHeight]);
  protected readonly hover = signal(false);
  private readonly dragging = signal<'move' | 'resize' | null>(null);
  private grab = { dx: 0, dy: 0 };
  protected readonly orbHover = signal(false);
  protected readonly orbFocus = signal(false);
  /** e.g. "Sun · 2:36 PM": the time the scene is showing, which follows the scrubber when it is in use. */
  protected readonly clockText = signal('');
  /** Where the light is right now, in words (read as part of its description). */
  protected readonly where = signal('');
  /** True while the light is on the clock; once it has been moved by hand its position no longer means a time. */
  protected readonly following = computed(() => this.settings.values()['lightFollowTime'] > 0);
  /** Escape hides the tooltip until the light is hovered or focused again. */
  protected readonly tipDismissed = signal(false);
  /** Last keyboard move or resize, spoken by the live region. */
  protected readonly moved = signal('');
  private hideTimer?: ReturnType<typeof setTimeout>;
  protected readonly showTip = computed(
    () =>
      this.following() &&
      !this.tipDismissed() &&
      (this.orbHover() || this.orbFocus()) &&
      this.dragging() === null,
  );

  constructor() {
    // Follow the clock: re-place the light whenever the mode or the scrubbed time changes, and every couple of
    // seconds so it creeps along with real time.
    // Re-place it when any of these change (a computed, so the effect ignores every other setting).
    const clockKey = computed(() => {
      const v = this.settings.values();
      return `${v['lightFollowTime']}|${v['lightClock']}|${v['latitude']}|${v['longitude']}|${v['dayOffset']}`;
    });
    effect(() => {
      void clockKey();
      untracked(() => {
        this.settings.applyTimeOfDay();
        this.refreshClock();
      });
    });
    this.refreshClock();
    const timer = setInterval(() => {
      this.settings.applyTimeOfDay();
      this.refreshClock();
    }, 2000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));

    // Switching the light on or off (the sun button or the "Show light" slider) puts it back where the time of
    // day says it should be, even if it had been dragged somewhere by hand.
    let wasVisible = this.visible();
    effect(() => {
      const visible = this.visible();
      if (visible === wasVisible) return;
      wasVisible = visible;
      untracked(() => {
        this.settings.set('lightFollowTime', 1);
        this.settings.applyTimeOfDay();
        this.refreshClock();
      });
    });
  }

  protected readonly active = computed(() => this.hover() || this.dragging() !== null);
  protected readonly visible = computed(() => this.settings.values()['lightShow'] > 0);
  protected readonly x = computed(() => this.settings.values()['lightX']);
  protected readonly y = computed(() => this.settings.values()['lightY']);
  protected readonly radius = computed(() => this.settings.values()['lightRadius']);
  protected readonly hue = computed(() => this.settings.values()['lightHue']);
  protected readonly orbSize = computed(() => `${this.settings.values()['lightOrbSize']}px`);
  protected readonly radiusPx = computed(() => `${this.radius()}px`);
  protected readonly darkness = computed(() => this.settings.values()['lightDarkness']);
  /** Where the gradient stops being fully clear, as a percentage of the radius. */
  protected readonly inner = computed(() => `${(1 - this.settings.values()['lightSoftness']) * 100}%`);
  protected readonly px = computed(() => this.x() * this.viewport()[0]);
  protected readonly py = computed(() => this.y() * this.viewport()[1]);

  /** Park the resize handle on the ring, on the side facing the middle of the screen so it stays reachable. */
  protected readonly handleTransform = computed(() => {
    const [w, h] = this.viewport();
    let angle = Math.atan2(h / 2 - this.py(), w / 2 - this.px());
    if (Math.hypot(w / 2 - this.px(), h / 2 - this.py()) < 24) angle = -Math.PI / 4;
    const r = this.radius();
    return `translate(-50%, -50%) translate(${Math.cos(angle) * r}px, ${Math.sin(angle) * r}px)`;
  });

  /** Where the light is: the sun or moon's place in the sky, or the spot it was dragged to. */
  private describeWhere(): string {
    const v = this.settings.values();
    if (v['lightFollowTime'] === 0) {
      return `The light has been moved by hand to ${Math.round(v['lightX'] * 100)} percent across and ${Math.round(v['lightY'] * 100)} percent down.`;
    }
    const sky = this.settings.skyAt(this.settings.instant());
    const body = this.settings.body === 'sun' ? sky.sun : sky.moon;
    const above = body.altitude >= 0;
    return `It is showing the ${this.settings.body}, ${Math.round(Math.abs(body.altitude))}° ${above ? 'above' : 'below'} the horizon in the ${compass(body.azimuth)}.`;
  }

  /** Updates the tooltip text, in the user's own 12/24-hour format. */
  private refreshClock(): void {
    const hour = this.settings.hourOfDay();
    const wholeHours = Math.floor(hour);
    const minutes = Math.min(Math.floor((hour - wholeHours) * 60), 59);
    const time = new Date(2000, 0, 1, wholeHours % 24, minutes).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    this.clockText.set(`${this.settings.body === 'sun' ? 'Sun' : 'Moon'} · ${time}`);
    this.where.set(this.describeWhere());
  }

  protected enterOrb(): void {
    clearTimeout(this.hideTimer);
    this.hover.set(true);
    this.orbHover.set(true);
    this.tipDismissed.set(false);
  }

  /** Leaving the orb hides the tooltip after a beat, so the pointer can travel onto the tooltip itself. */
  protected leaveOrb(): void {
    this.hover.set(false);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.orbHover.set(false), 150);
  }

  protected enterTip(): void {
    clearTimeout(this.hideTimer);
    this.orbHover.set(true);
  }

  protected dismissTip(): void {
    if (this.showTip()) this.tipDismissed.set(true);
  }

  protected onResize(): void {
    this.viewport.set([innerWidth, innerHeight]);
  }

  protected startDrag(event: PointerEvent, mode: 'move' | 'resize'): void {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragging.set(mode);
    if (mode === 'move') this.settings.set('lightFollowTime', 0); // moving it by hand takes over from the clock
    this.grab = { dx: event.clientX - this.px(), dy: event.clientY - this.py() };
    event.preventDefault();
  }

  protected drag(event: PointerEvent): void {
    const mode = this.dragging();
    if (!mode) return;
    const [w, h] = this.viewport();
    if (mode === 'move') {
      this.settings.set('lightX', clamp((event.clientX - this.grab.dx) / w, 0, 1));
      this.settings.set('lightY', clamp((event.clientY - this.grab.dy) / h, 0, 1));
    } else {
      this.setRadius(Math.hypot(event.clientX - this.px(), event.clientY - this.py()));
    }
  }

  protected endDrag(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.dragging.set(null);
  }

  protected onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.setRadius(this.radius() * Math.exp(-event.deltaY * 0.0015));
  }

  protected onKey(event: KeyboardEvent): void {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_STEP, 0],
      ArrowRight: [KEY_STEP, 0],
      ArrowUp: [0, -KEY_STEP],
      ArrowDown: [0, KEY_STEP],
    };
    const move = moves[event.key];
    if (move) {
      this.settings.set('lightFollowTime', 0);
      this.settings.set('lightX', clamp(this.x() + move[0], 0, 1));
      this.settings.set('lightY', clamp(this.y() + move[1], 0, 1));
    } else if (event.key === '+' || event.key === '=') {
      this.setRadius(this.radius() * 1.1);
    } else if (event.key === '-' || event.key === '_') {
      this.setRadius(this.radius() / 1.1);
    } else {
      return;
    }
    this.moved.set(
      `Light at ${Math.round(this.x() * 100)} percent across and ${Math.round(this.y() * 100)} percent down, radius ${this.radius()} pixels.`,
    );
    event.preventDefault();
  }

  private setRadius(value: number): void {
    this.settings.set('lightRadius', clamp(Math.round(value), MIN_RADIUS, MAX_RADIUS));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
