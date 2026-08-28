#!/usr/bin/env python3
"""Bake Mobile Yuki's prototype BVH clips into the original GLB.

This is a model-preserving injector: existing meshes, skins, materials, images,
morph targets, and node transforms are not round-tripped through Blender.
Only new animation accessors, buffer views, and animation records are appended.

Usage:
  python3 ios/Tools/bake-yuki-animations.py
"""
from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "ios/App/Models/Yuki.glb"
CLIPS = ROOT.parent / "metaquest-client/public/animations/yuki/prototype"
OUTPUT = ROOT / "ios/App/Models/YukiAnimated.glb"

CLIP_NAMES = (
    "neutral_idle", "curiosity", "confusion", "action_attention_seeking",
    "talk_gesture", "walk_start", "walk_forward", "walk_stop", "turn_left",
    "turn_right", "sit_down", "seated_idle", "stand_up",
)

CENTER = {
    "hips": "Hips", "spine": "Spine", "chest": "Chest",
    "upperChest": "UpperChest", "neck": "Neck", "head": "Head",
}


def target_name(source: str) -> str | None:
    if source in CENTER:
        return "J_Bip_C_" + CENTER[source]
    if source == "leftEye":
        return "J_Adj_L_FaceEye"
    if source == "rightEye":
        return "J_Adj_R_FaceEye"
    if source.startswith("left"):
        side, stem = "L", source[4:]
    elif source.startswith("right"):
        side, stem = "R", source[5:]
    else:
        return None
    direct = {
        "Shoulder": "Shoulder", "UpperArm": "UpperArm", "LowerArm": "LowerArm",
        "Hand": "Hand", "UpperLeg": "UpperLeg", "LowerLeg": "LowerLeg",
        "Foot": "Foot", "Toes": "ToeBase",
    }
    if stem in direct:
        return f"J_Bip_{side}_{direct[stem]}"
    for finger in ("Index", "Little", "Middle", "Ring", "Thumb"):
        for suffix, number in (("Proximal", "1"), ("Intermediate", "2"), ("Distal", "3")):
            if stem == finger + suffix:
                return f"J_Bip_{side}_{finger}{number}"
    return None


Quat = tuple[float, float, float, float]  # x, y, z, w


def qnorm(q: Quat) -> Quat:
    length = math.sqrt(sum(v * v for v in q))
    return tuple(v / length for v in q)  # type: ignore[return-value]


def qmul(a: Quat, b: Quat) -> Quat:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return qnorm((
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ))


def qinv(q: Quat) -> Quat:
    x, y, z, w = qnorm(q)
    return (-x, -y, -z, w)


def qaxis(axis: str, degrees: float) -> Quat:
    half = math.radians(degrees) * 0.5
    s, c = math.sin(half), math.cos(half)
    if axis == "X": return (s, 0.0, 0.0, c)
    if axis == "Y": return (0.0, s, 0.0, c)
    return (0.0, 0.0, s, c)


@dataclass
class BVHJoint:
    name: str
    parent: str | None
    channels: list[str] = field(default_factory=list)


@dataclass
class BVHClip:
    joints: list[BVHJoint]
    frames: list[list[float]]
    frame_time: float


def parse_bvh(path: Path) -> BVHClip:
    lines = [line.strip() for line in path.read_text().splitlines() if line.strip()]
    joints: list[BVHJoint] = []
    stack: list[str | None] = []
    pending: str | None = None
    motion_at = next(i for i, line in enumerate(lines) if line == "MOTION")
    i = 1
    while i < motion_at:
        parts = lines[i].split()
        if parts[0] in ("ROOT", "JOINT"):
            parent = next((name for name in reversed(stack) if name is not None), None)
            pending = parts[1]
            joints.append(BVHJoint(pending, parent))
        elif parts[0] == "End":
            pending = None
        elif parts[0] == "{":
            stack.append(pending)
            pending = None
        elif parts[0] == "}":
            stack.pop()
        elif parts[0] == "CHANNELS":
            current = next(name for name in reversed(stack) if name is not None)
            joint = next(j for j in joints if j.name == current)
            joint.channels = parts[2:2 + int(parts[1])]
        i += 1
    count = int(lines[motion_at + 1].split(":", 1)[1])
    frame_time = float(lines[motion_at + 2].split(":", 1)[1])
    frames = [[float(v) for v in line.split()] for line in lines[motion_at + 3:motion_at + 3 + count]]
    expected = sum(len(j.channels) for j in joints)
    if len(frames) != count or any(len(frame) != expected for frame in frames):
        raise ValueError(f"Malformed BVH motion data in {path}")
    return BVHClip(joints, frames, frame_time)


