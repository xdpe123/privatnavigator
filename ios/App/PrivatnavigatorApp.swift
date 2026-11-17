import ActivityKit
import SwiftUI
import UIKit
import WebKit
import WidgetKit

private let site = URL(string: "https://privatnavigator.jrk-healthtrain.workers.dev/")!

@main
struct PrivatnavigatorApp: App {
    @State private var destination = site
    @State private var message: String?

    var body: some Scene {
        WindowGroup {
            NavigatorWebView(destination: destination) { message = $0 }
                .onOpenURL { url in
                    guard url.scheme == "privatnavigator" else { return }
                    let id = url.lastPathComponent
                    var components = URLComponents(url: site, resolvingAgainstBaseURL: false)
                    components?.fragment = url.host == "fahrt" && id.range(of: "^[a-f0-9]{24}$", options: .regularExpression) != nil
                        ? "fahrt-\(id)" : "saved-trips"
                    destination = components?.url ?? site
                }
                .alert("Privatnavigator", isPresented: Binding(
                    get: { message != nil }, set: { if !$0 { message = nil } }
                )) {
                    Button("OK") { message = nil }
                } message: {
                    Text(message ?? "")
                }
        }
    }
}

private struct NavigatorWebView: UIViewRepresentable {
    let destination: URL
    let report: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(report: report) }

    func makeUIView(context: Context) -> WKWebView {
        let settings = WKWebViewConfiguration()
        settings.websiteDataStore = .default()
        settings.userContentController.add(context.coordinator, name: "navigatorTrips")
        let webView = WKWebView(frame: .zero, configuration: settings)
        webView.navigationDelegate = context.coordinator
        return webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.lastDestination != destination else { return }
        context.coordinator.lastDestination = destination
        view.load(URLRequest(url: destination))
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let report: (String) -> Void
        var lastDestination: URL?

        init(report: @escaping (String) -> Void) { self.report = report }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.scheme == "https" else {
                decisionHandler(.cancel)
                return
            }
            if url.host == site.host && url.port == nil {
                decisionHandler(.allow)
            } else {
                if action.navigationType == .linkActivated { UIApplication.shared.open(url) }
                decisionHandler(.cancel)
            }
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "https",
                  message.frameInfo.securityOrigin.host == site.host,
                  let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
            if action == "sync", let trips: [TripSnapshot] = decode(body["trips"]) {
                TripStore.save(trips)
                WidgetCenter.shared.reloadTimelines(ofKind: "NächsteFahrt")
                Task { @MainActor in
                    for activity in Activity<TripActivity>.activities {
                        if let trip = trips.first(where: { $0.id == activity.attributes.id }) {
                            await activity.update(content(trip))
                        } else {
                            await activity.end(nil, dismissalPolicy: .immediate)
                        }
                    }
                }
            } else if action == "activity", let trip: TripSnapshot = decode(body["trip"]) {
                Task { @MainActor in await start(trip) }
            }
        }

        private func decode<T: Decodable>(_ object: Any?) -> T? {
            guard let object, JSONSerialization.isValidJSONObject(object),
                  let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
            return try? JSONDecoder().decode(T.self, from: data)
        }

        private func content(_ trip: TripSnapshot) -> ActivityContent<TripActivity.ContentState> {
            ActivityContent(state: .init(trip: trip), staleDate: trip.ends)
        }

        @MainActor private func start(_ trip: TripSnapshot) async {
            guard ActivityAuthorizationInfo().areActivitiesEnabled else {
                report("Erlaube Live-Aktivitäten in den iPhone-Einstellungen.")
                return
            }
            guard trip.ends > .now else { return }
            do {
                if let activity = Activity<TripActivity>.activities.first(where: { $0.attributes.id == trip.id }) {
                    await activity.update(content(trip))
                    report("Die Live-Aktivität ist bereits eingerichtet.")
                    return
                }
                let start = trip.starts.addingTimeInterval(-3600)
                let attributes = TripActivity(id: trip.id)
                if start <= .now {
                    _ = try Activity.request(attributes: attributes, content: content(trip), pushType: nil)
                    report("Live-Aktivität gestartet.")
                } else if #available(iOS 26.0, *) {
                    let alert = AlertConfiguration(title: "Deine Fahrt", body: "Deine Fahrt beginnt in etwa einer Stunde.", sound: .default)
                    _ = try Activity.request(attributes: attributes, content: content(trip), pushType: nil,
                                             style: .standard, alertConfiguration: alert, start: start)
                    report("Live-Aktivität für eine Stunde vor Abfahrt geplant.")
                } else {
                    report("Auf dieser iOS-Version kannst du die Live-Aktivität innerhalb der letzten Stunde vor Abfahrt starten.")
                }
            } catch {
                report("Die Live-Aktivität konnte nicht eingerichtet werden: \(error.localizedDescription)")
            }
        }
    }
}
