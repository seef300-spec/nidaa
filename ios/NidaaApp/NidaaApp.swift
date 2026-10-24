import SwiftUI

/// التطبيق الكامل مطلوب من آبل لاحتواء الـ App Clip. يكفي أن يعرض الطلب من الرابط نفسه.
@main
struct NidaaMainApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Image(systemName: "bell.badge").font(.system(size: 64)).foregroundStyle(.green)
                Text("نداء").font(.largeTitle.bold())
                Text("امسح رمز طلبك في المحل لمتابعته وتلقي النداء عند الجاهزية.").multilineTextAlignment(.center).foregroundStyle(.secondary)
            }
            .padding()
            .environment(\.layoutDirection, .rightToLeft)
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { a in
                if let url = a.webpageURL { UIApplication.shared.open(url) }
            }
        }
    }
}