def source_pose(clip: BVHClip, frame: list[float]) -> tuple[dict[str, Quat], dict[str, tuple[float, float, float]]]:
    cursor = 0
    global_rot: dict[str, Quat] = {}
    positions: dict[str, tuple[float, float, float]] = {}
    for joint in clip.joints:
        local: Quat = (0.0, 0.0, 0.0, 1.0)
        pos = [0.0, 0.0, 0.0]
        for channel in joint.channels:
            value = frame[cursor]
            cursor += 1
            if channel.endswith("rotation"):
                local = qmul(local, qaxis(channel[0], value))
            elif channel.endswith("position"):
                pos["XYZ".index(channel[0])] = value
        parent_rotation = global_rot[joint.parent] if joint.parent is not None else (0.0, 0.0, 0.0, 1.0)
        global_rot[joint.name] = qmul(parent_rotation, local)
        positions[joint.name] = (pos[0], pos[1], pos[2])
    return global_rot, positions


def read_glb(path: Path) -> tuple[dict, bytearray]:
    raw = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", raw, 0)
    if magic != 0x46546C67 or version != 2 or length != len(raw):
        raise ValueError("Expected a valid GLB 2.0 file")
    json_len, json_type = struct.unpack_from("<II", raw, 12)
    if json_type != 0x4E4F534A:
        raise ValueError("First GLB chunk is not JSON")
    document = json.loads(raw[20:20 + json_len])
    offset = 20 + json_len
    bin_len, bin_type = struct.unpack_from("<II", raw, offset)
    if bin_type != 0x004E4942:
        raise ValueError("Second GLB chunk is not BIN")
    return document, bytearray(raw[offset + 8:offset + 8 + bin_len])


def write_glb(path: Path, document: dict, binary: bytearray) -> None:
    document["buffers"][0]["byteLength"] = len(binary)
    json_bytes = json.dumps(document, separators=(",", ":")).encode()
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    binary.extend(b"\0" * ((4 - len(binary) % 4) % 4))
    header = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_bytes) + 8 + len(binary))
    path.write_bytes(header + struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
                     + struct.pack("<II", len(binary), 0x004E4942) + binary)


