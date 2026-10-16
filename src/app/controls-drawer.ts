import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { LiquidSettings, SETTING_GROUPS, SettingDef } from './liquid-settings';
import { ThemeService } from './theme';

@Component({
  selector: 'app-controls-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './controls-drawer.css',
  host: { '(window:keydown.escape)': 'onEscape()', '(window:pointerdown)': 'onPointerDown($event)' },
  template: `
    <nav class="actions" [class.open]="open()" aria-label="Display options">
      <button
        type="button"
        role="switch"
        class="toggle theme"
        aria-label="Dark mode"
        [attr.aria-checked]="theme.dark()"
        [title]="'Dark mode is ' + (theme.dark() ? 'on' : 'off') + (auto() ? ' (follows the time of day until you choose)' : '')"
        (click)="theme.toggle()"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        class="toggle motion"
        [class.on]="calmOn()"
        [attr.aria-pressed]="calmOn()"
        aria-label="Calm motion"
        [title]="calmOn() ? 'Calm motion on: ambient movement is stopped' : 'Calm motion off'"
        (click)="toggleCalm()"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <path d="M8 5v14M16 5v14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
        </svg>
      </button>
      <button
        type="button"
        class="toggle clouds"
        [class.on]="cloudsOn()"
        [attr.aria-pressed]="cloudsOn()"
        aria-label="Show clouds"
        [title]="cloudsOn() ? 'Clouds on' : 'Clouds off'"
        (click)="toggleClouds()"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <path
            d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 8.5a4.75 4.75 0 0 1 .5 9.5z"
            fill="currentColor"
            fill-opacity="0.3"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        type="button"
        class="toggle light"
        [class.on]="lightOn()"
        [attr.aria-pressed]="lightOn()"
        aria-label="Show light source"
        [title]="lightOn() ? 'Light on' : 'Light off'"
        (click)="toggleLight()"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="4" fill="currentColor" fill-opacity="0.35" stroke="currentColor" stroke-width="2" />
          <path
            d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button
        #settingsButton
        type="button"
        class="toggle"
        [class.on]="open()"
        [attr.aria-expanded]="open()"
        aria-controls="controls-panel"
        aria-label="Wave controls"
        (click)="open.set(!open())"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <path
            d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </nav>

    <aside id="controls-panel" aria-labelledby="controls-title" [class.open]="open()" [attr.inert]="open() ? null : ''">
      <div class="head">
        <h2 id="controls-title">Wave controls</h2>
        <button type="button" class="reset" [disabled]="settings.isDefault()" (click)="settings.reset()">
          Reset
        </button>
      </div>

      @for (group of groups; track group.name) {
        <details [open]="group.name === 'Surface' || group.name === 'Current' || group.name === 'Look'">
          <summary>{{ group.name }}</summary>
          @for (d of group.defs; track d.key) {
            @if (isSwitch(d)) {
              <!-- On/off settings are real switches, not 0-1 sliders. -->
              <label class="switch">
                <span>{{ d.label }}</span>
                <input
                  type="checkbox"
                  role="switch"
                  [checked]="settings.values()[d.key] > 0"
                  (change)="onSwitch(d.key, $event)"
                />
              </label>
            } @else {
              <label>
                <span class="row">
                  <span>{{ d.label }}</span>
                  <!-- Shown for sighted users only: the slider itself announces its value (aria-valuetext). -->
                  <span class="value" aria-hidden="true">{{ display(d) }}</span>
                </span>
                <input
                  type="range"
                  [attr.aria-label]="d.label"
                  [attr.aria-valuetext]="display(d)"
                  [min]="d.min"
                  [max]="d.max"
                  [step]="d.step"
                  [value]="settings.values()[d.key]"
                  (input)="onSlide(d.key, $event)"
                />
              </label>
            }
          }
        </details>
      }
    </aside>
  `,
})
export class ControlsDrawer {
  protected readonly settings = inject(LiquidSettings);
  protected readonly theme = inject(ThemeService);
  protected readonly groups = SETTING_GROUPS;
  protected readonly open = signal(false);
  private readonly settingsButton = viewChild.required<ElementRef<HTMLButtonElement>>('settingsButton');
  protected readonly auto = computed(() => this.settings.values()['themeAuto'] > 0);
  protected readonly lightOn = computed(() => this.settings.values()['lightShow'] > 0);
  protected readonly cloudsOn = computed(() => this.settings.values()['cloudsShow'] > 0);
  protected readonly calmOn = computed(() => this.settings.values()['calm'] > 0);
  protected toggleClouds(): void {
    this.settings.set('cloudsShow', this.cloudsOn() ? 0 : 1);
  }

  protected toggleLight(): void {
    this.settings.set('lightShow', this.lightOn() ? 0 : 1);
  }

  protected toggleCalm(): void {
    this.settings.set('calm', this.calmOn() ? 0 : 1);
  }

  /**
   * Pressing anywhere outside the panel and the toolbar closes it. (It listens for the press, not the click, so
   * dragging a slider inside the panel and letting go outside it does not count.) Focus is left where the press
   * put it, so clicking into the text box leaves you typing.
   */
  protected onPointerDown(event: PointerEvent): void {
    if (!this.open()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('aside, .actions')) return;
    this.open.set(false);
  }

  /** Escape closes the panel and puts focus back on the button that opened it. */
  protected onEscape(): void {
    if (!this.open()) return;
    this.open.set(false);
    this.settingsButton().nativeElement.focus();
  }

  protected isSwitch(d: SettingDef): boolean {
    return d.min === 0 && d.max === 1 && d.step === 1;
  }

  protected onSwitch(key: string, event: Event): void {
    this.settings.set(key, (event.target as HTMLInputElement).checked ? 1 : 0);
  }

  protected onSlide(key: string, event: Event): void {
    this.settings.set(key, +(event.target as HTMLInputElement).value);
    // Placing the light by hand takes over from the clock.
    if (key === 'lightX' || key === 'lightY') this.settings.set('lightFollowTime', 0);
    // Typing in a place by hand replaces the detected one.
    if (key === 'latitude' || key === 'longitude') this.settings.locationSource.set('manual');
  }

  /** The value as text, for both the visible readout and screen readers. */
  protected display(d: SettingDef): string {
    const value = this.settings.values()[d.key];
    if (d.key === 'lightClock') {
      if (value < 0) return 'Real clock';
      const hours = Math.floor(value);
      const time = new Date(2000, 0, 1, hours % 24, Math.min(Math.floor((value - hours) * 60), 59));
      return `${time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${this.settings.isDay(value) ? 'day' : 'night'})`;
    }
    if (d.key === 'latitude') return `${Math.abs(value).toFixed(1)}° ${value >= 0 ? 'N' : 'S'}`;
    if (d.key === 'longitude') return `${Math.abs(value).toFixed(1)}° ${value >= 0 ? 'E' : 'W'}`;
    if (d.key === 'dayOffset') return value === 0 ? 'Today' : `${value > 0 ? '+' : '−'}${Math.abs(value)} days`;
    const decimals = (d.step.toString().split('.')[1] ?? '').length;
    return value.toFixed(decimals);
  }
}
