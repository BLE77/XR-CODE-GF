import argparse
import os
import sys
import bpy
from math import radians


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-name", required=True)
    parser.add_argument("--texture-name", default="FULL TEXTURE.png")
    parser.add_argument(
        "--action-mode",
        choices=("preserve", "idle", "idle_pose", "walk", "walk_pose"),
        default="preserve",
    )
    parser.add_argument("--action-fbx")
    parser.add_argument("--freeze-frame", type=int, default=1)
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


def choose_image(preferred_name: str) -> bpy.types.Image | None:
    images = [image for image in bpy.data.images if image and (image.filepath or image.name)]
    if not images:
        return None

    preferred_name = preferred_name.lower()
    for image in images:
        image_name = os.path.basename(bpy.path.abspath(image.filepath or image.name)).lower()
        if image_name == preferred_name:
            return image

    for image in images:
        image_name = os.path.basename(bpy.path.abspath(image.filepath or image.name)).lower()
        if "full texture" in image_name:
            return image

    for image in images:
        image_name = os.path.basename(bpy.path.abspath(image.filepath or image.name)).lower()
        if "sketchfab" not in image_name:
            return image

    return images[0]


def export_image_copy(
    image: bpy.types.Image | None,
    export_dir: str,
    output_stem: str,
    file_format: str = "PNG",
) -> bpy.types.Image | None:
    if image is None:
        return None

    os.makedirs(export_dir, exist_ok=True)
    extension = "png" if file_format == "PNG" else "jpg"
    output_path = os.path.join(export_dir, f"{output_stem}.{extension}")

    image_copy = image.copy()
    image_copy.filepath_raw = output_path
    image_copy.file_format = file_format
    image_copy.save()

    return bpy.data.images.load(output_path, check_existing=True)


def build_simple_material(
    material_name: str,
    image: bpy.types.Image | None,
    base_color: tuple[float, float, float, float],
    alpha_mode: str = "OPAQUE",
    roughness: float = 0.85,
) -> bpy.types.Material:
    material = bpy.data.materials.get(material_name)
    if material is None:
        material = bpy.data.materials.new(name=material_name)

    material.use_nodes = True
    material.blend_method = "HASHED" if alpha_mode == "HASHED" else "OPAQUE"
    material.use_backface_culling = False
    if hasattr(material, "shadow_method"):
        material.shadow_method = "HASHED" if alpha_mode == "HASHED" else "OPAQUE"

    node_tree = material.node_tree
    nodes = node_tree.nodes
    links = node_tree.links
    nodes.clear()

    output = nodes.new(type="ShaderNodeOutputMaterial")
    output.location = (300, 0)

    principled = nodes.new(type="ShaderNodeBsdfPrincipled")
    principled.location = (0, 0)
    principled.inputs["Base Color"].default_value = base_color
    principled.inputs["Roughness"].default_value = roughness
    if "Specular IOR Level" in principled.inputs:
        principled.inputs["Specular IOR Level"].default_value = 0.15
    elif "Specular" in principled.inputs:
        principled.inputs["Specular"].default_value = 0.15
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])

    if image is not None:
        texture = nodes.new(type="ShaderNodeTexImage")
        texture.location = (-320, 40)
        texture.image = image
        links.new(texture.outputs["Color"], principled.inputs["Base Color"])
        if alpha_mode == "HASHED" and "Alpha" in texture.outputs and "Alpha" in principled.inputs:
            links.new(texture.outputs["Alpha"], principled.inputs["Alpha"])

    return material


def simplify_scene_materials() -> None:
    material_fallback_color = {
        "Dress": (0.28, 0.05, 0.09, 1.0),
        "Corset": (0.09, 0.06, 0.08, 1.0),
        "M_Face": (0.91, 0.78, 0.80, 1.0),
        "M_Body": (0.90, 0.77, 0.79, 1.0),
        "M_Tongue": (0.74, 0.38, 0.45, 1.0),
        "M_Eyelash": (0.06, 0.04, 0.05, 1.0),
        "M_EyeRefractive": (0.63, 0.14, 0.18, 1.0),
        "M_Teeth": (0.93, 0.92, 0.90, 1.0),
        "Boots": (0.15, 0.08, 0.08, 1.0),
        "M_Hair_Add": (0.12, 0.03, 0.10, 1.0),
        "MI__Hair": (0.08, 0.02, 0.08, 1.0),
    }
    material_alpha_mode = {
        "M_Eyelash": "HASHED",
    }
    material_roughness = {
        "M_EyeRefractive": 0.25,
        "M_Teeth": 0.45,
        "M_Eyelash": 0.75,
    }

    material_cache = {}
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue

        if not obj.material_slots:
            continue

        for slot in obj.material_slots:
            original_name = slot.material.name if slot.material is not None else slot.name
            if original_name not in material_cache:
                material_cache[original_name] = build_simple_material(
                    material_name=f"Codex_{original_name}",
                    image=None,
                    base_color=material_fallback_color.get(original_name, (0.6, 0.6, 0.65, 1.0)),
                    alpha_mode=material_alpha_mode.get(original_name, "OPAQUE"),
                    roughness=material_roughness.get(original_name, 0.85),
                )
            slot.material = material_cache[original_name]