def add_floats(document: dict, binary: bytearray, values: Iterable[float], accessor_type: str,
               count: int, *, minimum: list[float] | None = None,
               maximum: list[float] | None = None) -> int:
    while len(binary) % 4:
        binary.append(0)
    offset = len(binary)
    packed_values = list(values)
    binary.extend(struct.pack("<" + "f" * len(packed_values), *packed_values))
    view = len(document.setdefault("bufferViews", []))
    document["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(packed_values) * 4})
    accessor = {"bufferView": view, "componentType": 5126, "count": count, "type": accessor_type}
    if minimum is not None: accessor["min"] = minimum
    if maximum is not None: accessor["max"] = maximum
    index = len(document.setdefault("accessors", []))
    document["accessors"].append(accessor)
    return index


def global_rest_rotations(document: dict) -> tuple[dict[int, Quat], dict[int, int]]:
    parents: dict[int, int] = {}
    for parent, node in enumerate(document["nodes"]):
        for child in node.get("children", []):
            parents[child] = parent
    cache: dict[int, Quat] = {}
    def visit(index: int) -> Quat:
        if index in cache: return cache[index]
        local = tuple(document["nodes"][index].get("rotation", [0.0, 0.0, 0.0, 1.0]))
        cache[index] = qmul(visit(parents[index]), local) if index in parents else qnorm(local)
        return cache[index]
    for index in range(len(document["nodes"])): visit(index)
    return cache, parents


def bake() -> None:
    document, binary = read_glb(MODEL)
    original = {key: len(document.get(key, [])) for key in ("nodes", "meshes", "skins", "materials", "images")}
    node_by_name = {node.get("name"): i for i, node in enumerate(document["nodes"])}
    rest_global, parents = global_rest_rotations(document)
    animations = []
    for clip_name in CLIP_NAMES:
        clip = parse_bvh(CLIPS / f"{clip_name}.bvh")
        mapped: list[tuple[str, str]] = []
        for joint in clip.joints:
            target = target_name(joint.name)
            if target is not None and target in node_by_name:
                mapped.append((joint.name, target))
        unmapped = [joint.name for joint in clip.joints if target_name(joint.name) is None]
        if unmapped not in ([], ["jaw"]):
            raise ValueError(f"{clip_name}: unexpected unmapped joints: {unmapped}")
        expected_mapped = 53 if unmapped == ["jaw"] else 54
        if len(mapped) != expected_mapped:
            raise ValueError(f"{clip_name}: expected {expected_mapped} mapped joints, got {len(mapped)}")
        times = [frame * clip.frame_time for frame in range(len(clip.frames))]
        time_accessor = add_floats(document, binary, times, "SCALAR", len(times), minimum=[times[0]], maximum=[times[-1]])
        rotations: dict[str, list[Quat]] = {target: [] for _, target in mapped}
        translations: list[tuple[float, float, float]] = []
        first_root_position = None
        for frame in clip.frames:
            source_global, positions = source_pose(clip, frame)
            desired_global: dict[int, Quat] = {}
            for source, target in mapped:
                index = node_by_name[target]
                desired_global[index] = qmul(source_global[source], rest_global[index])
            for source, target in mapped:
                index = node_by_name[target]
                parent = parents.get(index)
                if parent is None:
                    parent_global = (0.0, 0.0, 0.0, 1.0)
                else:
                    parent_global = desired_global.get(parent, rest_global[parent])
                rotations[target].append(qmul(qinv(parent_global), desired_global[index]))
            root_pos = positions["hips"]
            if first_root_position is None: first_root_position = root_pos
            node_translation = document["nodes"][node_by_name["J_Bip_C_Hips"]].get("translation", [0.0, 0.0, 0.0])
            translations.append((node_translation[0], node_translation[1] + (root_pos[1] - first_root_position[1]) * 0.01, node_translation[2]))
        samplers, channels = [], []
        for _, target in mapped:
            values = [component for quat in rotations[target] for component in quat]
            output = add_floats(document, binary, values, "VEC4", len(times))
            sampler = len(samplers)
            samplers.append({"input": time_accessor, "output": output, "interpolation": "LINEAR"})
            channels.append({"sampler": sampler, "target": {"node": node_by_name[target], "path": "rotation"}})
        translation_values = [component for vector in translations for component in vector]
        output = add_floats(document, binary, translation_values, "VEC3", len(times))
        sampler = len(samplers)
        samplers.append({"input": time_accessor, "output": output, "interpolation": "LINEAR"})
        channels.append({"sampler": sampler, "target": {"node": node_by_name["J_Bip_C_Hips"], "path": "translation"}})
        animations.append({"name": clip_name, "samplers": samplers, "channels": channels})
        print(f"BAKED {clip_name} frames={len(times)} duration={times[-1]:.2f}s channels={len(channels)}")
    document["animations"] = animations
    if original != {key: len(document.get(key, [])) for key in original}:
        raise AssertionError("Existing GLB resource counts changed")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    write_glb(OUTPUT, document, binary)
    print(f"WROTE {OUTPUT} bytes={OUTPUT.stat().st_size} animations={len(animations)}")


if __name__ == "__main__":
    bake()
