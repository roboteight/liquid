import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Clouds } from './clouds';
import { ControlsDrawer } from './controls-drawer';
import { LightSource } from './light-source';
import { TimeSlider } from './time-slider';
import { LiquidCanvas } from './liquid-canvas';
import { LiquidSettings } from './liquid-settings';
import { SceneDescription } from './scene-description';

/** Typing this word makes the input drop into the water. */
const TRIGGER = /something/i;

/** The hint toast waits this long after load before it appears. */
const HINT_DELAY_MS = 2500;
const HINT_STORAGE_KEY = 'liquid-hint-done';

@Component({
  selector: 'app-root',
  imports: [LiquidCanvas, ControlsDrawer, LightSource, Clouds, TimeSlider, SceneDescription],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './app.css',
  host: {
    '[style.--bg-hue]': 'hue()',
    '[style.--bg-glow]': 'glow()',
    '[style.--bg-spread]': 'spread()',
    '[style.--bg-duration]': 'duration()',
    '[style.--bg-state]': 'state()',
  },
  template: `
    <main>
      <h1 class="sr-only">Liquid: type to drop letters into the water</h1>
      <app-scene-description />
      <div class="sky" aria-hidden="true"></div>
      <app-clouds layer="back" aria-hidden="true" />
      <header>
        <input
          type="text"
          placeholder="Type something…"
          autocomplete="off"
          spellcheck="false"
          autofocus
          aria-label="Text to drop into the liquid"
          aria-describedby="input-hint"
          [class.dropped]="dropped()"
          [class.entering]="entering()"
          (animationend)="entering.set(false)"
          [disabled]="dropped()"
          (input)="onInput($event)"
        />
      </header>
      <app-liquid-canvas />
      <p id="input-hint" class="sr-only">
        Each letter you type drops into the water and splashes. Typing the word "something" makes the text box
        itself fall in; a new one slides down afterwards.
      </p>
      <!-- Announces what happens on screen, e.g. the text box falling in and a new one arriving. -->
      <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>

      <!-- A hint for first-time visitors. The region always exists so screen readers announce the toast when
           it appears; it goes away for good once dismissed or once the word has been typed. -->
      <div class="toast-region" role="status" aria-live="polite">
        @if (hintVisible()) {
          <div class="toast">
            <span>Type <strong class="word">&ldquo;something&rdquo;</strong></span>
            <button type="button" class="toast-close" aria-label="Dismiss hint" (click)="finishHint()">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        }
      </div>
    </main>
    <app-clouds layer="front" aria-hidden="true" />
    <app-light-source />
    <app-time-slider />
    <app-controls-drawer />
  `,
})
export class App {
  private readonly settings = inject(LiquidSettings);
  private readonly liquid = viewChild.required(LiquidCanvas);

  // The animated backdrop is themed from the same settings as the water.
  protected readonly hue = computed(() => this.settings.values()['waterHue']);
  protected readonly spread = computed(() => this.settings.values()['backgroundSpread']);
  protected readonly glow = computed(() => this.settings.values()['backgroundGlow']);
  protected readonly duration = computed(() => `${40 / Math.max(this.settings.values()['backgroundSpeed'], 0.1)}s`);
  protected readonly state = computed(() => {
    const v = this.settings.values();
    return v['backgroundSpeed'] > 0 && v['calm'] <= 0 ? 'running' : 'paused';
  });
  protected readonly announcement = signal('');
  protected readonly hintVisible = signal(false);
  private hintDone = this.readHintDone();
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // Show the hint a moment after load, unless it has already done its job this session.
    afterNextRender(() => {
      if (this.hintDone) return;
      const timer = setTimeout(() => this.hintVisible.set(!this.hintDone), HINT_DELAY_MS);
      this.destroyRef.onDestroy(() => clearTimeout(timer));
    });
  }
  /** True while the input box is out of the DOM and floating in the water. */
  protected readonly dropped = signal(false);
  /** True while the replacement input slides down from the top. */
  protected readonly entering = signal(false);
  private previous = '';

  protected onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value;
    // Only newly added characters drop; deletions and edits mid-string are ignored.
    const added = value.length > this.previous.length ? value.slice(this.previous.length) : '';
    const fresh = value.startsWith(this.previous) ? added : ((event as InputEvent).data ?? '');
    const hadTrigger = TRIGGER.test(this.previous);
    this.previous = value;

    const box = input.getBoundingClientRect();
    const charWidth = parseFloat(getComputedStyle(input).fontSize) * 0.6;
    const total = [...value].length;
    [...fresh].forEach((ch, i) => {
      const caret = Math.min((total - fresh.length + i) * charWidth + 24, box.width - 24);
      this.liquid().drop(ch, box.left + caret);
    });

    if (!hadTrigger && TRIGGER.test(value)) {
      this.dropInput(input);
      this.finishHint(); // they found it
    }
  }

  /** Hides the hint and keeps it hidden for the rest of this browser session. */
  protected finishHint(): void {
    this.hintDone = true;
    this.hintVisible.set(false);
    try {
      sessionStorage.setItem(HINT_STORAGE_KEY, '1');
    } catch {
      // Storage can be blocked; the hint then just stays hidden for this page load.
    }
  }

  private readHintDone(): boolean {
    try {
      return sessionStorage.getItem(HINT_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** The input itself falls into the water; a fresh, empty one slides down from the top once it has sunk. */
  private dropInput(input: HTMLInputElement): void {
    const style = getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    const spec = {
      text: input.value,
      font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
      padding: parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth),
    };
    const started = this.liquid().dropBox(rect, spec, () => {
      input.value = '';
      this.previous = '';
      this.dropped.set(false);
      this.entering.set(true);
      this.announcement.set('A new text box is ready.');
      // The input is re-enabled on the next render; focus it after that so it is ready to type in.
      setTimeout(() => input.focus());
    });
    if (started) {
      this.dropped.set(true);
      this.announcement.set('The text box fell into the water. A new one is on its way.');
    }
  }
}
