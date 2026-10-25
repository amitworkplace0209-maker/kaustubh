# Trading Terminal

Real-time Kotak Neo trading application — orders, positions, holdings, P&L,
portfolio and account management.

- Routes: `/trading/*`
- Shell: `TRADING_SHELL` (`components/layout/nav.ts`)
- Default theme: Emerald + Dark
- Session mode: `kotak-dialog` (manual Kotak login / logout)

## Features

- **Dashboard** — account mode, connection status, totals, position summary.
- **Orders** — order placement, basket orders (cancel-on-fill), order entry
  with charge estimate.
- **Positions / Holdings / Portfolio** — live positions with SL, modify,
  square off; holdings; portfolio breakdown.
- **Account** — Demo (managed balances) or Live API mode.
- **Market Watch / Order History / Calculator** — gainers/losers filters,
  execution log, brokerage + charges calculator.
- **Notifications / Settings** — trading alerts and 10-category settings.

## No fake data

Every number comes from the live backend or the account store. On missing
data the UI shows Loading / Not Connected / No Data Available / Stale / Error —
never fabricated zeroes.

See `DETAILS.md` for route and component inventory.