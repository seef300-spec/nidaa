import Foundation
import SwiftUI
import UserNotifications
import ActivityKit

@MainActor
final class OrderModel: ObservableObject {
    enum Phase { case idle, loading, loaded(PublicOrder), invalid, expired, failed }
    @Published var phase: Phase = .idle
    @Published var notificationState: String = "unknown" // ephemeral | authorized | denied | notDetermined
    @Published var liveActivityOn = false

    private var api: NidaaAPI?
    private var streamTask: Task<Void, Never>?
    private var activity: Activity<NidaaOrderAttributes>?
    private var seenCallId: String?

    func open(url: URL) {
        guard let api = NidaaAPI.from(url: url) else { phase = .invalid; return }
        // App Clip قد يُفتح لاحقًا من إشعار بلا رابط — نحفظ آخر رابط
        UserDefaults.standard.set(url.absoluteString, forKey: "nidaa.lastURL")
        self.api = api
        phase = .loading
        Task { await start() }
    }

    func resumeIfNeeded() {
        if api == nil, let s = UserDefaults.standard.string(forKey: "nidaa.lastURL"), let url = URL(string: s) { open(url: url) }
    }

    private func start() async {
        guard let api else { return }
        do {
            let o = try await api.hello()
            apply(o)
            await setupNotifications()
            await startLiveActivity(o)
            listen()
        } catch NidaaAPIError.notFound { phase = .invalid }
        catch NidaaAPIError.expired { phase = .expired }
        catch { phase = .failed }
    }

    func refresh() async {
        guard let api else { return }
        do { apply(try await api.fetch()) }
        catch NidaaAPIError.expired { phase = .expired }
        catch { /* نبقي آخر حالة معروفة */ }
    }

    private func apply(_ o: PublicOrder) {
        phase = .loaded(o)
        if o.order.status == "ready", let call = o.order.lastCall, call.id != seenCallId {
            seenCallId = call.id
            Task { await api?.receipt(callId: call.id) }
        }
        if o.order.status == "delivered" || o.order.status == "cancelled" { endLiveActivity(o) }
    }

    private func listen() {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let api = self?.api else { return }
                do { for try await _ in api.events() { await self?.refresh() } } catch { }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                await self?.refresh()
            }
        }
    }

    // App Clip: إشعارات مؤقتة لمدة 8 ساعات دون سؤال إذا لم يعطّلها العميل من بطاقة App Clip
    private func setupNotifications() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .ephemeral: notificationState = "ephemeral"
        case .authorized, .provisional: notificationState = "authorized"
        case .denied: notificationState = "denied"; return
        default: notificationState = "notDetermined"; return
        }
        ClipDelegate.onToken = { [weak self] token in
            Task { try? await self?.api?.registerAPNs(deviceToken: token, type: "alert") }
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    private func startLiveActivity(_ o: PublicOrder) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled, activity == nil,
              o.order.status == "preparing" || o.order.status == "ready", let api else { return }
        let attrs = NidaaOrderAttributes(shopName: o.shop.name, orderURL: api.orderURL.absoluteString)
        let state = NidaaOrderAttributes.ContentState(status: o.order.status, number: o.order.number,
                                                      message: o.order.status == "ready" ? "طلبك جاهز" : "قيد التجهيز", calledAt: 0)
        do {
            let a = try Activity.request(attributes: attrs, content: .init(state: state, staleDate: Date().addingTimeInterval(8 * 3600)), pushType: .token)
            activity = a
            liveActivityOn = true
            Task {
                for await data in a.pushTokenUpdates {
                    let hex = data.map { String(format: "%02x", $0) }.joined()
                    try? await api.registerAPNs(deviceToken: hex, type: "liveactivity")
                }
            }
        } catch {
            liveActivityOn = false
        }
    }

    private func endLiveActivity(_ o: PublicOrder) {
        guard let a = activity else { return }
        let st = NidaaOrderAttributes.ContentState(status: o.order.status, number: o.order.number,
                                                   message: o.order.status == "delivered" ? "تم الاستلام" : "أُلغي الطلب", calledAt: 0)
        Task { await a.end(.init(state: st, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(120))) }
        activity = nil
        liveActivityOn = false
    }

    func ack() async {
        guard let api else { return }
        if let o = try? await api.ack() { apply(o) }
    }
}
