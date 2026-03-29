import argparse
import math
import sys

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--resolution", type=int, default=1024)
    return parser.parse_args(argv)


def choose_main_mesh() -> bpy.types.Object | None:
    candidates = [
        obj
        for obj in bpy.data.objects
        if obj.type == "MESH" and getattr(obj.data, "vertices", None) and len(obj.data.vertices) > 0
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda obj: len(obj.data.vertices))


def choose_armature() -> bpy.types.Object | None:
    armatures = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    if not armatures:
        return None
    return max(armatures, key=lambda obj: len(obj.data.bones))


def prune_helpers(main_mesh: bpy.types.Object) -> None:
    for obj in list(bpy.data.objects):
        if obj == main_mesh:
            continue
        if obj.type == "MESH" and (obj.name.startswith("WGT-") or not obj.material_slots):
            bpy.data.objects.remove(obj, do_unlink=True)


def set_pose_bone_rotation(armature: bpy.types.Object, name: str, xyz_degrees: tuple[float, float, float]) -> None:
    pose_bone = armature.pose.bones.get(name)
    if pose_bone is None:
        return
    pose_bone.rotation_mode = "XYZ"
    pose_bone.rotation_euler = tuple(math.radians(value) for value in xyz_degrees)


def apply_idle_pose(armature: bpy.types.Object, sway: float = 0.0, breathing: float = 0.0) -> None:
    pose_map = {
        "DEF-upper_arm.L": (0.0, 0.0, 52.0 + sway),
        "DEF-upper_arm.R": (0.0, 0.0, -52.0 - sway),
        "DEF-forearm.L": (0.0, 0.0, 9.0 + (sway * 0.35)),
        "DEF-forearm.R": (0.0, 0.0, -9.0 - (sway * 0.35)),
        "DEF-hand.L": (0.0, 0.0, -3.0),
        "DEF-hand.R": (0.0, 0.0, 3.0),
        "DEF-spine": (-4.0 - (breathing * 0.6), 0.0, sway * 0.12),
        "DEF-spine.001": (5.5 + breathing, 0.0, sway * 0.18),
        "DEF-spine.002": (4.0 + (breathing * 0.7), 0.0, sway * 0.22),
        "DEF-spine.003": (2.0, 0.0, sway * 0.26),
        "head": (-3.5, sway * -0.18, sway * -0.08),
        "neck": (1.5, sway * -0.08, 0.0),
    }

    for bone_name, rotation in pose_map.items():
        set_pose_bone_rotation(armature, bone_name, rotation)


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def main() -> None:
    args = parse_args()
    scene = bpy.context.scene

    main_mesh = choose_main_mesh()
    if main_mesh is None:
        raise RuntimeError("No renderable mesh found in the blend file.")
    armature = choose_armature()

    prune_helpers(main_mesh)
    if armature is not None:
        apply_idle_pose(armature, sway=-1.2, breathing=0.5)
    bpy.context.view_layer.update()

    bbox = [main_mesh.matrix_world @ Vector(corner) for corner in main_mesh.bound_box]
    min_corner = Vector((min(v.x for v in bbox), min(v.y for v in bbox), min(v.z for v in bbox)))
    max_corner = Vector((max(v.x for v in bbox), max(v.y for v in bbox), max(v.z for v in bbox)))
    center = (min_corner + max_corner) / 2
    size = max((max_corner - min_corner).x, (max_corner - min_corner).y, (max_corner - min_corner).z)

    for obj in list(bpy.data.objects):
        if obj.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(obj, do_unlink=True)

    bpy.ops.object.camera_add(location=(center.x, center.y - (size * 2.8), center.z + (size * 0.35)))
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = size * 0.95
    look_at(camera, center + Vector((0, 0, size * 0.18)))
    scene.camera = camera

    bpy.ops.object.light_add(type="AREA", location=(center.x + size * 1.2, center.y - size * 1.6, center.z + size * 1.8))
    key_light = bpy.context.object
    key_light.data.energy = 6000
    key_light.data.shape = "RECTANGLE"
    key_light.data.size = size * 2.2
    key_light.data.size_y = size * 2.2
    look_at(key_light, center + Vector((0, 0, size * 0.25)))

    bpy.ops.object.light_add(type="AREA", location=(center.x - size * 1.5, center.y - size * 0.8, center.z + size * 0.7))
    fill_light = bpy.context.object
    fill_light.data.energy = 1800
    fill_light.data.shape = "RECTANGLE"
    fill_light.data.size = size * 2.5
    fill_light.data.size_y = size * 2.5
    look_at(fill_light, center)

    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items.keys() else "BLENDER_EEVEE"
    scene.render.film_transparent = True
    scene.render.resolution_x = args.resolution
    scene.render.resolution_y = args.resolution
    bpy.ops.render.render(write_still=False)

    result = bpy.data.images["Render Result"]
    result.filepath_raw = args.output
    result.file_format = "PNG"
    result.save()


if __name__ == "__main__":
    main()
