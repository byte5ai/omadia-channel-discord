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

Verbindet einen Discord-Bot (über das discord.js-Gateway) mit omadia. Es nimmt Direktnachrichten, `@mentions` in Servern und einen `/ask`-Slash-Befehl auf, leitet jede davon an den omadia-Orchestrator weiter und gibt die Antwort im selben Thread zurück.

## So funktioniert es in omadia

Ein Channel-Plugin (`kind: channel`). Der omadia-Kernel aktiviert es aus der `manifest.yaml`, dann öffnet es die Discord-Gateway-Verbindung. Jede eingehende Nachricht geht an den Orchestrator-Chat-Agenten, und die Antwort kommt zurück nach Discord. Der Channel braucht zuerst einen dem Orchestrator zugewiesenen LLM-Provider, sonst gibt es keinen Agenten, der antworten kann.

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
| Register /ask slash command | boolean | |
| Ignore other bots | boolean | |
| Allowed IDs | string | Optionale Allowlist. |

## Aus dem Quellcode bauen

```bash
npm install
npm run build   # tsc, schreibt dist/
npm test        # prüft manifest.yaml gegen die Core-Invarianten
```

`@omadia/plugin-api` stellt der omadia-Host zur Laufzeit bereit (optionale Peer-Dep). Verlinke es aus einem lokalen omadia-Checkout zum Bauen. Aufbau siehe [byte5ai/omadia](https://github.com/byte5ai/omadia).

## Lizenz

[MIT](LICENSE), byte5 GmbH