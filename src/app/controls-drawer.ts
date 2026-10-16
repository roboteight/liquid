import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LiquidSettings, SETTING_GROUPS } from './liquid-settings';

@Component({
  selector: 'app-controls-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './controls-drawer.css',
  template: `
    <button
      type="button"
      class="toggle"
      [class.open]="open()"
      [attr.aria-expanded]="open()"
      aria-controls="controls-panel"
      aria-label="Toggle wave controls"
      (click)="open.set(!open())"
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
    </button>

    <aside id="controls-panel" [class.open]="open()" [attr.inert]="open() ? null : ''">
      <div class="head">
        <h2>Wave controls</h2>
        <button type="button" class="reset" [disabled]="settings.isDefault()" (click)="settings.reset()">
          Reset
        </button>
      </div>

      @for (group of groups; track group.name) {
        <details [open]="group.name === 'Surface' || group.name === 'Mouse'">
          <summary>{{ group.name }}</summary>
          @for (d of group.defs; track d.key) {
            <label>
              <span class="row">
                <span>{{ d.label }}</span>
                <output>{{ format(settings.values()[d.key], d.step) }}</output>
              </span>
              <input
                type="range"
                [min]="d.min"
                [max]="d.max"
                [step]="d.step"
                [value]="settings.values()[d.key]"
                (input)="onSlide(d.key, $event)"
              />
            </label>
          }
        </details>
      }
    </aside>
  `,
})
export class ControlsDrawer {
  protected readonly settings = inject(LiquidSettings);
  protected readonly groups = SETTING_GROUPS;
  protected readonly open = signal(false);

  protected onSlide(key: string, event: Event): void {
    this.settings.set(key, +(event.target as HTMLInputElement).value);
  }

  protected format(value: number, step: number): string {
    const decimals = (step.toString().split('.')[1] ?? '').length;
    return value.toFixed(decimals);
  }
}
