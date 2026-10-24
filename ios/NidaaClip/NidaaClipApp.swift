import SwiftUI
import UserNotifications
import ActivityKit

@main
struct NidaaClipApp: App {
    @UIApplicationDelegateAdaptor(ClipDelegate.self) var delegate
    @StateObject private var model = OrderModel()

    var body: some Scene {
        WindowGroup {
            OrderView(model: model)
                .environment(\.layoutDirection, .rightToLeft)
                .environment(\.locale, Locale(identifier: "ar"))
                // الفتح من رمز QR (الرابط نفسه المطبوع على الشاشة/الإيصال)
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { model.open(url: url) }
                }
                .onOpenURL { url in model.open(url: url) }
        }
    }
}

/// تسجيل الجهاز في APNs وتمرير الرمز للخادم
final class ClipDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static var onToken: ((String) -> Void)?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Self.onToken?(hex)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("APNs registration failed: \(error)")
    }
    // إظهار النداء حتى لو كان الـ App Clip مفتوحًا
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
