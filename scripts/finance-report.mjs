#!/usr/bin/env node
/**
 * Summarise an exported ledger. Offline by design: it reads one JSON file and prints figures that
 * are derived only from records in that file. No credentials, no network, no inferred values.
 *
 * Usage:
 *   node scripts/finance-report.mjs ledger.json
 *   node scripts/finance-report.mjs ledger.json --json
 *
 * Ledger shape (all arrays optional):
 *   { revenueEvents, payouts, approvals, expenses, assets, liabilities, period, primaryCurrency }
 */

import { readFileSync } from "node:fs";
import { summarizeFinanceFile } from "../ax-finance.mjs";

const file = process.argv[2];
const asJson = process.argv.includes("--json");

if (!file) {
  console.error("usage: node scripts/finance-report.mjs <ledger.json> [--json]");
  process.exitCode = 2;
} else {
  let document;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error("could not read " + file + ": " + String(error?.message || error));
    process.exitCode = 2;
  }

  if (document !== undefined) {
    const summary = summarizeFinanceFile(document);
    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const money = (cents) => (cents / 100).toFixed(2);
      const p = summary.primary;
      console.log("Habitat financial report — " + summary.primaryCurrency + " — as of " + summary.asOf);
      if (summary.period) console.log("period: " + (summary.period.from || "start") + " → " + (summary.period.to || "now"));
      console.log("");
      console.log("revenue (cash)        " + money(p.revenueCents));
      console.log("refunds               " + money(p.refundsCents));
      console.log("pipeline (not cash)   " + money(p.pipelineCents));
      console.log("expenses paid         " + money(p.expensesPaidCents));
      console.log("expenses committed    " + money(p.expensesDueCents));
      console.log("monthly run rate      " + money(p.monthlyRunRateCents));
      console.log("profit                " + money(p.profitCents) + (p.marginPct === null ? "" : "  (" + p.marginPct + "%)"));
      console.log("net cash flow         " + money(p.netCashFlowCents));
      console.log("");
      console.log("verified assets       " + money(p.verifiedAssetsCents));
      console.log("claimed assets        " + money(p.claimedAssetsCents));
      console.log("liabilities           " + money(p.liabilitiesCents));
      console.log("VERIFIED NET WORTH    " + money(p.verifiedNetWorthCents));
      console.log("claimed net worth     " + money(p.claimedNetWorthCents) + "  (includes unverified assets)");
      console.log("");
      if (summary.otherCurrencies.length) console.log("other currencies (not summed): " + summary.otherCurrencies.join(", "));
      if (summary.rejectedCount) {
        console.log("rejected records: " + summary.rejectedCount);
        for (const item of summary.rejected.slice(0, 10)) console.log("  - " + (item.id || "?") + ": " + item.code);
      }
      if (summary.outOfPeriodCount) console.log("records outside the period: " + summary.outOfPeriodCount);
      console.log("");
      console.log(summary.note);
    }
  }
}
