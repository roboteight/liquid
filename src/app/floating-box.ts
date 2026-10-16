/** What the box needs from the water simulation. */
export interface Water {
  /** Canvas y of the surface at x. */
  surfaceAt(x: number): number;
  /** Canvas y of the resting water level. */
  readonly level: number;
  /** Horizontal current (px/s) at a depth below the surface. */
  flowAt(depth: number): number;
  /** Push the surface down (positive) around x. */
  disturb(x: number, force: number, radius: number): void;
  /** Throw up a splash with droplets. `intensity` scales both the wave and the droplet count. */
  splash(x: number, impactSpeed: number, size: number, intensity: number): void;
}

export interface BoxSpec {
  /** Centre of the box and its size, in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  /** CSS font shorthand the text was typed in, and the gap between the box edge and the text. */
  font: string;
  padding: number;
}

const SAMPLES = 13; // columns along the box that each feel the water separately
const SUBSTEPS = 3;
const BUOYANCY = 2.1; // upthrust at full submersion relative to weight; ~1/2.1 of the box sits below the surface
const FLOAT_TIME = 4; // seconds it floats (counted from first contact with the water) before it starts to take on water
const SINK_TIME = 2.4;
const LINEAR_DRAG = 4;
const QUADRATIC_DRAG = 0.0035;
const COUPLING = 0.0008; // how strongly the moving box pushes the surface

/**
 * The input box as a rigid body: it falls, belly-flops, bobs and tilts with the waves, drifts with the
 * current, then slowly sinks. Buoyancy is sampled along its width, so the box rocks and rides slopes
 * naturally instead of following a scripted animation.
 */
export class FloatingBox {
  x: number;
  y: number;
  angle: number;
  private vx = 0;
  private vy = 0;
  private omega: number;
  /** Seconds since the box first touched the water. */
  private age = 0;
  private touched = false;
  /** 0 while floating, rising to 1 as it sinks and fades. */
  private sink = 0;
  private readonly wet = new Array<boolean>(SAMPLES).fill(false);

  constructor(
    private readonly spec: BoxSpec,
    private readonly onDone: () => void,
  ) {
    this.x = spec.x;
    this.y = spec.y;
    // Tipped slightly so one end hits first and the box rocks instead of landing perfectly flat.
    const lean = Math.random() < 0.5 ? -1 : 1;
    this.angle = lean * 0.03;
    this.omega = lean * (0.1 + Math.random() * 0.2);
  }

  /** Returns false once the box has gone. */
  step(dt: number, water: Water, gravity: number): boolean {
    const h = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) this.integrate(h, water, gravity);

    if (this.touched) this.age += dt;
    if (this.age > FLOAT_TIME) this.sink = Math.min((this.age - FLOAT_TIME) / SINK_TIME, 1);
    if (this.sink >= 1) {
      this.onDone();
      return false;
    }
    return true;
  }

  private integrate(dt: number, water: Water, gravity: number): void {
    const { width: w, height: hgt } = this.spec;
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    const inertia = (w * w + hgt * hgt) / 12; // unit mass
    const buoyancy = ((BUOYANCY * gravity) / SAMPLES) * (1 - this.sink);

    let fx = 0;
    let fy = gravity;
    let torque = 0;

    for (let i = 0; i < SAMPLES; i++) {
      const lx = ((i + 0.5) / SAMPLES - 0.5) * w;
      // Top and bottom edge of this column in world space.
      const bx = this.x + lx * cos - (hgt / 2) * sin;
      const by = this.y + lx * sin + (hgt / 2) * cos;
      const tx = this.x + lx * cos + (hgt / 2) * sin;
      const ty = this.y + lx * sin - (hgt / 2) * cos;
      const cx = (bx + tx) / 2;
      const cy = (by + ty) / 2;

      const bottom = Math.max(by, ty);
      const top = Math.min(by, ty);
      const surface = water.surfaceAt(cx);
      const submerged = Math.min(Math.max((bottom - surface) / Math.max(bottom - top, 1), 0), 1);

      // Velocity of this point on the body, and of the water around it.
      const rx = cx - this.x;
      const ry = cy - this.y;
      const pvx = this.vx - this.omega * ry;
      const pvy = this.vy + this.omega * rx;

      if (submerged > 0.05 && !this.wet[i]) {
        // First contact for this column: the faster it hits, the bigger the splash.
        if (pvy > 120) water.splash(cx, pvy, 44, 0.22);
      }
      this.wet[i] = submerged > 0.05;
      if (this.wet[i]) this.touched = true;

      if (submerged > 0) {
        const wvx = water.flowAt(cy - water.level);
        const rvx = pvx - wvx;
        const speed = Math.hypot(rvx, pvy);
        const drag = ((LINEAR_DRAG + QUADRATIC_DRAG * speed) / SAMPLES) * submerged;
        const sfx = -drag * rvx;
        const sfy = -buoyancy * submerged - drag * pvy;
        fx += sfx;
        fy += sfy;
        torque += rx * sfy - ry * sfx;
      }
    }

    this.vx += fx * dt;
    this.vy += fy * dt;
    this.omega += (torque / inertia) * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.angle += this.omega * dt;
  }

  /** The moving box shoves the surface around it, which makes the ripples and wake. */
  disturbWater(water: Water, frameScale: number): void {
    const { width: w, height: hgt } = this.spec;
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    for (let i = 0; i < SAMPLES; i++) {
      const lx = ((i + 0.5) / SAMPLES - 0.5) * w;
      const cx = this.x + lx * cos;
      const cy = this.y + lx * sin;
      const surface = water.surfaceAt(cx);
      if (cy + hgt / 2 < surface) continue;
      const pvy = this.vy + this.omega * lx * cos;
      water.disturb(cx, pvy * COUPLING * frameScale * (1 - this.sink), 26);
    }
  }

  /** `underwater` draws the dimmed, blurred copy that is seen through the water. */
  /** `tone` is 0 on a light scene and 1 on a dark one, fading in between. */
  draw(ctx: CanvasRenderingContext2D, underwater: boolean, tone: number): void {
    const mix = (light: number, dark: number) => light + (dark - light) * tone;
    const { width: w, height: h, text, font, padding } = this.spec;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.globalAlpha = (1 - this.sink * this.sink) * (underwater ? 0.5 : 1);
    if (underwater) ctx.filter = 'blur(1.5px)';

    const r = h / 2;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + r, -h / 2);
    ctx.lineTo(w / 2 - r, -h / 2);
    ctx.arc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(-w / 2 + r, h / 2);
    ctx.arc(-w / 2 + r, 0, r, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.closePath();

    if (!underwater) {
      ctx.shadowColor = `rgba(${mix(30, 120)}, ${mix(110, 220)}, ${mix(200, 255)}, ${mix(0.35, 0.45)})`;
      ctx.shadowBlur = 18;
    }
    // Frosted glass: pale on dark scenes, whiter and more opaque on light ones so it still reads.
    const glass = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    glass.addColorStop(0, `rgba(${mix(255, 240)}, ${mix(255, 250)}, 255, ${mix(0.72, 0.28)})`);
    glass.addColorStop(1, `rgba(${mix(225, 170)}, ${mix(240, 215)}, 255, ${mix(0.5, 0.12)})`);
    ctx.fillStyle = glass;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(${mix(40, 190)}, ${mix(100, 232)}, ${mix(170, 255)}, ${mix(0.6, 0.7)})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgb(${mix(15, 234)}, ${mix(42, 248)}, ${mix(71, 255)})`;
    ctx.fillText(text, -w / 2 + padding, 1);
    ctx.restore();
  }
}
