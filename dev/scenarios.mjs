// Scripted SemanticAnswers for the dev harness (dev/run.mjs via the fake SDK)
// and the offline preview (dev/preview.mjs). Each key is a keyword you can
// send to the bot in Discord. NOT shipped — dev/ is not in the ZIP.

const invoices = Array.from({ length: 34 }, (_, i) => {
  const n = i + 1;
  const amount = (1234.5 * ((n * 7) % 13) + 99).toFixed(2).replace('.', ',');
  return `| RE-2026-${1000 + n} | Kunde ${n} GmbH | 2026-10-${String((n % 28) + 1).padStart(2, '0')} | ${amount} € |`;
}).join('\n');

export const SCENARIOS = {
  tabelle: {
    text: `Es gibt aktuell **5 offene Rechnungen** über 10.000 €:

| Rechnung | Kunde | Fällig | Betrag | Status |
|---|---|---|---:|---|
| RE-2026-0412 | Müller & Söhne GmbH | 2026-10-12 | 24.380,00 € | ⚠️ überfällig |
| RE-2026-0418 | Bäckerei Größl | 2026-10-20 | 12.150,50 € | ⚠️ überfällig |
| RE-2026-0433 | Stadtwerke Köln | 2026-11-02 | 87.900,00 € | offen |
| RE-2026-0440 | Weber IT | 2026-11-05 | 10.004,99 € | offen |
| RE-2026-0451 | Ölmühle Hansen KG | 2026-11-14 | 15.600,00 € | offen |

Soll ich Mahnungen für die überfälligen vorbereiten?`,
    followUps: [
      { label: 'Mahnungen vorbereiten', prompt: 'Bereite Mahnungen für die überfälligen Rechnungen vor.' },
      { label: 'Nach Kunde sortieren', prompt: 'Sortiere die Liste nach Kunde.' },
    ],
  },

  lang: {
    text: `Alle Rechnungen aus Oktober (${34}):

| Nr. | Kunde | Datum | Betrag |
|---|---|---|---|
${invoices}`,
  },

  kunde: {
    text: `## Müller & Söhne GmbH

| Feld | Wert |
|---|---|
| Ansprechpartner | Jürgen Weiß |
| Umsatz 2026 | 184.220,00 € |
| Zahlungsziel | 30 Tage |
| Offene Posten | 2 |

---

#### Letzte Aktivität
Am 2026-10-27 wurde Angebot **AN-2026-118** versendet.`,
    verifier: { status: 'verified' },
  },

  matrix: {
    text: `Urlaubsübersicht Team Node (Tage):

| Name | Jan | Feb | Mär | Apr | Mai | Jun | Jul | Rest |
|---|---|---|---|---|---|---|---|---|
| Anna | 2 | 0 | 5 | 1 | 0 | 3 | 10 | 9 |
| Ben | 0 | 4 | 0 | 0 | 5 | 0 | 12 | 9 |
| Clara | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 23 |`,
  },

  projekte: {
    text: `Projektstatus:

| Projekt | Kunde | Owner | Phase | Start | Ende | Budget | Risiko |
|---|---|---|---|---|---|---|---|
| Delta Rewrite | Praxis QM GmbH | Team Node | Umsetzung Sprint 14 | 2026-03-01 | 2026-12-15 | 240.000 € | Abhängigkeit zur Beta-Migration |
| PX Notdienst | Pharmaworx GmbH | Team Node | Abnahme durch Kunde | 2026-05-10 | 2026-11-30 | 85.000 € | keins |`,
  },

  status: {
    text: `Stand der Integrationen:

| Integration | Status | Letzter Sync | Fehler |
|---|---|---|---:|
| Odoo | ✅ aktiv | vor 2 Min. | 0 |
| Microsoft 365 | ⚠️ Token läuft ab | vor 1 Std. | 3 |
| Jira | ❌ getrennt | vor 3 Tagen | 41 |`,
    disclaimer: 'Stand: letzter Health-Check der Integrationen.',
  },

  // Served by dev/run.mjs on localhost — unreachable for Discord's media
  // proxy, so it only shows up if the plugin uploads it itself (like a
  // diagram from a local or VPN-only Omadia).
  bild: {
    text: 'Hier das Diagramm zum Umsatzverlauf:',
    attachments: [
      {
        kind: 'image',
        url: `http://localhost:${process.env.PORT ?? 8787}/dev-assets/umsatz.png`,
        altText: 'Balkendiagramm: Umsatz 2026 in Tsd. €, Januar 120 bis Oktober 192',
      },
    ],
  },

  auswahl: {
    text: 'Für welchen Zeitraum soll ich den Bericht erstellen?',
    interactive: {
      kind: 'choice',
      question: 'Für welchen Zeitraum soll ich den Bericht erstellen?',
      options: [
        { label: 'Oktober', value: 'Bericht für Oktober' },
        { label: 'Q3', value: 'Bericht für Q3' },
        { label: 'Gesamtjahr', value: 'Bericht für das Gesamtjahr' },
      ],
    },
  },

  menu: {
    text: '',
    interactive: {
      kind: 'choice',
      question: 'Welchen Kunden meinst du?',
      options: Array.from({ length: 8 }, (_, i) => ({
        label: `Kunde ${i + 1} GmbH`,
        value: `Ich meine Kunde ${i + 1} GmbH`,
      })),
    },
  },

  code: {
    text:
      'Langer Code-Block (Chunk-/Fence-Test):\n```ts\n' +
      Array.from({ length: 160 }, (_, i) => `export const value${i} = ${i} * 2;`).join('\n') +
      '\n```',
  },

  noreply: { text: 'NO_REPLY' },
};

export function scriptedAnswer(message) {
  const m = String(message ?? '').toLowerCase();
  for (const [keyword, answer] of Object.entries(SCENARIOS)) {
    if (m.includes(keyword)) return answer;
  }
  return {
    text: `Echo: ${message}\n\n-# Testwörter: ${Object.keys(SCENARIOS).join(', ')}`,
  };
}
