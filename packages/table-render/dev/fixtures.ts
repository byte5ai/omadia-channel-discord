// Realistic orchestrator answers (Odoo-flavoured) covering every table shape.

const longRows = Array.from({ length: 45 }, (_, i) => {
  const n = i + 1;
  const amount = (1234.5 * ((n * 7) % 13) + 99).toFixed(2).replace('.', ',');
  return `| RE-2026-${String(1000 + n)} | Kunde ${n} GmbH | 2026-10-${String((n % 28) + 1).padStart(2, '0')} | ${amount} € |`;
}).join('\n');

export const FIXTURES: Record<string, string> = {
  kv: `Hier die Eckdaten zum Kunden:

| Feld | Wert |
|---|---|
| Name | **Müller & Söhne GmbH** |
| Ansprechpartner | Jürgen Weiß |
| Umsatz 2026 | 184.220,00 € |
| Zahlungsziel | 30 Tage |`,

  medium: `Es gibt aktuell **5 offene Rechnungen** über 10.000 €:

| Rechnung | Kunde | Fällig | Betrag | Status |
|---|---|---|---:|---|
| RE-2026-0412 | Müller & Söhne GmbH | 2026-10-12 | 24.380,00 € | überfällig |
| RE-2026-0418 | [Bäckerei Größl](https://example.com) | 2026-10-20 | 12.150,50 € | überfällig |
| RE-2026-0433 | Stadtwerke Köln | 2026-11-02 | 87.900,00 € | offen |
| RE-2026-0440 | \`Weber IT\` | 2026-11-05 | 10.004,99 € | offen |
| RE-2026-0451 | Ölmühle Hansen KG | 2026-11-14 | 15.600,00 € | offen |

Soll ich Mahnungen für die überfälligen vorbereiten?`,

  long: `Alle Rechnungen aus Oktober:

| Nr. | Kunde | Datum | Betrag |
|---|---|---|---|
${longRows}`,

  wide: `Urlaubsübersicht Team Node:

| Name | Jan | Feb | Mär | Apr | Mai | Jun | Jul | Rest |
|---|---|---|---|---|---|---|---|---|
| Anna | 2 | 0 | 5 | 1 | 0 | 3 | 10 | 9 |
| Ben | 0 | 4 | 0 | 0 | 5 | 0 | 12 | 9 |
| Clara | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 23 |`,

  status: `Stand der Integrationen:

| Integration | Status | Letzter Sync | Fehler |
|---|---|---|---:|
| Odoo | ✅ aktiv | vor 2 Min. | 0 |
| Microsoft 365 | ⚠️ Token läuft ab | vor 1 Std. | 3 |
| Jira | ❌ getrennt | vor 3 Tagen | 41 |`,

  wrapping: `Vergleich der Optionen:

| Option | Vorteile | Nachteile | Aufwand |
|---|---|---|---|
| Bild-Rendering | Kein Umbruch, sieht auf allen Geräten gleich aus, Zahlen sauber ausgerichtet | Nicht kopierbar ohne CSV, nicht durchsuchbar | mittel |
| Code-Block | Kopierbar, keine Abhängigkeiten | Bricht auf dem Handy um, Monospace wirkt technisch | gering |
| Embed-Felder | Nativ | Maximal 3 Spalten, keine echte Tabelle | gering |`,

  fenced: `So sieht eine Markdown-Tabelle aus:

\`\`\`md
| a | b |
|---|---|
| 1 | 2 |
\`\`\``,
};

FIXTURES.wideText = `Projektstatus:

| Projekt | Kunde | Owner | Phase | Start | Ende | Budget | Risiko |
|---|---|---|---|---|---|---|---|
| Delta Rewrite | Praxis QM GmbH | Morian Engelhardt | Umsetzung Sprint 14 | 2026-03-01 | 2026-12-15 | 240.000 € | Abhängigkeit zur Beta-Migration |
| PX Notdienst | Pharmaworx GmbH | Team Node | Abnahme durch Kunde | 2026-05-10 | 2026-11-30 | 85.000 € | keins |`;
