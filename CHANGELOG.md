# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-12

### Added

- Two delegated energy contracts, "Groupe E Vario (integrated price)" and
  "Groupe E Vario (grid)": every half hour priced as its two quarter hours
  (Swiss time, clock changes included), a supplement per kWh, the energy price
  (grid template) and VAT added as typed, a fixed amount per month computed by
  Gladys. A quarter hour not published yet fails the request (no cost, Gladys
  retries), never a zero; a negative total is counted 0 and labelled.
- The current price and the next one for the dashboard and the scenes.
- The calendars `groupe-e-vario` and `groupe-e-vario-grid` (15 minutes, CHF),
  fed with the days not received yet, retried at the next check or
  reconnection.
- The public Groupe E tariff API v2: the last 35 days at the first start, then
  the next day from 15:00 Swiss time, every 30 minutes until complete; a day a
  pricing request lacks asked in the background; back-off, 429 pause and the
  time of the attempt kept in `/data`; a retired API (404/410) said in the
  status.
- `THIRD_PARTY_NOTICES.md`, shipped in the image with `LICENSE`.
- VAT input bounded to 0-25 %, and a half hour above 10 CHF/kWh (the Gladys
  limit) refused with a reason, the current price too (none shown); the status
  gives the real time of the next attempt after a failure.
- The manifest declares `countries: ["CH"]` (Switzerland only), so it needs
  Gladys 5.3.0 or later.

### Changed

- The CI jobs stop after 30 minutes (`timeout-minutes`).

[Unreleased]: https://github.com/LM1LC3N7/gladys-groupe-e-vario/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-groupe-e-vario/releases/tag/v0.1.1
