// The wall: every work as one GPU instance on an infinite dot-grid canvas, soft shadows,
// and sharper images swapped in up close, resolving out of a mosaic while they load.
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NoColorSpace,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from 'three';
import { imageUrl, type Collection } from './data';

const PAINT_VERTEX = /* glsl */ `
#ifdef SINGLE
  uniform vec4 uRect;
  uniform vec2 uLiftU;
  uniform float uLightU;
  uniform float uMosaicU;
  #define RECT uRect
  #define LIFT uLiftU
  #define LIGHT uLightU
  #define MOSAIC uMosaicU
#else
  attribute vec4 aRect;
  attribute vec2 aLift;
  attribute float aLight;
  attribute float aMosaic;
  attribute vec4 aUv;
  attribute float aAtlas;
  attribute vec3 aColor;
  varying vec4 vUvRect;
  varying float vAtlas;
  varying vec3 vColor;
  #define RECT aRect
  #define LIFT aLift
  #define LIGHT aLight
  #define MOSAIC aMosaic
#endif
uniform float uPx;
varying vec2 vQ;
varying vec2 vSize;
varying float vLight;
varying float vMosaic;
varying vec2 vAspect;
void main() {
  // One pixel of bleed on every side: the fragment shader fades the true edge across it,
  // so works only a few pixels wide don't snap between pixels as they move.
  vec2 size = RECT.zw + 2.0 * uPx;
  vec3 p = vec3(position.xy * size, 0.0);
  float c = cos(LIFT.y), s = sin(LIFT.y);
  p = vec3(p.x * c, p.y, -p.x * s) + vec3(RECT.xy, LIFT.x);
  vQ = position.xy * size / max(RECT.zw, vec2(1e-4)) + 0.5;
  vSize = RECT.zw;
  vLight = LIGHT;
  vMosaic = MOSAIC;
  vAspect = RECT.zw / max(max(RECT.z, RECT.w), 1e-4);
#ifndef SINGLE
  vUvRect = aUv;
  vAtlas = aAtlas;
  vColor = aColor;
#endif
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const ROOM = /* glsl */ `
uniform vec3 uBg;
uniform vec3 uInk;
uniform float uDotLevel;
uniform float uPx;
uniform float uTime;
`;

const PAINT_FRAGMENT = /* glsl */ `
${ROOM}
varying vec2 vQ;
varying vec2 vSize;
varying float vLight;
varying float vMosaic;
varying vec2 vAspect;
#ifdef SINGLE
  uniform sampler2D tMap;
  uniform float uOpacity;
  uniform float uReveal;
#else
  uniform sampler2D tAtlas0;
  uniform sampler2D tAtlas1;
  uniform sampler2D tAtlas2;
  uniform sampler2D tAtlas3;
  uniform float uAtlasReady;
  varying vec4 vUvRect;
  varying float vAtlas;
  varying vec3 vColor;
#endif

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// Gradients are taken before any branching: inside an if, they're undefined and the GPU
// picks the wrong mip level, which is what made small works sparkle.
vec3 painting(vec2 q, vec2 gx, vec2 gy) {
#ifdef SINGLE
  return textureGrad(tMap, vec2(q.x, 1.0 - q.y), gx * vec2(1, -1), gy * vec2(1, -1)).rgb;
#else
  if (uAtlasReady < 0.5) return vColor;
  vec2 a = vec2(vUvRect.x + q.x * vUvRect.z, vUvRect.y + (1.0 - q.y) * vUvRect.w);
  vec2 ax = gx * vec2(vUvRect.z, -vUvRect.w);
  vec2 ay = gy * vec2(vUvRect.z, -vUvRect.w);
  // Stay a filter footprint inside the thumbnail, so blurred mips never reach a neighbour.
  vec2 m = min(max(abs(ax), abs(ay)), vUvRect.zw * 0.5);
  a = clamp(a, vUvRect.xy + m, vUvRect.xy + vUvRect.zw - m);
  int i = int(vAtlas + 0.5);
  if (i == 0) return textureGrad(tAtlas0, a, ax, ay).rgb;
  if (i == 1) return textureGrad(tAtlas1, a, ax, ay).rgb;
  if (i == 2) return textureGrad(tAtlas2, a, ax, ay).rgb;
  return textureGrad(tAtlas3, a, ax, ay).rgb;
#endif
}

