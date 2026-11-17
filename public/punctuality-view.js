export function setupPunctuality(getJson) {
  const get = (id) => document.getElementById(id);
  const dialog = get('punctuality-dialog');
  let routes = [];
  let request = 0;
  const make = (tag, text, classes) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (classes) node.className = classes;
    return node;
  };
  const percent = (count, total) => total ? Math.round(count / total * 100) + ' %' : '–';
  const minutes = (value) => value === null ? '–' : value.toLocaleString('de-DE') + ' Min.';
  function chart(title, rows, value, total) {
    const section = make('section', undefined, 'analysis-section');
    section.append(make('h2', title));
    for (const row of rows) {
      const count = value(row);
      const denominator = total(row);
      const item = make('div', undefined, 'analysis-bar-row');
      const label = make('div', undefined, 'analysis-bar-label');
      label.append(make('span', row.label), make('span', denominator ? percent(count, denominator) + ' · ' + count + '/' + denominator : 'Keine bestätigte Ankunft'));
      const track = make('div', undefined, 'analysis-track');
      const bar = make('span');
      bar.style.width = denominator ? count / denominator * 100 + '%' : '0%';
      track.append(bar);
      item.append(label, track);
      section.append(item);
    }
    return section;
  }
  function render() {
    const content = get('analysis-content');
    content.replaceChildren();
    const route = routes[Number(get('analysis-route').value)];
    const data = route?.details;
    if (!data) {
      get('analysis-status').textContent = 'Für diesen Zeitraum sind noch keine Fahrten erfasst.';
      return;
    }
    get('analysis-status').textContent = data.total + ' erfasste Fahrten · ' + data.observed + ' bestätigte Ankünfte';
    const grid = make('div', undefined, 'analysis-metrics');
    for (const [label, value] of [
      ['Pünktliche Ankünfte', percent(data.onTime, data.observed)],
      ['Ausfallquote', percent(data.cancelled, data.total)],
      ['Ø Ankunftsverspätung', minutes(data.average)],
      ['Median', minutes(data.median)],
      ['90. Perzentil', minutes(data.p90)],
      ['Prognosen / unbekannt', data.forecast + ' / ' + data.unknown],
    ]) {
      const item = make('div', undefined, 'panel analysis-metric');
      item.append(make('strong', value), make('span', label, 'muted'));
      grid.append(item);
    }
    content.append(grid, make('p', 'Das 90. Perzentil zeigt die Verspätung, die bei 90 % der bestätigten Ankünfte höchstens erreicht wurde.', 'muted'));
    content.append(chart('Ankunftsverspätungen', data.distribution, row => row.count, () => data.observed));
    const labels = { Mon: 'Montag', Tue: 'Dienstag', Wed: 'Mittwoch', Thu: 'Donnerstag', Fri: 'Freitag', Sat: 'Samstag', Sun: 'Sonntag' };
    const weekdays = Object.entries(labels).map(([key, label]) => ({ ...data.weekdays.find(row => row.label === key), label }));
    content.append(chart('Pünktlichkeit nach Wochentag', weekdays, row => row.onTime || 0, row => row.observed || 0));
    content.append(chart('Pünktlichkeit nach Abfahrtszeit', data.hours.map(row => ({ ...row, label: row.label + '–' + String(Number(row.label) + 4).padStart(2, '0') + ' Uhr' })), row => row.onTime, row => row.observed));
    content.append(chart('Pünktlichkeit im Zeitverlauf', data.trend, row => row.onTime, row => row.observed));
    content.append(chart('Pünktlichkeit nach Linienfolge', data.lines, row => row.onTime, row => row.observed));
    const history = make('section', undefined, 'analysis-section');
    history.append(make('h2', 'Erfasste Fahrten'));
    const list = make('ol', undefined, 'analysis-history');
    const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' });
    const kinds = { observed: 'Bestätigte Ankunft', cancelled: 'Ausfall', forecast: 'Letzte Prognose', unknown: 'Ohne Ankunftsdaten' };
    for (const trip of data.recent) {
      const item = make('li');
      item.append(make('strong', date.format(trip.departure) + ' · ' + trip.lines),
        make('span', kinds[trip.kind] + (trip.delay === null ? '' : ' · ' + minutes(Math.round(trip.delay / 6) / 10)), trip.kind === 'cancelled' ? 'problem' : 'muted'));
      list.append(item);
    }
    history.append(list);
    content.append(history);
  }
  async function load() {
    const id = ++request;
    get('analysis-status').textContent = 'Streckenanalyse wird geladen …';
    try {
      const data = await getJson('/api/punctuality', { days: get('analysis-period').value });
      if (id !== request) return;
      const previous = routes[Number(get('analysis-route').value)];
      routes = data.routes;
      get('analysis-route').replaceChildren(...routes.map((route, index) => {
        const option = make('option', route.origin + ' → ' + route.destination);
        option.value = index;
        option.selected = route.origin === previous?.origin && route.destination === previous?.destination;
        return option;
      }));
      render();
    } catch (error) {
      if (id === request) get('analysis-status').textContent = error.message;
    }
  }
  get('open-punctuality').onclick = () => { dialog.showModal(); void load(); };
  get('close-punctuality').onclick = () => dialog.close();
  get('analysis-period').onchange = load;
  get('analysis-route').onchange = render;
}
