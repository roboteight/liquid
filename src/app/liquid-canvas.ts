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
import { BoxSpec, FloatingBox, Water } from './floating-box';
import { BAND_COUNT, LiquidSettings } from './liquid-settings';
import { ThemeService, lerp } from './theme';

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
/** How far the mountains run below the waterline (px) before fading out. */
const LAND_DEPTH = 140;
const LAND_STEP = 4; // px between points along a ridge
const RIM_BUCKETS = 6; // rim-light strength is quantised so each frame needs only a few strokes
/** Largest sideways shift (px) of the nearest mountain layer at parallax 1. */
const LAND_PARALLAX_PX = 50;
/** Largest vertical shift (px) of the nearest mountain layer at vertical parallax 1: just a little. */
const LAND_PARALLAX_Y_PX = 26;
/** Ridges are built this far past each edge of the canvas, so shifting them never reveals a gap. */
const LAND_MARGIN = 110;

interface LandLayer {
  /** Ridge height (negative = up) every LAND_STEP px, relative to the waterline. */
  heights: Float32Array;
  path: Path2D;
  /** 0 for the farthest layer, 1 for the nearest. */
  depth: number;
}
const PARTICLE_COUNT = 140;

/** A speck of suspended matter that makes the current visible. */
interface Particle {
  x: number;
  depth: number;
  size: number;
  /** How closely it follows the current (0.6–1.2). */
  speed: number;
  phase: number;
}

