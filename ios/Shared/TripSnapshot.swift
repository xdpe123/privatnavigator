import ActivityKit
import Foundation

struct TripSnapshot: Codable, Hashable {
    let id: String
    let origin: String
    let destination: String
    let departure: Double
    let arrival: Double
    let line: String
    let platform: String
    let status: String

    var starts: Date { Date(timeIntervalSince1970: departure) }
    var ends: Date { Date(timeIntervalSince1970: arrival) }
    var link: URL { URL(string: "privatnavigator://fahrt/\(id)") ?? URL(string: "privatnavigator://fahrten")! }
}

struct TripActivity: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let trip: TripSnapshot
    }
    let id: String
}

enum TripStore {
    static let group = "group.org.privatnavigator.shared"
    private static let key = "trips"

    static func load() -> [TripSnapshot] {
        guard let data = UserDefaults(suiteName: group)?.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([TripSnapshot].self, from: data)) ?? []
    }

    static func save(_ trips: [TripSnapshot]) {
        guard let data = try? JSONEncoder().encode(trips) else { return }
        UserDefaults(suiteName: group)?.set(data, forKey: key)
    }
}
