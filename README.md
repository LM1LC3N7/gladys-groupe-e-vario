# Groupe E Vario for Gladys Assistant

**Unofficial**, not affiliated with Groupe E. Never tested with a real Gladys
energy contract nor a real meter yet (the Groupe E API was read for real on
2026-11-11).

A Gladys Assistant external integration for **Vario**, the optional dynamic
electricity tariff of Groupe E (Fribourg, Switzerland): a price for every
quarter hour, published the day before at about 15:00.

- Two delegated **energy contracts**: "Groupe E Vario (integrated price)" and
  "Groupe E Vario (grid)" (grid price plus an energy price typed), with an
  optional supplement per kWh, VAT and a fixed amount per month. Every half hour
  is priced as its two quarter hours; a quarter hour not published yet stays
  without a cost until it is, never a guessed price nor a zero.
- Two **price calendars**, `groupe-e-vario` and `groupe-e-vario-grid` (CHF/kWh,
  15 minutes, Europe/Zurich).
- The current price and the next one for the dashboard widget and the scenes.

Source: the public Groupe E tariff API, version 2,
`https://api.tariffs.groupe-e.ch/v2/tariffs` (no account, no key; the version 1
is retired). The next day is asked from 15:00 Swiss time, again every
30 minutes until complete; a complete day is never asked again.

Guides: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test                 # node --test, virtual clock and a scripted API
npm run lint && npm run format:check
node scripts/mutants.mjs # mutation check of the guards (use memcap)
```

Requires Gladys 5.3.0 or later (energy contracts, `countries`). Licence: Apache-2.0
(`LICENSE`); notices in `THIRD_PARTY_NOTICES.md`.
