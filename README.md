# Privatnavigator 0.3

Mobiler Verbindungsplaner mit echten Fahrplandaten. Bei der Abfahrtssuche steht die früheste Ankunft oben. Bei der Ankunftssuche steht die späteste passende Abfahrt oben. Bei gleicher Zeit zählen weniger Umstiege und dann die kürzere Reisedauer. Verbindungen zeigen Fahrtabschnitte, Zwischenhalte, Fahrtmeldungen und verfügbare Echtzeitinformationen. Favoriten für Orte und Strecken sowie gespeicherte Einzelverbindungen liegen im jeweiligen Browser. Auf HTTPS kann „Meinen Standort nutzen“ bei Start oder Ziel gewählt werden. Die App fragt den Standort beim Anwählen und bei einer neuen Suche ab.

## Start unter Windows

Im Projektordner in PowerShell mit Node.js 24 oder neuer ausführen:

```powershell
npm.cmd ci
npm.cmd start
```

Am PC [localhost:3000](http://localhost:3000) öffnen. Für einen Test auf einem Handy im selben privaten WLAN den Server mit `npm.cmd start -- --lan` starten und am Handy die unter „Handy im WLAN“ ausgegebene Adresse öffnen. Das Terminal offen lassen. Falls Windows beim ersten Start nach Netzwerkzugriff fragt, genügt das private Netzwerkprofil.

### Praxistest

1. Eine Haltestelle oder einen Ort als Start wählen.
2. Das Ziel auswählen und eine Verbindung öffnen. Straßenbahn, Bus, Fußweg und Zug können als eigene Abschnitte erscheinen.
3. Den Start mit dem Stern speichern und über „Strecke speichern“ die Kombination in die Favoriten übernehmen. Seite neu laden und den Streckenfavoriten antippen.
4. Mit ⇄ die Richtung tauschen und bei Bedarf von Abfahrt auf Ankunft wechseln.
5. Eine Verbindung aufklappen und „Fahrt merken“ wählen. Unter „Meine Fahrten“ prüfen, ob sie nach einem Neuladen weiter erscheint. „Live aktualisieren“ ruft dieselbe Fahrt erneut ab. Bei Abrufproblemen bleibt der letzte gespeicherte Stand sichtbar.

## Technik und Datenquellen

Die App verwendet einen Node-HTTP-Server sowie HTML, CSS und Browser-JavaScript. Die einzige direkte npm-Abhängigkeit ist `web-push`. Der Server bündelt die Abfragen an MOTIS und hält Ortsvorschläge zehn Minuten sowie identische Routenanfragen 30 Sekunden im Arbeitsspeicher. Meldungstexte kommen aus den von Transitous bereitgestellten Daten der Betreiber. Deren Abdeckung kann je nach Verkehrsbetrieb und Verbindung vom DB Navigator abweichen. Die Routing-API kann ausgefallene Fahrten bereits bei der Suche ausfiltern.

| Quelle | Ergebnis |
| --- | --- |
| [Transitous / MOTIS](https://transitous.org/api/) | Hauptquelle für Ortsvorschläge und Routen. Testabfragen einschließlich Nah- und Fernverkehr sowie Echtzeitdaten für einzelne Abschnitte erfolgreich. Eine deutschlandweite Stichprobe steht aus. |
| [DB OpenBoards](https://developers.deutschebahn.com/db-api-marketplace/apis/product/open-boards) | Abfahrts- und Ankunftstafeln mit Plan- und Prognosedaten. Kostenloser Tarif laut DB mit zehn Anfragen pro Sekunde. Für den Live-Test wird ein DB-Marketplace-Abonnement benötigt. Kandidat für eine Bahnhofstafel oder eine gezielte Ergänzung deutscher Bahnfahrten. |
| [db-vendo-client](https://github.com/public-transport/db-vendo-client) | Community-Client für DB-Schnittstellen. Die Entwickler berichten von Sperren und eingeschränkter Zuverlässigkeit. |
| [DB Transport REST v6](https://github.com/derhuerst/db-rest/blob/6/docs/readme.md) | Laut Betreiberdokumentation außer Betrieb. |
| [GTFS.de Echtzeitdaten](https://www.gtfs.de/de/realtime/) | Feed für die Verarbeitung von Rohdaten. Eigene Routensuche damit erfordert einen Routingdienst und regelmäßigen Datenimport. |

Transitous erlaubt ressourcenschonende Prototypentests vor der Quellcodeveröffentlichung. Für die reguläre Nutzung verlangt der Betreiber veröffentlichten Open-Source-Code. Er bittet um Abstimmung bei hohem Anfragevolumen, unter anderem oberhalb von 720 Routinganfragen in 24 Stunden. Eine Kontaktadresse oder Projekt-URL gehört in den User-Agent. Dazu `.env.example` als `.env` kopieren und `TRANSITOUS_CONTACT` eintragen. Für eine dauerhaft private Codebasis kommt eine eigene MOTIS-Instanz infrage. [Nutzungsregeln bei Transitous](https://transitous.org/api/)

## iPhone-Push bereitstellen

Die WLAN-Version bietet manuelle Live-Aktualisierung. Für Push braucht das iPhone eine erreichbare HTTPS-Adresse und iOS 16.4 oder neuer. Die Cloudflare-Bereitstellung prüft Fahrten auch bei ausgeschaltetem PC. Der Versand verwendet Apple Web Push. [Apple WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

### Cloudflare Workers

1. Mit `npx wrangler login` im gewünschten Cloudflare-Konto anmelden. Der Worker nutzt statische Assets und ein SQLite-basiertes Durable Object aus dem Workers Free-Tarif.
2. Eine ignorierte Datei `.env.cloud.json` mit den Schlüsseln `PUSH_ACCESS_PASSWORD`, `PUSH_SUBJECT`, `PUSH_PUBLIC_KEY`, `PUSH_PRIVATE_KEY` und `TRANSITOUS_CONTACT` anlegen. VAPID-Schlüsselpaar wie unten beschrieben erzeugen. Als Kontakt ist die öffentliche Projektseite mit erreichbarem Kontakt geeignet. Den Code veröffentlichen und automatisierte Abrufe mit Transitous abstimmen.
3. Mit `npx wrangler deploy --secrets-file .env.cloud.json` bereitstellen. Zugangsdaten und Laufzeitdaten gehören in die lokale Geheimnisdatei bzw. den privaten Cloud-Speicher.
4. Auf dem iPhone die ausgegebene HTTPS-Adresse in Safari öffnen. Mit Benutzernamen `navigator` und dem Projektpasswort anmelden, „Zum Home-Bildschirm“ wählen und die App dort öffnen.
5. Unter „Meine Fahrten“ **Testmitteilung senden** wählen und den Mitteilungen zustimmen. Der Test sendet eine Push-Mitteilung von Apple und ruft keine Fahrtdaten ab.
6. Nach der Abstimmung mit Transitous das Cloudflare-Geheimnis `PUSH_MONITORING` auf `true` setzen. Beim Merken einer Fahrt startet die Überwachung dann automatisch. Bei bereits gespeicherten Fahrten lässt sie sich über „Push aktivieren“ einschalten.

### Alternativ auf einem eigenen Server

1. Eine private HTTPS-Adresse auf den Node-Server weiterleiten. Der Start ohne `--lan` bindet den Server für einen lokalen Reverse Proxy an die Loopback-Adresse.
2. VAPID-Schlüsselpaar mit `node --input-type=module -e "import { generateVAPIDKeys } from 'web-push'; console.log(generateVAPIDKeys())"` erzeugen. HTTPS-Ursprung, ein starkes Zugangspasswort, VAPID-Schlüssel und Kontakt gemäß `.env.example` lokal hinterlegen.
3. Den dauerhaft laufenden Betrieb und die automatischen Abrufe gemäß Transitous-Nutzungsregeln abstimmen. Das Verzeichnis für `push-watches.json` muss für den Prozess schreibbar und persistent sein.
4. Auf dem iPhone die HTTPS-Adresse in Safari öffnen, mit Benutzername `navigator` und dem eingerichteten Passwort anmelden und „Zum Home-Bildschirm“ wählen.
5. Die App über ihr Symbol öffnen, eine Fahrt speichern und „Push aktivieren“ antippen. Ein Tipp auf die Meldung öffnet und aktualisiert die Fahrt in derselben installierten App.

Die Überwachung prüft ab dem Speichern mit Push etwa alle fünf Minuten bis 30 Minuten nach Ankunft. Sie meldet Änderungen bei Zeiten, Gleisen, Ausfällen, Haltausfällen und neuen Meldungen. Rund 60 und 30 Minuten vor dem geplanten Fahrtbeginn sendet sie den Status, sofern die Fahrt zu diesen Zeitpunkten bereits überwacht wird. Bei fehlender Echtzeit kennzeichnet sie den Datenstand. Zum Wechsel von WLAN auf HTTPS unter „Meine Fahrten“ die Daten als Datei speichern und am Ziel einlesen. Die Sicherungsdatei enthält Fahrtdaten und ist für den privaten Gebrauch bestimmt. Push wird für übertragene Fahrten auf dem neuen Gerät separat aktiviert.

## Entwicklungsreihenfolge

1. **Praxistest auf dem Handy.** Suche, Hin- und Rückfahrt und Favoriten prüfen. Weitere Stichproben für Fernverkehr, Bus, Straßenbahn und Halte mit mehreren Bahnsteigen durchführen.
2. **Anschlüsse und Alternativen.** Zeit zwischen prognostizierter Ankunft und Abfahrt berechnen, Datenlücken sichtbar machen und bei Bedarf eine neue Suche ab dem Umsteigepunkt auslösen. Gehzeiten zwischen Gleisen nur berücksichtigen, wenn sie belastbar sind.
3. **iPhone-Push im Alltag testen.** HTTPS-Betrieb einrichten und die Zustellung bis zum Öffnen der gespeicherten Fahrt prüfen.
4. **Optionale Ergänzungen.** DB-Bahnhofstafeln, Hinweise bei Fahrtänderungen und Buchungslinks je nach Bedarf prüfen.
