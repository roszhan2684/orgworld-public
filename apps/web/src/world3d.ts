import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ROOM_LABELS, type RoomId } from '@orgworld/core';

/*
 * 3D village renderer (ADR-004 amendment 2). Strict split:
 *  - SCENERY (sky, sun, grass, cottages, trees, clouds, pollen, butterflies) is ambient and never encodes state.
 *  - AGENTS are drawn exactly where main.ts puts them; main.ts moves them only when reduced events change.
 *  - BUBBLES show only the text of real recorded events (messages, votes, reviews, decisions, checks).
 * Logical layout coordinates (960×540) map to world units: X = (x−480)/S, Z = (y−270)/S.
 */
export const S = 18;
export const toWorld = (x: number, y: number) => new THREE.Vector3((x - 480) / S, 0, (y - 270) / S);

export interface LotLayout { id: RoomId; x: number; y: number; w: number; h: number; top: boolean }
export interface Bubble { text: string; kind: string; startedAt: number; seq: number }
export interface AgentDraw { id: string; name: string; roleId: string; color: string; status: string; x: number; y: number; moving: boolean; selected: boolean; bubble: Bubble | null }

const LAMP: Record<string, number> = { thinking: 0x7aa7e8, communicating: 0xe3a63d, working: 0x5fb98a, reviewing: 0xe06c5f, meeting: 0xb48ae8, waiting: 0x9aa3b0, failed: 0xff3b3b, idle: 0x6b7480 };
const ROOF: Record<RoomId, number> = { command: 0xb5523b, research: 0x3f7fa8, strategy: 0x6a5aa8, engineering: 0xc06a36, experiment: 0x3f8f62, critique: 0x9b3b4f, decision: 0xb08a3a, library: 0x7a5a36, analysis: 0x6f8f3a, meeting: 0x4f6fa0 };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function textSprite(text: string, bg: string, fg: string, scale: number): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = '600 30px "IBM Plex Sans", system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 28;
  c.width = w;
  c.height = 48;
  ctx.font = font;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 48, 14);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 14, 25);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set((w / 48) * scale, scale, 1);
  sp.renderOrder = 10;
  return sp;
}

