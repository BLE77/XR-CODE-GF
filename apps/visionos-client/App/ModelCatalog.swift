import Foundation

struct BundledModel: Identifiable, Hashable {
    let name: String
    let displayName: String
    let idleAssetName: String
    let walkAssetName: String?
    let walkPoseAssetNames: [String]
    let embeddedAnimationNames: [String]
    let rigSummary: String
    let facialRigSummary: String
    let immersiveTargetHeight: Double
    let immersiveDefaultScale: Double
    let immersiveFloorClearance: Double
    let immersiveLift: Double
    let previewImageName: String?
    let previewAssetName: String
    let previewPitchDegrees: Double
    let previewScale: Double
    let previewVerticalOffset: Double

    var id: String { name }

    var animationSummary: String {
        embeddedAnimationNames.isEmpty ? "No embedded clips detected" : embeddedAnimationNames.joined(separator: ", ")
    }

    var animationCountSummary: String {
        switch embeddedAnimationNames.count {
        case 0:
            return "No embedded animation clips"
        case 1:
            return "1 embedded animation clip"
        default:
            return "\(embeddedAnimationNames.count) embedded animation clips"
        }
    }
}

enum ModelCatalog {
    static let bundled: [BundledModel] = [
        BundledModel(
            name: "vamp",
            displayName: "Vamp",
            idleAssetName: "vamp_idle",
            walkAssetName: "vamp_walk",
            walkPoseAssetNames: ["vamp_step_a", "vamp_step_b", "vamp_step_c", "vamp_step_d"],
            embeddedAnimationNames: ["Action_002"],
            rigSummary: "Vampire Girl using the fixed-texture USDZ package as the default live character in the app. The immersive avatar now uses the bundled retargeted locomotion set when wandering so her body and clothing stop looking frozen while moving.",
            facialRigSummary: "Textured body-rigged humanoid with no detected face blendshapes or dedicated mouth/jaw bones in the packaged USDZ. Eyes, face, dress, corset, and boots come from the packed texture set.",
            immersiveTargetHeight: 1.18,
            immersiveDefaultScale: 1.5,
            immersiveFloorClearance: 0.02,
            immersiveLift: 0.38,
            previewImageName: nil,
            previewAssetName: "vamp_idle",
            previewPitchDegrees: 0,
            previewScale: 0.92,
            previewVerticalOffset: -10
        ),
        BundledModel(
            name: "megumin",
            displayName: "Megumin",
            idleAssetName: "megumin",
            walkAssetName: nil,
            walkPoseAssetNames: [],
            embeddedAnimationNames: ["CodexIdle"],
            rigSummary: "Exported from the source Blender rig. Includes a humanoid skeleton plus a baked CodexIdle animation clip generated during export.",
            facialRigSummary: "Full blendshape facial rig detected. This export carries the ARKit-style 52 face shapes plus three extra custom shapes: STAFF, EYEPATCH, and SMUG.",
            immersiveTargetHeight: 1.1,
            immersiveDefaultScale: 1.15,
            immersiveFloorClearance: 0.16,
            immersiveLift: 0.34,
            previewImageName: "megumin_preview",
            previewAssetName: "megumin",
            previewPitchDegrees: 0,
            previewScale: 0.32,
            previewVerticalOffset: -90
        ),
        BundledModel(
            name: "anime_girl",
            displayName: "Anime Girl",
            idleAssetName: "anime_girl",
            walkAssetName: nil,
            walkPoseAssetNames: [],
            embeddedAnimationNames: [],
            rigSummary: "Bundled preview avatar. It loads cleanly, but we have not inspected USD rig metadata for this file yet.",
            facialRigSummary: "No face rig metadata has been documented in the app for this model yet.",
            immersiveTargetHeight: 0.42,
            immersiveDefaultScale: 0.75,
            immersiveFloorClearance: 0.05,
            immersiveLift: 0.03,
            previewImageName: nil,
            previewAssetName: "anime_girl",
            previewPitchDegrees: 0,
            previewScale: 1,
            previewVerticalOffset: 0
        ),
        BundledModel(
            name: "indian_office_woman",
            displayName: "Indian Office Woman",
            idleAssetName: "indian_office_woman",
            walkAssetName: nil,
            walkPoseAssetNames: [],
            embeddedAnimationNames: ["mixamo_com"],
            rigSummary: "Skinned humanoid with one embedded skeletal clip from a Mixamo-style export.",
            facialRigSummary: "No USD blendshapes or viseme channels detected. It does include separate eyeball, cornea, and teeth meshes, so there is face-related geometry but not an obvious facial expression rig.",
            immersiveTargetHeight: 0.48,
            immersiveDefaultScale: 0.7,
            immersiveFloorClearance: 0.05,
            immersiveLift: 0.03,
            previewImageName: nil,
            previewAssetName: "indian_office_woman",
            previewPitchDegrees: 0,
            previewScale: 1,
            previewVerticalOffset: 0
        ),
        BundledModel(
            name: "sasha_cyberpunk_edgerunners",
            displayName: "Sasha",
            idleAssetName: "sasha_cyberpunk_edgerunners",
            walkAssetName: nil,
            walkPoseAssetNames: [],
            embeddedAnimationNames: ["IdlePose"],
            rigSummary: "Skinned character with one embedded idle-style skeletal animation clip.",
            facialRigSummary: "No USD blendshapes or viseme channels detected. It does include separate face, mouth, eye, and iris meshes, which is useful, but it does not read like a full facial blendshape rig.",
            immersiveTargetHeight: 0.46,
            immersiveDefaultScale: 0.72,
            immersiveFloorClearance: 0.05,
            immersiveLift: 0.03,
            previewImageName: nil,
            previewAssetName: "sasha_cyberpunk_edgerunners",
            previewPitchDegrees: 0,
            previewScale: 1,
            previewVerticalOffset: 0
        ),
        BundledModel(
            name: "mittelt_anime_girl",
            displayName: "Mittelt",
            idleAssetName: "mittelt_anime_girl",
            walkAssetName: nil,
            walkPoseAssetNames: [],
            embeddedAnimationNames: ["Mittelt_T_016"],
            rigSummary: "Skinned character with one embedded skeletal clip and a larger joint hierarchy than the other two imports.",
            facialRigSummary: "No USD blendshapes or viseme channels detected. This looks more like a standard skinned character rig with a separate head mesh than a dedicated face rig.",
            immersiveTargetHeight: 0.5,
            immersiveDefaultScale: 0.72,
            immersiveFloorClearance: 0.05,
            immersiveLift: 0.03,
            previewImageName: nil,
            previewAssetName: "mittelt_anime_girl",
            previewPitchDegrees: 0,
            previewScale: 1,
            previewVerticalOffset: 0
        ),
    ]

    static func model(named name: String) -> BundledModel {
        bundled.first(where: { $0.name == name }) ?? bundled[0]
    }
}
