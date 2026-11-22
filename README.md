# Darts Counter (Web)

Web-Version der iOS-App „Darts Counter“, als installierbare Web-App (PWA).
Reines HTML/CSS/JavaScript ohne Build-Schritt: Der Ordner wird so, wie er ist, ausgeliefert.

Ziel-Adresse: https://darts.pfleger.work

## Inhalt

| Datei | Zweck |
|---|---|
| `index.html` | Einstiegsseite |
| `js/engine.js` | Spiellogik, 1:1 aus `Engine/*.swift` übertragen (X01, Finish-Rechner, Trainings, Statistik, Abgleich, Testdaten) |
| `js/app.js` | Oberfläche (Spielen, Training, Spieler, Verlauf, Abgleichen) |
| `css/style.css` | Gestaltung, hell und dunkel |
| `manifest.webmanifest`, `icons/` | Installation auf dem Home-Bildschirm |
| `sw.js` | Offline-Betrieb (Service Worker) |
| `_headers` | Cache-Regeln für Cloudflare |

Die Daten liegen im Browser des jeweiligen Geräts (localStorage). Abgleich zwischen Geräten:
Spieler → Abgleichen → exportieren und auf dem anderen Gerät importieren. Doppelte Einträge werden erkannt.

## Lokal ansehen

```
python3 -m http.server 8000
```
Dann http://localhost:8000 öffnen.

## Auf Cloudflare veröffentlichen

1. Cloudflare Dashboard → Workers & Pages → Erstellen → Pages → Mit Git verbinden → dieses Repository wählen.
2. Framework: keins. Build-Befehl: leer lassen. Ausgabeverzeichnis: `/` (bzw. der Ordner, in dem `index.html` liegt).
3. Nach dem ersten Deploy: Projekt → Benutzerdefinierte Domains → `darts.pfleger.work` hinzufügen. Da die Domain bei Cloudflare liegt, wird der DNS-Eintrag automatisch angelegt.

## Neue Version ausliefern

In `sw.js` die Konstante `VERSION` hochzählen (z. B. `darts-v2`), damit installierte Apps die neuen Dateien laden.