def prune_helpers(main_mesh: bpy.types.Object) -> None:
    for obj in list(bpy.data.objects):
        if obj == main_mesh:
            continue
        if obj.type == "MESH" and (obj.name.startswith("WGT-") or not obj.material_slots):
            bpy.data.objects.remove(obj, do_unlink=True)


def ensure_animation_data(target: bpy.types.ID):
    if target.animation_data is None:
        target.animation_data_create()
    return target.animation_data


def find_pose_bone(armature: bpy.types.Object, names: tuple[str, ...]) -> bpy.types.PoseBone | None:
    for name in names:
        pose_bone = armature.pose.bones.get(name)
        if pose_bone is not None:
            return pose_bone
    return None


def set_pose_bone_rotation(
    armature: bpy.types.Object,
    names: tuple[str, ...],
    xyz_degrees: tuple[float, float, float],
) -> None:
    pose_bone = find_pose_bone(armature, names)
    if pose_bone is None:
        return
    pose_bone.rotation_mode = "XYZ"
    pose_bone.rotation_euler = tuple(radians(value) for value in xyz_degrees)


def set_pose_bone_location(
    armature: bpy.types.Object,
    names: tuple[str, ...],
    xyz: tuple[float, float, float],
) -> None:
    pose_bone = find_pose_bone(armature, names)
    if pose_bone is None:
        return
    pose_bone.location = xyz


def clear_pose_transforms(armature: bpy.types.Object) -> None:
    for pose_bone in armature.pose.bones:
        pose_bone.location = (0.0, 0.0, 0.0)
        pose_bone.rotation_mode = "XYZ"
        pose_bone.rotation_euler = (0.0, 0.0, 0.0)
        pose_bone.scale = (1.0, 1.0, 1.0)


def baked_pose_meshes(armature: bpy.types.Object) -> list[bpy.types.Object]:
    meshes: list[bpy.types.Object] = []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        if obj.find_armature() == armature:
            meshes.append(obj)
            continue
        for modifier in obj.modifiers:
            if modifier.type == "ARMATURE" and modifier.object == armature:
                meshes.append(obj)
                break
    return meshes


def apply_idle_pose(armature: bpy.types.Object, sway: float = 0.0, breathing: float = 0.0) -> None:
    clear_pose_transforms(armature)

    pose_map = {
        ("Ctrl_Shoulder_Left", "LeftShoulder"): (0.0, 0.0, 5.0),
        ("Ctrl_Shoulder_Right", "RightShoulder"): (0.0, 0.0, -5.0),
        ("Ctrl_Arm_FK_Left", "LeftArm", "DEF-upper_arm.L"): (28.0, 0.0, 7.0 + (sway * 0.35)),
        ("Ctrl_Arm_FK_Right", "RightArm", "DEF-upper_arm.R"): (-28.0, 0.0, -7.0 - (sway * 0.35)),
        ("Ctrl_ForeArm_FK_Left", "LeftForeArm", "DEF-forearm.L"): (-18.0, 0.0, 6.0 + (sway * 0.2)),
        ("Ctrl_ForeArm_FK_Right", "RightForeArm", "DEF-forearm.R"): (-18.0, 0.0, -6.0 - (sway * 0.2)),
        ("Ctrl_Hand_FK_Left", "LeftHand", "DEF-hand.L"): (4.0, 0.0, -3.0),
        ("Ctrl_Hand_FK_Right", "RightHand", "DEF-hand.R"): (4.0, 0.0, 3.0),
        ("Ctrl_Spine", "Spine", "DEF-spine"): (-5.0 - (breathing * 1.0), 0.0, sway * 0.3),
        ("Ctrl_Spine1", "Spine1", "DEF-spine.001"): (7.0 + breathing, 0.0, sway * 0.34),
        ("Ctrl_Spine2", "Spine2", "DEF-spine.002", "DEF-spine.003"): (5.0 + (breathing * 0.8), 0.0, sway * 0.24),
        ("Ctrl_Head", "Head", "head"): (-3.0, sway * -0.22, sway * -0.18),
        ("Ctrl_Neck", "Neck", "neck"): (1.5, sway * -0.12, 0.0),
    }

    for bone_names, rotation in pose_map.items():
        set_pose_bone_rotation(armature, bone_names, rotation)

    set_pose_bone_location(
        armature,
        ("Ctrl_Hips", "Ctrl_Hips_Free", "Hips"),
        (0.0, 0.0, breathing * 0.01),
    )


