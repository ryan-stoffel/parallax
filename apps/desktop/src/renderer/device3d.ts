// The Device panel's 3D view (PLX-886): the device as a lit model in three.js, its screen the live
// stream. iPhones and iPads are Apple's own models of each, from its AR product pages
// (assets/devices/NOTICE.md); Android phones are a Pixel 9 built here to its measurements.
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
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type { DevicePlatform } from "../protocol/generated/protocol";

const models = import.meta.glob<string>("./assets/devices/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
});

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

/**
 * Apple's model of an iOS device, by its name, such as "iPhone 17 Pro" or "iPad Air 13-inch (M3)".
 * Undefined for a device Apple has none of, or a renamed one: it turns as flat artwork instead.
 */
export function appleModel(name: string): string | undefined {
  const n = name.toLowerCase();
  // An 11-inch iPad's screen is narrower than the 13-inch one in each of these models.
  const ipad = /^ipad (pro|air) 13-inch \((m\d)\)/.exec(n);
  // The M3 iPad Air is the M4's body.
  const id = ipad
    ? `ipad-${ipad[1]}-${ipad[2]}`.replace("ipad-air-m3", "ipad-air-m4")
    : n === "ipad (a16)"
      ? "ipad-a16"
      : n === "iphone se (3rd generation)"
        ? "iphone-se-3"
        : n.replaceAll(" ", "-");
  return models[`./assets/devices/${id}.glb`];
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

/**
 * Maps the stream onto a flat screen across its own extent: its left edge left, its top up. A
 * compressed model's positions are quantized, with their offset and scale on its node, so they
 * aren't centered on the origin.
 */
function screenUv(geometry: BufferGeometry) {
  const position = geometry.getAttribute("position");
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox!;
  const uv = new Float32BufferAttribute(new Float32Array(position.count * 2), 2);
  for (let i = 0; i < position.count; i++) {
    uv.setXY(
      i,
      (position.getX(i) - min.x) / (max.x - min.x),
      (position.getY(i) - min.y) / (max.y - min.y),
    );
  }
  geometry.setAttribute("uv", uv);
}

/**
 * A Pixel 9, after Google's measurements (152.8 × 72.0 × 8.5 mm, and a 1080 × 2424 screen at
 * 422 ppi, so 145.9 mm tall in bezels about 3.5 mm): a satin aluminum frame, a frosted glass back,
 * and the camera bar's pill with two lenses and a flash. Its screen is `aspect` wide for its height.
 */
function pixel(texture: Texture, aspect: number) {
  const mm = SCREEN_HEIGHT / 145.9;
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
  // Obsidian's frosted glass: near black, with a soft sheen rather than a mirror.
  const back = new MeshPhysicalMaterial({
    color: 0x0b0c0e,
    metalness: 0,
    roughness: 0.62,
    specularIntensity: 0.35,
  });
  const bar = new MeshPhysicalMaterial({
    color: 0x141518,
    metalness: 1,
    roughness: 0.28,
    clearcoat: 0.5,
  });
  const lens = new MeshPhysicalMaterial({
    color: 0x000000,
    metalness: 0,
    roughness: 0.02,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
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
    rounded(screenWidth, SCREEN_HEIGHT, radius - 3.5 * mm),
    32,
  );
  screenUv(screenGeometry);
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
  // Power above the volume rocker, on the right: pills 2.4 mm wide, standing 0.55 mm off the frame.
  for (const [y, length] of [
    [32 * mm, 13 * mm],
    [6 * mm, 26 * mm],
  ] as const) {
    const button = new Mesh(
      new ExtrudeGeometry(rounded(2.4 * mm, length, 1.2 * mm), {
        depth: 0.5 * mm,
        bevelEnabled: true,
        bevelSize: 0.25 * mm,
        bevelThickness: 0.25 * mm,
        bevelSegments: 4,
        curveSegments: 16,
      }),
      frame,
    );
    // Turned to face right: its width runs front to back, and it stands out along x.
    button.rotation.y = Math.PI / 2;
    button.position.set(width / 2 - 0.2 * mm, y, -depth / 2);
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
  // The model's box, centered, in its own axes.
  let extent: Box3 | undefined;
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
  // Inset from the canvas as the flat view's artwork is, in CSS pixels: sides, top, and bottom.
  const inset = { side: 24, top: 24, bottom: 16 };
  const corner = new Vector3();
  // Framed as close as the turned device fits: each corner of its box, at (x, y, z) from its center,
  // fits when the camera is at least z + |x| / across and z + |y| / down away, those the tangents of
  // half the view inside the inset.
  const fit = () => {
    if (!viewport.width || !viewport.height || !extent) return;
    camera.aspect = viewport.width / viewport.height;
    const tan = Math.tan((FOV * Math.PI) / 360);
    const down = (tan * (viewport.height - inset.top - inset.bottom)) / viewport.height;
    const across = (tan * camera.aspect * (viewport.width - inset.side * 2)) / viewport.width;
    root.updateMatrixWorld(true);
    let distance = 0;
    for (let i = 0; i < 8; i++) {
      corner
        .set(
          i & 1 ? extent.max.x : extent.min.x,
          i & 2 ? extent.max.y : extent.min.y,
          i & 4 ? extent.max.z : extent.min.z,
        )
        .applyMatrix4(orientation.matrixWorld);
      distance = Math.max(
        distance,
        corner.z + Math.abs(corner.x) / across,
        corner.z + Math.abs(corner.y) / down,
      );
    }
    // The flat view centers the device a few pixels lower than the canvas's middle.
    camera.setViewOffset(
      viewport.width,
      viewport.height,
      0,
      (inset.bottom - inset.top) / 2,
      viewport.width,
      viewport.height,
    );
    camera.position.set(0, 0, distance);
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
    screenUv(found.geometry);
    found.material = new MeshBasicMaterial({ map: texture, toneMapped: false });
    screen = found;
    // Centered on its middle, front to back, so it turns about its own center.
    const whole = new Box3().setFromObject(model);
    const shift = -(whole.max.z + whole.min.z) / 2;
    model.position.z += shift;
    extent = whole.translate(new Vector3(0, 0, shift));
    orientation.add(model);
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
    const url = appleModel(options.name);
    if (!url) throw new Error("There's no model of this device.");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`The device model didn't load (${response.status}).`);
    const gltf = await new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await response.arrayBuffer(), "");
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
      orientation.rotation.z = (-roll * Math.PI) / 180;
      fit();
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
