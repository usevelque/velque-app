# velque-app

The web app for [Velque](https://usevelque.xyz): a single page, no framework, that trades the test market in all three sessions.

Live at **[usevelque.xyz/app](https://usevelque.xyz/app)**.

## What it shows

- **Session card.** Day book, night auction or opening cross, with the timer that matters for that session and the reference price broken down as `Nasdaq NVDA $230.47 x 1.0017` (exchange price times the token's dividend multiplier).
- **Book.** By day a two-sided ladder with the spread. By night the orders collected in the current window. The test-market maker's orders are labelled.
- **Order ticket.** By day it previews what will fill at once and at what average price. It refuses a price outside the band and an order under the market minimum before a transaction is built.
- **Your orders and fills.** Open auction orders, resting Day orders, and everything waiting to be claimed, each with its action.
- **Auction log.** Every cleared window still stored on chain, with a Verify button that recomputes the result in the browser from the stored orders.

Three test stocks are listed: tNVDAx, tTSLAx and tAAPLx. They are Token-2022 mints with 8 decimals and the same dividend multiplier as the real xStocks, so the app handles the real tokens the same way.

