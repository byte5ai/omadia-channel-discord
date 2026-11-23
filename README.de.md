<div align="center">

# @omadia/plugin-channel-discord

### Sprich mit deinen omadia-Agenten aus Discord.

Ein signiertes omadia-Plugin, das einen Discord-Bot mit deinem Agenten-Team verbindet. Es leitet Direktnachrichten, Server-Erwähnungen und einen Slash-Befehl an deine Agenten weiter und postet die Antwort im selben Thread zurück.

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

**Ein Bot pro Agent (eigener Name und Avatar in Discord).** Neben dem Bot aus seinem Setup betreibt das Plugin einen Bot pro Agent (Spec 2042 §5.3). Discord hat keine API zum Anlegen von Bots, also für jeden Agenten: im Developer Portal eine Application anlegen, benannt wie der Agent, einen Bot hinzufügen, dieselben privilegierten Intents wie beim Bot des Kanals einschalten, ihn auf deine Server einladen (`bot applications.commands` ist nicht nötig, der Agenten-Bot hat keine Slash-Commands) und sein Token in omadia unter **Operator → Agenten → der Agent → Kanäle → Eigene Bots → Discord** eintragen. omadia gibt das Token einmal an dieses Plugin; das Plugin prüft es bei Discord, legt es in seinem eigenen Vault ab (`agent_bot_token_<appId>`), verbindet den Bot und meldet den Routing-Schlüssel `discord-app:<appId>`. Danach spricht jeder, der diesen Bot erwähnt oder ihm eine DM schreibt, mit genau diesem Agenten (`/agent` sagt dort, wessen Bot es ist), die Antworten des Agenten und omadias Beiträge in seinem Namen gehen ohne Namenszeile über seinen Bot, und ein Bot, den omadia keinem Agenten zuordnet, antwortet nur mit einem kurzen Systemhinweis. Der Bot eines Agenten antwortet, wenn er erwähnt, auf ihn geantwortet oder ihm eine DM geschrieben wird, auch bei *In Servern antworten = alle* (sonst würde jeder Agenten-Bot im Channel auf dieselbe Nachricht antworten), und nimmt nie einen Beitrag eines anderen Bots dieser Installation als Turn, egal was *Bots ignorieren* sagt. Ist Discord beim Start von omadia nicht erreichbar, verbinden sich die Agenten-Bots im Hintergrund neu. Entfernen auf der Agent-Seite trennt den Bot und löscht sein Token. Agenten ohne eigenen Bot erreichst du über den gemeinsamen Bot mit `/agent`; sprechen mehrere Agenten in einer Unterhaltung, setzt der gemeinsame Bot eine kurze Namenszeile („Paul: …“) vor eine Antwort, wo der Sprecher sonst unklar wäre, und der Beitrag einer Kollegin erscheint als „Paul: …“ im Text.

Der Bot teilt omadia auch deine Sprache mit (die eines Slash-Befehls, sonst die bevorzugte Sprache des Servers, als Deutsch oder Englisch), damit die Systemnachrichten in ihr kommen; in einer DM ohne Slash-Befehl ist sie unbekannt und sie sind deutsch.

Ist einem Kanal kein Agent zugeordnet, ist der Agent deaktiviert oder für dich nicht verfügbar, antwortet der Bot mit einer Systemnachricht, die das sagt, nie mit einem anderen Agenten.

## Benachrichtigungen von omadia

omadia kann dich auch von sich aus anschreiben (eine Erinnerung, eine Eskalation): als Direktnachricht an eine Person oder als Beitrag in einen Kanal, den der Bot sieht. Das geht über den Bot, den omadia nennt: den eigenen Bot des Agenten, wenn er einen hat, sonst den gemeinsamen Bot. Direktnachrichten beachten *Direktnachrichten zulassen* und die Allowlist. Umfragen und Fragekarten zeichnet Discord nicht nativ: omadia stellt sie als nummerierte Textfrage in der Nachricht, und du antwortest, indem du auf diese Nachricht antwortest (oder in einer DM bzw. bei nur einer offenen Frage den Bot ansprichst) und die Nummer tippst. omadia liest diese Antwort als die Antwort. Dafür meldet der Bot die Nachrichten, die er in einer Unterhaltung lesen kann, an omadia, unter dem Identitätsschlüssel `discord-app:<application-id>` (die ID deiner Discord-Application); omadia behält sie nur für eine Unterhaltung, die ein Agent moderiert, und verwirft alle anderen. Eine Nachricht, die die Antwort auf eine offene Frage ist, beantwortet der Agent nicht zusätzlich: der Bot wartet bis zu 1,5 s auf das Urteil von omadia und macht dann wie gewohnt weiter. In einem Server sieht der Bot eine Nachricht ohne Erwähnung nur mit dem privilegierten Message-Content-Intent.

