import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { LiquidSettings } from './liquid-settings';
import { ThemeService } from './theme';
import { WeatherService } from './weather';

/** How long to wait after the last change before announcing, so a drag across the slider is spoken once. */
const ANNOUNCE_DELAY_MS = 800;

/**
 * What a sighted person sees, in words: the sky, the light, the water, the mountains and the clouds. The canvases
 * are hidden from assistive technology (they are pictures), so this section is how a screen reader user learns what
 * is on screen. It is plain text they can read at their own pace, and it is kept up to date quietly.
 *
 * The live region is separate and speaks only when the user changes the time, the place or the mode (by the slider,
 * the pin or the theme button, or because the sun has risen or set), giving the result in one short message.
 */
@Component({
  selector: 'app-scene-description',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="sr-only" aria-labelledby="scene-title">
      <h2 id="scene-title">Scene description</h2>
      <p>{{ sky() }}</p>
      <p>{{ times() }}</p>
      <p>{{ light() }}</p>
      <p>{{ water() }}</p>
      <p>{{ landscape() }}</p>
      <p>{{ clouds() }}</p>
      <p>{{ appearance() }}</p>
    </section>
    <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>
  `,
})
export class SceneDescription {
  private readonly settings = inject(LiquidSettings);
  private readonly theme = inject(ThemeService);
  private readonly weather = inject(WeatherService);

  /** Bumped every 30 seconds so the text follows the real clock (this region is not announced, only read). */
  private readonly tick = signal(0);
  protected readonly announcement = signal('');

  private readonly time = computed(() => {
    this.tick();
    const v = this.settings.values();
    const text = this.settings.formatHour(this.settings.hourOfDay());
    return v['lightClock'] >= 0 ? `${text}, set with the time slider` : `${text}, the current time`;
  });

  protected readonly sky = computed(() => `${this.time()}. ${this.settings.describeNow()}`);
  protected readonly times = computed(() => this.settings.sunTimesText());

  protected readonly light = computed(() => {
    const v = this.settings.values();
    if (v['lightShow'] <= 0) return 'The light source is off.';
    if (v['lightFollowTime'] === 0) {
      return `The light source is on, but has been moved by hand to ${Math.round(v['lightX'] * 100)} percent across and ${Math.round(v['lightY'] * 100)} percent down.`;
    }
    return `The light source is on and shows the ${this.settings.body}, following its real path across the sky.`;
  });

  protected readonly water = computed(() => {
    const v = this.settings.values();
    const flow = v['currentSpeed'] > 0 ? 'to the right' : v['currentSpeed'] < 0 ? 'to the left' : 'nowhere';
    const motion =
      v['calm'] > 0
        ? 'Calm motion is on, so the water is still unless you disturb it.'
        : `The water ripples gently, with a current carrying it ${flow}.`;
    return `The sea fills the lower part of the picture. ${motion} Letters you type drop into the water and splash. Moving the mouse through the water makes waves.`;
  });

  protected readonly landscape = computed(() => {
    const v = this.settings.values();
    if (v['landHeight'] <= 0) return 'There are no mountains.';
    const layers = Math.round(v['landLayers']);
    return `${layers} ${layers === 1 ? 'ridge' : 'ridges'} of mountains line the horizon, paler and hazier the further away. They slide slightly as the mouse moves, and the sun sets behind them.`;
  });

  protected readonly clouds = computed(() => {
    if (this.settings.values()['cloudsShow'] <= 0) return 'The clouds are hidden.';
    const weather = this.weather.summary();
    return weather
      ? `The clouds follow the real weather where you are: ${weather}. They drift the way the wind blows.`
      : 'Clouds drift slowly across the sky.';
  });

  protected readonly appearance = computed(() => {
    const following = this.settings.values()['themeAuto'] > 0;
    return `${this.theme.dark() ? 'Dark' : 'Light'} mode${following ? ', following the sun' : ', chosen by hand'}.`;
  });

  constructor() {
    const timer = setInterval(() => this.tick.update((n) => n + 1), 30_000);
    let announceTimer: ReturnType<typeof setTimeout> | undefined;
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      clearTimeout(announceTimer);
    });

    // Speak only when the user changes the time, place or mode, and only once their changes have settled.
    const trigger = computed(() => {
      const v = this.settings.values();
      return `${v['lightClock']}|${v['dayOffset']}|${v['latitude']}|${v['longitude']}|${this.theme.mode()}`;
    });
    let first = true;
    effect(() => {
      void trigger();
      if (first) {
        first = false;
        return;
      }
      untracked(() => {
        clearTimeout(announceTimer);
        announceTimer = setTimeout(() => {
          const lead = this.settings.values()['lightClock'] < 0 ? 'Showing the current time. ' : '';
          this.announcement.set(`${lead}${this.sky()} ${this.theme.dark() ? 'Dark' : 'Light'} mode.`);
        }, ANNOUNCE_DELAY_MS);
      });
    });
  }
}
