import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  afterNextRender,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { LiquidSettings } from './liquid-settings';
import { ThemeService } from './theme';

const SPRITE_W = 640;
const SPRITE_H = 260;
const SPRITE_VARIANTS = 6;
/** Which parallax layers each instance draws. Front clouds float over the light, so they can block it. */
const LAYER_SETS = { back: [0, 1], front: [2] };
const CLOUDS_PER_SET = { back: 8, front: 4 };
/** How far above the waterline front clouds fade out (px), so they never overlap the water. */
const WATERLINE_FADE = 70;

/** Parallax layers, far to near: opacity, drift speed (px/s), size, and the band of sky they float in (fractions of height). */
const LAYERS = [
  { alpha: 0.22, speed: 1, scale: 0.6, top: 0.03, bottom: 0.2 },
  { alpha: 0.34, speed: 2, scale: 1, top: 0.06, bottom: 0.3 },
  { alpha: 0.7, speed: 3.5, scale: 1.5, top: 0.1, bottom: 0.4 },
];

interface Cloud {
  sprite: number;
  layer: number;
  x: number;
  /** Vertical position as a fraction of the viewport height. */
  y: number;
  scale: number;
  phase: number;
}

/**
 * Slow, soft clouds moving the way the current flows. The `back` instance sits behind the water and
 * light; the `front` instance floats above the light's glow, so passing clouds dim it.
 */
