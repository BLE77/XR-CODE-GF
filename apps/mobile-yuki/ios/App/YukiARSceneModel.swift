import Foundation

@MainActor
final class YukiARSceneModel: ObservableObject {
    @Published var placementRequestID = 0
    @Published var placementStatus = "Not placed"

    func requestPlaceInFront() {
        placementRequestID += 1
    }
}
