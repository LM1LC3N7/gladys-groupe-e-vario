# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). Its
code is its own: no third-party code is copied or ported.

## Groupe E tariff API (data)

At run time the integration reads the public tariff API of Groupe E SA,
version 2: `https://api.tariffs.groupe-e.ch/v2/tariffs` (no account, no key;
answer format read on 2026-11-11). Groupe E publishes no terms of use for this
API (none found on 2026-11-11); the prices remain those of Groupe E, the
integration only reads them a few times a day, keeps them in its `/data` volume
and never ships them in this repository nor in the Docker image (the test
fixtures are made-up prices). "Groupe E" and "Vario" are names of Groupe E SA,
used here only to say which tariff is read.

Changes made to the data: a 30-minute interval is priced as its two quarter
hours; the supplement, the energy price and the VAT typed by the user are
added; a negative total is counted 0 (Gladys refuses a negative cost). A quarter
hour that does not read is left unknown.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), the Gladys SDK.
