// The iPhone Duo in the Device panel's 3D view (PLX-886), after T3 Code's `duoScene.ts` and
// `duoViewer.ts` (MIT, T3 Tools Inc.): a model whose halves turn on its hinge, with a cover display
// on one half and an inside display across both. The stream is whichever display is live.

import {
  Box3,
  CanvasTexture,
  Float32BufferAttribute,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Vector3,
  type Object3D,
  type Raycaster,
} from "three";

/** The cover display (1) and the inside one (3), as the hub numbers them. */
export type DuoDisplay = 1 | 3;

/** A canvas in a display's shape, which the stream is drawn onto, and its material. */
function surface(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false })!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  const clear = () => {
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    texture.needsUpdate = true;
  };
  clear();
  return {
    canvas,
    context,
    texture,
    clear,
    material: new MeshBasicMaterial({ map: texture, toneMapped: false }),
  };
}

/** Sets up the Duo `model`: its displays' materials, and its hinge. */
export function createDuo(model: Object3D) {
  const left = model.getObjectByName("left-half");
  const right = model.getObjectByName("right-half");
  const cover = model.getObjectByName("cover-display");
  const innerLeft = model.getObjectByName("inner-display-left");
  const innerRight = model.getObjectByName("inner-display-right");
  if (
    !left ||
    !right ||
    !(cover instanceof Mesh) ||
    !(innerLeft instanceof Mesh) ||
    !(innerRight instanceof Mesh)
  )
    throw new Error("The iPhone Duo model is missing its hinge or a display.");
  const meshes: Record<DuoDisplay, Mesh[]> = { 1: [cover], 3: [innerLeft, innerRight] };
  const surfaces = { 1: surface(784, 1140), 3: surface(1600, 1125) };
  // Each display's stream spans its meshes, as they lie open: the cover's seen from behind.
  for (const id of [1, 3] as const) {
    const bounds = new Box3();
    const point = new Vector3();
    for (const mesh of meshes[id]) {
      const position = mesh.geometry.getAttribute("position");
      for (let i = 0; i < position.count; i++)
        bounds.expandByPoint(point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix));
    }
    const size = bounds.getSize(new Vector3());
    for (const mesh of meshes[id]) {
      const position = mesh.geometry.getAttribute("position");
      const uv = new Float32BufferAttribute(new Float32Array(position.count * 2), 2);
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix);
        const x = (point.x - bounds.min.x) / size.x;
        uv.setXY(i, id === 1 ? 1 - x : x, (point.y - bounds.min.y) / size.y);
      }
      mesh.geometry.setAttribute("uv", uv);
      mesh.material = surfaces[id].material;
    }
  }
  let display: DuoDisplay = 1;
  const relative = new Matrix4();

  return {
    get display() {
      return display;
    },
    /** Opens the hinge to `angle` degrees, 0 closed and 180 flat, with `live` the display on. */
    fold(live: DuoDisplay, angle: number) {
      if (live !== display) surfaces[display].clear();
      display = live;
      const turn = ((180 - Math.min(180, Math.max(0, angle))) * Math.PI) / 360;
      left.rotation.y = turn;
      right.rotation.y = -turn;
    },
    /**
     * The facing, in `space`'s axes, of the display that shows at hinge `angle`: the cover when
     * it's mostly shut, the inside when it's mostly open. Mid-fold, the hub can still report the
     * other one live.
     */
    facing(space: Object3D, angle: number) {
      space.updateWorldMatrix(true, true);
      const inverse = space.matrixWorld.clone().invert();
      const normal = new Vector3();
      for (const mesh of meshes[angle < 90 ? 1 : 3]) {
        relative.multiplyMatrices(inverse, mesh.matrixWorld);
        normal.add(
          new Vector3()
            .fromBufferAttribute(mesh.geometry.getAttribute("normal"), 0)
            .transformDirection(relative),
        );
      }
      return normal.normalize();
    },
    /** Draws the stream's latest frame from `source` on the live display. */
    draw(source: HTMLCanvasElement) {
      if (!source.width || !source.height) return;
      const { canvas, context, texture } = surfaces[display];
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.save();
      context.translate(canvas.width / 2, canvas.height / 2);
      // The inside display is mounted a quarter turn from its framebuffer.
      const turned = display === 3;
      if (turned) context.rotate(Math.PI / 2);
      const scale = Math.min(
        canvas.width / (turned ? source.height : source.width),
        canvas.height / (turned ? source.width : source.height),
      );
      const [width, height] = [source.width * scale, source.height * scale];
      context.drawImage(source, -width / 2, -height / 2, width, height);
      context.restore();
      texture.needsUpdate = true;
    },
    /** The live display's point under `raycaster`, from 0 to 1 across its framebuffer. */
    screenPoint(raycaster: Raycaster) {
      const hit = raycaster.intersectObjects(meshes[display], false)[0];
      if (!hit?.uv) return null;
      const [u, v] = [hit.uv.x, 1 - hit.uv.y];
      return display === 1 ? { x: u, y: v } : { x: v, y: 1 - u };
    },
    dispose() {
      for (const { texture, material } of Object.values(surfaces)) {
        texture.dispose();
        material.dispose();
      }
    },
  };
}

export type Duo = ReturnType<typeof createDuo>;
