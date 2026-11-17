export const modeGroups = {
  longDistance: { label: 'Fernzüge (ICE, IC, EC, Nachtzug)', modes: ['HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL'] },
  regional: { label: 'Regionalzüge (RE, RB)', modes: ['REGIONAL_RAIL', 'REGIONAL_FAST_RAIL'] },
  suburban: { label: 'S-Bahn', modes: ['SUBURBAN', 'REGIONAL_RAIL'] },
  subway: { label: 'U-Bahn', modes: ['SUBWAY'] },
  tram: { label: 'Straßenbahn', modes: ['TRAM'] },
  bus: { label: 'Linienbus', modes: ['BUS'] },
  coach: { label: 'Fernbus', modes: ['COACH'] },
  other: { label: 'Weitere (z. B. Fähre)', modes: ['FERRY', 'AIRPLANE', 'FUNICULAR', 'AERIAL_LIFT', 'OTHER', 'ODM', 'RIDE_SHARING', 'FLEX'] },
};

export const allGroups = Object.keys(modeGroups);
export const ticketGroups = ['regional', 'suburban', 'subway', 'tram', 'bus'];

export function routingModes(groups) {
  return [...new Set(groups.flatMap((group) => modeGroups[group].modes))];
}

function groupForLeg(leg) {
  const line = leg.displayName || leg.routeShortName || '';
  if (leg.mode === 'REGIONAL_RAIL' && /^S\s*\d/i.test(line)) return 'suburban';
  if (leg.mode === 'SUBURBAN') return 'suburban';
  return allGroups.find((group) => modeGroups[group].modes.includes(leg.mode));
}

export function matchesFilters(itinerary, groups, ticket) {
  return itinerary.legs.every((leg) => {
    if (leg.mode === 'WALK') return true;
    const group = groupForLeg(leg);
    if (!groups.includes(group)) return false;
    if (!ticket) return true;
    const service = [leg.agencyName, leg.displayName, leg.routeLongName].filter(Boolean).join(' ');
    if (!leg.agencyName || /Fernverkehr|Flix|touristi|historisch|Museums|\b(?:ICE|IC|EC|EN|RJX?|TGV)\s*\d/i.test(service)) return false;
    const stops = [leg.from, ...(leg.intermediateStops || []), leg.to];
    return stops.every((stop) => /(?:^|_)de:\d{5}:/i.test(stop?.stopId || ''));
  });
}
