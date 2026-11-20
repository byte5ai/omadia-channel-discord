<div align="center">

# @omadia/plugin-channel-discord

### Sprich mit deinen omadia-Agenten aus Discord.

Ein signiertes omadia-Plugin, das einen Discord-Bot mit deinem Agenten-Team verbindet. Es leitet Direktnachrichten, Server-Erwähnungen und einen Slash-Befehl an den omadia-Orchestrator weiter und postet die Antwort im selben Thread zurück.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built for omadia](https://img.shields.io/badge/built%20for-omadia-2496ED.svg)](https://github.com/byte5ai/omadia)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**Haupt-Repo**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai) · [**Plugin-Hub**](https://hub.omadia.ai) · [**Was es kann**](#was-es-kann) · [**Installation**](#installation)

🇬🇧 This guide is also available [in English](./README.md).

</div>

---

omadia ist ein selbst-hostbares agentisches OS: stelle Multi-Agent-Teams aus signierten Plugins zusammen, betreibe sie auf der eigenen Maschine und erhalte für jede Aktion eine nachvollziehbare Spur. Dieses Plugin macht Discord zu einem Weg, diese Agenten zu erreichen. Haupt-Repo: [byte5ai/omadia](https://github.com/byte5ai/omadia).

## Was es kann

Verbindet einen Discord-Bot (über das discord.js-Gateway) mit omadia. Es nimmt Direktnachrichten, `@mentions` in Servern und die Slash-Befehle `/ask`, `/agent` und `/agents` auf, leitet jede davon an den omadia-Agenten weiter, der die Unterhaltung bedient, und gibt die Antwort im selben Thread zurück.

Antworten lesen sich wie die Nachricht einer Kollegin: reiner Text, keine Statuszeile, keine Buttons und keine Reaktion auf deine Nachricht. Während ein Agent arbeitet, zeigt der Bot „schreibt …"; dauert die Arbeit deutlich länger, sagt der Agent das einmal, mit eigenen Worten und unter eigenem Namen, und ein langsamer Slash-Befehl wird als normale Nachricht beantwortet, statt zu scheitern.

## Einen Agenten erreichen

**Eine Installation ist ein Discord-Bot** (eine Discord-Application, ein Token). Alle deine Agenten erreichst du über diesen Bot. Die Auswahl ist ausdrücklich:

| Du tippst | Was passiert |
| --- | --- |
| `/agent Mira` (oder der Slash-Befehl) | Mira wird dein Agent in dieser Unterhaltung. omadia bestätigt das einmal mit einer Systemnachricht. Wählbar sind nur Agenten, die dir in Discord zur Verfügung stehen. |
| `/agents` | Listet die Agenten, die du hier wählen kannst. |
| `/agent` | Hebt deine Wahl auf; es gilt wieder die Zuordnung des Kanals bzw. der Standard. |

omadia speichert die Wahl pro Person und Unterhaltung, sie übersteht also einen Neustart, und zwei Personen im selben Kanal können mit verschiedenen Agenten sprechen. Die Wahl hängt an der engsten Unterhaltung: der Kanal-ID, im Thread an dessen eigener ID (nie am Server), plus dir. Eine Wahl im Kanal gilt nicht in dessen Threads, und ein Betreiber ordnet einen Agenten einer Kanal- oder Thread-ID zu, nicht einem ganzen Server. Das Plugin reicht den Text unverändert weiter (die Slash-Befehle stehen für genau den Text, den du tippen würdest); omadia führt die Befehle aus und antwortet. Als normale Nachricht getippt, hebt `/agent` allein die Wahl auf und `/agents` zeigt die Liste.

**Ein Bot pro Agent (eigener Name und Avatar in Discord) wird noch nicht unterstützt.** Discord hat keine API zum Anlegen von Bots; jeder Agent würde dich also eine eigene Application im Developer Portal, ein eigenes Token, eine eigene Einladung auf jeden Server sowie eine eigene Gateway-Verbindung samt Intent-Einstellungen kosten, und dieses Plugin nimmt genau ein Token und kennt keinen Zuordnungsschlüssel pro Bot. Wer es heute braucht, nutzt die Wahl per `/agent`. Sprechen mehrere Agenten in einer Unterhaltung, setzt der Bot eine kurze Namenszeile („Paul: …") vor eine Antwort, wo der Sprecher sonst unklar wäre, nie vor jede Nachricht einer Ein-Agenten-Unterhaltung; der Beitrag einer Kollegin erscheint als „Paul: …" im Text.

Der Bot teilt omadia auch deine Sprache mit (die eines Slash-Befehls, sonst die bevorzugte Sprache des Servers, als Deutsch oder Englisch), damit die Systemnachrichten in ihr kommen; in einer DM ohne Slash-Befehl ist sie unbekannt und sie sind deutsch.

Ist einem Kanal kein Agent zugeordnet, ist der Agent deaktiviert oder für dich nicht verfügbar, antwortet der Bot mit einer Systemnachricht, die das sagt, nie mit einem anderen Agenten.

## Benachrichtigungen von omadia

omadia kann dich auch von sich aus anschreiben (eine Erinnerung, eine Eskalation): als Direktnachricht an eine Person oder als Beitrag in einen Kanal, den der Bot sieht. Das kommt als schlichte Systemnachricht des Bots; da es ein Bot ist, nie als einzelner Agent. Direktnachrichten beachten *Direktnachrichten zulassen* und die Allowlist. Umfragen und Fragekarten zeichnet Discord nicht nativ: omadia stellt sie als nummerierte Textfrage in der Nachricht, und du antwortest, indem du auf diese Nachricht antwortest (oder in einer DM bzw. bei nur einer offenen Frage den Bot ansprichst) und die Nummer tippst. omadia liest diese Antwort als die Antwort. Dafür meldet der Bot die Nachrichten, die er in einer Unterhaltung lesen kann, an omadia, unter dem Identitätsschlüssel `discord-app:<application-id>` (die ID deiner Discord-Application); omadia behält sie nur für eine Unterhaltung, die ein Agent moderiert, und verwirft alle anderen. Eine Nachricht, die die Antwort auf eine offene Frage ist, beantwortet der Agent nicht zusätzlich: der Bot wartet bis zu 1,5 s auf das Urteil von omadia und macht dann wie gewohnt weiter. In einem Server sieht der Bot eine Nachricht ohne Erwähnung nur mit dem privilegierten Message-Content-Intent.

## Server-Kanäle (Gruppen)

omadia antwortet in einer Gruppe nur, wenn es weiß, wer im Kanal ist. Discord liefert die Mitgliederliste nur an Bots mit dem privilegierten **Server-Members-Intent**: im Developer Portal aktivieren (Bot, Privileged Gateway Intents) und in den Plugin-Einstellungen *Server-Mitglieder-Intent anfordern* anhaken. Ohne ihn ist die Teilnehmerliste eines Server-Kanals „unbekannt", und der Bot antwortet nur in Direktnachrichten. Direktnachrichten brauchen kein Intent. Server mit mehr als 5.000 Mitgliedern gelten als teilweise bekannt, omadia behandelt sie also ebenfalls als unbekannt.

## So funktioniert es in omadia

Ein Channel-Plugin (`kind: channel`) für omadia core 1.76 oder neuer (Platzhalter-Untergrenze; die endgültige Version setzt das Release). Der omadia-Kernel aktiviert es aus der `manifest.yaml`, dann öffnet es die Discord-Gateway-Verbindung. Jede eingehende Nachricht geht an den Orchestrator-Chat-Agenten, und die Antwort kommt zurück nach Discord. Der Channel braucht zuerst einen dem Orchestrator zugewiesenen LLM-Provider, sonst gibt es keinen Agenten, der antworten kann.

## Installation

1. Installiere über den [Plugin-Hub](https://hub.omadia.ai) in der omadia-Admin-UI.
2. Öffne die Plugin-Setup-Seite und fülle die Felder unten aus. Es gibt keinen API-Key: der Channel nutzt die Setup-Tokens.
3. Weise dem Orchestrator zuerst einen LLM-Provider zu, sonst hat der Channel keinen Agenten zum Antworten.

## Konfiguration

| Feld | Typ | Hinweis |
| --- | --- | --- |
| Discord Bot Token | secret | Aus dem Discord-Developer-Portal. |
| Guild behaviour | enum | Wie der Bot in Servern reagiert. |
| Allow DMs | boolean | |
| Request message-content intent | boolean | Nötig, um Nachrichtentext in Servern zu lesen. |
| Request server-members intent | boolean | Nötig, damit omadia weiß, wer in einem Server-Kanal ist, und dort antwortet. |
| Register slash commands | boolean | `/ask`, `/agent`, `/agents`. |
| Ignore other bots | boolean | |
| Allowed IDs | string | Optionale Allowlist. |

## Aus dem Quellcode bauen

```bash
npm install
npm run build   # esbuild-Bundle nach dist/ und Upload-Zip in out/
npm run typecheck
npm test        # node --test; braucht einen gebauten omadia-Checkout, siehe unten
```

`@omadia/plugin-api` und `@omadia/channel-sdk` stellt der omadia-Host zur Laufzeit bereit (optionale Peer-Deps). Für den Typecheck zeigen die `paths` der tsconfig auf einen gebauten omadia-Checkout. Die Tests lösen beide Pakete über `OMADIA_REPO` auf (Wurzel des Checkouts, Standard `../`; vorher `middleware/packages/harness-channel-sdk` und `plugin-api` bauen). Aufbau siehe [byte5ai/omadia](https://github.com/byte5ai/omadia).

## Lizenz

[MIT](LICENSE), byte5 GmbH