// The Device panel's 3D view (PLX-886): the device as a lit model in three.js, its screen the live
// stream. iPhones and iPads are Apple's own models of each, from its AR product pages, and Pixels
// Google's, from its Store's 3D views (assets/devices/NOTICE.md).
// The screen and framing follow T3 Code's phone viewer (MIT, T3 Tools Inc.): a model's screen is
// one `device-screen` mesh, 2.2 units tall, centered and facing forward.

import {
  ACESFilmicToneMapping,
  Box3,
  CanvasTexture,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  Plane,
  Raycaster,
  SRGBColorSpace,
  Scene,
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
import { createDuo, type Duo } from "./deviceDuo";

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
  /** iPhone Duo: its live display, 1 the cover and 3 the inside, and its hinge, 0 to 180 degrees. */
  fold(display: number, angle: number): void;
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

/**
 * Google's model of an Android phone, by its name, such as "Pixel 9 Pro" or an AVD's "Pixel_9a":
 * its own Pixel's, or for another phone, the Pixel 9's. The stream fills the model's screen, so a
 * phone whose screen, `aspect` wide for its height, isn't a Pixel's shape, or a foldable or tablet,
 * gets none and turns as its flat artwork.
 */
export function pixelModel(name: string, aspect: number): string | undefined {
  const n = name.toLowerCase().replaceAll("_", " ");
  if (/fold|tablet/.test(n) || Math.abs(aspect - 1080 / 2424) > 0.02) return undefined;
  // A Pro XL is its Pro's design, larger.
  const pixel = /pixel (\d+a?)( pro)?/.exec(n);
  const own = pixel && models[`./assets/devices/pixel-${pixel[1]}${pixel[2] ? "-pro" : ""}.glb`];
  return own ?? models["./assets/devices/pixel-9.glb"];
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

/**
 * Renders `platform` device `name` in 3D on `canvas`, its screen drawn from `source`. An Android
 * phone's screen is `aspect` wide for its height.
 */
export function createDevice3d(options: {
  canvas: HTMLCanvasElement;
  source: HTMLCanvasElement;
  platform: DevicePlatform;
  name: string;
  aspect: number;
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
  // A texture keeps the size it was first uploaded at: one from a canvas that has since changed
  // size, such as before the first frame or after a turn to landscape, is uploaded afresh.
  let uploaded = { width: options.source.width, height: options.source.height };

  const root = new Group();
  const orientation = new Group();
  root.add(orientation);
  scene.add(root);
  let screen: Mesh | undefined;
  let duo: Duo | undefined;
  let model: Object3D | undefined;
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

  // Centers the model on its middle, so it turns about its own center: front to back for a phone,
  // whose screen is already centered, and every way for the folding Duo.
  const settle = () => {
    if (!model) return;
    model.position.set(0, 0, 0);
    orientation.updateWorldMatrix(true, true);
    const inverse = orientation.matrixWorld.clone().invert();
    const box = new Box3();
    model.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.computeBoundingBox();
      box.union(
        object.geometry
          .boundingBox!.clone()
          .applyMatrix4(inverse.clone().multiply(object.matrixWorld)),
      );
    });
    const center = box.getCenter(new Vector3());
    if (!duo) center.set(0, 0, center.z);
    model.position.sub(center);
    extent = box.translate(center.negate());
  };

  const install = (loaded: Object3D) => {
    if (duo) {
      // Its rig is in centimeters: scaled so its cover display is as tall as a phone's screen.
      const cover = new Box3().setFromObject(loaded.getObjectByName("cover-display")!);
      loaded.scale.setScalar(SCREEN_HEIGHT / cover.getSize(new Vector3()).y);
    } else {
      const screens: Mesh[] = [];
      loaded.traverse((object) => {
        if (object instanceof Mesh && object.name === "device-screen") screens.push(object);
      });
      const found = screens[0];
      if (!found) throw new Error("The device model has no screen.");
      screenUv(found.geometry);
      found.material = new MeshBasicMaterial({ map: texture, toneMapped: false });
      screen = found;
    }
    model = loaded;
    orientation.add(loaded);
    settle();
    fit();
    invalidate();
  };
  const ready = (async () => {
    const url =
      options.platform === "android"
        ? pixelModel(options.name, options.aspect)
        : appleModel(options.name);
    if (!url) throw new Error("There's no model of this device.");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`The device model didn't load (${response.status}).`);
    const gltf = await new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await response.arrayBuffer(), "");
    if (disposed) return release(gltf.scene, texture);
    if (/^iphone duo$/i.test(options.name)) duo = createDuo(gltf.scene);
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
      const { width, height } = options.source;
      if (duo) duo.draw(options.source);
      else {
        if (width !== uploaded.width || height !== uploaded.height) {
          uploaded = { width, height };
          texture.dispose();
        }
        texture.needsUpdate = true;
      }
      invalidate();
    },
    fold(display, angle) {
      if (!duo || !model || (display !== 1 && display !== 3)) return;
      duo.fold(display, angle);
      // Turned so the display it shows faces front.
      model.rotation.y = 0;
      const facing = duo.facing(orientation, angle);
      model.rotation.y = -Math.atan2(facing.x, facing.z);
      settle();
      fit();
      duo.draw(options.source);
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
      root.updateMatrixWorld(true);
      pointer.set(x * 2 - 1, 1 - y * 2);
      raycaster.setFromCamera(pointer, camera);
      if (duo) return duo.screenPoint(raycaster);
      if (!screen) return null;
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
      duo?.dispose();
      texture.dispose();
      scene.environment?.dispose();
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
