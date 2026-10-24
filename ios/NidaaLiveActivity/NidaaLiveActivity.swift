import ActivityKit
import WidgetKit
import SwiftUI

@main
struct NidaaLiveActivityBundle: WidgetBundle {
    var body: some Widget { NidaaLiveActivity() } // ملحق App Clip: Live Activity فقط (لا ويدجت أخرى)
}

struct NidaaLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NidaaOrderAttributes.self) { context in
            HStack(spacing: 16) {
                Text("\(context.state.number)").font(.system(size: 44, weight: .bold, design: .rounded))
                VStack(alignment: .leading, spacing: 4) {
                    Text(context.attributes.shopName).font(.caption).foregroundStyle(.secondary)
                    Text(title(context.state)).font(.headline)
                    if !context.state.message.isEmpty { Text(context.state.message).font(.subheadline) }
                }
                Spacer()
                Image(systemName: context.state.status == "ready" ? "bell.badge.fill" : "cup.and.saucer.fill")
                    .font(.title).foregroundStyle(context.state.status == "ready" ? .green : .orange)
            }
            .padding()
            .environment(\.layoutDirection, .rightToLeft)
            .activityBackgroundTint(context.state.status == "ready" ? Color.green.opacity(0.25) : nil)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Text("\(context.state.number)").font(.title.bold()) }
                DynamicIslandExpandedRegion(.trailing) { Image(systemName: context.state.status == "ready" ? "bell.badge.fill" : "hourglass") }
                DynamicIslandExpandedRegion(.bottom) { Text(title(context.state)).font(.headline) }
            } compactLeading: {
                Text("\(context.state.number)").bold()
            } compactTrailing: {
                Image(systemName: context.state.status == "ready" ? "bell.badge.fill" : "hourglass")
            } minimal: {
                Text("\(context.state.number)").bold()
            }
            .widgetURL(URL(string: context.attributes.orderURL))
        }
    }

    func title(_ s: NidaaOrderAttributes.ContentState) -> String {
        switch s.status {
        case "ready": return "طلبك جاهز — تفضل بالاستلام"
        case "delivered": return "تم الاستلام"
        case "cancelled": return "أُلغي الطلب"
        default: return "قيد التجهيز"
        }
    }
}
