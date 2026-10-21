// The Device panel's 3D view (PLX-886): the device as a lit model in three.js, its screen the live
// stream. iPhones and iPads are Apple's own models, from its AR product pages as T3 Code converted
// them (assets/devices/NOTICE.md); Android phones are a Pixel 9 built here to its measurements.
// The screen and framing follow T3 Code's phone viewer (MIT, T3 Tools Inc.): a model's screen is
// one `device-screen` mesh, 2.2 units tall, centered and facing forward.

import {
  ACESFilmicToneMapping,
  Box3,
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  Plane,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Texture,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type { DevicePlatform } from "../protocol/generated/protocol";
import ipadPro from "./assets/devices/ipad-pro-13-m5.glb?url";
import iphoneProMax from "./assets/devices/iphone-18-pro-max.glb?url";
import iphonePro from "./assets/devices/iphone-18-pro.glb?url";

/** A model's screen height, in scene units. */
const SCREEN_HEIGHT = 2.2;
/** The camera's field of view, in degrees: a long lens, so the phone looks as it does in hand. */
const FOV = 26;

export interface Device3d {
  /** Waits for the model; rejects when it can't show. */
  ready: Promise<void>;
  /** Turns the device: tilted back (pitch), around (yaw), and its own orientation (roll), in degrees. */
  setPose(pitch: number, yaw: number, roll: number): void;
  /** The stream drew a new frame. */
  frame(): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /**
   * The screen point under view point (`x`, `y`), from 0 to 1 across the view, from 0 to 1 across
   * the device's own screen. `captured` finds it on the screen's plane, for a touch that slides
   * past the screen's edge.
   */
  screenPoint(x: number, y: number, captured: boolean): { x: number; y: number } | null;
  dispose(): void;
}

/** Apple's model for an iOS device, by its name: the closest one there is. */
export function appleModel(name: string): string {
  if (/ipad/i.test(name)) return ipadPro;
  if (/pro max|plus/i.test(name)) return iphoneProMax;
  return iphonePro;
}

/** A rounded rectangle centered on the origin. */
function rounded(width: number, height: number, radius: number) {
  const shape = new Shape();
  const [x, y, r] = [-width / 2, -height / 2, Math.min(radius, width / 2, height / 2)];
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.absarc(x + width - r, y + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(x + width, y + height - r);
  shape.absarc(x + width - r, y + height - r, r, 0, Math.PI / 2, false);
  shape.lineTo(x + r, y + height);
  shape.absarc(x + r, y + height - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(x, y + r);
  shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/** Maps the stream onto a flat screen `width` by `height`: its left edge left, its top up. */
function screenUv(geometry: BufferGeometry, width: number, height: number) {
  const position = geometry.getAttribute("position");
  const uv = new Float32BufferAttribute(new Float32Array(position.count * 2), 2);
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, (position.getX(i) + width / 2) / width, (position.getY(i) + height / 2) / height);
  }
  geometry.setAttribute("uv", uv);
}

/**
 * A Pixel 9, after Google's measurements (152.8 × 72.0 × 8.5 mm, a 6.3" 1080 × 2424 screen): a
 * satin aluminum frame, a matte glass back, and the camera bar's pill with two lenses and a flash.
 * Its screen is `aspect` wide for its height.
 */
function pixel(texture: Texture, aspect: number) {
  const mm = SCREEN_HEIGHT / 140.6;
  const screenWidth = SCREEN_HEIGHT * aspect;
  const width = 72 * mm;
  const height = 152.8 * mm;
  const depth = 8.5 * mm;
  const radius = 11.5 * mm;
  const group = new Group();
  const frame = new MeshPhysicalMaterial({
    color: 0x2c2e32,
    metalness: 1,
    roughness: 0.34,
    clearcoat: 0.3,
    clearcoatRoughness: 0.4,
  });
  const glass = new MeshPhysicalMaterial({
    color: 0x050506,
    metalness: 0,
    roughness: 0.04,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
  });
  const back = new MeshPhysicalMaterial({
    color: 0x1d1f22,
    metalness: 0.2,
    roughness: 0.55,
    clearcoat: 0.25,
    clearcoatRoughness: 0.5,
  });
  const bar = new MeshPhysicalMaterial({
    color: 0x34363b,
    metalness: 1,
    roughness: 0.2,
    clearcoat: 0.5,
  });
  const lens = new MeshPhysicalMaterial({
    color: 0x020305,
    metalness: 0.4,
    roughness: 0.05,
    clearcoat: 1,
  });
  const bevel = 0.9 * mm;
  const body = new Mesh(
    new ExtrudeGeometry(rounded(width - bevel * 2, height - bevel * 2, radius - bevel), {
      depth: depth - bevel * 2,
      bevelEnabled: true,
      bevelSize: bevel,
      bevelThickness: bevel,
      bevelSegments: 8,
      curveSegments: 48,
    }),
    frame,
  );
  body.position.z = -depth + bevel;
  group.add(body);
  const face = new Mesh(
    new ShapeGeometry(rounded(width - 0.6 * mm, height - 0.6 * mm, radius - 0.4 * mm), 48),
    glass,
  );
  face.position.z = 0.001;
  group.add(face);
  const screenGeometry = new ShapeGeometry(
    rounded(screenWidth, SCREEN_HEIGHT, (87 / 1080) * screenWidth),
    32,
  );
  screenUv(screenGeometry, screenWidth, SCREEN_HEIGHT);
  const screen = new Mesh(
    screenGeometry,
    new MeshBasicMaterial({ map: texture, toneMapped: false }),
  );
  screen.name = "device-screen";
  screen.position.z = 0.002;
  group.add(screen);
  // The front camera's hole, which the stream shows the screen behind.
  const hole = new Mesh(new CircleGeometry(1.6 * mm, 32), glass);
  hole.position.set(0, SCREEN_HEIGHT / 2 - 5.2 * mm, 0.003);
  group.add(hole);
  const plate = new Mesh(
    new ShapeGeometry(rounded(width - 0.6 * mm, height - 0.6 * mm, radius - 0.4 * mm), 48),
    back,
  );
  plate.rotation.y = Math.PI;
  plate.position.z = -depth - 0.001;
  group.add(plate);
  // The camera bar: a raised pill across the top of the back, lenses on its left, flash on its right.
  const pillWidth = 55 * mm;
  const pillHeight = 17 * mm;
  const pill = new Mesh(
    new ExtrudeGeometry(rounded(pillWidth, pillHeight, pillHeight / 2), {
      depth: 1.6 * mm,
      bevelEnabled: true,
      bevelSize: 0.8 * mm,
      bevelThickness: 0.8 * mm,
      bevelSegments: 6,
      curveSegments: 48,
    }),
    bar,
  );
  const pillY = height / 2 - 21 * mm;
  pill.rotation.y = Math.PI;
  pill.position.set(0, pillY, -depth);
  group.add(pill);
  const pillBack = -depth - 2.6 * mm;
  for (const x of [-14 * mm, -1 * mm]) {
    const ring = new Mesh(new CylinderGeometry(5.6 * mm, 5.6 * mm, 0.6 * mm, 48), bar);
    ring.rotation.x = Math.PI / 2;
    // Seen from the back, its left is the device's right.
    ring.position.set(-x, pillY, pillBack - 0.3 * mm);
    group.add(ring);
    const glassDisc = new Mesh(new CircleGeometry(4.6 * mm, 48), lens);
    glassDisc.rotation.y = Math.PI;
    glassDisc.position.set(-x, pillY, pillBack - 0.61 * mm);
    group.add(glassDisc);
  }
  const flash = new Mesh(
    new CircleGeometry(2 * mm, 32),
    new MeshBasicMaterial({ color: 0xe9e2d0 }),
  );
  flash.rotation.y = Math.PI;
  flash.position.set(-15 * mm, pillY, pillBack - 0.05 * mm);
  group.add(flash);
  // Power above the volume rocker, on the right.
  for (const [y, length] of [
    [32 * mm, 13 * mm],
    [6 * mm, 26 * mm],
  ] as const) {
    const button = new Mesh(
      new ExtrudeGeometry(rounded(1.2 * mm, length, 0.6 * mm), {
        depth: 3 * mm,
        bevelEnabled: true,
        bevelSize: 0.3 * mm,
        bevelThickness: 0.3 * mm,
        bevelSegments: 3,
      }),
      frame,
    );
    button.position.set(width / 2 + 0.2 * mm, y, -depth / 2 - 1.5 * mm);
    group.add(button);
  }
  return group;
}

/** Releases every geometry, material, and texture under `root` but `keep`. */
function release(root: Object3D, keep: Texture) {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    for (const material of [object.material].flat() as Material[]) {
      for (const value of Object.values(material)) {
        if (value && (value as Texture).isTexture && value !== keep) (value as Texture).dispose();
      }
      material.dispose();
    }
  });
}

