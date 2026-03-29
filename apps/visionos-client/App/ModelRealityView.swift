import RealityKit
import SwiftUI
import UIKit

struct ModelRealityView: View {
    let model: BundledModel

    var body: some View {
        Group {
            if let previewImageName = model.previewImageName {
                if let image = bundledPreviewImage(named: previewImageName) {
                    ZStack {
                        Color.clear
                        ZStack {
                            Color.black.opacity(0.92)
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFit()
                                .padding(20)
                        }
                        .frame(width: 320, height: 320)
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(24)
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "photo")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text("Preview image missing for \(model.displayName)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                Model3D(named: model.previewAssetName, bundle: .main) { resolvedModel in
                    resolvedModel
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .rotation3DEffect(.degrees(model.previewPitchDegrees), axis: (x: 1, y: 0, z: 0))
                        .scaleEffect(model.previewScale)
                        .offset(y: model.previewVerticalOffset)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(24)
                } placeholder: {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Loading \(model.displayName)…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .overlay(alignment: .topLeading) {
            Text(model.previewImageName == nil ? "Previewing bundled avatar asset" : "Preview image from source rig")
                .font(.caption)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.thinMaterial, in: Capsule())
                .padding(16)
        }
        .padding(24)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24))
    }

    private func bundledPreviewImage(named name: String) -> UIImage? {
        let url =
            Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "Previews")
            ?? Bundle.main.url(forResource: name, withExtension: "png")

        guard let url else {
            return nil
        }
        return UIImage(contentsOfFile: url.path)
    }
}
