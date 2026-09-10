// state.js — single source of truth for in-memory app state.
// No Firebase calls here, no UI rendering here. Just plain data + a way to react to changes.

export const S = {
  user: null,          // firebase auth user object
  profile: null,       // { displayName, avatar, color } from users/{uid}
  ledgers: {},         // { ledgerId: {name, icon, role} } — lightweight list for the ledger-picker screen
  ledgersReady: false, // true once ledgers has loaded at least once this session
  activeLedgerId: null,
  activeLedgerDetail: null, // full record from ledgers/{lid} (currency, inviteCode, etc.) — only loaded once a ledger is opened
  members: {},         // members of the active ledger { uid: {displayName, role, ...} }
  txs: {},             // transactions of the active ledger { txId: {...} }
  debugPreviewRole: null, // Owner-only testing tool: "member" | "moderator" | "guest" | null
  view: "home",        // "home" | "ledgers" | "personalBudget" | "aiSettings"
  categoriesBackView: null, // where the shared Categories page's back button returns to: "quickAdd" | "settings"
  personalBudget: {},  // this month's personal target, from users/{uid}/personalBudget/{ym}
  personalCategoryBudgets: {}, // this month's per-category personal targets
  includedLedgers: {}, // { lid: true } — which ledgers count toward the personal overview
  personalOverview: null, // computed on demand by budgets.js refreshPersonalOverview()
  recentTx: [],        // latest 5 transactions across flagged ledgers, for the Home screen
  ledgerBudget: {},    // active ledger's monthly target, from ledgers/{lid}/budgets/{ym}
  recurring: {},       // active ledger's recurring transaction templates
  tags: [],            // active ledger's shared tag list
  walletBalances: {},  // { currency: amount } — your real wallet balance, per currency
  walletTx: {},        // wallet top-up/transfer history
  walletRecurring: {}, // wallet recurring top-up templates (e.g. fixed pocket money)
  ledgerWalletBalance: 0, // active ledger's own shared/pooled wallet balance (in the ledger's currency)
  categories: {},      // active ledger's custom categories (empty = use DEFAULT_CATEGORIES)
  settlements: {},     // active ledger's recorded settlements
  homeSplitsOverview: null, // cross-ledger combined splits overview for Home
  homeBookmarksOverview: null, // cross-ledger bookmarked transactions overview for Home (flagged ledgers only)
  uiPrefs: { theme: "teal", cardStyle: "glass", chartStyle: "donut", iconStyle: "plain", homeStartup: "overview" }, // synced appearance settings; homeStartup: "overview" | "last" | a ledger id
  uiPrefsReady: false, // true once uiPrefs has loaded at least once this session
};

// Very small pub/sub so ui.js can re-render whenever state changes,
// without state.js needing to know anything about the DOM.
const listeners = new Set();
export function onStateChange(fn) { listeners.add(fn); }
export function notify() { listeners.forEach(fn => fn(S)); }
