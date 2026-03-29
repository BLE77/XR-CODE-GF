import Foundation
import RealityKit

struct SpeechBlendShapeComponent: Component {
    var baseWeights: BlendShapeWeights
    var weightNames: [String]
}

struct MotionVariantStateComponent: Component {
    var activeVariantName: String
}

enum AvatarEntityFactory {
    static let previewBaseHeight: Float = 0.75
    private static var immersiveAvatarCache: [String: Entity] = [:]
    private static var immersiveMotionVariantCache: [String: [String: Entity]] = [:]
    private static var immersiveMotionVariantTasks: [String: Task<Void, Never>] = [:]
    private static var pendingMotionVariantRoots: [String: [Entity]] = [:]

    static func makeImmersiveAvatar(named modelName: String) -> Entity {
        let model = ModelCatalog.model(named: modelName)
        let avatarTemplate: Entity
        if let cached = immersiveAvatarCache[modelName] {
            avatarTemplate = cached
        } else {
            let avatar = makeAvatarVariants(
                for: model,
                targetHeight: Float(model.immersiveTargetHeight),
                floorClearance: Float(model.immersiveFloorClearance),
                includeMotionVariants: false
            )
            immersiveAvatarCache[modelName] = avatar
            avatarTemplate = avatar
        }

        let clone = avatarTemplate.clone(recursive: true)
        attachCachedMotionVariantsIfNeeded(to: clone, for: model)
        scheduleMotionVariantPreloadIfNeeded(for: model, targetRoot: clone)
        return clone
    }

    static func makePreviewAvatar(named modelName: String) -> Entity {
        let root = Entity()
        root.position = [0, -0.22, -1.15]
        let model = ModelCatalog.model(named: modelName)
        root.addChild(
            makeAssetAvatar(
                assetName: model.previewAssetName,
                targetHeight: previewBaseHeight,
                floorClearance: 0
            )
        )
        return root
    }

    static func updateMotionVariant(on root: Entity, isMoving: Bool, motionPhase: Int = 0) {
        let targetVariantName: String
        if isMoving {
            if root.findEntity(named: "assistant-avatar-walk") != nil {
                targetVariantName = "assistant-avatar-walk"
            } else {
                let walkPoseEntities = root.children.filter { $0.name.hasPrefix("assistant-avatar-walk-pose-") }
                if !walkPoseEntities.isEmpty {
                    let poseIndex = motionPhase % walkPoseEntities.count
                    targetVariantName = "assistant-avatar-walk-pose-\(poseIndex)"
                } else {
                    targetVariantName = "assistant-avatar-idle"
                }
            }
        } else {
            targetVariantName = "assistant-avatar-idle"
        }

        let currentVariantName = root.components[MotionVariantStateComponent.self]?.activeVariantName
        guard currentVariantName != targetVariantName else {
            return
        }

        root.findEntity(named: "assistant-avatar-idle")?.isEnabled = targetVariantName == "assistant-avatar-idle"
        root.findEntity(named: "assistant-avatar-walk")?.isEnabled = targetVariantName == "assistant-avatar-walk"
        for child in root.children where child.name.hasPrefix("assistant-avatar-walk-pose-") {
            child.isEnabled = child.name == targetVariantName
        }

        if let targetVariant = root.findEntity(named: targetVariantName) {
            playEmbeddedAnimationIfAvailable(in: targetVariant)
        }

        root.components.set(MotionVariantStateComponent(activeVariantName: targetVariantName))
    }

    private static func makeAvatarVariants(
        for model: BundledModel,
        targetHeight: Float,
        floorClearance: Float,
        includeMotionVariants: Bool = true
    ) -> Entity {
        let root = Entity()
        let idleAvatar = makeAssetAvatar(
            assetName: model.idleAssetName,
            targetHeight: targetHeight,
            floorClearance: floorClearance
        )
        idleAvatar.name = "assistant-avatar-idle"
        root.addChild(idleAvatar)

        if includeMotionVariants {
            attachMotionVariants(
                loadMotionVariantTemplates(for: model, targetHeight: targetHeight, floorClearance: floorClearance),
                to: root
            )
        }

        root.components.set(MotionVariantStateComponent(activeVariantName: "assistant-avatar-idle"))

        return root
    }

