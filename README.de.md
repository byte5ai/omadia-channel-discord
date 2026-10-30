# @omadia/channel-discord

Ein **Discord-Bot-Channel** für die [Omadia](https://github.com/byte5ai/omadia)-
Harness-Plattform. Er hält eine discord.js-Gateway-Verbindung, macht aus
Discord-Nachrichten, `/ask` und Button-Klicks Orchestrator-Turns und antwortet
mit Discord Components V2: Text, Trennlinien, Bilder, Dateien, Buttons.
Markdown-Tabellen kommen als Bild, weil Discord sie nicht darstellen kann.

[English](README.md)

## Einrichtung

1. <https://discord.com/developers/applications> → **New Application** → **Bot** → **Reset Token** → kopieren.
2. Omadia → Plugin installieren → Token als **Discord Bot Token** einfügen.
3. Plugin-Seite öffnen. Der Einrichtungs-Assistent zeigt den Bot, gibt dir den
   **Einladungs-Button**, listet die Server, auf denen der Bot ist, und hakt
   die erste Unterhaltung ab.

Mehr braucht es nicht: Application-ID, Einladungslink und der `/ask`-Command
ergeben sich aus dem Token. Den **Message Content Intent** (Portal → Bot)
brauchst du nur für *Verhalten in Servern: Auf jede Nachricht*. Fehlt er,
warnt der Assistent und verlinkt die richtige Stelle.

| Setup-Feld | Standard | |
|---|---|---|
| `discord_bot_token` | — | Bot-Token (Vault) |
| `respond_in_guilds` | `mention` | `mention` (@Erwähnung oder Antwort auf den Bot), `all` (jede Nachricht; braucht den Intent), `off` (nur DMs) |
| `allow_dms` | `true` | Auf 1:1-Direktnachrichten antworten |
| `allowlist` | leer | Komma-getrennte User- und/oder Server-IDs; leer = alle. Gilt für Nachrichten, `/ask` und Buttons |

## So sehen Antworten aus

- **Tabellen** werden ein PNG im omadia-UI-Design-System: transparenter
  Hintergrund, damit es in jedes Discord-Theme passt; Archivo; Zahlen
  rechtsbündig; ✅/⚠️/❌ als farbiger Status-Punkt. Zum Kopieren hängt eine
  **CSV** dran, und der Tabellentext ist die Bildbeschreibung. Zweispaltige
  Tabellen werden zu `**Schlüssel:** Wert`-Zeilen, sehr breite zu Karten pro
  Zeile, lange alle 20 Zeilen zu einem neuen Bild. Siehe
  [`packages/table-render`](packages/table-render/README.md).
- **Bilder** (z. B. Diagramme) lädt das Plugin selbst herunter und hängt sie an,
  damit auch lokale oder kurzlebige URLs funktionieren.
- `---` wird zur Trennlinie. Lange Antworten werden innerhalb der Discord-Limits
  aufgeteilt. Vorschläge und Auswahlen werden Buttons oder ein Auswahlmenü.
- Antworten pingen niemanden. Die erste Nachricht antwortet auf die Frage, ohne
  den Fragenden zu pingen.

## Routing und Verlauf

- Jeder Turn geht an den Agent, der an die Discord-**Kanal-ID** gebunden ist,
  sonst an die **Server-ID**, sonst an den Standard-Orchestrator
  (`channelResolver@1`).
- Die letzten 12 Wortwechsel pro Kanal gehen als Verlauf mit und liegen im
  `ctx.memory` des Plugins. Ein Gespräch übersteht so Neustarts und Updates.
  Der Orchestrator maskiert den Verlauf, bevor das Modell ihn sieht.

## Update von 0.1.x

2.0.0 ersetzt 0.1.x direkt. Token, `respond_in_guilds`, `allow_dms`,
`allowlist`, Bindings und der Session-Scope `discord:<kanal>` bleiben erhalten.
Entfallen sind `message_content_intent` (wird am Token erkannt),
`enable_slash_command` (`/ask` wird immer registriert, pro Server, sofort) und
`ignore_bots` (andere Bots werden immer ignoriert). Siehe
[CHANGELOG](CHANGELOG.md).

## Entwicklung

```bash
npm install                       # Workspace: Plugin + packages/table-render
npm run typecheck
npm run preview                   # offline: dev/scenarios.mjs → dev/out/, V2-Payloads + Limits prüfen
npm run build                     # esbuild-Bundle → out/omadia-channel-discord-<version>.zip
DISCORD_BOT_TOKEN=… npm run dev   # echtes Discord + geskripteter Orchestrator, Assistent auf :8787
```

Mit `npm run dev` schickst du ein Szenario-Stichwort aus `dev/scenarios.mjs`
(`tabelle`, `lang`, `kunde`, `matrix`, `projekte`, `status`, `bild`,
`auswahl`, `menu`, `code`, `noreply`) als Erwähnung, DM oder `/ask`. Optionale
Umgebungsvariablen: `DISCORD_RESPOND_IN_GUILDS`, `DISCORD_ALLOW_DMS`,
`DISCORD_ALLOWLIST`, `PORT`.

Details zu den Prüf-Skripten in `dev/`, zum Build und zum Aufbau stehen in der
[englischen README](README.md#develop).

## Lizenz

MIT