def apply_walk_pose(
    armature: bpy.types.Object,
    left_leg_forward: float,
    right_leg_forward: float,
    left_arm_forward: float,
    right_arm_forward: float,
    hips_bob: float,
    body_sway: float,
) -> None:
    clear_pose_transforms(armature)

    set_pose_bone_location(
        armature,
        ("Ctrl_Hips", "Ctrl_Hips_Free", "Hips"),
        (0.0, body_sway * 0.01, hips_bob),
    )
    set_pose_bone_rotation(armature, ("Ctrl_Spine", "Spine", "DEF-spine"), (-3.0 + (hips_bob * 30.0), 0.0, body_sway * 3.5))
    set_pose_bone_rotation(armature, ("Ctrl_Spine1", "Spine1", "DEF-spine.001"), (4.0 - (hips_bob * 22.0), 0.0, body_sway * 5.0))
    set_pose_bone_rotation(armature, ("Ctrl_Spine2", "Spine2", "DEF-spine.002", "DEF-spine.003"), (3.0, 0.0, body_sway * 4.0))
    set_pose_bone_rotation(armature, ("Ctrl_Neck", "Neck", "neck"), (1.0, 0.0, body_sway * -1.4))
    set_pose_bone_rotation(armature, ("Ctrl_Head", "Head", "head"), (-1.0, 0.0, body_sway * -1.6))

    set_pose_bone_rotation(armature, ("Ctrl_UpLeg_FK_Left", "LeftUpLeg"), (left_leg_forward, 0.0, body_sway * 1.6))
    set_pose_bone_rotation(armature, ("Ctrl_UpLeg_FK_Right", "RightUpLeg"), (right_leg_forward, 0.0, body_sway * -1.6))
    set_pose_bone_rotation(armature, ("Ctrl_Leg_FK_Left", "LeftLeg"), (max(0.0, -left_leg_forward * 0.9), 0.0, 0.0))
    set_pose_bone_rotation(armature, ("Ctrl_Leg_FK_Right", "RightLeg"), (max(0.0, -right_leg_forward * 0.9), 0.0, 0.0))
    set_pose_bone_rotation(armature, ("Foot_FK_Left", "LeftFoot"), (-8.0 + max(0.0, left_leg_forward * 0.35), 0.0, 0.0))
    set_pose_bone_rotation(armature, ("Foot_FK_Right", "RightFoot"), (-8.0 + max(0.0, right_leg_forward * 0.35), 0.0, 0.0))
    set_pose_bone_rotation(armature, ("Ctrl_Toe_FK_Left", "LeftToeBase"), (7.0 + max(0.0, -left_leg_forward * 0.28), 0.0, 0.0))
    set_pose_bone_rotation(armature, ("Ctrl_Toe_FK_Right", "RightToeBase"), (7.0 + max(0.0, -right_leg_forward * 0.28), 0.0, 0.0))

    set_pose_bone_rotation(armature, ("Ctrl_Shoulder_Left", "LeftShoulder"), (0.0, 0.0, 5.0))
    set_pose_bone_rotation(armature, ("Ctrl_Shoulder_Right", "RightShoulder"), (0.0, 0.0, -5.0))
    set_pose_bone_rotation(armature, ("Ctrl_Arm_FK_Left", "LeftArm", "DEF-upper_arm.L"), (left_arm_forward, 0.0, 9.0))
    set_pose_bone_rotation(armature, ("Ctrl_Arm_FK_Right", "RightArm", "DEF-upper_arm.R"), (right_arm_forward, 0.0, -9.0))
    set_pose_bone_rotation(armature, ("Ctrl_ForeArm_FK_Left", "LeftForeArm", "DEF-forearm.L"), (-12.0 - (left_arm_forward * 0.18), 0.0, 6.0))
    set_pose_bone_rotation(armature, ("Ctrl_ForeArm_FK_Right", "RightForeArm", "DEF-forearm.R"), (-12.0 - (right_arm_forward * 0.18), 0.0, -6.0))
    set_pose_bone_rotation(armature, ("Ctrl_Hand_FK_Left", "LeftHand", "DEF-hand.L"), (0.0, 0.0, -2.0))
    set_pose_bone_rotation(armature, ("Ctrl_Hand_FK_Right", "RightHand", "DEF-hand.R"), (0.0, 0.0, 2.0))


