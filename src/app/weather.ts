import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { LiquidSettings } from './liquid-settings';
import { compass } from './solar';

/** What the weather is doing right now, in the terms the sky needs. Cover values are fractions, 0 to 1. */
export interface Weather {
  cover: number;
  /** High, middle and low cloud layers: these become the far, middle and nearest clouds in the picture. */
  high: number;
  mid: number;
  low: number;
  windKmh: number;
  /** Compass bearing the wind blows FROM, in degrees (270 is a westerly). */
  windFrom: number;
  /** WMO weather code (0 clear, 3 overcast, 45 fog, 61 rain, 95 thunderstorm...). */
  code: number;
}

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const STORAGE_KEY = 'liquid-weather';
const FRESH_MS = 20 * 60_000; // reuse a saved answer for this long (the service updates about every 15 minutes)
const REFRESH_MS = 15 * 60_000;
const DEBOUNCE_MS = 600;
const TIMEOUT_MS = 10_000;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Plain words for a WMO weather code. */
export function describeCode(code: number): string {
  if (code === 0) return 'clear sky';
  if (code === 1) return 'mostly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'foggy';
  if (code >= 51 && code <= 57) return 'drizzly';
  if (code >= 61 && code <= 67) return 'rainy';
  if (code >= 71 && code <= 77) return 'snowy';
  if (code >= 80 && code <= 82) return 'showery';
  if (code === 85 || code === 86) return 'snow showers';
  if (code >= 95) return 'stormy';
  return 'unsettled';
}

/**
 * The real cloud cover and wind at the user's location, from Open-Meteo (free, no account). It is only asked for
 * when the place is real (the device's, or typed in by hand: a guess from the time zone is too rough to be worth
 * asking about) and only while "Real clouds" is on. The place is rounded to a tenth of a degree (about 11 km) before
 * it leaves the page, the answer is kept for 20 minutes so reloads do not ask again, and if anything goes wrong the
 * sky simply carries on with the cloud sliders.
 */
@Injectable({ providedIn: 'root' })
export class WeatherService {
  private readonly settings = inject(LiquidSettings);

  /** The latest weather for the current place, or null when it is off, not known yet, or could not be fetched. */
  readonly current = signal<Weather | null>(null);

  /** The weather in words, for screen readers and the scene description (empty when there is none). */
  readonly summary = computed(() => {
    const w = this.current();
    if (!w) return '';
    const wind =
      w.windKmh < 2 ? 'almost no wind' : `wind from the ${compass(w.windFrom)} at ${Math.round(w.windKmh)} kilometres an hour`;
    return `${describeCode(w.code)}, ${Math.round(w.cover * 100)}% cloud cover, ${wind}`;
  });

  private debounce?: ReturnType<typeof setTimeout>;
  private place = '';
  private latest = 0;

  constructor() {
    const key = computed(() => {
      const v = this.settings.values();
      const wanted = v['cloudsReal'] > 0 && v['cloudsShow'] > 0 && this.settings.locationSource() !== 'estimate';
      return wanted ? `${round1(v['latitude'])}|${round1(v['longitude'])}` : '';
    });
    effect(() => {
      const next = key();
      untracked(() => this.follow(next));
    });
    const refresh = setInterval(() => this.place && void this.load(this.place), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(refresh);
      clearTimeout(this.debounce);
    });
  }

  private follow(place: string): void {
    clearTimeout(this.debounce);
    this.place = place;
    if (!place) {
      this.latest++; // anything still in flight is no longer wanted
      this.current.set(null);
      return;
    }
    // Wait a moment, so dragging a latitude slider asks once, not for every step.
    this.debounce = setTimeout(() => void this.load(place), DEBOUNCE_MS);
  }

  private async load(place: string): Promise<void> {
    const cached = this.readCache(place);
    if (cached) {
      this.current.set(cached);
      return;
    }
    const ticket = ++this.latest;
    const [latitude, longitude] = place.split('|');
    const url =
      `${ENDPOINT}?latitude=${latitude}&longitude=${longitude}` +
      '&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_direction_10m,weather_code' +
      '&timezone=auto';
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`weather ${response.status}`);
      const c = (await response.json()).current;
      const weather: Weather = {
        cover: (c.cloud_cover ?? 0) / 100,
        high: (c.cloud_cover_high ?? 0) / 100,
        mid: (c.cloud_cover_mid ?? 0) / 100,
        low: (c.cloud_cover_low ?? 0) / 100,
        windKmh: c.wind_speed_10m ?? 0,
        windFrom: c.wind_direction_10m ?? 0,
        code: c.weather_code ?? 0,
      };
      if (ticket !== this.latest || place !== this.place) return; // the place changed while we waited
      this.current.set(weather);
      this.writeCache(place, weather);
    } catch {
      // Offline, blocked or an error from the service: keep whatever we had, or fall back to the sliders.
      if (ticket === this.latest && !this.current()) this.current.set(null);
    }
  }

  private readCache(place: string): Weather | null {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (saved && saved.place === place && Date.now() - saved.at < FRESH_MS) return saved.weather as Weather;
    } catch {
      // fall through
    }
    return null;
  }

  private writeCache(place: string, weather: Weather): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ place, at: Date.now(), weather }));
    } catch {
      // ignore
    }
  }
}