/** Renders `platform` device `name` in 3D on `canvas`, its screen drawn from `source`. */
export function createDevice3d(options: {
  canvas: HTMLCanvasElement;
  source: HTMLCanvasElement;
  platform: DevicePlatform;
  name: string;
}): Device3d {
  const renderer = new WebGLRenderer({ canvas: options.canvas, alpha: true, antialias: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new Scene();
  const environment = new PMREMGenerator(renderer);
  scene.environment = environment.fromScene(new RoomEnvironment(), 0.035).texture;
  const key = new DirectionalLight(0xf2f5ff, 1.6);
  key.position.set(-3, 4, 5);
  const rim = new DirectionalLight(0xffffff, 1.1);
  rim.position.set(4, 1.5, -4);
  scene.add(key, rim);
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 100);

  const texture = new CanvasTexture(options.source);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;

  const root = new Group();
  const orientation = new Group();
  root.add(orientation);
  scene.add(root);
  let screen: Mesh | undefined;
  let size = { width: 1, height: 1 };
  let viewport = { width: 0, height: 0 };
  let disposed = false;
  let pending = 0;

  const render = () => {
    pending = 0;
    if (disposed || !viewport.width) return;
    renderer.render(scene, camera);
  };
  const invalidate = () => {
    if (!pending && !disposed) pending = requestAnimationFrame(render);
  };
  const fit = () => {
    if (!viewport.width || !viewport.height) return;
    camera.aspect = viewport.width / viewport.height;
    // Framed facing front, with room to turn, at the size the flat view shows it.
    const half = (FOV * Math.PI) / 360;
    const roll = Math.abs(Math.sin(orientation.rotation.z));
    const across = size.width * (1 - roll) + size.height * roll;
    const down = size.height * (1 - roll) + size.width * roll;
    const distance = Math.max(
      down / 2 / Math.tan(half),
      across / 2 / (Math.tan(half) * camera.aspect),
    );
    camera.position.set(0, 0, distance * 1.02);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };

  const install = (model: Object3D) => {
    const screens: Mesh[] = [];
    model.traverse((object) => {
      if (object instanceof Mesh && object.name === "device-screen") screens.push(object);
    });
    const found = screens[0];
    if (!found) throw new Error("The device model has no screen.");
    model.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(found);
    const width = bounds.max.x - bounds.min.x;
    screenUv(found.geometry, width, bounds.max.y - bounds.min.y);
    found.material = new MeshBasicMaterial({ map: texture, toneMapped: false });
    screen = found;
    // Centered on its middle, front to back, so it turns about its own center.
    const whole = new Box3().setFromObject(model);
    model.position.z -= (whole.max.z + whole.min.z) / 2;
    orientation.add(model);
    size = { width: whole.max.x - whole.min.x, height: whole.max.y - whole.min.y };
    fit();
    invalidate();
  };

  const ready = (async () => {
    if (options.platform === "android") {
      const { width, height } = options.source;
      const aspect =
        width && height ? Math.min(width, height) / Math.max(width, height) : 1080 / 2424;
      install(pixel(texture, aspect));
      return;
    }
    const response = await fetch(appleModel(options.name));
    if (!response.ok) throw new Error(`The device model didn't load (${response.status}).`);
    const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), "");
    if (disposed) return release(gltf.scene, texture);
    install(gltf.scene);
  })();

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const local = new Vector3();
  return {
    ready,
    setPose(pitch, yaw, roll) {
      root.rotation.set((pitch * Math.PI) / 180, (yaw * Math.PI) / 180, 0, "XYZ");
      const turned = (-roll * Math.PI) / 180;
      if (orientation.rotation.z !== turned) {
        orientation.rotation.z = turned;
        fit();
      }
      invalidate();
    },
    frame() {
      texture.needsUpdate = true;
      invalidate();
    },
    resize(width, height, pixelRatio) {
      if (!width || !height) return;
      viewport = { width, height };
      renderer.setPixelRatio(Math.min(2, pixelRatio));
      renderer.setSize(width, height, false);
      fit();
      invalidate();
    },
    screenPoint(x, y, captured) {
      if (!screen) return null;
      root.updateMatrixWorld(true);
      pointer.set(x * 2 - 1, 1 - y * 2);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(screen, false)[0];
      if (hit) local.copy(hit.point);
      else if (captured) {
        const normal = new Vector3(0, 0, 1).transformDirection(screen.matrixWorld);
        const origin = new Vector3().setFromMatrixPosition(screen.matrixWorld);
        if (
          !raycaster.ray.intersectPlane(
            new Plane().setFromNormalAndCoplanarPoint(normal, origin),
            local,
          )
        )
          return null;
      } else return null;
      screen.worldToLocal(local);
      screen.geometry.computeBoundingBox();
      const box = screen.geometry.boundingBox!;
      const u = (local.x - box.min.x) / (box.max.x - box.min.x);
      const v = (local.y - box.min.y) / (box.max.y - box.min.y);
      const clamp = (n: number) => Math.min(1, Math.max(0, n));
      return { x: clamp(u), y: clamp(1 - v) };
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(pending);
      release(root, texture);
      texture.dispose();
      scene.environment?.dispose();
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