def apply_walk_cycle_pose(armature: bpy.types.Object, phase: int) -> None:
    poses = (
        (36.0, -28.0, -24.0, 24.0, 0.03, -1.0),
        (10.0, -6.0, -8.0, 8.0, -0.01, -0.25),
        (-28.0, 36.0, 24.0, -24.0, 0.03, 1.0),
        (-6.0, 10.0, 8.0, -8.0, -0.01, 0.25),
    )
    left_leg, right_leg, left_arm, right_arm, hips_bob, body_sway = poses[phase % len(poses)]
    apply_walk_pose(
        armature,
        left_leg_forward=left_leg,
        right_leg_forward=right_leg,
        left_arm_forward=left_arm,
        right_arm_forward=right_arm,
        hips_bob=hips_bob,
        body_sway=body_sway,
    )


def recreate_action(name: str) -> bpy.types.Action:
    existing = bpy.data.actions.get(name)
    if existing is not None:
        bpy.data.actions.remove(existing)
    return bpy.data.actions.new(name=name)


def keyframe_all_pose_bones(armature: bpy.types.Object, frame: int) -> None:
    for pose_bone in armature.pose.bones:
        pose_bone.keyframe_insert(data_path="location", frame=frame)
        pose_bone.keyframe_insert(data_path="rotation_euler", frame=frame)


def ensure_idle_action(armature: bpy.types.Object) -> str:
    action = recreate_action("CodexIdle")

    animation_data = ensure_animation_data(armature)
    animation_data.action = action
    action.frame_range = (1.0, 48.0)

    keyframes = (
        (1, -3.5, 0.0),
        (12, -1.2, 0.8),
        (24, 3.5, 1.3),
        (36, 1.4, 0.6),
        (48, -3.5, 0.0),
    )

    for frame, sway, breathing in keyframes:
        bpy.context.scene.frame_set(frame)
        apply_idle_pose(armature, sway=sway, breathing=breathing)
        keyframe_all_pose_bones(armature, frame)

    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 48
    bpy.context.scene.frame_set(1)
    return action.name


def ensure_walk_action(armature: bpy.types.Object) -> str:
    action = recreate_action("CodexWalk")

    animation_data = ensure_animation_data(armature)
    animation_data.action = action
    action.frame_range = (1.0, 24.0)

    keyframes = (
        (1, 18.0, -18.0, -16.0, 16.0, 0.02, -0.6),
        (6, 5.0, -5.0, -6.0, 6.0, -0.01, -0.2),
        (12, -18.0, 18.0, 16.0, -16.0, 0.02, 0.6),
        (18, -5.0, 5.0, 6.0, -6.0, -0.01, 0.2),
        (24, 18.0, -18.0, -16.0, 16.0, 0.02, -0.6),
    )

    for frame, left_leg, right_leg, left_arm, right_arm, hips_bob, sway in keyframes:
        bpy.context.scene.frame_set(frame)
        apply_walk_pose(
            armature,
            left_leg_forward=left_leg,
            right_leg_forward=right_leg,
            left_arm_forward=left_arm,
            right_arm_forward=right_arm,
            hips_bob=hips_bob,
            body_sway=sway,
        )
        keyframe_all_pose_bones(armature, frame)

    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 24
    bpy.context.scene.frame_set(1)
    return action.name