vec2 mosaicCell(vec2 q, out vec2 grid, out vec2 f) {
  grid = max(vec2(1.0), floor(vMosaic * vAspect + 0.5));
  vec2 cell = floor(q * grid);
  f = fract(q * grid);
  return cell;
}

vec3 tiles(vec2 q, out float lit) {
  // Loading: the work as a mosaic of its own colours, a light sweeping across the tiles.
  vec2 grid, f;
  vec2 cell = mosaicCell(q, grid, f);
  vec3 col = painting((cell + 0.5) / grid, vec2(0.0), vec2(0.0));
  float wave = sin(uTime * 3.2 - (cell.x + cell.y) * 0.45 + hash(cell) * 1.5);
  col *= 0.9 + 0.12 * wave;
  float gap = clamp(step(f.x, 0.06) + step(f.y, 0.06), 0.0, 1.0);
  lit = gap;
  return col;
}

void main() {
  vec2 q = clamp(vQ, 0.0, 1.0);
  vec2 gx = dFdx(vQ);
  vec2 gy = dFdy(vQ);
  // Coverage of the true edge, in pixels: the analytic antialiasing.
  vec2 px = vec2(length(vec2(gx.x, gy.x)), length(vec2(gx.y, gy.y)));
  vec2 edge = min(vQ, 1.0 - vQ) / max(px, vec2(1e-6));
  float coverage = clamp(min(edge.x, edge.y) + 0.5, 0.0, 1.0);
  // Works only a few pixels wide are drawn from a softer mip: their fine detail can't be
  // resolved anyway, and it's what glitters as the wall moves.
  float across = 1.0 / max(px.x, px.y);
  float soften = 1.0 + 2.0 * (1.0 - smoothstep(10.0, 70.0, across));
  vec3 col = painting(q, gx * soften, gy * soften);
  if (vMosaic > 0.5) {
    float gap;
    vec3 t = tiles(q, gap);
#ifdef SINGLE
    // The image arrives tile by tile, in one diagonal wave.
    vec2 grid, f;
    vec2 cell = mosaicCell(q, grid, f);
    float order = (cell.x + grid.y - 1.0 - cell.y) / (grid.x + grid.y) * 0.75 + hash(cell) * 0.25;
    float k = smoothstep(order, order + 0.18, uReveal);
    col = mix(mix(t, uBg, gap * 0.85), col, k);
#else
    col = mix(t, uBg, gap * 0.85);
#endif
  }
  col = mix(uBg, col, clamp(vLight, 0.0, 1.0));
  float alpha = coverage;
#ifdef SINGLE
  alpha *= uOpacity;
#endif
  gl_FragColor = vec4(col, alpha);
}
`;

const SHADOW_VERTEX = /* glsl */ `
attribute vec4 aRect;
attribute vec2 aLift;
attribute float aLight;
varying vec2 vP;
varying vec2 vHalf;
varying float vSoft;
varying float vAlpha;
void main() {
  float m = 0.0;
  float lift = max(aLift.x, 0.0);
  float soft = 4.0 + 0.04 * min(aRect.z, aRect.w) + lift * 0.18;
  vec2 halfSize = aRect.zw * 0.5 + m;
  vec2 size = halfSize * 2.0 + soft * 4.0;
  vP = position.xy * size;
  vHalf = halfSize;
  vSoft = soft;
  vAlpha = 0.16 * clamp(aLight, 0.0, 1.0) * clamp(aLight, 0.0, 1.0) / (1.0 + lift * 0.003);
  vec2 offset = vec2(lift * 0.06 + 2.0, -lift * 0.12 - 5.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(vP + aRect.xy + offset, min(aLift.x, 0.0) - 0.5, 1.0);
}
`;

const SHADOW_FRAGMENT = /* glsl */ `
varying vec2 vP;
varying vec2 vHalf;
varying float vSoft;
varying float vAlpha;
void main() {
  vec2 d = abs(vP) - vHalf;
  float sd = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  float a = 1.0 - smoothstep(-vSoft, vSoft * 1.6, sd);
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * vAlpha);
}
`;

const WALL_FRAGMENT = /* glsl */ `
${ROOM}
varying vec3 vWorld;
float dots(vec2 p, float spacing) {
  vec2 f = (fract(p / spacing + 0.5) - 0.5) * spacing;
  return 1.0 - smoothstep(uPx * 0.7, uPx * 1.7, length(f));
}
void main() {
  // An infinite canvas. Two grids, one twice as wide, cross-fade with zoom so the dots
  // never jump.
  float s0 = exp2(floor(uDotLevel));
  float t = fract(uDotLevel);
  float d = max(dots(vWorld.xy, s0 * 2.0), dots(vWorld.xy, s0) * (1.0 - t));
  gl_FragColor = vec4(mix(uBg, uInk, d * 0.16), 1.0);
}
`;

export interface Hover {
  index: number;
}

interface Detail {
  mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  texture: Texture | null;
  level: 'web' | 'print';
  loading: boolean;
  used: number;
  shown: number;
  /** Arrived while in focus: resolve out of the mosaic. */
  reveal: boolean;
  /** When a load last failed; the large image, once refused, isn't asked for again. */
  failed: number;
  noPrint: boolean;
}

const QUAD = new PlaneGeometry(1, 1);

export class Gallery {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(32, 1, 1, 200000);
  readonly n: number;
  /** Animated state, written by the app every frame: rect, lift (z, tilt), light. */
  readonly rect: Float32Array;
  readonly lift: Float32Array;
  readonly light: Float32Array;
  /** Mosaic cells across while a sharper image loads (0 = off). */
  readonly mosaic: Float32Array;

  private readonly geometry = new InstancedBufferGeometry();
  private readonly uniforms = {
    tAtlas0: { value: null as Texture | null },
    tAtlas1: { value: null as Texture | null },
    tAtlas2: { value: null as Texture | null },
    tAtlas3: { value: null as Texture | null },
    uAtlasReady: { value: 0 },
    uBg: { value: new Vector3(0.96, 0.96, 0.95) },
    uInk: { value: new Vector3(0.05, 0.05, 0.05) },
    uDotLevel: { value: 7 },
    uPx: { value: 1 },
    uTime: { value: 0 },
  };
  private readonly wall: Mesh;
  private readonly details = new Map<number, Detail>();
  private loads = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly collection: Collection,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.setClearColor(0xf4f4f2);
    const works = collection.works;
    const n = (this.n = works.length);
    this.rect = new Float32Array(n * 4);
    this.lift = new Float32Array(n * 2);
    this.light = new Float32Array(n).fill(1);
    this.mosaic = new Float32Array(n);

    const g = this.geometry;
    g.setAttribute('position', QUAD.attributes.position);
    g.setIndex(QUAD.index);
    const dyn = (arr: Float32Array, size: number) => new InstancedBufferAttribute(arr, size).setUsage(DynamicDrawUsage);
    g.setAttribute('aRect', dyn(this.rect, 4));
    g.setAttribute('aLift', dyn(this.lift, 2));
    g.setAttribute('aLight', dyn(this.light, 1));
    g.setAttribute('aMosaic', dyn(this.mosaic, 1));
    const uv = new Float32Array(n * 4);
    const atlas = new Float32Array(n);
    const color = new Float32Array(n * 3);
    works.forEach((w, i) => {
      const a = collection.atlases[w.atlas];
      // Inset half a texel so neighbours never bleed in.
      uv.set([(w.uv[0] + 0.5) / a.width, (w.uv[1] + 0.5) / a.height, (w.uv[2] - 1) / a.width, (w.uv[3] - 1) / a.height], i * 4);
      atlas[i] = w.atlas;
      const c = parseInt(w.palette[0].slice(1), 16);
      color.set([(c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255], i * 3);
    });
    g.setAttribute('aUv', new InstancedBufferAttribute(uv, 4));
    g.setAttribute('aAtlas', new InstancedBufferAttribute(atlas, 1));
    g.setAttribute('aColor', new InstancedBufferAttribute(color, 3));
    g.instanceCount = n;

    const shadows = new Mesh(
      g,
      new ShaderMaterial({ vertexShader: SHADOW_VERTEX, fragmentShader: SHADOW_FRAGMENT, uniforms: this.uniforms, transparent: true, depthWrite: false }),
    );
    shadows.frustumCulled = false;
    shadows.renderOrder = 1;
    const paintings = new Mesh(g, new ShaderMaterial({ vertexShader: PAINT_VERTEX, fragmentShader: PAINT_FRAGMENT, uniforms: this.uniforms, transparent: true }));
    paintings.frustumCulled = false;
    paintings.renderOrder = 2;

    this.wall = new Mesh(
      new PlaneGeometry(1, 1),
      new ShaderMaterial({
        uniforms: this.uniforms,
        depthWrite: false,
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: WALL_FRAGMENT,
      }),
    );
    this.wall.position.z = -2;
    this.wall.renderOrder = 0;
    this.wall.frustumCulled = false;
    this.scene.add(this.wall, shadows, paintings);
    this.loadAtlases();
  }

  private loadAtlases() {
    const loader = new TextureLoader();
    let pending = this.collection.atlases.length;
    this.collection.atlases.slice(0, 4).forEach((a, i) => {
      loader.load(a.file, (t) => {
        t.flipY = false;
        t.colorSpace = NoColorSpace;
        t.minFilter = LinearMipmapLinearFilter;
        t.anisotropy = 4;
        t.needsUpdate = true;
        this.uniforms[`tAtlas${i}` as 'tAtlas0'].value = t;
        if (--pending === 0) {
          // Unused slots still need a texture bound.
          for (let k = 0; k < 4; k++) this.uniforms[`tAtlas${k}` as 'tAtlas0'].value ??= t;
          this.uniforms.uAtlasReady.value = 1;
          this.onReady?.();
        }
      });
    });
  }

  onReady?: () => void;

  get ready() {
    return this.uniforms.uAtlasReady.value === 1;
  }

  /** Room colour and ink, in display RGB 0–1. */
  setRoom(bg: number[], ink: number[]) {
    this.uniforms.uBg.value.set(bg[0], bg[1], bg[2]);
    this.uniforms.uInk.value.set(ink[0], ink[1], ink[2]);
    this.renderer.setClearColor((Math.round(bg[0] * 255) << 16) | (Math.round(bg[1] * 255) << 8) | Math.round(bg[2] * 255));
    // The dot grid: about 26 screen pixels apart, as a power of two in wall units.
    this.uniforms.uDotLevel.value = Math.log2(26 * this.unitsPerPixel);
    this.uniforms.uPx.value = this.unitsPerPixel / this.renderer.getPixelRatio();
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** World units per CSS pixel on the wall plane. */
  get unitsPerPixel() {
    const dist = this.camera.position.z;
    return (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / this.canvas.clientHeight;
  }

  /** The painting under a point of the wall, if any (lifted paintings count as they look). */
  pick(x: number, y: number) {
    const r = this.rect;
    for (let i = this.n - 1; i >= 0; i--) {
      const hw = r[i * 4 + 2] / 2;
      const hh = r[i * 4 + 3] / 2;
      if (Math.abs(x - r[i * 4]) <= hw && Math.abs(y - r[i * 4 + 1]) <= hh) return i;
    }
    return -1;
  }

  /**
   * Sharper images for paintings that are big on screen: the museum's web size first,
   * the print size for whichever painting is in focus.
   */
  private refineDetails(focus: number) {
    const upp = this.unitsPerPixel;
    const cam = this.camera.position;
    const halfW = (this.canvas.clientWidth / 2) * upp;
    const halfH = (this.canvas.clientHeight / 2) * upp;
    const now = performance.now();
    const r = this.rect;
    const wanted: { i: number; px: number }[] = [];
    this.mosaic.fill(0);
    for (let i = 0; i < this.n; i++) {
      const px = Math.max(r[i * 4 + 2], r[i * 4 + 3]) / upp;
      if (px < 140) continue;
      if (Math.abs(r[i * 4] - cam.x) - r[i * 4 + 2] / 2 > halfW || Math.abs(r[i * 4 + 1] - cam.y) - r[i * 4 + 3] / 2 > halfH) continue;
      wanted.push({ i, px });
    }
    wanted.sort((a, b) => b.px - a.px);
    for (const { i, px } of wanted.slice(0, 60)) {
      const w = this.collection.works[i];
      const level = i === focus && w.print && px > 700 && !this.details.get(i)?.noPrint ? 'print' : 'web';
      let d = this.details.get(i);
      if (!d) {
        const mat = new ShaderMaterial({
          vertexShader: PAINT_VERTEX,
          fragmentShader: PAINT_FRAGMENT,
          defines: { SINGLE: '' },
          transparent: true,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -4,
          uniforms: {
            ...this.uniforms,
            tMap: { value: null },
            uRect: { value: new Vector4() },
            uLiftU: { value: new Vector2() },
            uLightU: { value: 1 },
            uOpacity: { value: 0 },
            uMosaicU: { value: 0 },
            uReveal: { value: 1 },
          },
        });
        const mesh = new Mesh(QUAD, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 3;
        mesh.visible = false;
        this.scene.add(mesh);
        d = { mesh, texture: null, level: 'web', loading: false, used: now, shown: 0, reveal: false, failed: -Infinity, noPrint: false };
        this.details.set(i, d);
      }
      d.used = now;
      if (!d.texture && i === focus) this.mosaic[i] = 22;
      const upgrade = level === 'print' && d.level !== 'print';
      const resting = now - d.failed < 30000;
      if (!d.loading && !resting && (!d.texture || upgrade) && this.loads < 6) this.load(i, d, level, i === focus);
    }
    // Forget images that haven't been near the screen for a while.
    if (this.details.size > 140) {
      const stale = [...this.details.entries()].filter(([, d]) => now - d.used > 4000 && !d.loading).sort((a, b) => a[1].used - b[1].used);
      for (const [i, d] of stale.slice(0, this.details.size - 120)) {
        d.texture?.dispose();
        d.mesh.material.dispose();
        this.scene.remove(d.mesh);
        this.details.delete(i);
      }
    }
  }

  private async load(i: number, d: Detail, level: 'web' | 'print', focused: boolean) {
    const w = this.collection.works[i];
    const path = level === 'print' ? w.print! : w.web;
    d.loading = true;
    this.loads++;
    try {
      const res = await fetch(imageUrl(path));
      if (!res.ok) throw new Error(String(res.status));
      const bitmap = await createImageBitmap(await res.blob());
      const t = new Texture(bitmap);
      t.flipY = false;
      t.colorSpace = NoColorSpace;
      t.minFilter = LinearMipmapLinearFilter;
      t.anisotropy = 8;
      t.needsUpdate = true;
      if (!this.details.has(i)) {
        t.dispose();
        return;
      }
      const old = d.texture;
      d.texture = t;
      d.level = level;
      d.mesh.material.uniforms.tMap.value = t;
      if (old) setTimeout(() => old.dispose(), 500);
      else {
        d.shown = performance.now();
        d.reveal = focused;
      }
    } catch {
      // Keep what's showing. A refused large image falls back to the regular one for good;
      // a failed regular one is tried again after a pause.
      if (level === 'print') d.noPrint = true;
      else d.failed = performance.now();
    } finally {
      d.loading = false;
      this.loads--;
    }
  }

  render(focus: number, morphing: boolean) {
    const g = this.geometry;
    for (const name of ['aRect', 'aLift', 'aLight', 'aMosaic']) (g.attributes[name] as InstancedBufferAttribute).needsUpdate = true;
    const cam = this.camera;
    const upp = this.unitsPerPixel;
    this.wall.position.set(cam.position.x, cam.position.y, -2);
    this.wall.scale.set(this.canvas.clientWidth * upp * 3, this.canvas.clientHeight * upp * 3, 1);
    this.uniforms.uTime.value = performance.now() / 1000;
    if (!morphing) this.refineDetails(focus);
    else this.mosaic.fill(0);
    const now = performance.now();
    for (const [i, d] of this.details) {
      const u = d.mesh.material.uniforms;
      d.mesh.visible = !!d.texture && !morphing;
      if (!d.mesh.visible) continue;
      u.uRect.value.fromArray(this.rect, i * 4);
      u.uLiftU.value.set(this.lift[i * 2], this.lift[i * 2 + 1]);
      u.uLightU.value = this.light[i];
      // The work in focus resolves out of its mosaic in one wave; others simply fade in.
      if (d.reveal) {
        const t = (now - d.shown) / 900;
        u.uOpacity.value = 1;
        u.uMosaicU.value = t < 1 ? 22 : 0;
        u.uReveal.value = Math.min(1, t * 1.15);
      } else {
        u.uOpacity.value = Math.min(1, (now - d.shown) / 350);
        u.uMosaicU.value = 0;
      }
    }
    this.renderer.render(this.scene, cam);
  }
}