**Trigger und Routinen.** Ein Agent kann in einer Unterhaltung einen Trigger oder eine Routine setzen („erinnere mich morgen um 9“, ein Wochenbericht). Jeder Turn öffnet den Routinen-Kontext von omadia (`routinesIntegration@1`, nur mit Datenbank), erst damit bekommt der Agent diese Werkzeuge hier, und die Zustellung geht später über den Bot, über den die Unterhaltung läuft: den eigenen Bot des Agenten ohne Namenszeile, den gemeinsamen Bot benannt wie eine Antwort. Ein Bot, der entfernt oder einem anderen Agenten gegeben wurde, stellt nichts zu. Wer auf eine Erinnerungs-DM mit Discords *Antworten* reagiert, dessen Antwort kann omadia dieser Erinnerung zuordnen: der Bot meldet, auf welche Nachricht die DM antwortet.

**Reaktion statt Echo.** Wo omadia nur zeigen muss, dass es eine Nachricht aufgenommen hat (ein Moderator, der einen Beitrag festhält), setzt es ein 👍 auf diese Nachricht, statt zu antworten, und zwar als genau der Bot, den omadia nennt: der eigene Bot des Agenten oder der gemeinsame Bot, nie ein anderer. Das nutzt Discords [Create Reaction](https://discord.com/developers/docs/resources/message#create-reaction) und braucht in dem Kanal die Bot-Berechtigungen **Reaktionen hinzufügen** (Add Reactions) und **Nachrichtenverlauf lesen** (Read Message History). Der Einladungslink auf der Admin-Seite des Plugins fragt beide an (zusammen mit Kanäle ansehen, Nachrichten senden und Links einbetten); ein Bot, der mit einem älteren Link eingeladen wurde, braucht Add Reactions in den Server-Einstellungen oder eine neue Einladung. Ohne die Berechtigung bekommt omadia „not permitted" zurück, und es wird nichts gesetzt.

## Server-Kanäle (Gruppen)

omadia antwortet in einer Gruppe nur, wenn es weiß, wer im Kanal ist. Discord liefert die Mitgliederliste nur an Bots mit dem privilegierten **Server-Members-Intent**: im Developer Portal aktivieren (Bot, Privileged Gateway Intents) und in den Plugin-Einstellungen *Server-Mitglieder-Intent anfordern* anhaken. Ohne ihn ist die Teilnehmerliste eines Server-Kanals „unbekannt", und der Bot antwortet nur in Direktnachrichten. Direktnachrichten brauchen kein Intent. Server mit mehr als 5.000 Mitgliedern gelten als teilweise bekannt, omadia behandelt sie also ebenfalls als unbekannt. Jeder Zug in einem Server-Kanal gibt omadia diese Liste (die Menschen, nicht die Bots) als Publikum des Raums mit: omadia erlaubt ein Tool nur, wenn alle im Raum es nutzen dürfen. Ohne vollständige Liste darf ein Gruppen-Zug also kein Tool nutzen, auch keinen Facilitator-Start.

## Facilitatoren (moderierte Gruppen)

Ein Facilitator-Agent (Spec 2043) moderiert einen Server-Kanal oder Thread: er sammelt Beiträge und Stimmen, hält den Stand und erinnert. In Discord gilt:

- **Ein eigener Bot.** Ein Facilitator braucht einen eigenen Bot (siehe *Ein Bot pro Agent* oben). Zwei Facilitatoren posten als zwei verschiedene Bots, auch in zwei verschiedenen Kanälen.
- **Jede Nachricht, nur dort, wo er moderiert.** Solange eine Moderation ein Nachrichten-Abo für einen Kanal hält, gibt ihr Bot jede menschliche Nachricht dort an omadia weiter (auch ohne Erwähnung) und startet selbst keine Antwort: die Moderation antwortet. In allen anderen Kanälen bleiben die Erwähnungsregeln. omadia fragt das Plugin vorher, ob der Bot das in diesem Kanal kann (Readiness); die Antwort nennt, was fehlt: das **Message-Content-Intent** (ohne es liefert Discord den Text von Nachrichten ohne Erwähnung nicht), abgeschaltete Server-Kanäle, ein Server, der nicht auf der Allowlist steht, oder die Rechte Kanal ansehen, Nachrichtenverlauf lesen und Nachrichten senden (im Thread: Nachrichten in Threads senden).
- **Nur Menschen zählen.** Eine Nachricht, Bearbeitung oder Reaktion eines Bots oder Webhooks und eine Systemnachricht (Beitritt, Anheften) ist nie ein Beitrag oder eine Stimme, egal was *Ignore bots* sagt: ein Webhook kann unter jedem Namen posten. In einem moderierten Kanal gibt der Bot so eine Nachricht gar nicht weiter; anderswo bekommt ein Bot, der den Bot erwähnt, bei ausgeschaltetem *Ignore bots* wie bisher seine Antwort.
- **Anwesenheit.** omadia lässt eine Moderation erst mitlesen, wenn der Bot im Kanal gesehen wurde. Der Bot meldet das mit der ersten Nachricht, die er dort empfängt (und alle 12 Stunden erneut). Jemand muss dort also zuerst schreiben, etwa die Nachricht, mit der die Moderation beginnt.
- **Bearbeiten, Löschen, Reaktionen.** Eine bearbeitete Nachricht wird mit neuem Text gemeldet (eine bearbeitete Stimme zählt in ihrer letzten Fassung), eine weitergeleitete Nachricht als weitergeleitet markiert (sie ist nicht die Stimme der weiterleitenden Person), und Reaktionen werden mit der Person gemeldet, die sie gesetzt hat. Dafür fordert das Plugin selbst die Intents Guild Message Reactions und Direct Message Reactions an (nicht privilegiert).
- **Wer da ist.** Mit dem Server-Members-Intent listet der Bot alle, die den Kanal sehen. Eine Abfrage, die omadia als frisch markiert, fragt Discord neu statt den Fünf-Minuten-Cache zu nehmen; ein Beitritt, Austritt oder Rollenwechsel verwirft den Cache. Vollständig (`complete`) ist die Liste nur, wenn Discord so viele Mitglieder geliefert hat, wie der Server hat; eine kürzere Liste ist `partial`, eine fehlgeschlagene `unknown`, jeweils mit Grund und Lesezeitpunkt.
- **Beitritte und Austritte.** Mit dem Server-Members-Intent wird ein Beitritt oder Austritt im Server an omadia gemeldet, für die Kanäle dieses Servers, in denen der Bot gesehen wurde (ein Beitritt nur dort, wo die Person den Kanal sehen kann).
- **Abstimmungen als Text.** Umfragen gehen als nummerierte Textfrage raus; man antwortet mit einer Antwort auf die Nachricht mit der Nummer, ohne den Bot zu erwähnen. omadia hält die offene Frage selbst, ein Neustart dazwischen ändert nichts. Der Facilitator kann eine Stimme mit 👍 bestätigen.

**Was Discord nicht kann, und was stattdessen passiert:**

| Anforderung | Lücke in Discord | Nächstliegendes Verhalten |
| --- | --- | --- |
| Native Umfragen | Eine Antwort in einer Discord-Umfrage trägt keine eigenen Daten, nur Position und Text. Eine Stimme der omadia-Option zuzuordnen braucht einen Datensatz, der einen Neustart überlebt; den führt dieses Plugin nicht. Eine Rangfolge kann eine Discord-Umfrage auch nicht abbilden. | Das Plugin meldet keine Umfragen an. omadia stellt jede Umfrage als nummerierten Text und liest getippte Antworten als Antwort; die offene Frage hält omadia selbst, also neustartfest. |
| Nachrichten ohne Erwähnung lesen | Nur mit dem privilegierten Message-Content-Intent. | Ohne es sagt die Readiness das, und omadia lehnt das Abo mit diesem Grund ab, den der Facilitator im Chat nennen kann; der Bot hört dann nur Nachrichten, die ihn erwähnen (eine Antwort mit Ping zählt), und DMs. |
| Wer im Kanal ist | Nur mit dem privilegierten Server-Members-Intent; Discord kennt keine Mitgliedschaft pro Kanal, nur Server-Mitglieder und Kanalrechte. | Ohne das Intent ist die Liste `unknown`. Server über 5.000 Mitglieder sind `partial`. |
| Beitritt und Austritt | Nur serverweit (GUILD_MEMBER_ADD / REMOVE, Server-Members-Intent); Rechteänderungen erzeugen kein Ereignis. | Ereignisse gehen an die Kanäle, in denen der Bot seit seinem letzten Start gesehen wurde; eine Rechteänderung verwirft nur den Cache, die nächste Abfrage stimmt also. |
| „Bot zum Kanal hinzugefügt" | Discord sendet dafür kein Ereignis pro Kanal. | Anwesenheit wird mit der ersten empfangenen Nachricht dort gemeldet. |
| Löschen | Das Lösch-Ereignis von Discord nennt weder Autor noch die löschende Person. | Gemeldet wird nur eine Löschung einer Nachricht, die der Bot noch im Cache hatte (Autor bekannt); sonst wird sie nur protokolliert. |

## So funktioniert es in omadia

Ein Channel-Plugin (`kind: channel`) für omadia core 1.79 oder neuer. Der omadia-Kernel aktiviert es aus der `manifest.yaml`, dann öffnet es die Discord-Gateway-Verbindung. Jede eingehende Nachricht geht an die Agent-Runtime, und die Antwort kommt zurück nach Discord. Der Channel braucht zuerst ein der Agent-Runtime zugewiesenes Modell, sonst gibt es keinen Agenten, der antworten kann.

## Installation

1. Installiere über den [Plugin-Hub](https://hub.omadia.ai) in der omadia-Admin-UI.
2. Öffne die Plugin-Setup-Seite und fülle die Felder unten aus. Es gibt keinen API-Key: der Channel nutzt die Setup-Tokens.
3. Weise der Agent-Runtime zuerst ein Modell zu, sonst hat der Channel keinen Agenten zum Antworten.

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