def retarget_mixamo_action_from_fbx(armature: bpy.types.Object, fbx_path: str, target_action_name: str) -> str:
    before_objects = {obj.name for obj in bpy.data.objects}
    before_actions = {action.name for action in bpy.data.actions}

    bpy.ops.import_scene.fbx(filepath=fbx_path)

    imported_armatures = [
        obj
        for obj in bpy.data.objects
        if obj.type == "ARMATURE" and obj.name not in before_objects
    ]
    if not imported_armatures:
        raise RuntimeError(f"No armature imported from {fbx_path}")

    source_armature = imported_armatures[0]
    source_action = None
    if source_armature.animation_data and source_armature.animation_data.action:
        source_action = source_armature.animation_data.action
    else:
        new_actions = [action for action in bpy.data.actions if action.name not in before_actions]
        if new_actions:
            source_action = new_actions[0]

    if source_action is None:
        raise RuntimeError(f"No action found in imported FBX {fbx_path}")

    action = recreate_action(target_action_name)
    animation_data = ensure_animation_data(armature)
    animation_data.action = action
    ensure_animation_data(source_armature).action = source_action

    start_frame = int(source_action.frame_range[0])
    end_frame = int(source_action.frame_range[1])
    mapped_bones = [
        (source_pose_bone, armature.pose.bones.get(source_pose_bone.name.split(":")[-1]))
        for source_pose_bone in source_armature.pose.bones
    ]
    mapped_bones = [(source_pose_bone, target_pose_bone) for source_pose_bone, target_pose_bone in mapped_bones if target_pose_bone is not None]

    if not mapped_bones:
        raise RuntimeError(f"Could not map any animated bones from {fbx_path} onto {armature.name}")

    for frame in range(start_frame, end_frame + 1):
        bpy.context.scene.frame_set(frame)
        for source_pose_bone, target_pose_bone in mapped_bones:
            target_pose_bone.location = source_pose_bone.location.copy()
            target_pose_bone.scale = source_pose_bone.scale.copy()
            target_pose_bone.rotation_mode = source_pose_bone.rotation_mode

            if source_pose_bone.rotation_mode == "QUATERNION":
                target_pose_bone.rotation_quaternion = source_pose_bone.rotation_quaternion.copy()
                target_pose_bone.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            elif source_pose_bone.rotation_mode == "AXIS_ANGLE":
                target_pose_bone.rotation_axis_angle = source_pose_bone.rotation_axis_angle[:]
                target_pose_bone.keyframe_insert(data_path="rotation_axis_angle", frame=frame)
            else:
                target_pose_bone.rotation_euler = source_pose_bone.rotation_euler.copy()
                target_pose_bone.keyframe_insert(data_path="rotation_euler", frame=frame)

            target_pose_bone.keyframe_insert(data_path="location", frame=frame)
            target_pose_bone.keyframe_insert(data_path="scale", frame=frame)

    action.frame_range = source_action.frame_range
    bpy.context.scene.frame_start = start_frame
    bpy.context.scene.frame_end = end_frame
    bpy.context.scene.frame_set(start_frame)

    imported_names = {obj.name for obj in bpy.data.objects if obj.name not in before_objects}
    for obj_name in imported_names:
        obj = bpy.data.objects.get(obj_name)
        if obj is not None:
            bpy.data.objects.remove(obj, do_unlink=True)

    return action.name


