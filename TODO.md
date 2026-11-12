# TODO

## Before announcing

- [ ] Test on a real Gladys 5.3+: install, the status, both contracts on a
      meter, the costs of a day, the dashboard price widget, the calendars.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store field left out of the manifest: `keywords` (Groupe E, Vario,
      tarif dynamique, Fribourg, quart d'heure).

## To confirm

- [ ] What the "integrated" price includes (VAT, federal surcharge, municipal
      charges): compare with a Vario bill, then adjust the default VAT (0 now)
      and the docs.
- [ ] The terms of use of the API (none published on 2026-11-11): ask Groupe E
      if the integration becomes popular.
- [ ] How the core shows a delegated contract that throws (the reason in the
      supervision, the catch-up once the day arrives).
- [ ] Whether Groupe E announces a v3 (the v1 answers 410): the status tells a
      404/410 of the v2.

## Ideas

- A recomputation of the past costs when Groupe E corrects a price (the core
  offers no dated recalculation to a delegated integration).
- Rules templates reading the calendars, once the core can leave an interval
  without a cost instead of applying a `fallback` price.

## Decisions

- **Version 0.1.0** set once by hand when leaving the template (package, lock
  file, manifest, image tag `ghcr.io/lm1lc3n7/gladys-groupe-e-vario:0.1.0`);
  the Release workflow owns it from now on.
- **`type: "provider"`, `gladys_version: ">=5.3.0"`, `countries: ["CH"]`**: no
  device, the energy contract capability only (Gladys 5.2), and Switzerland
  only, which the `countries` field needs Gladys 5.3 for (Louis, 2026-11-12);
  SDK ^0.16.0, the latest on 2026-11-11.
- **Delegated templates, not rules**: a rules template reading the calendar
  applies its `fallback` price to a missing quarter hour, which would be a
  guessed price. Delegated, a missing quarter fails the request: no cost, the
  core retries. Two templates (integrated, grid) rather than a select input.
- **Calendars too** (`groupe-e-vario`, `groupe-e-vario-grid`, 15 minutes, no
  enum): the key names the tariff Groupe E publishes, not this integration, so
  any integration feeding the same prices can own it. Granularity fixed for
  good (the core never changes it).
- **API v2 only** (`/v2/tariffs?start_timestamp=&end_timestamp=`): the v1
  answers 410 Gone. 404 or 410 on the v2 is the `retired` error, asked again
  every 6 hours and said in the status. History starts on 2026-01-01 (empty
  before).
- **Schedule**: Groupe E publishes D+1 at about 14:50: asked from 15:00, every
  30 minutes while incomplete; a past day incomplete once a day; a day lacked
  by a pricing request a minute after the last request at the earliest. The
  time of the attempt goes to `/data` first. The process never sleeps more than
  an hour (the plan is decided again on the wall clock).
- **Strict reading**: unit `CHF_kWh` only, |price| ≤ 5 CHF, exact ISO instants
  15 minutes apart on the quarter, two different prices for one quarter: none.
  An answer never erases a price held; a changed price replaces it.
- **Negative total counted 0** (the core refuses a negative cost), labelled.
- **Inputs**: energy price (grid template) and supplement 0-2 CHF/kWh before
  VAT, VAT 0-25 % on the whole (with the energy and supplement bounds, a price could
  still pass the core limit of 10 CHF/kWh: such a half hour is refused with a reason) (0 by default: unknown whether the published
  price includes it), fixed 0-1000 CHF/month (a `fixed` component the core
  computes). Checked by the module; an empty input takes its default.
- **No configuration, no button**: the inputs belong to the contract.
- **CI**: `timeout-minutes: 30` on the jobs (a test that hangs never blocks a
  runner); the release tag of this first version is set by hand.
