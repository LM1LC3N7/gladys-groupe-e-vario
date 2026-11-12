# Groupe E Vario for Gladys Assistant

**Unofficial integration, not affiliated with Groupe E. Never tested with a real
Gladys energy contract nor a real meter yet; the Groupe E API itself was read
for real on 2026-11-11.**

Vario is the optional dynamic tariff of Groupe E (canton of Fribourg and
around): a different price for every quarter hour, published the day before at
about 15:00, and a bill computed on the meter's quarter-hour readings.

This integration adds two **energy contracts** and two **price calendars** to
Gladys:

- **Groupe E Vario (integrated price)**: the Vario integrated price (energy and
  grid) of each quarter hour;
- **Groupe E Vario (grid)**: the Vario grid price of each quarter hour, plus the
  energy price you type (when your energy is billed apart);
- the calendars `groupe-e-vario` (integrated price) and `groupe-e-vario-grid`
  (grid price), in CHF/kWh per quarter hour, that other contract templates can
  read.

## Source

The public tariff API of Groupe E, version 2:
`https://api.tariffs.groupe-e.ch/v2/tariffs` (no account, no key). Groupe E
retired the version 1 (it answers "410 Gone"); if the version 2 goes too, the
status says so ("the API v2 is gone") and the integration needs an update.
Groupe E publishes no terms of use for this API (none found on 2026-11-11): the
integration spares it (see below) and names itself with its own User-Agent.
Your bill always prevails.

## Getting started

1. Install the integration (Gladys 5.3.0 or later, nothing to configure).
2. In **Energy → Contracts**, create a "Groupe E Vario (integrated price)" or
   "Groupe E Vario (grid)" contract on your main meter.
3. Type, if needed:
   - **Energy price per kWh** (grid template only), before VAT, 0 to 2 CHF;
   - **Supplement per kWh**: what is billed per kWh and not in the Vario price
     (federal grid surcharge, municipal charges…), before VAT, 0 to 2 CHF;
   - **VAT**, 0 to 100 %, added to the whole price per kWh. 0 keeps the prices
     as Groupe E publishes them: check on your bill whether they already include
     VAT (8.1 % in 2026);
   - **Fixed amount per month** (subscription, metering), VAT included, 0 to
     1000 CHF, computed by Gladys.

An input out of these bounds is not priced (the status counts those contracts).

## How each half hour is priced

Gladys sends half hours; Vario prices change every quarter hour. A half hour is
priced as its two quarter hours, each with half of the energy (the Gladys
convention for quarter-hour calendars):

cost = (½ kWh × price of the 1st quarter + ½ kWh × price of the 2nd quarter +
kWh × (energy typed + supplement)) × (1 + VAT).

- **A missing price is never guessed nor counted 0**: when a quarter hour is not
  known yet, the Gladys request fails, the half hour stays without a cost, and
  Gladys computes it again later (about every 30 minutes). The missing day is
  asked from Groupe E in the background.
- The price never depends on the network at pricing time: only the prices
  already received are used; a retry of Gladys gets the same answer.
- **Negative price**: Gladys refuses a negative cost for a delegated contract. A
  half hour whose total would be negative is counted 0 and labelled "negative
  price, counted 0". The current price is shown as it is.
- The **current price** (dashboard widget, "current price" scene condition) is
  the one of the current quarter hour, with the next one when published;
  unknown, it is empty, never 0.
- Clock changes: the spring day has 92 quarter hours, the autumn one 100; the
  hour from 02:00 to 03:00 seen twice in October has its own prices.

## When Groupe E is asked

- At the first start: the last 35 days, in windows of 7 days at most, one
  request at a time.
- Then: the next day, from 15:00 (Swiss time), then every 30 minutes until it
  is complete; a complete day is never asked again.
- A past day incomplete or empty (before the start of the API history, January
  2026): asked again once a day at most.
- A day a pricing request of Gladys did not find: asked a minute after the last
  request at the earliest (later after a failure).
- After a failure: tried again after 5, 15, 30 minutes, 1 h, then every
  3 hours; a "429" follows its `Retry-After` (between 1 minute and 6 hours,
  10 minutes without the header), kept in `/data`; a retired API (404/410) is
  asked again every 6 hours. A failure stops the other windows until the next
  attempt.
- The time of each attempt is written to `/data` before the request: a restart
  or a reconnection does not ask sooner.
- Bounded answers: 30 seconds, 2 MB, 1000 quarter hours; a redirect is never
  followed.

## What an answer may not carry

A quarter hour is kept only when its start and end are exact ISO instants
15 minutes apart, on the quarter, and both of its prices numbers in `CHF_kWh`
between −5 and 5 CHF. Another unit is never converted, a text or an empty value
is never a 0, two different prices for one quarter hour: neither is believed.
An answer never makes a price already received forgotten. A complete day is
not asked again, so a later correction by Groupe E is not seen; a quarter hour
received again with another price (a day asked again while incomplete) replaces
the old one and is published again to the calendar, but the costs Gladys
already computed are not computed again (Gladys does not offer it to a
delegated contract).

## Status

The status of the integration tells: up to which day the prices are known, the
time of the last Groupe E publication, the last check, the error of the last
attempt and the time of the next one, a today or tomorrow not complete, a
calendar refused, the contracts with an input out of bounds, a `/data` that
cannot be read or written.

## Calendars

The keys `groupe-e-vario` and `groupe-e-vario-grid` name the tariff Groupe E
publishes. If another integration declared them first, Gladys refuses this one's
writes (the status says so); this integration's contracts keep working, they do
not read the calendars. A calendar not fed (Gladys unreachable) is tried again
at the next check or reconnection, without a new request to Groupe E.

## Data kept

`/data/groupe-e-vario-state.json`: the prices per day (400 days at most), the
time of the attempts, the pause if any, what each calendar received. No secret,
no personal data. A file that does not read is read again every 10 seconds
without asking Groupe E anything, and never overwritten with an empty state.

## Limits

- Gladys cannot express a negative cost for a delegated contract: counted 0.
- A correction by Groupe E of a day already complete is not seen, and Gladys
  does not compute again the past costs of a delegated contract.
- The "integrated" price is taken as Groupe E publishes it: what it includes
  (VAT, levies) was not checked against a bill.
