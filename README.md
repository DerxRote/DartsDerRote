# Darts Counter (Web)

Web-Version der iOS-App „Darts Counter“ als installierbare Web-App (PWA), Adresse: https://darts.pfleger.work

## Zwei Bereiche

| Adresse | Wer | Daten |
|---|---|---|
| `darts.pfleger.work/` | alle, ohne Anmeldung | Feste Spieler „Spieler 1–3“. Es wird nichts gespeichert, auch nicht im Browser. |
| `darts.pfleger.work/app/` | nur eingeladene Freunde (Cloudflare Access, Login-Code per E-Mail) | Spieler, Spiele und Trainings liegen gemeinsam in einer D1-Datenbank (Standort EU). |

E-Mail-Adressen werden nicht in der Datenbank gespeichert. Die Anmeldung übernimmt Cloudflare Access.

## Aufbau

| Pfad | Zweck |
|---|---|
| `public/` | Statische Seite (wird so ausgeliefert, kein Build-Schritt) |
| `public/index.html`, `public/app/index.html` | Einstieg Gastmodus bzw. Freunde-Bereich |
| `public/js/engine.js` | Spiellogik, 1:1 aus den Swift-Engines übertragen |
| `public/js/app.js` | Oberfläche, Gastmodus und Abgleich mit dem Server |
| `public/fonts/` | Schriften lokal (keine Verbindung zu Google) |
| `public/sw.js` | Offline-Betrieb. Bei jeder Änderung `VERSION` hochzählen. |
| `src/worker.js` | Server für `/api/*`: prüft die Access-Anmeldung, liest/schreibt D1 |
| `wrangler.jsonc` | Cloudflare-Einstellungen: Domain, Datenbank, Access-Team |

API (nur angemeldet): `GET /api/data` liefert alles, `POST /api/sync` mit `{ ops: [{ kind, uuid, data|null }] }` speichert oder löscht.
Die Tabelle legt der Worker beim ersten Aufruf selbst an.

## Cloudflare einrichten (einmalig)

1. **D1-Datenbank**: Storage & Databases → D1 → Create, Name `darts`, Data location „Specify jurisdiction: EU“. Die Database ID in `wrangler.jsonc` eintragen.
2. **Zero Trust**: Team-Namen festlegen (Free-Tarif). `TEAM_DOMAIN` in `wrangler.jsonc` auf `https://<team>.cloudflareaccess.com` setzen.
3. **Worker anlegen**: Workers & Pages → Create application → GitHub → dieses Repository. Name `darts`. Build-Befehl leer, Deploy-Befehl `npx wrangler deploy`. Die Domain `darts.pfleger.work` richtet `wrangler.jsonc` beim Deploy selbst ein.
4. **Access-Anwendung**: Zero Trust → Access → Applications → Add → Self-hosted. Domain `darts.pfleger.work` mit den Pfaden `app` und `api`. Policy „Allow“ mit den E-Mail-Adressen der Freunde. Login-Methode: One-time PIN.
5. Optional: AUD-Tag der Anwendung als `POLICY_AUD` in `wrangler.jsonc` eintragen.

## Lokal testen

```
npm install
echo 'DEV_SKIP_AUTH_EMAIL=test@example.com' > .dev.vars
npx wrangler dev
```
Dann http://localhost:8787 (Gast) bzw. http://localhost:8787/app/ (Freunde, ohne Anmeldung). `DEV_SKIP_AUTH_EMAIL` nur lokal verwenden, nie im Dashboard setzen.