/** Vignette + gentle warm grade (cinematic finish). */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0.32 }, uWarm: { value: 0.04 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVignette; uniform float uWarm; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv - 0.5; float v = smoothstep(0.85, 0.25, length(d) * (1.0 + uVignette));
    c.rgb *= mix(1.0 - uVignette, 1.0, v); c.rgb += vec3(uWarm, uWarm * 0.55, -uWarm * 0.3); gl_FragColor = c; }`,
};

interface AgentObj {
  group: THREE.Group;
  legs: THREE.Object3D[];
  arms: THREE.Object3D[];
  lamp: THREE.Mesh;
  ring: THREE.Mesh;
  bubbleEl: HTMLDivElement;
  bubbleObj: CSS2DObject;
  bubbleSeq: number;
  color: string;
}

export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly labels = new CSS2DRenderer();
  private readonly composer: EffectComposer;
  private readonly controls: OrbitControls;
  private readonly agents = new Map<string, AgentObj>();
  private readonly ambient: Array<(t: number) => void> = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly sunDir = new THREE.Vector3();
  private grassUniforms = { uTime: { value: 0 } };
  private line: THREE.LineSegments | null = null;
  private introStart = -1;
  follow: string | null = null;
  /** 'low' on software GL (SwiftShader/llvmpipe) or ?quality=low: fewer grass blades, smaller shadows, no post-processing. */
  readonly quality: 'high' | 'low';
  private readonly composerOn: boolean;

  constructor(private readonly canvas: HTMLCanvasElement, lots: LotLayout[], private readonly reduceMotion: boolean) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const q = new URLSearchParams(location.search).get('quality');
    this.quality = q === 'low' || (q !== 'high' && /swiftshader|llvmpipe|software/i.test(gpu)) ? 'low' : 'high';
    this.composerOn = this.quality === 'high';
    this.renderer.setPixelRatio(this.quality === 'high' ? Math.min(2, window.devicePixelRatio) : 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.62;
    this.camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.3, 3000);
    this.camera.position.set(0, 34, 40);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 1.5);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 85;
    // HTML speech bubbles layered over the canvas
    const host = canvas.parentElement!;
    host.style.position = 'relative';
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    host.appendChild(this.labels.domElement);
    this.buildSky();
    this.buildGround();
    for (const l of lots) this.buildCottage(l);
    this.buildTrees();
    this.buildGrass();
    this.buildFlowers();
    this.buildClouds();
    if (!reduceMotion) (this.buildButterflies(), this.buildPollen());
    if (this.quality === 'low') this.renderer.toneMappingExposure = 0.62;
    // post-processing
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.55, 0.92));
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  private resize() {
    const w = this.canvas.clientWidth || 960;
    const h = Math.round((w * 9) / 16);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ---------------- scenery (ambient, never state) ---------------- */
  private buildSky() {
    const sky = new Sky();
    sky.scale.setScalar(2500);
    const u = sky.material.uniforms;
    u.turbidity!.value = 4.5;
    u.rayleigh!.value = 1.6;
    u.mieCoefficient!.value = 0.006;
    u.mieDirectionalG!.value = 0.86;
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 11), THREE.MathUtils.degToRad(-125)); // low morning sun
    u.sunPosition!.value.copy(this.sunDir);
    this.scene.add(sky);
    // image-based lighting from the sky itself
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.fog = new THREE.FogExp2(0xe9dccb, 0.0085);
    this.scene.add(new THREE.HemisphereLight(0xd9ecff, 0x4f7a34, 0.55));
    const sun = new THREE.DirectionalLight(0xffd6a0, 3.4);
    sun.position.copy(this.sunDir).multiplyScalar(60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.quality === 'high' ? 4096 : 1024, this.quality === 'high' ? 4096 : 1024);
    const sc = sun.shadow.camera;
    sc.left = -38; sc.right = 38; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 160;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 3;
    this.scene.add(sun);
  }

  private buildGround() {
    const R = rng(7);
    const geo = new THREE.PlaneGeometry(260, 260, 120, 120);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position');
    const colors: number[] = [];
    const a = new THREE.Color(0x6fa443), b = new THREE.Color(0x52893a), c2 = new THREE.Color(0x93bd57);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), d = Math.hypot(x, z);
      if (d > 42) pos.setY(i, Math.sin(x * 0.06) * Math.cos(z * 0.05) * 5 + (d - 42) * 0.11);
      const n = R();
      const col = a.clone().lerp(n > 0.5 ? b : c2, Math.abs(n - 0.5) * 1.4);
      colors.push(col.r, col.g, col.b);
    }
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96 }));
    ground.receiveShadow = true;
    this.scene.add(ground);
    const pathMat = new THREE.MeshStandardMaterial({ color: 0xcfb07a, roughness: 1 });
    const path = new THREE.Mesh(new THREE.BoxGeometry(56, 0.06, 2.3), pathMat);
    path.position.y = 0.03;
    path.receiveShadow = true;
    this.scene.add(path);
    // stepping stones along the path edge
    const stoneGeo = new THREE.CylinderGeometry(0.28, 0.32, 0.08, 7);
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0xb8ad9a, roughness: 0.9 });
    for (let x = -26; x <= 26; x += 1.6)
      for (const z of [-1.45, 1.45]) {
        const s = new THREE.Mesh(stoneGeo, stoneMat);
        s.position.set(x + (R() - 0.5) * 0.3, 0.04, z + (R() - 0.5) * 0.15);
        s.receiveShadow = true;
        this.scene.add(s);
      }
  }

  private buildCottage(l: LotLayout) {
    const cx = l.x + l.w / 2;
    const p = toWorld(cx, l.top ? l.y + 40 : l.y + l.h - 40);
    const g = new THREE.Group();
    g.position.copy(p);
    g.rotation.y = l.top ? 0 : Math.PI;
    const std = (color: number, rough = 0.85) => new THREE.MeshStandardMaterial({ color, roughness: rough });
    const base = new THREE.Mesh(new THREE.BoxGeometry(5, 0.35, 3.8), std(0x9b9286));
    base.position.y = 0.17;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.6, 3.4), std(0xf3e8d2, 0.9));
    wall.position.y = 1.65;
    // timber frame accents
    const beamMat = std(0x6b4a2f);
    for (const dx of [-2.25, 2.25]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 0.16), beamMat);
      beam.position.set(dx, 1.65, 1.72);
      g.add(beam);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.16, 0.16), beamMat);
    lintel.position.set(0, 2.9, 1.72);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.8, 2.4, 4, 1), new THREE.MeshStandardMaterial({ color: ROOF[l.id], roughness: 0.75, flatShading: true }));
    roof.position.y = 4.15;
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1, 1, 0.84);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.6, 0.08), std(0x6e4428));
    door.position.set(0, 1.15, 1.73);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshStandardMaterial({ color: 0xd8b24a, metalness: 0.9, roughness: 0.25 }));
    knob.position.set(0.3, 1.15, 1.79);
    const glass = new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffc96b, emissiveIntensity: 0.55, roughness: 0.2 });
    for (const dx of [-1.45, 1.45]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 0.06), glass);
      w.position.set(dx, 1.95, 1.73);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 0.25), beamMat);
      sill.position.set(dx, 1.55, 1.8);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.25), std(0x5c3a22));
      box.position.set(dx, 1.38, 1.85);
      g.add(w, sill, box);
      for (let k = 0; k < 4; k++) {
        const f = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), std([0xff7aa2, 0xffd34d, 0xffffff, 0xc58cff][k]!, 0.6));
        f.position.set(dx - 0.33 + k * 0.22, 1.55, 1.88);
        g.add(f);
      }
    }
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.4, 0.5), std(0x8f8378));
    chimney.position.set(1.15, 4.4, -0.6);
    for (const m of [base, wall, lintel, roof, door, knob, chimney]) {
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
    // chimney smoke puffs (ambient)
    if (!this.reduceMotion) {
      const puffMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, roughness: 1, depthWrite: false });
      const puffs = Array.from({ length: 4 }, () => new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), puffMat.clone()));
      const off = Math.random() * 10;
      for (const pf of puffs) g.add(pf);
      this.ambient.push((t) =>
        puffs.forEach((pf, i) => {
          const k = ((t * 0.00025 + off + i / puffs.length) % 1 + 1) % 1;
          pf.position.set(1.15 + Math.sin(k * 6 + i) * 0.2, 5.2 + k * 2.6, -0.6 - k * 0.6);
          pf.scale.setScalar(0.6 + k * 1.6);
          (pf.material as THREE.MeshStandardMaterial).opacity = 0.45 * (1 - k);
        }),
      );
    }
    const yard = new THREE.Mesh(new THREE.CircleGeometry(3.7, 32), new THREE.MeshStandardMaterial({ color: 0x86b95a, roughness: 1 }));
    yard.rotation.x = -Math.PI / 2;
    const yc = toWorld(cx, l.top ? l.y + 128 : l.y + 60);
    yard.position.set(yc.x, 0.02, yc.z);
    yard.receiveShadow = true;
    this.scene.add(yard);
    const lp = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, Math.abs(p.z) - 1.6), new THREE.MeshStandardMaterial({ color: 0xcfb07a, roughness: 1 }));
    lp.position.set(p.x, 0.025, p.z / 2 + (l.top ? 0.8 : -0.8));
    lp.receiveShadow = true;
    this.scene.add(lp);
    const sign = textSprite(ROOM_LABELS[l.id], 'rgba(255,250,240,0.94)', '#3a2f22', 0.95);
    sign.position.set(0, 6.3, 0);
    g.add(sign);
    this.scene.add(g);
  }

  private inVillage(x: number, z: number) {
    if (Math.abs(z) < 2.4) return true; // path
    if (Math.abs(x) < 27.5 && Math.abs(z) < 16) {
      const lx = (((x + 27) % 10.67) + 10.67) % 10.67;
      return lx > 0.6 && lx < 10;
    }
    return false;
  }

  private buildTrees() {
    const R = rng(11);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6f4a2c, roughness: 1 });
    const leaves = [0x4a8a36, 0x5a9e45, 0x3c7a31, 0x6fab4a].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, flatShading: true }));
    const blossom = new THREE.MeshStandardMaterial({ color: 0xf6bccd, roughness: 0.85, flatShading: true });
    let placed = 0;
    for (let i = 0; i < 600 && placed < 90; i++) {
      const x = (R() - 0.5) * 140, z = (R() - 0.5) * 120;
      if (this.inVillage(x, z) || Math.hypot(x, z) < 6) continue;
      placed++;
      const t = new THREE.Group();
      const h = 1.5 + R() * 1.4;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.28, h, 7), trunkMat);
      trunk.position.y = h / 2;
      trunk.castShadow = true;
      const crown = new THREE.Group();
      const pine = R() < 0.3;
      const mat = R() < 0.14 ? blossom : leaves[Math.floor(R() * leaves.length)]!;
      for (let k = 0; k < (pine ? 3 : 4); k++) {
        const s = pine ? new THREE.Mesh(new THREE.ConeGeometry(1.3 - k * 0.32, 1.5, 7), mat) : new THREE.Mesh(new THREE.IcosahedronGeometry(1.05 - k * 0.15 + R() * 0.3, 1), mat);
        s.position.set(pine ? 0 : (R() - 0.5) * 0.9, h + 0.4 + k * (pine ? 0.75 : 0.55), pine ? 0 : (R() - 0.5) * 0.9);
        s.castShadow = true;
        s.receiveShadow = true;
        crown.add(s);
      }
      t.add(trunk, crown);
      t.position.set(x, 0, z);
      t.scale.setScalar(0.8 + R() * 0.8);
      this.scene.add(t);
      const ph = R() * 6;
      if (!this.reduceMotion) this.ambient.push((time) => ((crown.rotation.z = Math.sin(time * 0.0007 + ph) * 0.025), (crown.rotation.x = Math.cos(time * 0.0005 + ph) * 0.015)));
    }
  }

  /** ~24k instanced grass blades bending in the wind (vertex shader). */
  private buildGrass() {
    const R = rng(5);
    const blade = new THREE.PlaneGeometry(0.07, 0.55, 1, 4);
    blade.translate(0, 0.275, 0);
    const p = blade.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) * (1 - p.getY(i) / 0.6)); // taper
    const mat = new THREE.MeshStandardMaterial({ color: 0x6aa64a, roughness: 0.8, side: THREE.DoubleSide });
    const uniforms = this.grassUniforms;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uniforms.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
         float bend = position.y * position.y * 0.9;
         transformed.x += sin(uTime * 1.6 + wp.x * 0.35 + wp.z * 0.2) * bend * 0.35;
         transformed.z += cos(uTime * 1.2 + wp.z * 0.3) * bend * 0.18;`,
      );
    };
    const N = this.quality === 'high' ? 24000 : 3000;
    const inst = new THREE.InstancedMesh(blade, mat, N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
    const tint = new THREE.Color();
    let n = 0;
    for (let i = 0; i < N * 3 && n < N; i++) {
      const x = (R() - 0.5) * 84, z = (R() - 0.5) * 60;
      if (Math.abs(z) < 1.4) continue;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * Math.PI);
      const s = 0.6 + R() * 0.9;
      m.compose(ps.set(x, 0, z), q, sc.set(1, s, 1));
      inst.setMatrixAt(n, m);
      inst.setColorAt(n, tint.setHSL(0.24 + R() * 0.05, 0.45 + R() * 0.15, 0.34 + R() * 0.12));
      n++;
    }
    inst.count = n;
    inst.receiveShadow = true;
    this.scene.add(inst);
  }

  private buildFlowers() {
    const R = rng(23);
    const geo = new THREE.IcosahedronGeometry(0.1, 0);
    for (const c of [0xffffff, 0xffd84d, 0xf28fb3, 0xb59af0, 0xff8a65]) {
      const n = 120;
      const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, emissive: c, emissiveIntensity: 0.05 }), n);
      const m = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const x = (R() - 0.5) * 84, z = (R() - 0.5) * 64;
        m.makeTranslation(x, 0.45 + R() * 0.15, Math.abs(z) < 1.5 ? z + 3 : z);
        inst.setMatrixAt(i, m);
      }
      this.scene.add(inst);
    }
  }

  private buildClouds() {
    const R = rng(41);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.92, depthWrite: false });
    for (let i = 0; i < 9; i++) {
      const c = new THREE.Group();
      for (let k = 0; k < 6; k++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(3 + R() * 3, 14, 10), mat);
        s.position.set(k * 3.4 + R() * 2, R() * 1.8, R() * 3);
        s.scale.y = 0.6;
        c.add(s);
      }
      const bx = (R() - 0.5) * 300, bz = -80 - R() * 120, y = 45 + R() * 30, sp = 0.0006 + R() * 0.0008;
      c.position.set(bx, y, bz);
      this.scene.add(c);
      if (!this.reduceMotion) this.ambient.push((t) => (c.position.x = ((bx + t * sp * 10 + 200) % 400) - 200));
    }
  }

  private buildButterflies() {
    const R = rng(31);
    const palette = [0xffa63d, 0x6fc2f5, 0xf79ccf, 0xfff07a, 0xc3a3ff];
    for (let i = 0; i < 22; i++) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: palette[i % palette.length], side: THREE.DoubleSide, roughness: 0.5, emissive: palette[i % palette.length], emissiveIntensity: 0.15 });
      const wing = new THREE.CircleGeometry(0.2, 10);
      wing.scale(1, 1.35, 1);
      const mk = (dx: number) => {
        const w = new THREE.Group();
        const top = new THREE.Mesh(wing, mat);
        top.position.set(dx * 0.2, 0.06, 0);
        const bot = new THREE.Mesh(wing, mat);
        bot.scale.setScalar(0.65);
        bot.position.set(dx * 0.16, -0.12, 0);
        w.add(top, bot);
        return w;
      };
      const lw = mk(-1), rw = mk(1);
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.22, 2, 6), new THREE.MeshStandardMaterial({ color: 0x2a2320 }));
      g.add(lw, rw, body);
      g.scale.setScalar(1.2);
      this.scene.add(g);
      const bx = (R() - 0.5) * 50, bz = (R() - 0.5) * 34, ph = R() * 10, sp = 0.00022 + R() * 0.00025;
      this.ambient.push((t) => {
        const a = t * sp + ph;
        g.position.set(bx + Math.sin(a) * 4 + Math.sin(a * 3.1) * 0.6, 1.3 + Math.sin(a * 2.3) * 0.7, bz + Math.cos(a * 0.8) * 3);
        g.rotation.y = -a;
        const flap = Math.sin(t * 0.03 + ph) * 1.15;
        lw.rotation.y = flap;
        rw.rotation.y = -flap;
      });
    }
  }

  /** Pollen drifting in the sunlight (ambient). */
  private buildPollen() {
    const R = rng(77);
    const N = 700;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) pos.set([(R() - 0.5) * 70, 0.5 + R() * 7, (R() - 0.5) * 46], i * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xfff1c2, size: 0.09, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scene.add(pts);
    this.ambient.push((t) => {
      pts.position.set(Math.sin(t * 0.0001) * 1.5, Math.sin(t * 0.00023) * 0.4, Math.cos(t * 0.00008) * 1.2);
      pts.rotation.y = t * 0.000015;
    });
  }

  /* ---------------- agents (state-driven only) ---------------- */
  private makeAgent(a: AgentDraw): AgentObj {
    const group = new THREE.Group();
    const color = new THREE.Color(a.color);
    const cloth = new THREE.MeshStandardMaterial({ color, roughness: 0.65 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xf0cda8, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2e3440, roughness: 0.8 });
    const tag = (m: THREE.Mesh) => ((m.userData.agentId = a.id), (m.castShadow = true), m);
    const body = tag(new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.5, 6, 14), cloth));
    body.position.y = 1.0;
    const head = tag(new THREE.Mesh(new THREE.SphereGeometry(0.31, 24, 18), skin));
    head.position.y = 1.72;
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ color: color.clone().offsetHSL(0, -0.2, -0.32), roughness: 0.9 }));
    hair.position.y = 1.75;
    hair.rotation.x = -0.25;
    hair.castShadow = true;
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1b1d22 });
    for (const dx of [-0.1, 0.1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), eyeMat);
      e.position.set(dx, 1.74, 0.28);
      group.add(e);
    }
    const limb = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const m = tag(new THREE.Mesh(geo, mat));
      m.position.y = -0.24;
      pivot.add(m);
      return pivot;
    };
    const legs = [-0.14, 0.14].map((dx) => limb(new THREE.CapsuleGeometry(0.09, 0.32, 4, 8), dark, dx, 0.62));
    const arms = [-0.43, 0.43].map((dx) => limb(new THREE.CapsuleGeometry(0.075, 0.36, 4, 8), cloth, dx, 1.32));
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), new THREE.MeshStandardMaterial({ color: 0x6b7480, emissive: 0x6b7480, emissiveIntensity: 2.2 }));
    lamp.position.set(0, 2.32, 0);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 40), new THREE.MeshBasicMaterial({ color: 0xe3a63d, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    const label = textSprite(a.name, 'rgba(24,30,40,0.82)', '#f4f1ea', 0.36);
    label.position.y = 2.62;
    group.add(body, head, hair, ...legs, ...arms, lamp, ring, label);
    group.scale.setScalar(1.5);
    this.scene.add(group);
    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'bubble';
    bubbleEl.hidden = true;
    const bubbleObj = new CSS2DObject(bubbleEl);
    bubbleObj.position.set(0, 3.05, 0);
    group.add(bubbleObj);
    return { group, legs, arms, lamp, ring, bubbleEl, bubbleObj, bubbleSeq: -1, color: a.color };
  }

  private updateBubble(o: AgentObj, a: AgentDraw, now: number) {
    const b = a.bubble;
    if (!b) {
      if (!o.bubbleEl.hidden) o.bubbleEl.hidden = true;
      o.bubbleSeq = -1;
      return;
    }
    if (o.bubbleSeq !== b.seq) {
      o.bubbleSeq = b.seq;
      o.bubbleEl.hidden = false;
      o.bubbleEl.dataset.kind = b.kind;
      o.bubbleEl.innerHTML = `<span class="who"></span><span class="kind"></span><span class="txt"></span>`;
      (o.bubbleEl.querySelector('.who') as HTMLElement).textContent = a.name;
      (o.bubbleEl.querySelector('.kind') as HTMLElement).textContent = b.kind.replace(/_/g, ' ').toLowerCase();
    }
    // typewriter reveal of the real recorded text (instant under reduced motion)
    const shown = this.reduceMotion ? b.text.length : Math.min(b.text.length, Math.floor((now - b.startedAt) / 18));
    const el = o.bubbleEl.querySelector('.txt') as HTMLElement;
    const next = b.text.slice(0, shown);
    if (el.textContent !== next) el.textContent = next;
  }

  /** Called every frame with the positions main.ts derived from reduced events. */
  render(t: number, agents: AgentDraw[], link: { from: string; to: string[] } | null) {
    if (this.introStart < 0) this.introStart = t;
    if (!this.reduceMotion && t - this.introStart < 3200) {
      const k = 1 - Math.pow(1 - (t - this.introStart) / 3200, 3);
      this.camera.position.set(Math.sin((1 - k) * 0.9) * 60, 34 + (1 - k) * 30, 40 + (1 - k) * 25);
    }
    const now = performance.now();
    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.id);
      let o = this.agents.get(a.id);
      if (!o || o.color !== a.color) {
        if (o) this.scene.remove(o.group);
        o = this.makeAgent(a);
        this.agents.set(a.id, o);
      }
      const p = toWorld(a.x, a.y);
      const prev = o.group.position.clone();
      const walk = a.moving && !this.reduceMotion;
      o.group.position.set(p.x, walk ? Math.abs(Math.sin(t * 0.012)) * 0.07 : 0, p.z);
      const dx = p.x - prev.x, dz = p.z - prev.z;
      if (Math.hypot(dx, dz) > 0.001) o.group.rotation.y = Math.atan2(dx, dz);
      const swing = walk ? Math.sin(t * 0.012) * 0.7 : a.status === 'communicating' && !this.reduceMotion ? Math.sin(t * 0.006) * 0.25 : 0;
      o.legs[0]!.rotation.x = swing;
      o.legs[1]!.rotation.x = -swing;
      o.arms[0]!.rotation.x = -swing;
      o.arms[1]!.rotation.x = swing;
      const lc = LAMP[a.status] ?? 0x6b7480;
      const lm = o.lamp.material as THREE.MeshStandardMaterial;
      lm.color.setHex(lc);
      lm.emissive.setHex(lc);
      o.lamp.position.y = a.status === 'thinking' && !this.reduceMotion ? 2.32 + Math.sin(t * 0.008) * 0.08 : 2.32;
      o.ring.visible = a.selected;
      this.updateBubble(o, a, now);
    }
    for (const [id, o] of this.agents) if (!seen.has(id)) (o.bubbleEl.remove(), this.scene.remove(o.group), this.agents.delete(id));
    if (this.line) (this.scene.remove(this.line), (this.line = null));
    if (link) {
      const a = this.agents.get(link.from);
      const pts: THREE.Vector3[] = [];
      for (const to of link.to) {
        const b = this.agents.get(to);
        if (a && b) pts.push(a.group.position.clone().setY(1.6), b.group.position.clone().setY(1.6));
      }
      if (pts.length) {
        this.line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xffc15a, dashSize: 0.45, gapSize: 0.25 }));
        this.line.computeLineDistances();
        this.scene.add(this.line);
      }
    }
    if (this.follow) {
      const f = this.agents.get(this.follow);
      if (f) this.controls.target.lerp(f.group.position, 0.06);
    }
    this.grassUniforms.uTime.value = this.reduceMotion ? 0 : t * 0.001;
    for (const fn of this.ambient) fn(t);
    this.controls.update();
    if (this.composerOn) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  pick(clientX: number, clientY: number): string | null {
    const r = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const meshes: THREE.Object3D[] = [];
    for (const o of this.agents.values()) o.group.traverse((c) => c.userData.agentId && meshes.push(c));
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return (hit?.object.userData.agentId as string) ?? null;
  }

  /** Screen position (CSS px, relative to the canvas) of an agent's body — used by UI tests to click agents. */
  screenPos(id: string): { x: number; y: number } | null {
    const o = this.agents.get(id);
    if (!o) return null;
    const v = o.group.position.clone().setY(1.4).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
  }
}