def apply_walk_pose_from_fbx_frame(armature: bpy.types.Object, fbx_path: str, frame: int) -> None:
    before_objects = {obj.name for obj in bpy.data.objects}
    before_actions = {action.name for action in bpy.data.actions}

    bpy.ops.import_scene.fbx(filepath=fbx_path)

    imported_armatures = [
        obj
        for obj in bpy.data.objects
        if obj.type == "ARMATURE" and obj.name not in before_objects
    ]
    if not imported_armatures:
        raise RuntimeError(f"No armature imported from {fbx_path}")

    source_armature = imported_armatures[0]
    source_action = None
    if source_armature.animation_data and source_armature.animation_data.action:
        source_action = source_armature.animation_data.action
    else:
        new_actions = [action for action in bpy.data.actions if action.name not in before_actions]
        if new_actions:
            source_action = new_actions[0]

    if source_action is None:
        raise RuntimeError(f"No action found in imported FBX {fbx_path}")

    ensure_animation_data(source_armature).action = source_action
    bpy.context.scene.frame_set(frame)

    mapped_bones = [
        (source_pose_bone, armature.pose.bones.get(source_pose_bone.name.split(":")[-1]))
        for source_pose_bone in source_armature.pose.bones
    ]
    mapped_bones = [(source_pose_bone, target_pose_bone) for source_pose_bone, target_pose_bone in mapped_bones if target_pose_bone is not None]

    if not mapped_bones:
        raise RuntimeError(f"Could not map any animated bones from {fbx_path} onto {armature.name}")

    clear_pose_transforms(armature)
    for source_pose_bone, target_pose_bone in mapped_bones:
        target_pose_bone.location = source_pose_bone.location.copy()
        target_pose_bone.scale = source_pose_bone.scale.copy()
        target_pose_bone.rotation_mode = source_pose_bone.rotation_mode

        if source_pose_bone.rotation_mode == "QUATERNION":
            target_pose_bone.rotation_quaternion = source_pose_bone.rotation_quaternion.copy()
        elif source_pose_bone.rotation_mode == "AXIS_ANGLE":
            target_pose_bone.rotation_axis_angle = source_pose_bone.rotation_axis_angle[:]
        else:
            target_pose_bone.rotation_euler = source_pose_bone.rotation_euler.copy()

    imported_names = {obj.name for obj in bpy.data.objects if obj.name not in before_objects}
    for obj_name in imported_names:
        obj = bpy.data.objects.get(obj_name)
        if obj is not None:
            bpy.data.objects.remove(obj, do_unlink=True)


def bake_current_pose_to_meshes(armature: bpy.types.Object) -> None:
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    source_meshes = baked_pose_meshes(armature)
    baked_objects: list[bpy.types.Object] = []

    for source_mesh in source_meshes:
        evaluated_mesh = source_mesh.evaluated_get(depsgraph)
        baked_mesh_data = bpy.data.meshes.new_from_object(
            evaluated_mesh,
            preserve_all_data_layers=True,
            depsgraph=depsgraph,
        )
        baked_object = bpy.data.objects.new(source_mesh.name, baked_mesh_data)
        baked_object.matrix_world = evaluated_mesh.matrix_world.copy()

        for slot in source_mesh.material_slots:
            baked_object.data.materials.append(slot.material)

        bpy.context.scene.collection.objects.link(baked_object)
        baked_objects.append(baked_object)

    for obj in list(bpy.data.objects):
        if obj.type == "ARMATURE" or obj in source_meshes:
            bpy.data.objects.remove(obj, do_unlink=True)


def prepare_action(
    armature: bpy.types.Object | None,
    action_mode: str,
    action_fbx: str | None,
    freeze_frame: int,
) -> list[str]:
    if armature is None:
        return []

    if action_mode == "idle":
        return [ensure_idle_action(armature)]
    if action_mode == "idle_pose":
        apply_idle_pose(armature, sway=0.8, breathing=1.0)
        bake_current_pose_to_meshes(armature)
        return []
    if action_mode == "walk":
        if action_fbx:
            return [retarget_mixamo_action_from_fbx(armature, action_fbx, "CodexWalk")]
        return [ensure_walk_action(armature)]
    if action_mode == "walk_pose":
        apply_walk_cycle_pose(armature, max(0, (freeze_frame - 1) // 8))
        bake_current_pose_to_meshes(armature)
        return []

    animation_data = ensure_animation_data(armature)
    if animation_data.action is not None:
        return [animation_data.action.name]
    if bpy.data.actions:
        action = bpy.data.actions[0]
        animation_data.action = action
        return [action.name]
    return [ensure_idle_action(armature)]


def main() -> None:
    args = parse_args()

    main_mesh = choose_main_mesh()
    if main_mesh is None:
        raise RuntimeError("No mesh with vertices found in the blend file.")
    armature = choose_armature()

    image = choose_image(args.texture_name)
    if image is not None:
        image.reload()

    simplify_scene_materials()
    prune_helpers(main_mesh)
    prepare_action(armature, args.action_mode, args.action_fbx, args.freeze_frame)

    static_pose_export = args.action_mode in {"idle_pose", "walk_pose"}

    bpy.ops.wm.usd_export(
        filepath=args.output,
        export_armatures=not static_pose_export,
        export_shapekeys=not static_pose_export,
        export_materials=True,
        export_meshes=True,
        export_uvmaps=True,
        export_normals=True,
        export_animation=not static_pose_export,
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
        root_prim_path=f"/{args.model_name}",
    )


if __name__ == "__main__":
    main()
