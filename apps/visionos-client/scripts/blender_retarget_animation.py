import argparse
import os
import sys

import bpy

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from blender_export_avatar import (
    bake_current_pose_to_meshes,
    choose_armature,
    choose_main_mesh,
    clear_pose_transforms,
    prune_helpers,
    simplify_scene_materials,
)


CONTROL_BONE_MAP = {
    "Hips": "Ctrl_Hips_Free",
    "Spine": "Ctrl_Spine",
    "Spine1": "Ctrl_Spine1",
    "Spine2": "Ctrl_Spine2",
    "Neck": "Ctrl_Neck",
    "Head": "Ctrl_Head",
    "LeftShoulder": "Ctrl_Shoulder_Left",
    "LeftArm": "Ctrl_Arm_FK_Left",
    "LeftForeArm": "Ctrl_ForeArm_FK_Left",
    "LeftHand": "Ctrl_Hand_FK_Left",
    "RightShoulder": "Ctrl_Shoulder_Right",
    "RightArm": "Ctrl_Arm_FK_Right",
    "RightForeArm": "Ctrl_ForeArm_FK_Right",
    "RightHand": "Ctrl_Hand_FK_Right",
    "LeftUpLeg": "Ctrl_UpLeg_FK_Left",
    "LeftLeg": "Ctrl_Leg_FK_Left",
    "LeftFoot": "Foot_FK_Left",
    "LeftToeBase": "Ctrl_Toe_FK_Left",
    "RightUpLeg": "Ctrl_UpLeg_FK_Right",
    "RightLeg": "Ctrl_Leg_FK_Right",
    "RightFoot": "Foot_FK_Right",
    "RightToeBase": "Ctrl_Toe_FK_Right",
}


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser()
    parser.add_argument("--animation-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-name", required=True)
    parser.add_argument("--mode", choices=("action", "pose"), default="action")
    parser.add_argument("--action-name", default="CodexImported")
    parser.add_argument("--sample-percent", type=float, default=0.0)
    parser.add_argument("--keep-root-motion", action="store_true")
    return parser.parse_args(argv)


def ensure_animation_data(target: bpy.types.ID):
    if target.animation_data is None:
        target.animation_data_create()
    return target.animation_data


def source_pose_bone(source_armature: bpy.types.Object, name: str) -> bpy.types.PoseBone | None:
    return source_armature.pose.bones.get(f"mixamorig:{name}") or source_armature.pose.bones.get(name)


def import_source_animation(animation_file: str) -> tuple[bpy.types.Object, bpy.types.Action]:
    before_objects = {obj.name for obj in bpy.data.objects}
    before_actions = {action.name for action in bpy.data.actions}

    extension = os.path.splitext(animation_file)[1].lower()
    if extension == ".fbx":
        bpy.ops.import_scene.fbx(filepath=animation_file)
    else:
        raise RuntimeError(f"Unsupported animation format: {extension}")

    imported_armatures = [
        obj
        for obj in bpy.data.objects
        if obj.type == "ARMATURE" and obj.name not in before_objects
    ]
    if not imported_armatures:
        raise RuntimeError(f"No armature imported from {animation_file}")

    source_armature = imported_armatures[0]
    source_action = None

    if source_armature.animation_data and source_armature.animation_data.action:
        source_action = source_armature.animation_data.action
    else:
        new_actions = [action for action in bpy.data.actions if action.name not in before_actions]
        if new_actions:
            source_action = new_actions[0]

    if source_action is None:
        raise RuntimeError(f"No action found in {animation_file}")

    ensure_animation_data(source_armature).action = source_action
    return source_armature, source_action


def cleanup_imported_objects(source_armature: bpy.types.Object) -> None:
    for obj in list(bpy.data.objects):
        if obj == source_armature or obj.find_armature() == source_armature:
            bpy.data.objects.remove(obj, do_unlink=True)