    private static func loadMotionVariantTemplates(
        for model: BundledModel,
        targetHeight: Float,
        floorClearance: Float
    ) -> [String: Entity] {
        var variants: [String: Entity] = [:]

        if let walkAssetName = model.walkAssetName {
            let walkAvatar = makeAssetAvatar(
                assetName: walkAssetName,
                targetHeight: targetHeight,
                floorClearance: floorClearance
            )
            walkAvatar.name = "assistant-avatar-walk"
            walkAvatar.isEnabled = false
            variants[walkAvatar.name] = walkAvatar
        }

        for (index, walkPoseAssetName) in model.walkPoseAssetNames.enumerated() {
            let walkPoseAvatar = makeAssetAvatar(
                assetName: walkPoseAssetName,
                targetHeight: targetHeight,
                floorClearance: floorClearance
            )
            walkPoseAvatar.name = "assistant-avatar-walk-pose-\(index)"
            walkPoseAvatar.isEnabled = false
            variants[walkPoseAvatar.name] = walkPoseAvatar
        }

        return variants
    }

    private static func attachCachedMotionVariantsIfNeeded(to root: Entity, for model: BundledModel) {
        guard let cachedVariants = immersiveMotionVariantCache[model.name], !cachedVariants.isEmpty else {
            return
        }
        attachMotionVariants(cachedVariants, to: root)
    }

    private static func attachMotionVariants(_ variants: [String: Entity], to root: Entity) {
        for (name, variant) in variants {
            guard root.findEntity(named: name) == nil else {
                continue
            }
            let clone = variant.clone(recursive: true)
            clone.name = name
            clone.isEnabled = false
            root.addChild(clone)
        }
    }

    private static func scheduleMotionVariantPreloadIfNeeded(for model: BundledModel, targetRoot: Entity) {
        let variantNamesNeeded = (model.walkAssetName != nil) || !model.walkPoseAssetNames.isEmpty
        guard variantNamesNeeded else {
            return
        }
        guard immersiveMotionVariantCache[model.name] == nil else {
            return
        }

        pendingMotionVariantRoots[model.name, default: []].append(targetRoot)
        guard immersiveMotionVariantTasks[model.name] == nil else {
            return
        }

        let targetHeight = Float(model.immersiveTargetHeight)
        let floorClearance = Float(model.immersiveFloorClearance)
        immersiveMotionVariantTasks[model.name] = Task.detached(priority: .utility) {
            let variants = loadMotionVariantTemplates(
                for: model,
                targetHeight: targetHeight,
                floorClearance: floorClearance
            )
            await MainActor.run {
                immersiveMotionVariantCache[model.name] = variants
                if let template = immersiveAvatarCache[model.name] {
                    attachMotionVariants(variants, to: template)
                }
                for root in pendingMotionVariantRoots[model.name] ?? [] {
                    attachMotionVariants(variants, to: root)
                }
                pendingMotionVariantRoots[model.name] = []
                immersiveMotionVariantTasks[model.name] = nil
            }
        }
    }

    private static func makeAssetAvatar(assetName: String, targetHeight: Float, floorClearance: Float) -> Entity {
        guard let avatar = try? Entity.load(named: assetName, in: .main) else {
            return fallbackAvatar(height: targetHeight)
        }

        stripImportedLighting(from: avatar)

        var bounds = avatar.visualBounds(recursive: true, relativeTo: nil)
        if bounds.extents.z > bounds.extents.y * 1.2 {
            avatar.orientation = simd_quatf(angle: -.pi / 2, axis: [1, 0, 0])
            bounds = avatar.visualBounds(recursive: true, relativeTo: nil)
        }

        let height = max(bounds.extents.y, 0.001)
        let normalizedScale = targetHeight / height

        avatar.scale = SIMD3<Float>(repeating: normalizedScale)
        avatar.position = SIMD3<Float>(
            -bounds.center.x * normalizedScale,
            (-bounds.min.y * normalizedScale) + floorClearance,
            -bounds.center.z * normalizedScale
        )
        installBlendShapeDriver(in: avatar)
        playEmbeddedAnimationIfAvailable(in: avatar)

        let root = Entity()
        root.addChild(avatar)
        return root
    }

    private static func stripImportedLighting(from entity: Entity) {
        entity.components[ImageBasedLightComponent.self] = nil
        entity.components[ImageBasedLightReceiverComponent.self] = nil
        entity.components[DirectionalLightComponent.self] = nil
        entity.components[PointLightComponent.self] = nil
        entity.components[SpotLightComponent.self] = nil

        for child in Array(entity.children) {
            if isImportedLightEntity(child) {
                child.removeFromParent()
            } else {
                stripImportedLighting(from: child)
            }
        }
    }

