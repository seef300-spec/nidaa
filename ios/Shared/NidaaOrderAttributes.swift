import ActivityKit
import Foundation

/// يجب أن تطابق الحقول ما يرسله الخادم في content-state (src/services/notify/index.js)
struct NidaaOrderAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var status: String      // preparing | ready | delivered | cancelled
        var number: Int
        var message: String
        var calledAt: Int       // ثوانٍ منذ 1970، 0 إن لم يُنادَ
    }
    var shopName: String
    var orderURL: String
}
