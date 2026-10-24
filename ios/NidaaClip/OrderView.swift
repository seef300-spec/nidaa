import SwiftUI

struct OrderView: View {
    @ObservedObject var model: OrderModel
    private let brand = Color(red: 0.055, green: 0.231, blue: 0.161)

    var body: some View {
        Group {
            switch model.phase {
            case .idle: message("امسح رمز الطلب", "افتح الكاميرا ووجهها نحو الرمز على شاشة المحل.")
            case .loading: ProgressView("جارٍ تحميل طلبك…")
            case .invalid: message("الرابط غير صالح", "تأكد من مسح الرمز الصحيح أو اسأل الموظف.")
            case .expired: message("انتهت صلاحية هذا الرابط", "إن كان لديك طلب جديد فامسح رمزه.")
            case .failed: VStack { message("تعذّر تحميل طلبك", "تحقق من الإنترنت."); Button("إعادة المحاولة") { Task { await model.refresh() } } }
            case .loaded(let o): loaded(o)
            }
        }
        .padding()
        .onAppear { model.resumeIfNeeded() }
    }

    func message(_ t: String, _ s: String) -> some View {
        VStack(spacing: 12) { Text(t).font(.title2.bold()); Text(s).foregroundStyle(.secondary).multilineTextAlignment(.center) }
    }

    @ViewBuilder func loaded(_ o: PublicOrder) -> some View {
        let ready = o.order.status == "ready"
        ScrollView {
            VStack(spacing: 16) {
                Text(o.shop.name).font(.headline)
                VStack(spacing: 8) {
                    Text("رقم طلبك").foregroundStyle(ready ? .white.opacity(0.9) : .secondary)
                    Text("\(o.order.number)").font(.system(size: 96, weight: .bold, design: .rounded)).foregroundStyle(ready ? .white : brand)
                    Text(statusText(o)).font(.title2.bold()).foregroundStyle(ready ? .white : .primary)
                    if ready && !o.shop.pickup.isEmpty { Text("تفضل بالاستلام — \(o.shop.pickup)").foregroundStyle(.white) }
                    if ready {
                        Button("أنا في الطريق") { Task { await model.ack() } }
                            .buttonStyle(.borderedProminent).tint(.white).foregroundStyle(brand).controlSize(.large)
                    }
                }
                .frame(maxWidth: .infinity).padding(24)
                .background(ready ? Color.green.opacity(0.85) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 24))

                if o.order.status == "preparing" { notifyCard }
            }
        }
    }

    var notifyCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch model.notificationState {
            case "ephemeral", "authorized":
                Label("التنبيه مفعّل على هذا الجوال", systemImage: "bell.badge.fill").font(.headline).foregroundStyle(.green)
                Text(model.liveActivityOn ? "ستظهر حالة طلبك على شاشة القفل." : "سيصلك إشعار عند جاهزية طلبك.").foregroundStyle(.secondary)
            case "denied":
                Label("التنبيهات معطّلة", systemImage: "bell.slash").font(.headline)
                Text("أبقِ هذه الشاشة مفتوحة، أو فعّل الإشعارات من الإعدادات.").foregroundStyle(.secondary)
            default:
                Text("أبقِ هذه الشاشة مفتوحة وسنُحدّث حالة طلبك.").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    func statusText(_ o: PublicOrder) -> String {
        switch o.order.status {
        case "preparing": return "قيد التجهيز"
        case "ready": return "طلبك جاهز!"
        case "delivered": return "تم الاستلام"
        default: return o.order.cancelReason == "expired" ? "انتهت مدة الطلب" : "أُلغي الطلب"
        }
    }
}