    private static func isImportedLightEntity(_ entity: Entity) -> Bool {
        entity is DirectionalLight
            || entity is PointLight
            || entity is SpotLight
            || entity.components[ImageBasedLightComponent.self] != nil
            || entity.components[DirectionalLightComponent.self] != nil
            || entity.components[PointLightComponent.self] != nil
            || entity.components[SpotLightComponent.self] != nil
    }

    private static func fallbackAvatar(height: Float) -> Entity {
        let fallback = ModelEntity(
            mesh: .generateBox(size: [height * 0.3, height, height * 0.3]),
            materials: [SimpleMaterial()]
        )
        fallback.position = [0, height / 2, 0]

        let root = Entity()
        root.addChild(fallback)
        return root
    }

    static func applyFacialAnimation(to entity: Entity, isSpeaking: Bool, speechPhase: Float, idlePhase: Float) {
        guard
            var blendComponent = entity.components[BlendShapeWeightsComponent.self],
            let speechComponent = entity.components[SpeechBlendShapeComponent.self],
            var weightsData = blendComponent.weightSet.default
        else {
            return
        }

        var weights = speechComponent.baseWeights

        func set(_ name: String, _ value: Float) {
            guard let index = speechComponent.weightNames.firstIndex(of: name), index < weights.endIndex else {
                return
            }
            weights[index] = value
        }

        let blinkAmount = blinkPulse(phase: idlePhase)
        set("eyeBlinkLeft", blinkAmount)
        set("eyeBlinkRight", blinkAmount)

        if isSpeaking {
            let openness = min(0.72, 0.18 + (abs(sinf(speechPhase)) * 0.54))
            set("jawOpen", openness)
            set("mouthClose", max(0, 0.16 - (openness * 0.14)))
            set("mouthFunnel", min(0.28, openness * 0.32))
            set("mouthSmileLeft", 0.05)
            set("mouthSmileRight", 0.05)
            set("SMUG", 0.04)
        } else {
            let restingMouth = max(0, sinf(idlePhase * 0.55)) * 0.03
            set("jawOpen", restingMouth)
            set("mouthClose", 0)
            set("mouthFunnel", 0)
            set("mouthSmileLeft", 0.015)
            set("mouthSmileRight", 0.015)
            set("SMUG", 0.02)
        }

        weightsData.weights = weights
        blendComponent.weightSet.default = weightsData
        entity.components[BlendShapeWeightsComponent.self] = blendComponent
    }

    private static func installBlendShapeDriver(in avatar: Entity) {
        guard
            let blendEntity = firstBlendShapeEntity(in: avatar),
            let blendComponent = blendEntity.components[BlendShapeWeightsComponent.self],
            let weightsData = blendComponent.weightSet.default
        else {
            return
        }

        blendEntity.name = "assistant-blendshape-driver"
        blendEntity.components.set(
            SpeechBlendShapeComponent(
                baseWeights: weightsData.weights,
                weightNames: weightsData.weightNames
            )
        )
    }

    private static func firstBlendShapeEntity(in entity: Entity) -> Entity? {
        if entity.components.has(BlendShapeWeightsComponent.self) {
            return entity
        }

        for child in entity.children {
            if let found = firstBlendShapeEntity(in: child) {
                return found
            }
        }

        return nil
    }

    private static func playEmbeddedAnimationIfAvailable(in entity: Entity) {
        if let animation = preferredAnimation(in: entity) {
            entity.playAnimation(animation.repeat(), transitionDuration: 0.25, startsPaused: false)
        }

        for child in entity.children {
            playEmbeddedAnimationIfAvailable(in: child)
        }
    }

    private static func preferredAnimation(in entity: Entity) -> AnimationResource? {
        entity.availableAnimations.max { lhs, rhs in
            animationPriority(lhs) < animationPriority(rhs)
        }
    }

    private static func animationPriority(_ animation: AnimationResource) -> Int {
        let name = (animation.name ?? "").lowercased()
        var score = 0

        if !name.isEmpty {
            score += 20
        }
        if name.contains("idle") {
            score += 100
        }
        if name.contains("codex") {
            score += 40
        }
        if name.contains("default subtree") || name.contains("default scene") || name.contains("global scene") {
            score -= 60
        }

        return score
    }

    private static func blinkPulse(phase: Float) -> Float {
        let cycle = phase.truncatingRemainder(dividingBy: 14)
        let blinkStart: Float = 11.8
        let blinkDuration: Float = 0.9
        let offset = cycle - blinkStart

        guard offset >= 0, offset <= blinkDuration else {
            return 0
        }

        let midpoint = blinkDuration / 2
        if offset <= midpoint {
            return min(1, offset / midpoint)
        }

        return min(1, (blinkDuration - offset) / midpoint)
    }
}
