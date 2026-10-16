import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  afterNextRender,
  inject,
  viewChild,
} from '@angular/core';
import { BAND_COUNT, LiquidSettings } from './liquid-settings';

interface Letter {
  ch: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  size: number;
  hue: number;
  /** 0 while falling; counts up once the letter has entered the liquid. */
  submerged: number;
}

interface Droplet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
}

const SPACING = 5; // px between surface columns
const BAND_SPACING = 10;

@Component({
  selector: 'app-liquid-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #canvas></canvas>`,
  styles: `
    :host {
      display: block;
      position: relative;
      overflow: hidden;
      touch-action: none;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
  `,
  host: {
    '(pointermove)': 'onPointerMove($event)',
    '(pointerleave)': 'lastPointer = null',
  },
})
export class LiquidCanvas implements OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);
  private readonly settings = inject(LiquidSettings);
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private get s(): Record<string, number> {
    return this.settings.values();
  }

  private ctx!: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private baseY = 0;

  private heights = new Float32Array(0);
  private velocities = new Float32Array(0);
  private lDeltas = new Float32Array(0);
  private rDeltas = new Float32Array(0);

  /** Per-band displacement and velocity: underwater swells that lag the surface and react to the pointer. */
  private bandPos: Float32Array[] = [];
  private bandVel: Float32Array[] = [];
  private letters: Letter[] = [];
  private droplets: Droplet[] = [];
  private time = 0;
  private wavePhase = 0;
  private last = 0;
  private raf = 0;
  private resizeObserver?: ResizeObserver;
  protected lastPointer: { x: number; y: number; t: number } | null = null;

  constructor() {
    afterNextRender(() => {
      this.ctx = this.canvasRef().nativeElement.getContext('2d')!;
      this.resize();
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.host.nativeElement);
      // Animation loop runs outside Angular's zone; nothing here needs change detection.
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

  /** Drop a character into the liquid. `clientX` is a viewport x; random if omitted. */
  drop(ch: string, clientX?: number): void {
    if (!ch.trim() || this.width === 0) return;
    const xRatio =
      clientX === undefined
        ? Math.random()
        : (clientX - this.host.nativeElement.getBoundingClientRect().left) / this.width;
    const size = (34 + Math.random() * 22) * this.s['letterSize'];
    this.letters.push({
      ch,
      x: Math.min(Math.max(xRatio, 0.03), 0.97) * this.width + (Math.random() - 0.5) * 20,
      y: -size,
      vx: (Math.random() - 0.5) * 60,
      vy: 80 + Math.random() * 120,
      angle: (Math.random() - 0.5) * 0.8,
      spin: (Math.random() - 0.5) * 4,
      size,
      hue: 185 + Math.random() * 50,
      submerged: 0,
    });
  }

  protected onPointerMove(e: PointerEvent): void {
    const rect = this.host.nativeElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const now = performance.now();
    const prev = this.lastPointer;
    this.lastPointer = { x, y, t: now };
    if (!prev) return;

    const s = this.s;
    const dt = Math.max(now - prev.t, 1);
    const vx = (x - prev.x) / dt; // px/ms
    const vy = (y - prev.y) / dt;
    const speed = Math.hypot(vx, vy);
    const surface = this.surfaceAt(x);
    const wasBelow = prev.y > this.surfaceAt(prev.x);
    const isBelow = y > surface;

    if (wasBelow !== isBelow) {
      // Pointer broke the surface: splash proportional to how fast it crossed.
      const impact = Math.min(speed * 900, 900);
      this.disturb(x, Math.min(impact / 60, 12) * s['mouseSplash'], 20);
      const count = Math.round(Math.min(4 + Math.floor(impact / 40), 20) * s['mouseSplash']);
      for (let i = 0; i < count; i++) {
        this.droplets.push({
          x: x + (Math.random() - 0.5) * 16,
          y: surface,
          vx: vx * 250 + (Math.random() - 0.5) * 200,
          vy: -(60 + impact * (0.2 + Math.random() * 0.5)),
          r: 1.5 + Math.random() * 3,
          life: 1,
        });
      }
    } else if (isBelow) {
      // Sweeping through the water pumps out a train of travelling waves: the push alternates
      // up/down with the distance travelled, so each wavelength of movement emits one crest.
      this.wavePhase += ((x - prev.x) / s['wavelength']) * Math.PI * 2;
      const depthFalloff = Math.exp(-(y - surface) / 200);
      const amp = Math.min(Math.abs(vx) * 7 + Math.abs(vy) * 3, 9) * depthFalloff * s['wakeStrength'];
      this.disturb(x, Math.sin(this.wavePhase) * amp, 26);
      // Underwater bands nearest the pointer get shoved the hardest, so you can feel the depth.
      this.settings.bands().forEach((band, b) => {
        const nearness = Math.exp(-Math.abs(y - (this.baseY + band.depth)) / 70);
        this.pushBand(b, x, (vy * 6 + Math.sin(this.wavePhase) * Math.abs(vx) * 5) * nearness * band.react * 0.6 * s['layerPush'], 50);
      });
    } else if (surface - y < 30) {
      // Hovering just above the surface nudges it, like a breath of air.
      this.wavePhase += ((x - prev.x) / s['wavelength']) * Math.PI * 2;
      this.disturb(x, Math.sin(this.wavePhase) * Math.min(speed * 2, 2.5) * s['hoverStrength'], 30);
    }
  }

  private pushBand(band: number, x: number, force: number, radius: number): void {
    const vel = this.bandVel[band];
    const centre = x / BAND_SPACING;
    const r = radius / BAND_SPACING;
    const from = Math.max(0, Math.floor(centre - r * 2));
    const to = Math.min(vel.length - 1, Math.ceil(centre + r * 2));
    for (let i = from; i <= to; i++) {
      const d = (i - centre) / r;
      vel[i] += force * Math.exp(-d * d);
    }
  }

  private stepBands(k: number): void {
    this.settings.bands().forEach((band, b) => {
      const pos = this.bandPos[b];
      const vel = this.bandVel[b];
      const n = pos.length;
      for (let i = 0; i < n; i++) {
        // Pulled toward the (depth-attenuated) surface height, with a soft spring and drag.
        const target = this.heights[Math.min(i * 2, this.heights.length - 1)] * band.follow;
        vel[i] += ((target - pos[i]) * band.stiffness - pos[i] * 0.003 - vel[i] * (0.04 + band.stiffness)) * k;
      }
      for (let i = 1; i < n - 1; i++) vel[i] += (pos[i - 1] + pos[i + 1] - 2 * pos[i]) * 0.12 * k;
      for (let i = 0; i < n; i++) pos[i] += vel[i] * k;
    });
  }

  private resize(): void {
    const el = this.host.nativeElement;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = this.canvasRef().nativeElement;
    canvas.width = Math.round(w * this.dpr);
    canvas.height = Math.round(h * this.dpr);
    this.width = w;
    this.height = h;
    this.baseY = h * this.s['level'];

    const bn = Math.ceil(w / BAND_SPACING) + 1;
    if (this.bandPos[0]?.length !== bn) {
      this.bandPos = Array.from({ length: BAND_COUNT }, () => new Float32Array(bn));
      this.bandVel = Array.from({ length: BAND_COUNT }, () => new Float32Array(bn));
    }

    const n = Math.ceil(w / SPACING) + 1;
    if (n !== this.heights.length) {
      const old = this.heights;
      this.heights = new Float32Array(n);
      this.velocities = new Float32Array(n);
      this.lDeltas = new Float32Array(n);
      this.rDeltas = new Float32Array(n);
      this.heights.set(old.subarray(0, Math.min(old.length, n)));
    }
  }

  private surfaceAt(x: number): number {
    const f = Math.min(Math.max(x / SPACING, 0), this.heights.length - 1.001);
    const i = Math.floor(f);
    const t = f - i;
    return this.baseY + this.heights[i] * (1 - t) + this.heights[i + 1] * t;
  }

  /** Push the surface down (positive force) around x with a smooth bell-shaped falloff. */
  private disturb(x: number, force: number, radius: number): void {
    const centre = x / SPACING;
    const r = radius / SPACING;
    const from = Math.max(0, Math.floor(centre - r * 2));
    const to = Math.min(this.heights.length - 1, Math.ceil(centre + r * 2));
    for (let i = from; i <= to; i++) {
      const d = (i - centre) / r;
      this.velocities[i] += force * Math.exp(-d * d);
    }
  }

  private splash(letter: Letter, impactSpeed: number): void {
    const force = Math.min(impactSpeed / 90, 14) * (letter.size / 44) * this.s['splashForce'];
    this.disturb(letter.x, force, letter.size * 0.5);
    const count = Math.round(
      (10 + Math.floor(Math.random() * 8) + Math.floor(impactSpeed / 150)) * this.s['droplets'],
    );
    const surface = this.surfaceAt(letter.x);
    for (let i = 0; i < count; i++) {
      const dir = i % 2 ? 1 : -1;
      this.droplets.push({
        x: letter.x + (Math.random() - 0.5) * letter.size * 0.6,
        y: surface,
        vx: dir * (30 + Math.random() * 190),
        vy: -(impactSpeed * (0.25 + Math.random() * 0.45)),
        r: 1.5 + Math.random() * 3.5,
        life: 1,
      });
    }
  }

  private frame = (now: number): void => {
    const dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.last = now;
    this.time += dt;
    this.baseY = this.height * this.s['level'];
    this.step(dt);
    this.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  private step(dt: number): void {
    const s = this.s;
    const h = this.heights;
    const v = this.velocities;
    const n = h.length;
    if (!n) return;

    // Spring-column wave simulation, scaled to 60fps steps.
    const k = dt * 60;
    for (let i = 0; i < n; i++) {
      v[i] += (-s['tension'] * h[i] - s['damping'] * v[i]) * k;
      h[i] += v[i] * k;
    }
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < n; i++) {
        if (i > 0) {
          this.lDeltas[i] = s['spread'] * (h[i] - h[i - 1]);
          v[i - 1] += this.lDeltas[i] * k;
        }
        if (i < n - 1) {
          this.rDeltas[i] = s['spread'] * (h[i] - h[i + 1]);
          v[i + 1] += this.rDeltas[i] * k;
        }
      }
      for (let i = 0; i < n; i++) {
        if (i > 0) h[i - 1] += this.lDeltas[i] * k;
        if (i < n - 1) h[i + 1] += this.rDeltas[i] * k;
      }
    }

    this.stepBands(k);

    // Ambient gentle swell so the liquid never looks frozen.
    const idle = Math.sin(this.time * 0.9) * 0.01 * s['swell'];
    for (let i = 0; i < n; i++) v[i] += idle * Math.sin(i * 0.05 + this.time);

    for (const l of this.letters) {
      if (l.submerged === 0) {
        l.vy += s['gravity'] * dt;
        l.x += l.vx * dt;
        l.y += l.vy * dt;
        l.angle += l.spin * dt;
        if (l.y + l.size * 0.3 >= this.surfaceAt(l.x)) {
          l.submerged = 0.001;
          this.splash(l, l.vy);
          l.vy *= 0.35;
          l.vx *= 0.3;
          l.spin *= 0.3;
        }
      } else {
        // Sink with drag, then bob and fade out.
        l.submerged += dt;
        l.vy += (s['gravity'] * 0.15 - l.vy * 3) * dt;
        l.vx -= l.vx * 2 * dt;
        l.x += l.vx * dt;
        l.y += l.vy * dt;
        l.angle += l.spin * dt;
      }
    }
    this.letters = this.letters.filter((l) => l.submerged < 2.2);

    for (const d of this.droplets) {
      d.vy += s['gravity'] * 0.8 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.vy > 0 && d.y >= this.surfaceAt(d.x)) {
        this.disturb(d.x, d.r * 0.5, 6);
        d.life = 0;
      }
    }
    this.droplets = this.droplets.filter((d) => d.life > 0 && d.y < this.height + 20);
  }

  private draw(): void {
    const { ctx, width, height, dpr } = this;
    if (!ctx || !width) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Falling letters (above water) are drawn first.
    this.drawLetters(false);

    // Droplets
    ctx.fillStyle = 'rgba(120, 220, 255, 0.85)';
    for (const d of this.droplets) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Water body
    const h = this.heights;
    const path = new Path2D();
    path.moveTo(0, height);
    for (let i = 0; i < h.length; i++) path.lineTo(i * SPACING, this.baseY + h[i]);
    path.lineTo((h.length - 1) * SPACING, height);
    path.closePath();

    const grad = ctx.createLinearGradient(0, this.baseY - 20, 0, height);
    grad.addColorStop(0, 'rgba(70, 200, 255, 0.85)');
    grad.addColorStop(0.5, 'rgba(20, 110, 220, 0.92)');
    grad.addColorStop(1, 'rgba(8, 30, 110, 0.97)');
    ctx.fillStyle = grad;
    ctx.fill(path);

    // Submerged letters are seen through the water.
    ctx.save();
    ctx.clip(path);
    this.drawLetters(true);
    ctx.restore();

    // Underwater swells: they follow the surface with a delay and get shoved by the pointer.
    ctx.save();
    ctx.clip(path);
    this.settings.bands().forEach((band, b) => {
      const pos = this.bandPos[b];
      const base = this.baseY + band.depth;
      const sway = Math.sin(this.time * band.drift + b) * 8;
      const wave = (x: number) =>
        base + sway * Math.sin(x * 0.012 + this.time * band.drift + b) +
        pos[Math.min(Math.round(x / BAND_SPACING), pos.length - 1)] * 1.6;
      ctx.beginPath();
      ctx.moveTo(0, wave(0));
      for (let x = 0; x <= width + BAND_SPACING; x += BAND_SPACING) ctx.lineTo(x, wave(x));
      ctx.lineTo(width + BAND_SPACING, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 255, 255, ${0.07 - b * 0.01})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(200, 240, 255, ${0.16 - b * 0.03})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x <= width + BAND_SPACING; x += BAND_SPACING) {
        x ? ctx.lineTo(x, wave(x)) : ctx.moveTo(x, wave(x));
      }
      ctx.stroke();
    });
    ctx.restore();

    // Surface highlight
    ctx.beginPath();
    for (let i = 0; i < h.length; i++) {
      const x = i * SPACING;
      const y = this.baseY + h[i];
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = 'rgba(220, 250, 255, 0.9)';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  private drawLetters(submerged: boolean): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of this.letters) {
      if ((l.submerged > 0) !== submerged) continue;
      ctx.save();
      ctx.translate(l.x, l.y);
      ctx.rotate(l.angle);
      ctx.font = `700 ${l.size}px system-ui, sans-serif`;
      if (submerged) {
        ctx.globalAlpha = Math.max(0, 1 - l.submerged / 2.2) * 0.8;
        ctx.fillStyle = `hsl(${l.hue} 90% 85%)`;
        ctx.filter = `blur(${Math.min(l.submerged * 3, 4)}px)`;
      } else {
        ctx.fillStyle = `hsl(${l.hue} 90% 92%)`;
        ctx.shadowColor = `hsl(${l.hue} 100% 70%)`;
        ctx.shadowBlur = 14;
      }
      ctx.fillText(l.ch, 0, 0);
      ctx.restore();
    }
  }
}