@Component({
  selector: 'app-liquid-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #canvas aria-hidden="true"></canvas>`,
  styles: `
    :host {
      display: block;
      position: relative;
      touch-action: none;
    }
    /* The canvas reaches up past the top of this box (to the top of the page) so the light's glow and a
       falling input box are never cut off; its top and height are set in resize(). */
    canvas {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      display: block;
      pointer-events: none;
    }
  `,
  host: {
    // Listen on the window so overlays above the water (the light's grab area, clouds, the vignette)
    // never stop the mouse from making waves.
    '(window:pointermove)': 'onPointerMove($event)',
    '(document:pointerleave)': 'lastPointer = null',
  },
})
export class LiquidCanvas implements OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);
  private readonly settings = inject(LiquidSettings);
  private readonly theme = inject(ThemeService);
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private get s(): Record<string, number> {
    return this.settings.values();
  }

  private ctx!: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private baseY = 0;
  private hostTop = 0;
  /** How far (px) the canvas extends above the top of the host; drawing coordinates stay relative to the host. */
  private overscan = 0;

  private heights = new Float32Array(0);
  private velocities = new Float32Array(0);
  private lDeltas = new Float32Array(0);
  private rDeltas = new Float32Array(0);

  /** Per-band displacement and velocity: underwater swells that lag the surface and react to the pointer. */
  private bandPos: Float32Array[] = [];
  private bandVel: Float32Array[] = [];
  private bandPhase: number[] = Array(BAND_COUNT).fill(0);
  private scratch = new Float32Array(0);
  private surfacePhase = 0;
  /** Current velocity at the surface in px/s (positive flows right), including gusts. */
  private flow = 0;
  private particles: Particle[] = [];
  private sprite?: HTMLCanvasElement;
  /** The sun is composed here so the landscape can be cut out of it before it is drawn. */
  private readonly sunLayer = document.createElement('canvas');
  private landKey = '';
  private landLayers: LandLayer[] = [];
  /** Sideways parallax of the mountains, -1..1, eased toward where the pointer is across the screen. */
  private parallax = 0;
  /** Small vertical parallax, -1..1, eased toward the pointer's height on screen. */
  private parallaxY = 0;
  private pointerNx = 0;
  private pointerNy = 0;
  private box: FloatingBox | null = null;
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
      y: 0, // starts level with the top of the canvas, behind the input box
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
    this.pointerNx = Math.min(Math.max((e.clientX / innerWidth) * 2 - 1, -1), 1);
    this.pointerNy = Math.min(Math.max((e.clientY / innerHeight) * 2 - 1, -1), 1);
    // No waves while using the controls, typing, or dragging/resizing the light with a button held.
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('input, app-controls-drawer, .actions') || (e.buttons && target?.closest('.orb, .handle'))) {
      this.lastPointer = null;
      return;
    }
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

  /** Current velocity (px/s) at a depth below the surface; it weakens with depth. */
  private flowAt(depth: number): number {
    return this.flow * Math.exp(-Math.max(depth, 0) / this.s['currentDepth']);
  }

  /** Semi-Lagrangian advection: shift `arr` downstream by `cells` (fractional) grid cells. */
  private advect(arr: Float32Array, cells: number): void {
    const n = arr.length;
    const out = this.scratch;
    for (let i = 0; i < n; i++) {
      const src = Math.min(Math.max(i - cells, 0), n - 1.001);
      const j = Math.floor(src);
      const t = src - j;
      out[i] = arr[j] * (1 - t) + arr[j + 1] * t;
    }
    for (let i = 0; i < n; i++) arr[i] = out[i];
  }

  /** A pre-rendered soft blob (bright centre fading to nothing), stretched per particle when drawn. */
  private blurSprite(): HTMLCanvasElement {
    if (this.sprite) return this.sprite;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 32;
    const g = c.getContext('2d')!;
    g.translate(32, 16);
    g.scale(1, 0.5); // turns the circular gradient into an ellipse
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 32);
    grad.addColorStop(0, 'rgba(225, 248, 255, 1)');
    grad.addColorStop(0.35, 'rgba(215, 245, 255, 0.55)');
    grad.addColorStop(1, 'rgba(215, 245, 255, 0)');
    g.fillStyle = grad;
    g.fillRect(-32, -32, 64, 64);
    return (this.sprite = c);
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

  private stepBands(k: number, dt: number): void {
    this.settings.bands().forEach((band, b) => {
      const pos = this.bandPos[b];
      const vel = this.bandVel[b];
      const n = pos.length;
      // The layer is carried along by the current at its depth, and its ambient shimmer travels with it.
      const flow = this.flowAt(band.depth);
      this.advect(pos, (flow * dt) / BAND_SPACING);
      this.advect(vel, (flow * dt) / BAND_SPACING);
      if (this.s['calm'] <= 0) this.bandPhase[b] += dt * ((Math.sign(this.flow) || 1) * band.drift * 0.25 + 0.012 * flow);
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
    this.hostTop = el.getBoundingClientRect().top;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = this.canvasRef().nativeElement;
    this.overscan = Math.max(Math.ceil(this.hostTop), 0);
    canvas.style.top = `${-this.overscan}px`;
    canvas.style.height = `${h + this.overscan}px`;
    canvas.width = this.sunLayer.width = Math.round(w * this.dpr);
    canvas.height = this.sunLayer.height = Math.round((h + this.overscan) * this.dpr);
    this.width = w;
    this.height = h;
    this.baseY = h * this.s['level'];

    const bn = Math.ceil(w / BAND_SPACING) + 1;
    if (this.bandPos[0]?.length !== bn) {
      this.bandPos = Array.from({ length: BAND_COUNT }, () => new Float32Array(bn));
      this.bandVel = Array.from({ length: BAND_COUNT }, () => new Float32Array(bn));
    }

    const n = Math.ceil(w / SPACING) + 1;
    this.scratch = new Float32Array(Math.max(n, bn));
    if (!this.particles.length) {
      this.particles = Array.from({ length: PARTICLE_COUNT }, () => ({
        x: Math.random() * Math.max(w, 1920),
        depth: 10 + Math.random() ** 1.5 * 520,
        size: 0.8 + Math.random() * 1.8,
        speed: 0.6 + Math.random() * 0.6,
        phase: Math.random() * Math.PI * 2,
      }));
    }
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
    this.splashAt(letter.x, impactSpeed, letter.size, 1);
  }

  private splashAt(x: number, impactSpeed: number, size: number, intensity: number): void {
    const force = Math.min(impactSpeed / 90, 14) * (size / 44) * intensity * this.s['splashForce'];
    this.disturb(x, force, size * 0.5);
    const count = Math.round(
      (10 + Math.floor(Math.random() * 8) + Math.floor(impactSpeed / 150)) * intensity * this.s['droplets'],
    );
    const surface = this.surfaceAt(x);
    for (let i = 0; i < count; i++) {
      const dir = i % 2 ? 1 : -1;
      this.droplets.push({
        x: x + (Math.random() - 0.5) * size * 0.6,
        y: surface,
        vx: dir * (30 + Math.random() * 190),
        vy: -(impactSpeed * (0.25 + Math.random() * 0.45)),
        r: 1.5 + Math.random() * 3.5,
        life: 1,
      });
    }
  }

  /** The water as seen by the floating box. */
  private readonly water: Water = this.makeWater();

  private makeWater(): Water {
    const sim = this;
    return {
      surfaceAt: (x) => sim.surfaceAt(x),
      get level() {
        return sim.baseY;
      },
      flowAt: (depth) => sim.flowAt(depth),
      disturb: (x, force, radius) => sim.disturb(x, force, radius),
      splash: (x, speed, size, intensity) => sim.splashAt(x, speed, size, intensity),
    };
  }

  /**
   * Drops a box (the page's input) into the water. `rect` is in viewport pixels. Returns false if one
   * is already in the water. `onDone` fires once it has sunk out of sight.
   */
  dropBox(
    rect: DOMRect,
    spec: { text: string; font: string; padding: number },
    onDone: () => void,
  ): boolean {
    if (this.box || !this.width) return false;
    const host = this.host.nativeElement.getBoundingClientRect();
    const full: BoxSpec = {
      ...spec,
      x: rect.left - host.left + rect.width / 2,
      y: rect.top - host.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
    this.box = new FloatingBox(full, () => {
      this.box = null;
      onDone();
    });
    return true;
  }

  private frame = (now: number): void => {
    const dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.last = now;
    // Calm motion freezes the clock the ambient animation runs on (swells, rays, shimmer, drifting specks),
    // while anything the user causes (letters, ripples, the dropped box) keeps its real-time physics.
    if (this.s['calm'] <= 0) this.time += dt;
    this.baseY = this.height * this.s['level'];
    this.settings.waterline = this.hostTop + this.baseY;
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

    // Mountain parallax eases toward the pointer's position across the screen, with a faint idle sway so
    // it is never static.
    const calmed = s['calm'] > 0;
    const parallaxTarget = this.pointerNx + (calmed ? 0 : Math.sin(this.time * 0.2) * 0.12);
    this.parallax += (parallaxTarget - this.parallax) * Math.min(dt * 3, 1);
    this.parallaxY += (this.pointerNy - this.parallaxY) * Math.min(dt * 3, 1);

    // Current: slow gusts modulate the base speed.
    const gust = 1 + s['currentGusts'] * 0.6 * Math.sin(this.time * 0.35 + 2 * Math.sin(this.time * 0.13));
    this.flow = calmed ? 0 : s['currentSpeed'] * gust;

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

    // Ripples and swells are carried downstream by the surface current.
    this.advect(h, (this.flowAt(0) * dt) / SPACING);
    this.advect(v, (this.flowAt(0) * dt) / SPACING);

    this.stepBands(k, dt);

    // Ambient gentle swell so the liquid never looks frozen.
    const idle = calmed ? 0 : Math.sin(this.time * 0.9) * 0.01 * s['swell'];
    for (let i = 0; i < n; i++) v[i] += idle * Math.sin(i * 0.05 + this.time);

    // Driven waves: a wave train that travels at the speed of the current.
    const drive = calmed ? 0 : 0.08 * s['currentWaves'] * Math.min(Math.abs(this.flow) / 60, 3);
    this.surfacePhase += dt * 0.025 * this.flow;
    if (drive) for (let i = 0; i < n; i++) v[i] += drive * Math.sin(i * SPACING * 0.025 - this.surfacePhase);

    const box = this.box;
    if (box && box.step(dt, this.water, s['gravity'])) box.disturbWater(this.water, k);

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
        l.vx += (this.flowAt(l.y - this.baseY) * s['currentLetters'] - l.vx) * 1.5 * dt;
        l.x += l.vx * dt;
        l.y += l.vy * dt;
        l.angle += l.spin * dt;
      }
    }
    this.letters = this.letters.filter((l) => l.submerged < 2.2);

    for (const p of this.particles) {
      if (!calmed) {
        p.x += (this.flowAt(p.depth) * p.speed + Math.sin(this.time * 0.8 + p.phase) * 4) * dt;
        p.depth += Math.cos(this.time * 0.6 + p.phase) * 3 * dt;
      }
      p.x = ((p.x % this.width) + this.width) % this.width;
    }

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
    // y = 0 is the top of the host; the overscan above it has negative y.
    ctx.setTransform(dpr, 0, 0, dpr, 0, this.overscan * dpr);
    ctx.clearRect(0, -this.overscan, width, height + this.overscan);

    this.drawSun();
    this.drawLand();

    // Falling letters (above water) are drawn first.
    this.drawLetters(false);
    // 0 on a light scene, 1 on a dark one, and in between while the theme is fading.
    const tone = this.theme.tone;
    this.box?.draw(ctx, false, tone);

    // Droplets
    ctx.fillStyle = `rgba(${lerp(40, 120, tone)}, ${lerp(140, 220, tone)}, ${lerp(215, 255, tone)}, 0.85)`;
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

    // Depth gradient: bright, translucent shallows fading to dark, saturated depths.
    const hue = this.s['waterHue'];
    const dark = this.s['depthDarkness'];
    const grad = ctx.createLinearGradient(0, this.baseY - 20, 0, height);
    // Light mode keeps the water bright all the way down; dark mode lets it fade toward black-blue.
    grad.addColorStop(0, `hsla(${hue} 90% ${lerp(62, 64, tone)}% / 0.86)`);
    grad.addColorStop(0.12, `hsla(${hue + 6} 88% ${lerp(52, 54, tone)}% / 0.92)`);
    grad.addColorStop(0.45, `hsla(${hue + 16} 82% ${lerp(46 - dark * 10, 44 - dark * 12, tone)}% / 0.95)`);
    grad.addColorStop(1, `hsla(${hue + 28} 78% ${lerp(36 - dark * 16, 30 - dark * 22, tone)}% / 0.98)`);
    ctx.fillStyle = grad;
    ctx.fill(path);

    // Submerged letters are seen through the water.
    ctx.save();
    ctx.clip(path);
    this.drawLetters(true);
    this.box?.draw(ctx, true, tone);
    ctx.restore();

    // Underwater swells: they follow the surface with a delay and get shoved by the pointer.
    ctx.save();
    ctx.clip(path);
    this.settings.bands().forEach((band, b) => {
      const pos = this.bandPos[b];
      const base = this.baseY + band.depth;
      const sway = Math.sin(this.time * band.drift + b) * 8;
      const wave = (x: number) =>
        base + sway * Math.sin(x * 0.012 - this.bandPhase[b] + b) +
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

    // Flow streaks: soft, blurry smudges stretched along the current. Deeper ones are blurrier,
    // like out-of-focus particles, and the bright core tapers off to nothing at every edge.
    const visible = Math.round(PARTICLE_COUNT * this.s['currentParticles']);
    const sprite = this.blurSprite();
    for (let i = 0; i < visible; i++) {
      const p = this.particles[i];
      const flow = this.flowAt(p.depth) * p.speed;
      const y =
        this.baseY + p.depth + this.heights[Math.min(Math.round(p.x / SPACING), h.length - 1)] * Math.exp(-p.depth / 150) * 0.8;
      const stretch = this.s['currentStreakLength'];
      const len = Math.min(Math.max(Math.abs(flow) * 0.22 * stretch, 2), 70 * stretch);
      const blur = (1 + p.depth / 260) * this.s['currentStreakBlur'];
      const w = len * 1.7 + p.size * 5 * blur;
      const hgt = p.size * 3.6 * blur;
      ctx.globalAlpha = Math.min((0.5 + p.size * 0.2) * Math.exp(-p.depth / 450) / Math.sqrt(blur), 1);
      ctx.drawImage(sprite, p.x - Math.sign(flow || 1) * len * 0.5 - w / 2, y - hgt / 2, w, hgt);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    this.drawLight(path);

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

  /** Glow under the surface, slow light shafts and a darkened edge vignette, all clipped to the water. */
  private drawLight(water: Path2D): void {
    const { ctx, width, height, baseY, time } = this;
    const s = this.s;
    ctx.save();
    ctx.clip(water);

    const glow = s['lightIntensity'] * this.settings.daylight;
    if (s['lightShow'] > 0 && glow > 0) {
      // The light's warm pool on the water, added to what is already there.
      const x = s['lightX'] * width;
      const y = s['lightY'] * innerHeight - this.hostTop;
      const hue = s['lightHue'];
      const pool = ctx.createRadialGradient(x, y, 0, x, y, s['lightRadius'] * 0.9);
      pool.addColorStop(0, `hsl(${hue} 100% 78% / ${glow * 0.6})`);
      pool.addColorStop(0.45, `hsl(${hue} 100% 62% / ${glow * 0.22})`);
      pool.addColorStop(1, `hsl(${hue} 100% 55% / 0)`);
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = pool;
      ctx.fillRect(0, baseY - 20, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }

    if (s['surfaceGlow'] > 0) {
      const glow = ctx.createLinearGradient(0, baseY - 10, 0, baseY + 140);
      glow.addColorStop(0, `rgba(230, 250, 255, ${0.45 * s['surfaceGlow']})`);
      glow.addColorStop(1, 'rgba(230, 250, 255, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, baseY - 10, width, 150);
    }

    if (s['lightRays'] > 0) {
      // Beams of light in the water. They fan out from the light source (or, with the light off, from an
      // imaginary sky light straight overhead): each one enters the surface at a point on the far side of
      // the sun and leans away from it, and bends steeper below the surface, as light does when it enters water.
      const lightOn = s['lightShow'] > 0;
      const sx = lightOn ? s['lightX'] * width : width / 2;
      const sy = lightOn ? s['lightY'] * innerHeight - this.hostTop : baseY - 900;
      const above = baseY - sy; // how far the source is above the surface
      // A source at or below the surface sends no beams down; the sun and moon dim the beams with the light.
      const strength = lightOn ? this.settings.daylight * Math.min(Math.max(above / 40, 0), 1) : 1;
      if (strength > 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.filter = `blur(${s['raySoftness']}px)`;
        const reach = (height - baseY) * 0.85;
        const rays = Math.round(s['rayCount']);
        const spread = width * 0.7;
        const falloff = s['lightRadius'] * 1.4;
        const tint = lightOn ? `${s['lightHue']} 90% 86%` : '195 100% 88%';
        for (let i = 0; i < rays; i++) {
          const t = rays === 1 ? 0 : (i / (rays - 1)) * 2 - 1;
          // Denser close to the sun's column, sparser toward the sides.
          const entry = sx + Math.sign(t) * Math.abs(t) ** 1.5 * spread + Math.sin(time * 0.15 + i * 1.9) * 24;
          const dx = entry - sx;
          // Snell's law with n = 1.33: the beam leans by sin(angle in air) in air, and by a third less in water.
          const sinAir = Math.min(Math.abs(dx) / Math.hypot(dx, Math.max(above, 30)), 0.97);
          const sinWater = sinAir / 1.33;
          const lean = Math.sign(dx) * (sinWater / Math.sqrt(1 - sinWater * sinWater)) * reach;
          const topW = 14 + (i % 3) * 10;
          const botW = topW + 90 + (i % 2) * 40;
          const pulse = 0.55 + 0.45 * Math.sin(time * 0.5 + i * 2.3);
          // Beams are strongest beneath the light and fade toward the sides.
          const near = lightOn ? Math.exp(-Math.abs(dx) / falloff) : 1;
          const alpha = 0.22 * s['lightRays'] * pulse * strength * (0.3 + 0.7 * near);
          const g = ctx.createLinearGradient(0, baseY, 0, baseY + reach);
          g.addColorStop(0, `hsl(${tint} / ${alpha})`);
          g.addColorStop(1, `hsl(${tint} / 0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(entry - topW, baseY);
          ctx.lineTo(entry + topW, baseY);
          ctx.lineTo(entry + lean + botW, baseY + reach);
          ctx.lineTo(entry + lean - botW, baseY + reach);
          ctx.closePath();
          ctx.fill();
        }
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    if (s['vignette'] > 0) {
      const r = Math.max(width, height);
      const vg = ctx.createRadialGradient(width / 2, baseY + 60, r * 0.25, width / 2, baseY + 60, r * 0.8);
      vg.addColorStop(0, 'rgba(0, 10, 50, 0)');
      vg.addColorStop(1, `rgba(0, 10, 50, ${0.55 * s['vignette']})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, baseY - 20, width, height);
    }
    ctx.restore();
  }

  /** The mountain layers, rebuilt only when their settings or the canvas width change; empty when switched off. */
  private ensureLand(): LandLayer[] {
    const s = this.s;
    const rise = s['landHeight'];
    const count = Math.round(s['landLayers']);
    if (rise <= 0 || s['landDarkness'] <= 0 || !this.width) return [];
    const key = `${this.width}|${rise}|${s['landJagged']}|${s['landSeed']}|${count}`;
    if (this.landKey !== key) {
      this.landKey = key;
      this.landLayers = this.buildLand(this.width, rise, s['landJagged'], s['landSeed'], count);
    }
    return this.landLayers;
  }

  /** Vertical parallax offset (px) of a layer: a gentle lift, again stronger for near layers. */
  private landLift(depth: number): number {
    return -this.parallaxY * LAND_PARALLAX_Y_PX * this.s['landParallaxY'] * (0.15 + 0.85 * depth);
  }

  /** Sideways parallax offset (px) of a layer: near layers (depth 1) shift more than far ones. */
  private landShift(depth: number): number {
    return -this.parallax * LAND_PARALLAX_PX * this.s['landParallax'] * (0.15 + 0.85 * depth);
  }

  /**
   * The sun and its halo. They are composed on their own layer so the landscape can be cut out of it:
   * every mountain ridge, and everything below the waterline, is erased from the sun before it is drawn.
   * That keeps the sun behind the landscape wherever it is put, even though the far ridges are translucent.
   */
  private drawSun(): void {
    const s = this.s;
    if (s['lightShow'] <= 0 || !this.width) return;
    const { width, height, dpr, baseY } = this;
    const g = this.sunLayer.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, this.overscan * dpr);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, -this.overscan, width, height + this.overscan);

    const x = s['lightX'] * width;
    const y = s['lightY'] * innerHeight - this.hostTop;
    const size = s['lightOrbSize'] * this.settings.lightScale;
    const hue = s['lightHue'];
    const sat = this.settings.lightSat; // a moon is paler than a sun
    const glow = s['lightIntensity'] * this.settings.daylight;

    // The soft pool of light in the sky. It lives on this layer, so mountains and water cut it out as well:
    // nothing bright shows through the landscape.
    const pool = g.createRadialGradient(x, y, 0, x, y, s['lightRadius'] * 0.9);
    pool.addColorStop(0, `hsl(${hue} 100% 78% / ${glow * 0.6})`);
    pool.addColorStop(0.45, `hsl(${hue} 100% 62% / ${glow * 0.22})`);
    pool.addColorStop(1, `hsl(${hue} 100% 55% / 0)`);
    g.fillStyle = pool;
    g.fillRect(0, -this.overscan, width, height + this.overscan);

    const halo = g.createRadialGradient(x, y, 0, x, y, size * 1.6);
    halo.addColorStop(0, `hsl(${hue} ${sat}% 70% / 0.8)`);
    halo.addColorStop(0.3, `hsl(${hue} ${sat}% 66% / 0.5)`);
    halo.addColorStop(1, `hsl(${hue} ${sat}% 60% / 0)`);
    g.fillStyle = halo;
    g.fillRect(x - size * 1.6, y - size * 1.6, size * 3.2, size * 3.2);

    const disc = g.createRadialGradient(x, y, 0, x, y, size / 2);
    disc.addColorStop(0, `hsl(${hue + 14} ${sat}% 92%)`);
    disc.addColorStop(0.55, `hsl(${hue + 6} ${sat}% ${sat < 100 ? 80 : 68}%)`);
    disc.addColorStop(0.9, `hsl(${hue} ${sat}% ${sat < 100 ? 70 : 54}%)`);
    disc.addColorStop(1, `hsl(${hue - 6} ${sat}% ${sat < 100 ? 62 : 48}% / 0.6)`);
    g.fillStyle = disc;
    g.beginPath();
    g.arc(x, y, size / 2, 0, Math.PI * 2);
    g.fill();

    // Cut out the landscape: each ridge (with its own parallax shift), then everything under the waterline.
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    for (const layer of this.ensureLand()) {
      g.save();
      g.translate(this.landShift(layer.depth), baseY + this.landLift(layer.depth));
      g.fill(layer.path);
      g.restore();
    }
    g.fillRect(0, baseY + 14, width, height);
    g.globalCompositeOperation = 'source-over';

    this.ctx.drawImage(this.sunLayer, 0, -this.overscan, width, height + this.overscan);
  }

  /**
   * Layered mountain ridges on the horizon, far (pale, hazy) to near (dark), the way the water has layered
   * swells. They are drawn first, so letters and splashes pass in front, but before the water, so waves
   * wash over them; and because this canvas sits above the light's orb, the sun sets behind the peaks.
   *
   * - Parallax: each layer slides sideways with the pointer (and lifts a little with its height), the
   *   near ones more than the far ones.
   * - Light: every layer gets a warm wash around the light, and a glowing rim along the slopes, brighter
   *   where a slope faces the light and fading with distance.
   */
  private drawLand(): void {
    const { ctx, width, baseY } = this;
    const s = this.s;
    const layers = this.ensureLand();
    if (!layers.length) return;
    const rise = s['landHeight'];
    const dark = s['landDarkness'];

    const hue = s['waterHue'];
    // The light's position in canvas pixels, and how strongly it should touch the mountains.
    const tone = this.theme.tone;
    const lit = s['lightShow'] > 0 ? (s['landLight'] * s['lightIntensity'] * this.settings.daylight) / 0.7 : 0;
    const lightX = s['lightX'] * width;
    const lightY = s['lightY'] * innerHeight - this.hostTop;
    const reach = s['lightRadius'];
    const lightHue = s['lightHue'];

    for (const layer of layers) {
      const t = layer.depth;
      const scale = 1 - 0.6 * t;
      const shift = this.landShift(t);
      // Dark: black-blue silhouettes. Light: pale hazy blue far away, deeper blue-grey near.
      const colour = `${lerp(hue + 6 + 10 * t, hue + 10 + 14 * t, tone)} ${lerp(34 + 10 * t, 38 + 7 * t, tone)}% ${lerp(76 - 40 * t, 24 - 17 * t, tone)}%`;
      const alpha = dark * (0.55 + 0.45 * t);

      ctx.save();
      const lift = this.landLift(t);
      ctx.translate(shift, baseY + lift);

      // Solid down to the waterline, then fading out below it so it never muddies the water.
      const top = rise * scale;
      const fill = ctx.createLinearGradient(0, -top, 0, LAND_DEPTH);
      fill.addColorStop(0, `hsl(${colour} / ${alpha})`);
      fill.addColorStop(top / (top + LAND_DEPTH), `hsl(${colour} / ${alpha})`);
      fill.addColorStop(1, `hsl(${colour} / 0)`);
      ctx.fillStyle = fill;
      ctx.fill(layer.path);

      if (lit > 0) {
        // The light's position in this layer's own (shifted) coordinates.
        const gx = lightX - shift;
        const gy = lightY - (baseY + lift);

        // Scattered light across the whole ridge: stronger on the far, hazier layers.
        const haze = (1 - 0.55 * t) * lit;
        ctx.save();
        ctx.clip(layer.path);
        // Falls off sideways only, never radially: a round hot spot here would show where the sun is
        // through the mountains.
        const wash = ctx.createLinearGradient(gx - reach * 1.15, 0, gx + reach * 1.15, 0);
        wash.addColorStop(0, `hsl(${lightHue} 100% 55% / 0)`);
        wash.addColorStop(0.5, `hsl(${lightHue} 100% 58% / ${Math.min(0.3 * haze, 1)})`);
        wash.addColorStop(1, `hsl(${lightHue} 100% 55% / 0)`);
        ctx.fillStyle = wash;
        ctx.fillRect(-LAND_MARGIN, -top - 40, width + 2 * LAND_MARGIN, top + LAND_DEPTH + 80);
        ctx.restore();

        // Rim light: segments are bucketed by brightness so this is a handful of strokes, not hundreds.
        const buckets = Array.from({ length: RIM_BUCKETS }, () => new Path2D());
        const h = layer.heights;
        for (let i = 0; i < h.length - 1; i++) {
          const x0 = i * LAND_STEP - LAND_MARGIN;
          const x1 = x0 + LAND_STEP;
          const dx = x1 - x0;
          const dy = h[i + 1] - h[i];
          const len = Math.hypot(dx, dy);
          const toX = gx - (x0 + x1) / 2;
          const toY = gy - (h[i] + h[i + 1]) / 2;
          const dist = Math.hypot(toX, toY) || 1;
          // Outward (upward) normal of this slope against the direction to the light.
          const facing = Math.max(0, ((dy / len) * toX + (-dx / len) * toY) / dist);
          const strength = Math.exp(-dist / (reach * 0.9)) * (0.45 + 0.55 * facing) * lit * (1 - 0.3 * t);
          const bucket = Math.min(Math.floor(strength * RIM_BUCKETS), RIM_BUCKETS - 1);
          if (bucket < 1) continue;
          buckets[bucket].moveTo(x0, h[i]);
          buckets[bucket].lineTo(x1, h[i + 1]);
        }
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.1 + 0.8 * t;
        for (let b = 1; b < RIM_BUCKETS; b++) {
          const a = Math.min(((b + 0.5) / RIM_BUCKETS) * 0.7, 1);
          ctx.strokeStyle = `hsl(${lightHue} 100% 74% / ${a})`;
          ctx.shadowColor = `hsl(${lightHue} 100% 62% / ${a})`;
          ctx.shadowBlur = 12;
          ctx.stroke(buckets[b]);
        }
        ctx.shadowBlur = 0;
      }
      ctx.restore();
    }
  }

  private buildLand(width: number, rise: number, jagged: number, seed: number, count: number): LandLayer[] {
    return Array.from({ length: count }, (_, l) => {
      const depth = count === 1 ? 1 : l / (count - 1);
      // Far ridges are a little smoother and taller; near ones craggier and lower.
      const jag = Math.min(Math.max(jagged + (depth - 0.5) * 0.3, 0), 1);
      const heights = ridgeHeights(width + 2 * LAND_MARGIN, rise * (1 - 0.6 * depth), jag, seed * 7 + l * 13 + 1);
      const path = new Path2D();
      path.moveTo(-LAND_MARGIN, LAND_DEPTH);
      heights.forEach((y, i) => path.lineTo(i * LAND_STEP - LAND_MARGIN, y));
      path.lineTo((heights.length - 1) * LAND_STEP - LAND_MARGIN, LAND_DEPTH);
      path.closePath();
      return { heights, path, depth };
    });
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
        // Pale glowing letters on a dark sky; deep, legible ones with a soft white halo on a bright sky.
        const tone = this.theme.tone;
        ctx.fillStyle = `hsl(${l.hue} ${lerp(70, 90, tone)}% ${lerp(24, 92, tone)}%)`;
        ctx.shadowColor = `hsla(${l.hue} ${lerp(0, 100, tone)}% ${lerp(100, 70, tone)}% / ${lerp(0.85, 1, tone)})`;
        ctx.shadowBlur = lerp(10, 14, tone);
      }
      ctx.fillText(l.ch, 0, 0);
      ctx.restore();
    }
  }
}

/** Deterministic pseudo-random number in [0, 1) for a lattice point of one noise octave. */
function lattice(seed: number, octave: number, i: number): number {
  let h = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(octave + 1, 0xc2b2ae35) ^ Math.imul(i + 0x1234, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Heights of a mountain ridge (negative is up from the waterline) every LAND_STEP px, starting LAND_MARGIN px
 * left of the screen. Layered noise with
 * straight interpolation between points gives angular peaks and saddles; higher `jagged` weights the fine
 * octaves more, so the outline gets craggier. Noise is sampled by x in pixels, so resizing the window
 * extends the range instead of reshuffling it.
 */
function ridgeHeights(width: number, rise: number, jagged: number, seed: number): Float32Array {
  const gain = 0.3 + 0.5 * jagged;
  const octaves = 6;
  const points = Math.ceil(width / LAND_STEP) + 2;
  const heights = new Float32Array(points);
  for (let k = 0; k < points; k++) {
    // x = 0 is the left edge of the screen; the first LAND_MARGIN px are the hidden overscan.
    const x = k * LAND_STEP - LAND_MARGIN;
    let sum = 0;
    let norm = 0;
    let amp = 1;
    for (let o = 0; o < octaves; o++) {
      const p = x / (360 / 2 ** o);
      const i = Math.floor(p);
      const t = p - i;
      // Ridged noise: folding the value over turns smooth bumps into sharp summits with creases between.
      const v = lattice(seed, o, i) * (1 - t) + lattice(seed, o, i + 1) * t;
      sum += amp * (1 - Math.abs(2 * v - 1));
      norm += amp;
      amp *= gain;
    }
    // Soft S-curve instead of clamping: stretches the contrast without flattening the summits into plateaus.
    const n = 1 / (1 + Math.exp(-9 * (sum / norm - 0.5)));
    heights[k] = -rise * (0.08 + 0.92 * n);
  }
  return heights;
}
