import SwiftUI

@main
struct MobileYukiIOSApp: App {
    @StateObject private var client = YukiIOSClient()

    var body: some Scene {
        WindowGroup {
            YukiARContentView()
                .environmentObject(client)
        }
    }
}