def apply_source_frame_to_controls(
    target_armature: bpy.types.Object,
    source_armature: bpy.types.Object,
    keep_root_motion: bool,
) -> None:
    clear_pose_transforms(target_armature)

    for source_name, target_name in CONTROL_BONE_MAP.items():
        source_bone = source_pose_bone(source_armature, source_name)
        target_bone = target_armature.pose.bones.get(target_name)
        if source_bone is None or target_bone is None:
            continue

        target_bone.rotation_mode = "QUATERNION"
        if source_bone.rotation_mode == "QUATERNION":
            target_bone.rotation_quaternion = source_bone.rotation_quaternion.copy()
        elif source_bone.rotation_mode == "AXIS_ANGLE":
            target_bone.rotation_quaternion = source_bone.rotation_axis_angle.to_quaternion()
        else:
            target_bone.rotation_quaternion = source_bone.rotation_euler.to_quaternion()

        if source_name == "Hips":
            if keep_root_motion:
                target_bone.location = source_bone.location.copy()
            else:
                target_bone.location = (0.0, 0.0, 0.0)
        else:
            target_bone.location = (0.0, 0.0, 0.0)

        target_bone.scale = source_bone.scale.copy()


def recreate_action(name: str) -> bpy.types.Action:
    existing = bpy.data.actions.get(name)
    if existing is not None:
        bpy.data.actions.remove(existing)
    return bpy.data.actions.new(name=name)


def keyframe_control_bones(target_armature: bpy.types.Object, frame: int) -> None:
    for target_name in CONTROL_BONE_MAP.values():
        bone = target_armature.pose.bones.get(target_name)
        if bone is None:
            continue
        bone.keyframe_insert(data_path="location", frame=frame)
        bone.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        bone.keyframe_insert(data_path="scale", frame=frame)


def build_retargeted_action(
    target_armature: bpy.types.Object,
    source_armature: bpy.types.Object,
    source_action: bpy.types.Action,
    action_name: str,
    keep_root_motion: bool,
) -> tuple[int, int]:
    action = recreate_action(action_name)
    ensure_animation_data(target_armature).action = action

    start_frame = int(source_action.frame_range[0])
    end_frame = int(source_action.frame_range[1])

    for frame in range(start_frame, end_frame + 1):
        bpy.context.scene.frame_set(frame)
        apply_source_frame_to_controls(target_armature, source_armature, keep_root_motion)
        keyframe_control_bones(target_armature, frame)

    action.frame_range = (start_frame, end_frame)
    bpy.context.scene.frame_start = start_frame
    bpy.context.scene.frame_end = end_frame
    bpy.context.scene.frame_set(start_frame)
    return start_frame, end_frame


def sample_frame(start_frame: int, end_frame: int, percent: float) -> int:
    percent = max(0.0, min(1.0, percent))
    return int(round(start_frame + ((end_frame - start_frame) * percent)))


def export_usd(output: str, model_name: str, export_animation: bool) -> None:
    bpy.ops.wm.usd_export(
        filepath=output,
        export_armatures=export_animation,
        export_shapekeys=export_animation,
        export_materials=True,
        export_meshes=True,
        export_uvmaps=True,
        export_normals=True,
        export_animation=export_animation,
        export_cameras=False,
        export_lights=False,
        export_curves=False,
        export_points=False,
        export_volumes=False,
        export_hair=False,
        selected_objects_only=False,
        use_instancing=False,
        generate_preview_surface=True,
        generate_materialx_network=False,
        export_textures_mode="NEW",
        overwrite_textures=True,
        relative_paths=True,
        root_prim_path=f"/{model_name}",
    )


def main() -> None:
    args = parse_args()

    main_mesh = choose_main_mesh()
    if main_mesh is None:
        raise RuntimeError("No mesh with vertices found in the source blend file.")

    target_armature = choose_armature()
    if target_armature is None:
        raise RuntimeError("No armature found in the source blend file.")

    simplify_scene_materials()
    prune_helpers(main_mesh)

    source_armature, source_action = import_source_animation(args.animation_file)
    start_frame, end_frame = build_retargeted_action(
        target_armature=target_armature,
        source_armature=source_armature,
        source_action=source_action,
        action_name=args.action_name,
        keep_root_motion=args.keep_root_motion,
    )

    if args.mode == "pose":
        frame = sample_frame(start_frame, end_frame, args.sample_percent)
        bpy.context.scene.frame_set(frame)
        apply_source_frame_to_controls(target_armature, source_armature, args.keep_root_motion)
        bake_current_pose_to_meshes(target_armature)
        cleanup_imported_objects(source_armature)
        export_usd(args.output, args.model_name, export_animation=False)
        return

    cleanup_imported_objects(source_armature)
    export_usd(args.output, args.model_name, export_animation=True)


if __name__ == "__main__":
    main()
