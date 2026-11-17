import ActivityKit
import SwiftUI
import WidgetKit

struct TripEntry: TimelineEntry {
    let date: Date
    let trip: TripSnapshot?
}

struct TripProvider: TimelineProvider {
    func placeholder(in context: Context) -> TripEntry { TripEntry(date: .now, trip: nil) }

    func getSnapshot(in context: Context, completion: @escaping (TripEntry) -> Void) {
        completion(entry(at: .now, trips: TripStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TripEntry>) -> Void) {
        let now = Date.now
        let trips = TripStore.load().filter { $0.ends > now }
        let changes = Set(trips.map(\.ends)).sorted()
        let dates = [now] + changes.map { $0.addingTimeInterval(1) }
        completion(Timeline(entries: dates.map { entry(at: $0, trips: trips) }, policy: .atEnd))
    }

    private func entry(at date: Date, trips: [TripSnapshot]) -> TripEntry {
        TripEntry(date: date, trip: trips.filter { $0.ends > date }.min { $0.starts < $1.starts })
    }
}

private struct TripSummary: View {
    let trip: TripSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(trip.destination).font(.headline).lineLimit(2)
            Text(trip.starts, style: .time).font(.title3.bold()).monospacedDigit()
            Text([trip.line, trip.platform.isEmpty ? "" : "Gleis \(trip.platform)"]
                .filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).lineLimit(1)
            Text(trip.status).font(.caption2).foregroundStyle(.secondary)
        }
    }
}

private struct NextTripWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "NächsteFahrt", provider: TripProvider()) { entry in
            Group {
                if let trip = entry.trip {
                    TripSummary(trip: trip).widgetURL(trip.link)
                } else {
                    Text("Keine bevorstehende Fahrt").widgetURL(URL(string: "privatnavigator://fahrten"))
                }
            }.containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Nächste Fahrt")
        .description("Abfahrt, Ziel und Gleis aus deinen gespeicherten Fahrten.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct TripLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TripActivity.self) { context in
            HStack {
                Image(systemName: "tram.fill")
                    .font(.title2)
                    .foregroundStyle(.red)
                TripSummary(trip: context.state.trip)
                Spacer()
            }
            .padding()
            .widgetURL(context.state.trip.link)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "tram.fill").foregroundStyle(.red) }
                DynamicIslandExpandedRegion(.bottom) { TripSummary(trip: context.state.trip) }
            } compactLeading: {
                Image(systemName: "tram.fill").foregroundStyle(.red)
            } compactTrailing: {
                Text(context.state.trip.starts, style: .time).monospacedDigit()
            } minimal: {
                Image(systemName: "tram.fill")
            }
            .widgetURL(context.state.trip.link)
        }
    }
}

@main
struct ReiseWidgets: WidgetBundle {
    var body: some Widget {
        NextTripWidget()
        TripLiveActivity()
    }
}
