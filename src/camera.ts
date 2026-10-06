// Moving through the wall: drag with inertia, zoom towards the pointer, pinch, and long
// camera flights that rise over the wall and come back down. The camera leans into motion.
import { MathUtils, Plane, Raycaster, Vector2, Vector3, type PerspectiveCamera } from 'three';

interface Flight {
  from: Vector3;
  to: Vector3;
  start: number;
  duration: number;
  peak: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class CameraRig {
  readonly pos = new Vector3(0, 0, 9000);
  minZ = 22;
  maxZ = 30000;
  /** Wall units per second. */
  private vel = new Vector2();
  private lean = new Vector2();
  private flight: Flight | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; t: number; moved: boolean; pinched?: boolean; hold?: boolean; away?: boolean; from?: Vector3 } | null = null;
  private pinch = 0;
  private lastMove = 0;
  private lastUser = 0;
  private readonly ray = new Raycaster();
  private readonly plane = new Plane(new Vector3(0, 0, 1), 0);
  reduced = false;

  onTap?: (x: number, y: number) => void;
  onUserMove?: () => void;
  /** While this says so, a one-finger drag doesn't pan: it tugs, and past a short pull calls onDragAway. */
  holdStill?: () => boolean;
  onDragAway?: () => void;

  constructor(
    readonly camera: PerspectiveCamera,
    readonly el: HTMLElement,
  ) {
    el.addEventListener('pointerdown', this.pointerDown);
    el.addEventListener('pointermove', this.pointerMove);
    el.addEventListener('pointerup', this.pointerUp);
    el.addEventListener('pointercancel', this.pointerUp);
    el.addEventListener('wheel', this.wheel, { passive: false });
  }

  /** Wall units per CSS pixel at the current height. */
  get upp() {
    return (2 * this.pos.z * Math.tan((this.camera.fov * Math.PI) / 360)) / this.el.clientHeight;
  }

  get flying() {
    return this.flight !== null;
  }

  /** Flying, gliding or being steered right now. */
  get moving() {
    return this.flight !== null || this.vel.lengthSq() > (this.upp * 4) ** 2 || performance.now() - this.lastUser < 300;
  }

  /** The point on the wall under a screen position. */
  toWall(clientX: number, clientY: number, out = new Vector3()) {
    const r = this.el.getBoundingClientRect();
    const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray.ray.intersectPlane(this.plane, out) ?? out.set(this.pos.x, this.pos.y, 0);
  }

  flyTo(x: number, y: number, z: number, duration?: number) {
    z = MathUtils.clamp(z, this.minZ, this.maxZ);
    const from = this.pos.clone();
    const travel = Math.hypot(x - from.x, y - from.y);
    // Long journeys rise above the wall to keep their bearings, like a map flight.
    const peak = Math.max(from.z, z, travel * 0.85);
    const d = duration ?? MathUtils.clamp(900 + Math.log2(1 + travel / Math.min(from.z, z)) * 260, 900, 2600);
    this.vel.set(0, 0);
    if (this.reduced) {
      this.pos.set(x, y, z);
      this.flight = null;
      return;
    }
    this.flight = { from, to: new Vector3(x, y, z), start: performance.now(), duration: d, peak };
  }

  zoomAt(clientX: number, clientY: number, factor: number) {
    this.flight = null;
    const before = this.toWall(clientX, clientY);
    const z = MathUtils.clamp(this.pos.z * factor, this.minZ, this.maxZ);
    const k = 1 - z / this.pos.z;
    // Keep the point under the pointer where it is.
    this.pos.x += (before.x - this.pos.x) * k;
    this.pos.y += (before.y - this.pos.y) * k;
    this.pos.z = z;
    this.lastUser = performance.now();
    this.onUserMove?.();
  }

  private pointerDown = (e: PointerEvent) => {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) this.down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.down) this.down.moved = this.down.pinched = true;
    }
    this.vel.set(0, 0);
  };

  private pointerMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch > 0) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, this.pinch / dist);
      this.pinch = dist;
      return;
    }
    if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) this.down.moved = true;
    if (!this.down?.moved) return;
    const d = this.down;
    if (d.hold === undefined && !d.pinched) {
      d.hold = this.holdStill?.() ?? false;
      if (d.hold) d.from = this.pos.clone();
    }
    if (d.hold) {
      if (d.away) return;
      // A tug that follows the finger at a third of its pace; far enough, and it lets go.
      const pull = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (pull > 70) {
        d.away = true;
        this.onDragAway?.();
        return;
      }
      this.flight = null;
      this.pos.x -= dx * this.upp * 0.3;
      this.pos.y += dy * this.upp * 0.3;
      return;
    }
    this.flight = null;
    const upp = this.upp;
    this.pos.x -= dx * upp;
    this.pos.y += dy * upp;
    const now = performance.now();
    const dt = Math.max(1, now - this.lastMove) / 1000;
    this.lastMove = now;
    // Smoothed release velocity, in wall units per second.
    this.vel.lerp(new Vector2((-dx * upp) / dt, (dy * upp) / dt), 0.35);
    this.lastUser = now;
    this.onUserMove?.();
  };

  private pointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = 0;
    if (this.pointers.size === 0) {
      const d = this.down;
      this.down = null;
      // A tug that didn't go far enough springs back.
      if (d?.hold && !d.away && d.from) this.flyTo(d.from.x, d.from.y, d.from.z, 350);
      if (d && !d.moved && performance.now() - d.t < 500) {
        this.vel.set(0, 0);
        this.onTap?.(e.clientX, e.clientY);
      }
      if (performance.now() - this.lastMove > 80 || this.reduced) this.vel.set(0, 0);
    }
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    // Trackpad pinch arrives as ctrl+wheel with small deltas; scale it up.
    const k = e.ctrlKey ? 0.012 : 0.0016;
    this.zoomAt(e.clientX, e.clientY, Math.exp(delta * k));
  };

  update(dt: number) {
    const f = this.flight;
    if (f) {
      const t = Math.min(1, (performance.now() - f.start) / f.duration);
      const e = ease(t);
      this.pos.x = MathUtils.lerp(f.from.x, f.to.x, e);
      this.pos.y = MathUtils.lerp(f.from.y, f.to.y, e);
      // Height travels in log space (zoom feels even), lifted by an arc for long trips.
      const base = Math.exp(MathUtils.lerp(Math.log(f.from.z), Math.log(f.to.z), e));
      const arc = Math.sin(Math.PI * e) * Math.max(0, Math.log(f.peak / Math.max(f.from.z, f.to.z)));
      this.pos.z = base * Math.exp(arc);
      if (t >= 1) this.flight = null;
    } else if (this.pointers.size === 0 && this.vel.lengthSq() > 1e-4) {
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      this.vel.multiplyScalar(Math.exp(-dt * 3.2));
    }
    // Lean into the motion, a degree or two, measured in screen speed.
    const upp = this.upp;
    const target = this.reduced ? new Vector2() : new Vector2(this.vel.x / upp, this.vel.y / upp).multiplyScalar(0.000025).clampLength(0, 0.05);
    this.lean.lerp(target, 1 - Math.exp(-dt * 6));
    this.camera.position.copy(this.pos);
    this.camera.rotation.set(this.lean.y, -this.lean.x, 0);
    this.camera.updateMatrixWorld();
  }
}
