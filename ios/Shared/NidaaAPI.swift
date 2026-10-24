import Foundation

/// عميل الواجهة العامة لصفحة العميل — نفس الصلاحية التي يمنحها رابط QR فقط.
struct PublicOrder: Decodable {
    struct Shop: Decodable { let name: String; let branchName: String; let pickup: String; let logoUrl: String? }
    struct Order: Decodable {
        struct Call: Decodable { let id: String; let seq: Int; let at: String }
        let number: Int
        let status: String
        let cancelReason: String?
        let isToday: Bool
        let lastCall: Call?
        let customerAckAt: String?
    }
    let shop: Shop
    let order: Order
}

enum NidaaAPIError: Error { case invalidURL, notFound, expired, server(Int), network }

struct NidaaAPI {
    let base: URL
    let token: String

    /// يستخرج الرمز من رابط مثل https://domain/o/<token>
    static func from(url: URL) -> NidaaAPI? {
        let parts = url.pathComponents
        guard parts.count >= 3, parts[1] == "o", parts[2].count == 24,
              let scheme = url.scheme, let host = url.host else { return nil }
        var comps = URLComponents(); comps.scheme = scheme; comps.host = host; comps.port = url.port
        guard let base = comps.url else { return nil }
        return NidaaAPI(base: base, token: parts[2])
    }

    var orderURL: URL { base.appendingPathComponent("o/\(token)") }

    static var clientId: String {
        let key = "nidaa.clientId"
        if let v = UserDefaults.standard.string(forKey: key) { return v }
        let v = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        UserDefaults.standard.set(v, forKey: key)
        return v
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        var req = URLRequest(url: base.appendingPathComponent("api/public/o/\(token)\(path)"))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" { req.setValue("1", forHTTPHeaderField: "X-Nidaa") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data, resp: URLResponse
        do { (data, resp) = try await URLSession.shared.data(for: req) } catch { throw NidaaAPIError.network }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 404 { throw NidaaAPIError.notFound }
        if code == 410 { throw NidaaAPIError.expired }
        guard (200..<300).contains(code) else { throw NidaaAPIError.server(code) }
        return data
    }

    func hello() async throws -> PublicOrder {
        let d = try await request("/hello", method: "POST", body: [
            "clientId": Self.clientId, "platform": "ios", "standalone": true, "capability": "apns", "permission": "ephemeral",
        ])
        return try JSONDecoder().decode(PublicOrder.self, from: d)
    }

    func fetch() async throws -> PublicOrder {
        try JSONDecoder().decode(PublicOrder.self, from: try await request(""))
    }

    func registerAPNs(deviceToken: String, type: String) async throws {
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        _ = try await request("/apns", method: "POST", body: [
            "clientId": Self.clientId, "platform": "ios", "type": type, "deviceToken": deviceToken, "environment": env,
        ])
    }

    func ack() async throws -> PublicOrder {
        try JSONDecoder().decode(PublicOrder.self, from: try await request("/ack", method: "POST", body: [:]))
    }

    func receipt(callId: String) async {
        _ = try? await request("/receipt", method: "POST", body: ["channel": "page", "callId": callId, "clientId": Self.clientId])
    }

    /// بث لحظي (SSE): كل رسالة تعني «أعد الجلب»
    func events() -> AsyncThrowingStream<Void, Error> {
        AsyncThrowingStream { cont in
            let task = Task {
                var req = URLRequest(url: base.appendingPathComponent("api/public/o/\(token)/stream"))
                req.timeoutInterval = 90
                let (bytes, _) = try await URLSession.shared.bytes(for: req)
                for try await line in bytes.lines where line.hasPrefix("event: status") {
                    cont.yield(())
                }
                cont.finish()
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }
}
