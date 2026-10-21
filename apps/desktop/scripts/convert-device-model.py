# Converts one device in Apple's AR file to a Device view model (PLX-886), after T3 Code's
# scripts/convert-device-model.py (MIT, T3 Tools Inc.). With Blender 4.5 or later:
#   blender --background --python convert-device-model.py -- \
#     <source.usdz> <out.glb> <body node or -> <screen node>[!]
#   npx @gltf-transform/cli@4.2.1 optimize <out.glb> <tmp.glb> --compress false --simplify false \
#     --join false --palette false --flatten false --texture-size 1024 --texture-compress webp
#   npx @gltf-transform/cli@4.2.1 meshopt <tmp.glb> src/renderer/assets/devices/<id>.glb
# The body node is the device's in a file with several, and "-" for a file's only one. The screen
# is the flat mesh with Apple's wallpaper on it; "!" turns a device its UVs face backward around.
# It keeps only the visible meshes around the screen. NOTICE.md lists each model's arguments.
import json
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

args = sys.argv[sys.argv.index("--") + 1 :]
source, output = args[:2]
body_name = args[2] if len(args) > 2 and args[2] != "-" else None
screen_name = args[3].rstrip("!")
flip = args[3].endswith("!")
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.usd_import(filepath=source, import_materials=True)


def visible(o):
    while o:
        if o.hide_render or o.hide_get():
            return False
        o = o.parent
    return True


if body_name:
    body = bpy.data.objects[body_name]
    objects = [o for o in body.children_recursive if o.type == "MESH"]
    if body.type == "MESH":
        objects.append(body)
else:
    objects = [o for o in bpy.data.objects if o.type == "MESH"]
objects = [o for o in objects if visible(o) and len(o.data.vertices)]

screen = bpy.data.objects[screen_name]

uv = screen.data.uv_layers.active
points = []
coords = []
for loop in screen.data.loops:
    points.append(
        tuple(screen.matrix_world @ screen.data.vertices[loop.vertex_index].co)
    )
    coords.append((*uv.data[loop.index].uv, 1))
coef = np.linalg.lstsq(np.array(coords), np.array(points), rcond=None)[0]
right = Vector(coef[0]).normalized()
up = Vector(coef[1]).normalized()
normal = right.cross(up).normalized()


# The authored UVs establish the device's front and its physical portrait axes.
# No body proportions are changed. The runtime uses a standard planar framebuffer UV.
def frame(right, up, normal):
    rot = Matrix((right, up, normal)).to_4x4()
    world = [rot @ Vector(p) for p in points]
    lo = Vector(tuple(min(p[i] for p in world) for i in range(3)))
    hi = Vector(tuple(max(p[i] for p in world) for i in range(3)))
    return rot, lo, hi, (lo + hi) / 2


rot, lo, hi, center = frame(right, up, normal)


# Only what's around the screen: the device, not a stand, a shadow, or a placement helper.
def near(o):
    # Its vertices, not its box: a box in a tilted mesh's own axes can be far thicker than it.
    points = [rot @ (o.matrix_world @ v.co) for v in o.data.vertices]
    margin = (hi.y - lo.y) * 0.15
    return all(
        lo.x - margin <= p.x <= hi.x + margin
        and lo.y - margin <= p.y <= hi.y + margin
        and abs(p.z - center.z) <= margin * 1.5
        for p in points
    )


objects = [o for o in objects if o == screen or near(o)]
if flip:
    right, normal = -right, -normal
    rot, lo, hi, center = frame(right, up, normal)
scale = 2.2 / (hi.y - lo.y)
transform = (
    Matrix.Translation(Vector((0, 0, 0.043)))
    @ Matrix.Diagonal(Vector((scale, scale, scale, 1)))
    @ Matrix.Translation(-center)
    @ rot
)
for o in objects:
    matrix = transform @ o.matrix_world
    o.parent = None
    o.matrix_world = Matrix.Identity(4)
    o.data.transform(matrix)
    # Blender is Z-up; glTF export converts to Y-up. Store canonical Y-up geometry as Blender Z-up.
    o.data.transform(Matrix.Rotation(np.pi / 2, 4, "X"))
    if o == screen:
        o.name = "device-screen"
        o.data.name = "device-screen"
        for loop in o.data.loops:
            p = o.data.vertices[loop.vertex_index].co
            uv.data[loop.index].uv = (
                (p.x / ((hi.x - lo.x) * scale)) + 0.5,
                p.z / 2.2 + 0.5,
            )
        # This material is replaced by the viewer and must not retain the marketing screenshot.
        mat = bpy.data.materials.new("device-screen")
        mat.diffuse_color = (0, 0, 0, 1)
        o.data.materials.clear()
        o.data.materials.append(mat)
for o in list(bpy.data.objects):
    if o not in objects:
        bpy.data.objects.remove(o, do_unlink=True)
for image in bpy.data.images:
    if image.size[0] > 1024 or image.size[1] > 1024:
        k = 1024 / max(image.size)
        image.scale(max(1, round(image.size[0] * k)), max(1, round(image.size[1] * k)))
for o in objects:
    o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=output,
    export_format="GLB",
    use_selection=True,
    export_yup=True,
    export_animations=False,
    export_extras=False,
    export_image_format="AUTO",
    export_copyright="Apple Inc. Original device assets; see NOTICE.md for provenance.",
)
print(
    "MODEL_METRICS",
    json.dumps(
        {
            "width": (hi.x - lo.x) * scale,
            "height": 2.2,
            "bodyMeshes": len(objects),
            "screen": screen.name,
            "source": source,
        }
    ),
)