@Component({
  selector: 'app-clouds',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.z-index]': "layer() === 'front' ? 6 : null" },
  template: `<canvas #canvas aria-hidden="true"></canvas>`,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
  `,
})
export class Clouds implements OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);
  private readonly settings = inject(LiquidSettings);
  private readonly theme = inject(ThemeService);
  readonly layer = input<'back' | 'front'>('back');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private ctx!: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  /** Cloud sprites per theme: bluish-grey wisps on dark skies, bright white ones on light skies. */
  private readonly spriteSets: Partial<Record<'dark' | 'light', HTMLCanvasElement[]>> = {};
  /** Scratch layer used to build the light's glow in the shape of the clouds only. */
  private lit = document.createElement('canvas');
  private clouds: Cloud[] = [];
  private raf = 0;
  private last = 0;
  private time = 0;
  private resizeObserver?: ResizeObserver;

  constructor() {
    afterNextRender(() => {
      this.ctx = this.canvasRef().nativeElement.getContext('2d')!;
      this.resize();
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.host.nativeElement);
      this.zone.runOutsideAngular(() => {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.frame);
      });
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
  }

  private spritesFor(dark: boolean): HTMLCanvasElement[] {
    const key = dark ? 'dark' : 'light';
    return (this.spriteSets[key] ??= Array.from({ length: SPRITE_VARIANTS }, () => makeCloudSprite(dark)));
  }

  private resize(): void {
    const w = this.host.nativeElement.clientWidth;
    const h = this.host.nativeElement.clientHeight;
    if (!w || !h) return;
    const canvas = this.canvasRef().nativeElement;
    canvas.width = this.lit.width = w;
    canvas.height = this.lit.height = h;
    this.width = w;
    this.height = h;
    if (!this.clouds.length) this.clouds = this.spawn();
  }

  /** Scatter this instance's clouds across its layers, spread evenly so the sky never looks clumped. */
  private spawn(): Cloud[] {
    const set = this.layer();
    const count = CLOUDS_PER_SET[set];
    const layers = LAYER_SETS[set];
    return Array.from({ length: count }, (_, i) => {
      const layer = layers[i % layers.length];
      const l = LAYERS[layer];
      return {
        sprite: Math.floor(Math.random() * SPRITE_VARIANTS),
        layer,
        x: (i / count) * (this.width + 600) - 300 + Math.random() * 120,
        y: l.top + Math.random() * (l.bottom - l.top),
        scale: l.scale * (0.8 + Math.random() * 0.4),
        phase: Math.random() * Math.PI * 2,
      };
    });
  }

  private frame = (now: number): void => {
    const dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.last = now;
    if (this.settings.values()['calm'] <= 0) this.time += dt; // calm motion: clouds stop thickening, thinning and bobbing
    this.draw(dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  /**
   * Lights the clouds from the light source: a warm radial glow is painted only where clouds already
   * are, then added back on top, so clouds near the light blaze while the rest stay dim.
   */
  private backlight(strength: number, s: Record<string, number>): void {
    const { ctx, lit, width, height } = this;
    const g = lit.getContext('2d')!;
    const x = s['lightX'] * width;
    const y = s['lightY'] * height;
    const r = s['lightRadius'] * 1.15;
    const hue = s['lightHue'];

    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, width, height);
    g.drawImage(ctx.canvas, 0, 0);
    g.globalCompositeOperation = 'source-atop'; // colour only the existing cloud pixels
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `hsl(${hue} 100% 78% / 1)`);
    grad.addColorStop(0.35, `hsl(${hue} 100% 66% / 0.75)`);
    grad.addColorStop(1, `hsl(${hue} 100% 55% / 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(strength * 1.4, 1);
    ctx.drawImage(lit, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private draw(dt: number): void {
    const { ctx, width, height } = this;
    if (!ctx || !width) return;
    const s = this.settings.values();
    ctx.clearRect(0, 0, width, height);
    if (!s['cloudsShow']) return;

    // While the theme fades, both looks are drawn, each weighted by how far the fade has got, so the clouds
    // dissolve from bright white to dim grey-blue rather than switching.
    const tone = this.theme.tone;
    const darkSprites = tone > 0.01 ? this.spritesFor(true) : null;
    const lightSprites = tone < 0.99 ? this.spritesFor(false) : null;
    const opacity = s['cloudOpacity'];
    const visible = Math.round(this.clouds.length * s['cloudCover']);
    if (!opacity || !visible) return;

    // Clouds drift the way the current flows (rightwards if it's still).
    const dir = Math.sign(s['currentSpeed']) || 1;
    const speed = s['calm'] > 0 ? 0 : s['cloudSpeed'];

    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      const layer = LAYERS[c.layer];
      const size = c.scale * s['cloudSize'];
      const w = SPRITE_W * size;
      const h = SPRITE_H * size;
      c.x += dir * layer.speed * speed * dt;
      if (dir > 0 && c.x > width) c.x = -w;
      if (dir < 0 && c.x < -w) c.x = width;
      if (i >= visible) continue;

      // Each cloud slowly thickens and thins, and bobs a little, so it never looks like a rigid picture.
      const breathe = 0.82 + 0.18 * Math.sin(this.time * 0.18 + c.phase);
      const bob = Math.sin(this.time * 0.05 + c.phase) * 6;
      const frontDensity = this.layer() === 'front' ? s['cloudFrontDensity'] : 1;
      const base = layer.alpha * frontDensity * opacity * breathe;
      const top = (c.y + s['cloudAltitude']) * height + bob;
      if (darkSprites) {
        ctx.globalAlpha = Math.min(base * tone, 0.95);
        ctx.drawImage(darkSprites[c.sprite], c.x, top, w, h);
      }
      if (lightSprites) {
        // Pale clouds need to be denser to show against a bright sky.
        ctx.globalAlpha = Math.min(base * 1.55 * (1 - tone), 0.95);
        ctx.drawImage(lightSprites[c.sprite], c.x, top, w, h);
      }
    }
    ctx.globalAlpha = 1;

    const glow = s['lightShow'] > 0 ? s['lightCloudGlow'] * s['lightIntensity'] * this.settings.daylight : 0;
    if (glow > 0) this.backlight(glow, s);

    if (this.layer() === 'front') {
      // Erase everything at and below the waterline (fading in just above it) so these clouds
      // stay in the sky instead of floating over the water.
      const wl = Math.min(this.settings.waterline, height);
      const fade = ctx.createLinearGradient(0, wl - WATERLINE_FADE, 0, wl);
      fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
      fade.addColorStop(1, 'rgba(0, 0, 0, 1)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = fade;
      ctx.fillRect(0, wl - WATERLINE_FADE, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

/**
 * Builds one cumulus-style cloud from many faint overlapping puffs: tall in the middle, flat on the
 * bottom, with a bluish shaded underside.
 */
function makeCloudSprite(dark: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_W;
  canvas.height = SPRITE_H;
  const g = canvas.getContext('2d')!;
  const base = SPRITE_H * 0.68;

  const puffs = 26 + Math.floor(Math.random() * 10);
  for (let i = 0; i < puffs; i++) {
    const t = (i + Math.random()) / puffs;
    const bump = Math.sin(t * Math.PI); // 0 at the ends, 1 in the middle
    const r = (28 + bump * 62) * (0.65 + Math.random() * 0.6);
    const x = SPRITE_W * (0.12 + 0.76 * t);
    const y = base - bump * SPRITE_H * 0.3 * Math.random() - r * 0.15;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, dark ? 'rgba(214, 226, 247, 0.5)' : 'rgba(255, 255, 255, 0.55)');
    grad.addColorStop(0.55, dark ? 'rgba(206, 220, 244, 0.22)' : 'rgba(250, 252, 255, 0.28)');
    grad.addColorStop(1, dark ? 'rgba(200, 215, 240, 0)' : 'rgba(245, 250, 255, 0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Shade the underside, and fade the very bottom so the base stays flat but soft.
  g.globalCompositeOperation = 'source-atop';
  const shade = g.createLinearGradient(0, SPRITE_H * 0.25, 0, base + 30);
  shade.addColorStop(0, dark ? 'rgba(120, 140, 190, 0)' : 'rgba(150, 170, 205, 0)');
  shade.addColorStop(1, dark ? 'rgba(70, 90, 150, 0.55)' : 'rgba(120, 145, 190, 0.5)');
  g.fillStyle = shade;
  g.fillRect(0, 0, SPRITE_W, SPRITE_H);
  g.globalCompositeOperation = 'destination-out';
  const cut = g.createLinearGradient(0, base - 10, 0, base + 40);
  cut.addColorStop(0, 'rgba(0, 0, 0, 0)');
  cut.addColorStop(1, 'rgba(0, 0, 0, 1)');
  g.fillStyle = cut;
  g.fillRect(0, base - 10, SPRITE_W, SPRITE_H);
  return canvas;
}
