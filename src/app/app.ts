import { ChangeDetectionStrategy, Component, viewChild } from '@angular/core';
import { ControlsDrawer } from './controls-drawer';
import { LiquidCanvas } from './liquid-canvas';

@Component({
  selector: 'app-root',
  imports: [LiquidCanvas, ControlsDrawer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './app.css',
  template: `
    <main>
      <header>
        <input
          type="text"
          placeholder="Type something…"
          autocomplete="off"
          spellcheck="false"
          autofocus
          aria-label="Text to drop into the liquid"
          (input)="onInput($event)"
        />
      </header>
      <app-liquid-canvas />
    </main>
    <app-controls-drawer />
  `,
})
export class App {
  private readonly liquid = viewChild.required(LiquidCanvas);
  private previous = '';

  protected onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value;
    // Only newly added characters drop; deletions and edits mid-string are ignored.
    const added = value.length > this.previous.length ? value.slice(this.previous.length) : '';
    const fresh = value.startsWith(this.previous) ? added : ((event as InputEvent).data ?? '');
    this.previous = value;

    const box = input.getBoundingClientRect();
    const charWidth = parseFloat(getComputedStyle(input).fontSize) * 0.6;
    const total = [...value].length;
    [...fresh].forEach((ch, i) => {
      const caret = Math.min((total - fresh.length + i) * charWidth + 24, box.width - 24);
      this.liquid().drop(ch, box.left + caret);
    });
  }
}
