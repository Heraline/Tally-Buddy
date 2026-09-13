// ui.js — plain, minimal rendering just to prove Phase 2 works end-to-end.
// This is NOT the final look — the 5-theme system from Phase 1 gets wired
// in during a later phase. Right now this only renders into <div id="app">.

import { S } from "./state.js";
import { can, isOwner, canDeleteTx, canRemoveMembers, canManageRoles, canDeleteLedger, canManageCategories, canManageTags, GRANTABLE_PERMISSIONS } from "./permissions.js";
import { currentYM } from "./budgets.js";
import { FREQUENCIES } from "./recurring.js";
import { computeBalances } from "./splits.js";
import { groupedCategories, EMOJI_PALETTE, DEFAULT_CATEGORIES } from "./categories.js";
import { tagUsageCounts } from "./tags.js";
import { getGeminiKey } from "./receipt.js";
import { THEMES } from "./theme.js";

const app = document.getElementById("app");

// System icons (nav, panel headers, buttons) use the Tabler icon font,
// rendered plain or inside a small colored badge depending on the user's
// "Icon style" preference. Category icons stay user-picked emoji — this
// only applies to fixed/system UI chrome.
function sysIcon(name) {
  const style = S.uiPrefs?.iconStyle || "plain";
  if (style === "badge") return `<span class="sys-icon-badge"><i class="ti ti-${name}" aria-hidden="true"></i></span>`;
  return `<i class="ti ti-${name} sys-icon" aria-hidden="true"></i>`;
}
function navIcon(name) {
  const style = S.uiPrefs?.iconStyle || "plain";
  if (style === "badge") return `<span class="nav-icon-badge"><i class="ti ti-${name}" aria-hidden="true"></i></span>`;
  return `<i class="ti ti-${name}" aria-hidden="true"></i>`;
}

function todayFormatted() {
  return new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}
function timeBasedGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// Best-effort emoji for a transaction's category label. Recent Transactions
// spans multiple ledgers, each with its own (possibly custom) category list,
// so we don't always have the exact icon on hand — fall back to the shared
// default set, then a generic icon.
function categoryEmoji(label) {
  const found = Object.values(DEFAULT_CATEGORIES).find((c) => c.label === label);
  return found?.icon || "💳";
}

// Groups a list of transactions (already sorted newest-first) into
// {label, items} buckets by day — "Today", "Yesterday", then a short date.
function groupTxByDay(txs) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const yestStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const groups = [];
  const byLabel = {};
  txs.forEach((t) => {
    let label;
    if (t.date === todayStr) label = "Today";
    else if (t.date === yestStr) label = "Yesterday";
    else label = t.date ? new Date(t.date).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "Earlier";
    if (!byLabel[label]) { byLabel[label] = []; groups.push(label); }
    byLabel[label].push(t);
  });
  return groups.map((label) => ({ label, items: byLabel[label] }));
}

// Net "you are owed / you owe" for one ledger, from the cross-ledger splits
// overview computed on Home load (S.homeSplitsOverview). Returns null while
// that data hasn't loaded yet, so the caller can show a neutral state.
function myLedgerSplitLine(lid) {
  const entry = S.homeSplitsOverview?.perLedger?.find((p) => p.lid === lid);
  if (!entry) return null;
  let owed = 0, owe = 0;
  entry.balances.forEach((b) => {
    if (b.to === S.user.uid) owed += b.amount;
    if (b.from === S.user.uid) owe += b.amount;
  });
  const net = owed - owe;
  if (Math.abs(net) < 0.01) return { text: "All settled", cls: "muted" };
  if (net > 0) return { text: `You're owed ${entry.currency} ${net.toFixed(2)}`, cls: "income" };
  return { text: `You owe ${entry.currency} ${Math.abs(net).toFixed(2)}`, cls: "expense" };
}

// Re-attaches the scroll listener that keeps the swipe-card dots in sync.
// Needed after every render() because ui.js rebuilds app.innerHTML from
// scratch each time, which discards any previously attached listeners.
function wireHomeCardSwipe() {
  const track = document.getElementById("homeCardTrack");
  const dots = document.querySelectorAll("#homeCardDots .card-dot");
  if (!track || !dots.length) return;
  track.addEventListener("scroll", () => {
    const idx = Math.round(track.scrollLeft / track.clientWidth);
    dots.forEach((d, i) => d.classList.toggle("active", i === idx));
  });
}

// ===== Home: tap-to-reveal ledger switcher row =====
// Registered once at module load (not per-render) so listeners never pile
// up across re-renders — the handlers just look up the current DOM by id
// each time, which works fine since #app is fully replaced on every render.
let homeLedgerRowOpen = false;
let ledgerRowAutoCloseTimer = null;
const LEDGER_ROW_AUTO_CLOSE_MS = 4000; // auto-close after this long with no interaction

function closeLedgerRow() {
  clearTimeout(ledgerRowAutoCloseTimer);
  ledgerRowAutoCloseTimer = null;
  if (!homeLedgerRowOpen) return;
  homeLedgerRowOpen = false;
  document.getElementById("ledgerPulldownWrap")?.classList.remove("open");
}

function scheduleLedgerRowAutoClose() {
  clearTimeout(ledgerRowAutoCloseTimer);
  ledgerRowAutoCloseTimer = setTimeout(closeLedgerRow, LEDGER_ROW_AUTO_CLOSE_MS);
}

document.addEventListener("click", (e) => {
  const wrap = document.getElementById("ledgerPulldownWrap");
  if (!wrap) return;

  const hint = document.getElementById("ledgerPulldownHint");
  if (hint && hint.contains(e.target)) {
    homeLedgerRowOpen = !homeLedgerRowOpen;
    wrap.classList.toggle("open", homeLedgerRowOpen);
    if (homeLedgerRowOpen) scheduleLedgerRowAutoClose();
    else clearTimeout(ledgerRowAutoCloseTimer);
    return;
  }

  // Tapped a tile inside the open row (switching ledgers, Add Ledger, etc.)
  // -> keep it open, just restart the inactivity countdown.
  if (homeLedgerRowOpen && wrap.contains(e.target)) {
    scheduleLedgerRowAutoClose();
    return;
  }

  // Tapped anywhere else on the page while the row is open -> close it
  // immediately (an explicit dismiss, separate from the inactivity timer).
  if (homeLedgerRowOpen && !wrap.contains(e.target)) {
    closeLedgerRow();
  }
}, true); // capture phase — must run before index.js's #app click handler
          // re-renders and detaches e.target, or wrap.contains(e.target)
          // below would wrongly read as "clicked outside"


export function render() {
  document.body.classList.toggle("qa-active", S.view === "quickAdd" && !S.activeLedgerId);
  if (!S.user) return renderLogin();
  if (S.view === "aiSettings") return renderAiSettings();
  if (S.view === "settingsAppearance") return renderAppearancePage();
  if (S.view === "settingsStartup") return renderStartupPage();
  if (S.view === "settingsCurrency") return renderCurrencyPage();
  if (S.view === "settingsLedgerCurrency") return renderLedgerCurrencyPage();
  if (S.view === "settingsCategoriesAndBudget") return renderSettingsCategoriesAndBudgetPage();
  if (S.view === "ledgerSection") return renderLedgerSectionPage();
  if (S.view === "settingsAiReceipt") return renderAiReceiptScanPage();
  if (S.activeLedgerId) {
    if (S.view === "splits") return renderSplitsPage();
    if (S.view === "bookmarked") return renderBookmarkedPage();
    if (S.view === "ledgerManage") return renderLedgerDetail();
    if (S.view === "ledgerBudget") return renderLedgerBudgetPage();
    if (S.view === "ledgerWallet") return renderLedgerWalletPage();
    if (S.view === "categories") return renderCategoriesPage();
    if (S.view === "tags") return renderTagsPage();
    if (S.view === "recurring") return renderRecurringPage();
    return renderHome();
  }
  if (S.view === "personalBudget") return renderPersonalBudget();
  if (S.view === "ledgers") return renderLedgerList();
  if (S.view === "homeSplits") return renderHomeSplitsPage();
  if (S.view === "homeBookmarks") return renderHomeBookmarksPage();
  if (S.view === "wallet") return renderWalletPage();
  if (S.view === "quickAdd") return renderQuickAddPage();
  return renderHome();
}

function budgetProgress(pct, over) {
  if ((S.uiPrefs?.chartStyle || "donut") === "donut") {
    const r = 26, circumference = 2 * Math.PI * r;
    const offset = circumference - (pct / 100) * circumference;
    return `
      <div class="ring-wrap">
        <svg viewBox="0 0 60 60">
          <circle cx="30" cy="30" r="${r}" fill="none" stroke="var(--budget-track)" stroke-width="6" />
          <circle cx="30" cy="30" r="${r}" fill="none" stroke="${over ? "var(--budget-over)" : "var(--accent)"}" stroke-width="6"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round" transform="rotate(-90 30 30)" />
        </svg>
        <span class="ring-pct">${pct}%</span>
      </div>`;
  }
  return `<div class="budget-bar-track"><div class="budget-bar-fill ${over ? "over" : ""}" style="width:${pct}%"></div></div>`;
}

// Rebuilds the equal-split-by-default amount inputs for a group of selected
// people. Called from index.js (not during a full render) whenever chip
// selection or the total amount changes — keeps typed form values intact.
export function splitAmountRowsHtml(uids, totalAmount, group) {
  if (!uids.length) return "";
  const share = (Number(totalAmount) || 0) / uids.length;
  return uids.map((uid) => {
    const m = S.members[uid];
    return `
      <div class="split-amt-row">
        <span>${m?.avatar || "🙂"} ${m?.displayName || uid}</span>
        <input type="number" step="0.01" class="split-amt-input" data-amt-group="${group}" data-amt-uid="${uid}" value="${share.toFixed(2)}" />
      </div>`;
  }).join("");
}

function renderLogin() {
  app.innerHTML = `
    <div class="auth-box">
      <h2>Tally Buddy</h2>
      <div id="authError" class="error"></div>
      <input id="authName" placeholder="Name (sign up only)" />
      <input id="authEmail" type="email" placeholder="Email" />
      <input id="authPass" type="password" placeholder="Password" />
      <div class="btn-row">
        <button id="btnLogin">Log in</button>
        <button id="btnSignup" class="secondary">Sign up</button>
      </div>
    </div>`;
}

function categoryOptionsHtml(selectedLabel) {
  const { expense, income } = groupedCategories();
  const opt = (c) => `<option value="${c.label}" ${c.label === selectedLabel ? "selected" : ""}>${c.icon} ${c.label}</option>`;
  return `
    <optgroup label="Expense">${expense.map(opt).join("")}</optgroup>
    <optgroup label="Income">${income.map(opt).join("")}</optgroup>`;
}

function ledgerIcon(icon) {
  // Old app allowed custom uploaded icons (long image data), not just emoji.
  if (icon && icon.startsWith("data:image")) {
    return `<img src="${icon}" class="icon-img" alt="" />`;
  }
  return `<span class="icon">${icon || "💼"}</span>`;
}

// Same shape of numbers as the personal overview, but computed for just
// the active ledger from data that's already live-streamed in (S.txs,
// S.ledgerBudget) — no extra Firebase reads needed, unlike the multi-ledger
// personal overview which spans several ledgers and has to fetch on demand.
function ledgerHomeStats() {
  const ledger = S.activeLedgerDetail || {};
  const currency = ledger.currency || "USD";
  const ym = currentYM();
  const today = new Date().toISOString().slice(0, 10);
  let spentToday = 0, spent = 0, received = 0, totalBalance = 0;
  Object.values(S.txs || {}).forEach((t) => {
    totalBalance += t.type === "income" ? t.amount : -t.amount;
    if (t.type === "expense" && t.date === today) spentToday += t.amount;
    if (t.date?.startsWith(ym)) {
      if (t.type === "expense") spent += t.amount;
      else received += t.amount;
    }
  });
  const target = S.ledgerBudget?.total || 0;
  return { currency, spentToday, spent, received, totalBalance, target };
}

function renderHome() {
  const inLedger = !!S.activeLedgerId;
  const ledgerEntries = Object.entries(S.ledgers || {});
  const activeLedger = S.activeLedgerDetail || {};

  let homeCurrency, spentToday, totalBalance, target, spent, received;
  if (inLedger) {
    const stats = ledgerHomeStats();
    homeCurrency = stats.currency;
    spentToday = stats.spentToday;
    totalBalance = stats.totalBalance;
    target = stats.target;
    spent = stats.spent;
    received = stats.received;
  } else {
    const pb = S.personalBudget || {};
    homeCurrency = pb.homeCurrency || "USD";
    const overview = S.personalOverview;
    target = pb.total || 0;
    spent = overview?.total || 0;
    received = overview?.receivedThisMonth || 0;
    spentToday = overview?.spentToday || 0;
    totalBalance = overview?.totalBalance || 0;
  }
  const remaining = target - spent;
  const pct = target > 0 ? Math.min(100, Math.round((spent / target) * 100)) : 0;
  const over = target > 0 && spent > target;
  const today = new Date();
  const daysLeft = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate() + 1;
  const dailySafe = target > 0 ? Math.max(0, remaining) / daysLeft : 0;
  const netWorth = S.walletNetWorth;
  const budgetCardTitle = inLedger ? `${ledgerIcon(activeLedger.icon)} ${activeLedger.name || "Ledger"} Budget` : "This Month's Budget";
  const walletCardTitle = inLedger ? "Ledger Wallet" : "Pocket";
  const hasOverviewData = inLedger || !!S.personalOverview;

  app.innerHTML = `
    <div class="topbar">
      <div class="home-greeting">
        <div class="date-line">${todayFormatted()}</div>
        <div class="greeting-line">${timeBasedGreeting()}, ${S.profile?.displayName || "there"}!</div>
      </div>
      <div class="topbar-icons">
        <button id="btnHomeSearch" class="icon-btn" aria-label="Search" title="Search (coming soon)" disabled><i class="ti ti-search" aria-hidden="true"></i></button>
        <button id="btnHomeNotifications" class="icon-btn" aria-label="Notifications" title="Notifications (coming soon)" disabled><i class="ti ti-bell" aria-hidden="true"></i></button>
        <button id="btnHomeSettings" class="icon-btn" aria-label="Settings"><i class="ti ti-settings" aria-hidden="true"></i></button>
      </div>
    </div>

    <div class="ledger-pulldown-wrap ${homeLedgerRowOpen ? "open" : ""}" id="ledgerPulldownWrap">
      <div class="ledger-pulldown-hint" id="ledgerPulldownHint"><span class="pulldown-chevron">⌄</span></div>
      <div class="ledger-pulldown-row">
        <button class="ledger-pulldown-tile ${!inLedger ? "active" : ""}" data-nav="home">
          <span class="ledger-pulldown-icon">📊</span><span class="ledger-pulldown-label">Overview</span>
        </button>
        ${ledgerEntries.map(([lid, l]) => `
          <button class="ledger-pulldown-tile ${S.activeLedgerId === lid ? "active" : ""}" data-lid="${lid}">
            <span class="ledger-pulldown-icon">${ledgerIcon(l.icon)}</span><span class="ledger-pulldown-label">${l.name || "Untitled"}</span>
          </button>`).join("")}
        <button class="ledger-pulldown-tile ledger-pulldown-add" data-nav="ledgers">
          <span class="ledger-pulldown-icon">+</span><span class="ledger-pulldown-label">Add Ledger</span>
        </button>
      </div>
    </div>

    <div class="spent-balance-row">
      <div>
        <div class="date-line" style="text-transform:uppercase;letter-spacing:0.04em">Spent Today</div>
        <div class="spent-today-amount">${homeCurrency} ${spentToday.toFixed(2)}</div>
      </div>
      <div class="total-balance-pill">
        <span class="muted" style="font-size:11px">Total Balance</span>
        <span style="font-weight:700">${homeCurrency} ${totalBalance.toFixed(2)}</span>
      </div>
    </div>

    <div class="card-swipe-wrap">
      <div class="card-swipe-track" id="homeCardTrack">
        <div class="card-swipe-slide">
          <div id="btnHomeBudgetCard" class="panel card-button" role="button" tabindex="0">
            <div class="card-header-row">
              <h3 style="margin:0">${budgetCardTitle}</h3>
              <div class="card-mini-icons">
                <button class="mini-icon-btn" disabled title="Calendar (coming soon)"><i class="ti ti-calendar" aria-hidden="true"></i></button>
                <button class="mini-icon-btn" disabled title="Stats (coming soon)"><i class="ti ti-chart-bar" aria-hidden="true"></i></button>
              </div>
            </div>
            ${hasOverviewData ? `
              <div class="budget-stat-row">
                <div><span class="date-line">SPENDING</span><div class="expense" style="font-size:18px;font-weight:700">${homeCurrency} ${spent.toFixed(2)}</div></div>
                <div style="text-align:right"><span class="date-line">RECEIVING</span><div class="income" style="font-size:18px;font-weight:700">${homeCurrency} ${received.toFixed(2)}</div></div>
              </div>
              ${target > 0 ? budgetProgress(pct, over) : `<p class="muted">Set a${inLedger ? " ledger" : " personal"} budget target to see your progress here.</p>`}
              ${target > 0 ? `
                <div class="budget-stat-row" style="margin-top:8px">
                  <div><span class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:0.03em">Remaining</span><div style="font-size:16px;font-weight:700">${homeCurrency} ${remaining.toFixed(2)} <span class="muted" style="font-size:11px;font-weight:500">/ ${target.toFixed(2)}</span></div></div>
                  <div style="text-align:right"><span class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:0.03em">Daily Safe Spend</span><div style="font-size:16px;font-weight:700">${homeCurrency} ${dailySafe.toFixed(2)}</div></div>
                </div>
              ` : ""}
            ` : `<p class="muted">Set a personal budget target to see your overview here.</p>`}
            <p class="muted" style="margin-top:6px">Tap for details →</p>
          </div>
        </div>
        <div class="card-swipe-slide">
          <div id="btnHomeWalletCard" class="panel card-button" role="button" tabindex="0">
            <h3 style="margin:0">${walletCardTitle}</h3>
            ${inLedger ? `
              <div class="budget-stat-row" style="margin-top:8px">
                <div><span class="date-line">BALANCE</span><div style="font-size:18px;font-weight:700">${homeCurrency} ${(S.ledgerWalletBalance || 0).toFixed(2)}</div></div>
              </div>
            ` : (netWorth ? `
              <div class="budget-stat-row" style="margin-top:8px">
                <div><span class="date-line">NET</span><div style="font-size:18px;font-weight:700">${netWorth.homeCurrency} ${netWorth.net.toFixed(2)}</div></div>
              </div>
              <div class="net-worth-divider" style="margin:8px 0"></div>
              <div class="budget-stat-row">
                <div><span class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:0.03em">Wallet</span><div style="font-size:16px;font-weight:700">${netWorth.homeCurrency} ${netWorth.assets.toFixed(2)}</div></div>
                <div style="text-align:right"><span class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:0.03em">Borrow</span><div style="font-size:16px;font-weight:700">${netWorth.homeCurrency} ${netWorth.liabilities.toFixed(2)}</div></div>
              </div>
            ` : `<p class="muted">No funds yet — tap to add some.</p>`)}
            <p class="muted" style="margin-top:6px">Tap to manage →</p>
          </div>
        </div>
      </div>
      <div class="card-dots" id="homeCardDots">
        <span class="card-dot active" data-dot="0"></span>
        <span class="card-dot" data-dot="1"></span>
      </div>
    </div>

    ${inLedger ? renderLedgerTransactionsSection() : renderRecentTransactionsSection()}

    <div class="quick-tile-row">
      <button id="btnHomeSplits" class="quick-tile">${sysIcon("users-group")}<span>Splits & Settle</span></button>
      <button id="btnHomeBookmarked" class="quick-tile">${sysIcon("star")}<span>Bookmarked</span></button>
      <button class="quick-tile" disabled title="Coming soon">${sysIcon("pig-money")}<span>Saving Jar</span></button>
    </div>

    <button id="btnHomeQuickAdd" class="fab-add" aria-label="Add a transaction">
      <i class="ti ti-plus" aria-hidden="true"></i>
    </button>`;

  wireHomeCardSwipe();
}

// Ledger-focused equivalent of renderRecentTransactionsSection() — same
// look, but sourced from this one ledger's own live S.txs instead of the
// cross-ledger S.recentTx list.
function renderLedgerTransactionsSection() {
  const all = Object.values(S.txs || {}).sort((a, b) => b.ts - a.ts);
  const visibleCount = S.recentTxVisibleCount || 5;
  const visible = all.slice(0, visibleCount);
  const remaining = all.length - visible.length;
  const groups = groupTxByDay(visible);

  const txRowHtml = (t) => {
    const isShared = !!(t.splitWith?.length || (t.splitAmounts && Object.keys(t.splitAmounts).length));
    return `
      <div class="tx-row">
        <span class="tx-emoji">${categoryEmoji(t.category)}</span>
        <span class="tx-main">
          <span class="tx-title">${t.category}${t.description ? " — " + t.description : ""}</span>
          ${isShared ? `<span class="tx-sub muted">Shared</span>` : ""}
        </span>
        <span class="${t.type}">${t.type === "income" ? "+" : "-"}${(t.origAmount ?? t.amount).toFixed(2)}</span>
      </div>`;
  };

  return `
    <div class="section-header-row">
      <h3 style="margin:0">Recent Transactions</h3>
      <button class="link small" id="btnOpenLedgerManage">Add / View all</button>
    </div>
    <div class="tx-list">
      ${all.length ? groups.map((g) => `
        <div class="tx-day-label muted">${g.label}</div>
        ${g.items.map(txRowHtml).join("")}
      `).join("") : `<p class="muted">No transactions yet — tap the + button to add one.</p>`}
    </div>
    ${remaining > 0 ? `<button id="btnToggleRecentTx" class="link">Show ${Math.min(5, remaining)} more transaction${Math.min(5, remaining) > 1 ? "s" : ""}</button>` : ""}`;
}

function renderRecentTransactionsSection() {
  const all = S.recentTx || [];
  const visibleCount = S.recentTxVisibleCount || 5;
  const visible = all.slice(0, visibleCount);
  const remaining = all.length - visible.length;
  const groups = groupTxByDay(visible);

  const txRowHtml = (t) => {
    const isShared = !!(t.splitWith?.length || (t.splitAmounts && Object.keys(t.splitAmounts).length));
    const subtitle = isShared ? "Shared" : (t.ledgerName || "");
    return `
      <div class="tx-row">
        <span class="tx-emoji">${categoryEmoji(t.category)}</span>
        <span class="tx-main">
          <span class="tx-title">${t.category}${t.description ? " — " + t.description : ""}</span>
          ${subtitle ? `<span class="tx-sub muted">${subtitle}</span>` : ""}
        </span>
        <span class="${t.type}">${t.type === "income" ? "+" : "-"}${(t.origAmount ?? t.amount).toFixed(2)}</span>
      </div>`;
  };

  return `
    <div class="section-header-row">
      <h3 style="margin:0">Recent Transactions</h3>
      <button class="link small" disabled title="Coming soon">View All</button>
    </div>
    <div class="tx-list">
      ${all.length ? groups.map((g) => `
        <div class="tx-day-label muted">${g.label}</div>
        ${g.items.map(txRowHtml).join("")}
      `).join("") : `<p class="muted">No recent activity yet — flag a ledger to include in your budget to see it here.</p>`}
    </div>
    ${remaining > 0 ? `<button id="btnToggleRecentTx" class="link">Show ${Math.min(5, remaining)} more transaction${Math.min(5, remaining) > 1 ? "s" : ""}</button>` : ""}`;
}

const LEDGER_ICON_CHOICES = ["💼", "🏠", "✈️", "🎓", "🎉", "🚗", "🏢", "👨‍👩‍👧", "🐾", "🎁", "💰", "🛍️"];

function renderLedgerList() {
  const ledgers = Object.entries(S.ledgers || {});
  const modal = S.ledgerModal; // null | "add" | "join" | "edit"
  const editLedger = modal === "edit" ? (S.ledgers?.[S.editLedgerId] || {}) : null;

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromLedgers" class="btn-back" aria-label="Back to Home">${sysIcon("chevron-left")}</button>
      <div class="topbar-icons">
        <button type="button" id="btnOpenAddLedgerModal" class="icon-btn" aria-label="Add ledger" title="Add ledger"><i class="ti ti-plus" aria-hidden="true"></i></button>
        <button type="button" id="btnOpenJoinLedgerModal" class="icon-btn" aria-label="Join with code" title="Join with code"><i class="ti ti-link" aria-hidden="true"></i></button>
      </div>
    </div>
    <h2>Your ledgers</h2>
    <div id="ledgerList" class="ledger-list">
      ${ledgers.length ? ledgers.map(([lid, l]) => `
        <div class="ledger-card-row">
          <button class="ledger-card" data-lid="${lid}">
            ${ledgerIcon(l.icon)}
            <span>${l.name || "Untitled ledger"}</span>
            <span class="role">${l.role}</span>
          </button>
          <button type="button" class="ledger-edit-btn" data-edit-lid="${lid}" aria-label="Edit ${l.name || "ledger"}">${sysIcon("pencil")}</button>
          <label class="toggle-switch" title="Include in my budget overview">
            <input type="checkbox" data-include-lid="${lid}" ${S.includedLedgers?.[lid] ? "checked" : ""} />
            <span class="track"></span>
          </label>
        </div>`).join("") : `<p class="muted">No ledgers yet — tap + above to add one, or the link icon to join with a code.</p>`}
    </div>

    ${modal === "add" ? `
      <div class="qa-modal-backdrop" id="ledgerModalBackdrop">
        <div class="qa-modal-card">
          <div class="qa-modal-title">Add ledger</div>
          <div style="padding:0 18px 4px">
            <div id="createError" class="error"></div>
            <input id="newLedgerName" placeholder="Ledger name (e.g. Family)" />
            <p class="muted" style="margin:8px 0 6px">Icon</p>
            <div class="chip-row">
              ${LEDGER_ICON_CHOICES.map(ic => `<button type="button" class="chip ${S.newLedgerIcon === ic ? "active" : ""}" data-pick-new-icon="${ic}">${ic}</button>`).join("")}
            </div>
          </div>
          <div class="qa-modal-footer">
            <button type="button" class="qa-modal-cancel" id="btnCloseLedgerModal">Cancel</button>
            <button type="button" class="qa-modal-ok" id="btnCreateLedger">Add</button>
          </div>
        </div>
      </div>` : ""}

    ${modal === "join" ? `
      <div class="qa-modal-backdrop" id="ledgerModalBackdrop">
        <div class="qa-modal-card">
          <div class="qa-modal-title">Join with invite code</div>
          <div style="padding:0 18px 4px">
            <div id="joinError" class="error"></div>
            <input id="joinCode" placeholder="6-character code" />
          </div>
          <div class="qa-modal-footer">
            <button type="button" class="qa-modal-cancel" id="btnCloseLedgerModal">Cancel</button>
            <button type="button" class="qa-modal-ok" id="btnJoinLedger">Join</button>
          </div>
        </div>
      </div>` : ""}

    ${modal === "edit" ? `
      <div class="qa-modal-backdrop" id="ledgerModalBackdrop">
        <div class="qa-modal-card">
          <div class="qa-modal-title">Edit ledger</div>
          <div style="padding:0 18px 4px">
            <div id="editLedgerError" class="error"></div>
            <input id="editLedgerName" placeholder="Ledger name" value="${editLedger?.name || ""}" />
            <p class="muted" style="margin:8px 0 6px">Icon</p>
            <div class="chip-row">
              ${LEDGER_ICON_CHOICES.map(ic => `<button type="button" class="chip ${(S.editLedgerIcon ?? editLedger?.icon) === ic ? "active" : ""}" data-pick-edit-icon="${ic}">${ic}</button>`).join("")}
            </div>
          </div>
          <div class="qa-modal-footer">
            <button type="button" class="qa-modal-cancel" id="btnCloseLedgerModal">Cancel</button>
            <button type="button" class="qa-modal-ok" id="btnSaveLedgerEdit">Save</button>
          </div>
        </div>
      </div>` : ""}`;
}

function renderAiSettings() {
  const inLedger = !!S.activeLedgerId;
  const ledger = S.activeLedgerDetail || {};

  const menuRow = (id, icon, title, subtitle, opts = {}) => `
    <button type="button" id="${id}" class="panel card-button" style="text-align:left" ${opts.disabled ? "disabled" : ""}>
      <div class="card-header-row"><h3 style="margin:0">${sysIcon(icon)}${title}</h3><span>&rarr;</span></div>
      <p class="muted" style="margin:0">${subtitle}</p>
    </button>`;
  const soon = (icon, title) => menuRow(`btnSettingsSoon_${title.replace(/\s+/g, "")}`, icon, title, "Coming soon", { disabled: true });

  app.innerHTML = `
    <div class="topbar">
      <div style="display:flex;align-items:center;gap:10px">
        <button id="btnBackFromSettings" class="btn-back" aria-label="Back to Home">${sysIcon("chevron-left")}</button>
        <h2 style="margin:0">Settings</h2>
      </div>
      <button id="btnLogout" class="link">Log out</button>
    </div>

    <div class="panel">
      <h3>Preference</h3>
      ${soon("language", "Language")}
      ${menuRow("btnOpenAppearanceFromSettings", "palette", "Appearance", "Theme colors, card style, and icon style")}
      ${soon("icons", "Icon Library")}
      ${menuRow("btnOpenStartupFromSettings", "home", "Start up", "Choose what Home opens to")}
      ${soon("adjustments", "Simple mode")}
    </div>

    <div class="panel">
      <h3>General</h3>
      <p class="muted" style="margin-bottom:8px">Viewing settings for</p>
      <div class="context-pill-row" id="settingsContextRow">
        <button type="button" class="context-pill ${!inLedger ? "active" : ""}" data-context-lid="">🏠 Overview</button>
        ${Object.entries(S.ledgers || {}).map(([lid, l]) => `
          <button type="button" class="context-pill ${S.activeLedgerId === lid ? "active" : ""}" data-context-lid="${lid}">${l.icon || "💼"} ${l.name || "Untitled ledger"}</button>
        `).join("")}
      </div>

      ${menuRow("btnOpenLedgerSectionFromSettings", "wallet", "Ledger", inLedger ? `${ledger.name || "Current ledger"} — members, identity, switching` : "Switch, join, or create a ledger")}
      ${menuRow("btnOpenCurrencyFromSettings", "currency-dollar", "Currency", inLedger ? `${ledger.currency || "USD"} — this ledger's currency` : "Your personal overview currency")}
      ${menuRow("btnOpenCategoriesFromSettings", "tag", "Categories and Budget", inLedger ? "Manage categories and monthly target" : "Your personal budget target")}
      ${menuRow("btnOpenPocketFromSettings", "briefcase", "Pocket", inLedger ? "This ledger's shared wallet" : "Your personal wallet balance")}
      ${inLedger ? menuRow("btnOpenTagsFromSettings", "tags", "Tag", "Manage tags used across transactions") : ""}
      ${inLedger ? menuRow("btnOpenRecurringFromSettings", "repeat", "Recurring", "Manage recurring transaction templates") : ""}
      ${soon("bell", "Reminder")}
      ${soon("pig-money", "Saving Jar")}
    </div>

    <div class="panel">
      <h3>AI Feature</h3>
      ${soon("bolt", "Shortcuts")}
      ${menuRow("btnOpenAiReceiptFromSettings", "camera", "AI Receipt Scanning", "Gemini API key for scanning receipts")}
      ${soon("robot", "AI Buddy Assistant")}
    </div>

    <div class="panel">
      <h3>Data</h3>
      ${soon("file-export", "Export to CSV")}
      ${soon("trash", "Clear all data")}
    </div>

    <div class="panel">
      <h3>Support</h3>
      ${soon("help", "How to Use")}
    </div>

    <div class="panel">
      <h3>About</h3>
      ${soon("info-circle", "App intro")}
    </div>
  `;
}

// ---------- Preference sub-pages ----------

function renderAppearancePage() {
  const prefs = S.uiPrefs || {};
  const themeBtn = (t) => `<button class="opt-btn ${prefs.theme === t.key ? "active" : ""}" data-set-theme="${t.key}">${t.label}</button>`;
  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromAppearance" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <h2 style="margin:0">Appearance</h2>
      <span style="width:36px"></span>
    </div>
    <div class="panel">
      <p class="muted" style="margin-bottom:8px">Dark themes</p>
      <div class="btn-row" style="flex-wrap:wrap;margin-bottom:10px">${THEMES.dark.map(themeBtn).join("")}</div>
      <p class="muted" style="margin-bottom:8px">Light themes</p>
      <div class="btn-row" style="flex-wrap:wrap;margin-bottom:10px">${THEMES.light.map(themeBtn).join("")}</div>
      <p class="muted" style="margin-bottom:8px">Card style</p>
      <div class="btn-row" style="margin-bottom:10px">
        <button class="opt-btn ${prefs.cardStyle === "glass" ? "active" : ""}" data-set-card="glass">Glass / Blurred</button>
        <button class="opt-btn ${prefs.cardStyle === "flat" ? "active" : ""}" data-set-card="flat">Flat / Minimal</button>
      </div>
      <p class="muted" style="margin-bottom:8px">Budget progress style</p>
      <div class="btn-row" style="margin-bottom:10px">
        <button class="opt-btn ${prefs.chartStyle === "donut" ? "active" : ""}" data-set-chart="donut">Ring</button>
        <button class="opt-btn ${prefs.chartStyle === "bar" ? "active" : ""}" data-set-chart="bar">Bar</button>
      </div>
      <p class="muted" style="margin-bottom:8px">Icon style</p>
      <div class="btn-row">
        <button class="opt-btn ${(prefs.iconStyle || "plain") === "plain" ? "active" : ""}" data-set-icon-style="plain">Minimal</button>
        <button class="opt-btn ${prefs.iconStyle === "badge" ? "active" : ""}" data-set-icon-style="badge">Bold</button>
      </div>
    </div>`;
}

function renderStartupPage() {
  const prefs = S.uiPrefs || {};
  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromStartup" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <h2 style="margin:0">Start up</h2>
      <span style="width:36px"></span>
    </div>
    <div class="panel">
      <p class="muted" style="margin-bottom:8px">Home screen starts on</p>
      <select id="homeStartupSelect">
        <option value="overview" ${(prefs.homeStartup || "overview") === "overview" ? "selected" : ""}>Overview</option>
        <option value="last" ${prefs.homeStartup === "last" ? "selected" : ""}>Last viewed</option>
        ${Object.entries(S.ledgers || {}).map(([lid, l]) => `
          <option value="${lid}" ${prefs.homeStartup === lid ? "selected" : ""}>${l.name || "Untitled"}</option>
        `).join("")}
      </select>
    </div>`;
}

// ---------- General sub-pages ----------

function renderCurrencyPage() {
  const pb = S.personalBudget || {};
  const homeCurrency = pb.homeCurrency || "USD";
  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromCurrency" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <h2 style="margin:0">Currency</h2>
      <span style="width:36px"></span>
    </div>
    <div class="panel">
      <p class="muted" style="margin-bottom:8px">Used for your personal Overview and budget total. Each ledger keeps its own currency separately.</p>
      <select id="settingsHomeCurrency">
        ${["USD", "MYR", "SGD", "EUR", "GBP", "JPY", "AUD"].map(c => `<option value="${c}" ${homeCurrency === c ? "selected" : ""}>${c}</option>`).join("")}
      </select>
      <button id="btnSaveSettingsCurrency">Save</button>
    </div>`;
}

// The "Ledger" hub under General — switching ledgers, this ledger's members,
// its identity settings (rename/invite/delete), and the owner's preview
// tool. Members/settings/preview gray out when no ledger is open; switching
// ledgers works regardless.
function renderLedgerSectionPage() {
  const ledger = S.activeLedgerDetail || {};
  const realMember = S.members[S.user.uid];
  const iAmRealOwner = isOwner(realMember);
  const myMember = effectiveLedgerMember();
  const iAmOwner = isOwner(myMember);
  const memberEntries = Object.entries(S.members || {});

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromLedgerSection" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <h2 style="margin:0">${ledgerIcon(ledger.icon)} ${ledger.name || "Ledger"}</h2>
      <span style="width:36px"></span>
    </div>

    <button type="button" id="btnManageLedgers" class="link" style="margin-bottom:12px">${sysIcon("switch-3")}Switch / manage all ledgers</button>

    ${previewWrap(`
      <div class="panel">
        <h3>${sysIcon("users")}Members</h3>
        ${renderMembersPanel(memberEntries, myMember, iAmOwner)}
      </div>

      <div class="panel">
        <h3>Ledger settings</h3>
        ${renderSettingsPanel(ledger, myMember, iAmOwner)}
      </div>
    `)}

    ${iAmRealOwner ? `
      <div class="panel">
        <h3>🔍 Preview as <span class="muted" style="font-weight:400">(testing tool)</span></h3>
        <p class="muted" style="margin-bottom:8px">See this ledger as a different role would — nothing you do while previewing actually happens.</p>
        <select id="previewRoleSelect">
          <option value="" ${!S.debugPreviewRole ? "selected" : ""}>My real view (Owner)</option>
          <option value="moderator" ${S.debugPreviewRole === "moderator" ? "selected" : ""}>Moderator (all permissions)</option>
          <option value="member" ${S.debugPreviewRole === "member" ? "selected" : ""}>Member</option>
          <option value="guest" ${S.debugPreviewRole === "guest" ? "selected" : ""}>Guest</option>
        </select>
      </div>` : ""}
  `;
}

// ---------- AI Feature sub-pages ----------

function renderAiReceiptScanPage() {
  const hasKey = !!getGeminiKey();
  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromAiReceipt" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <h2 style="margin:0">AI Receipt Scanning</h2>
      <span style="width:36px"></span>
    </div>
    <div class="panel">
      <p class="muted" style="margin-bottom:10px">Used for scanning receipt photos. Get a free key at <strong>aistudio.google.com/apikey</strong>. It's stored only in this browser — never sent anywhere except directly to Google when you scan a receipt.</p>
      <div id="aiKeyError" class="error"></div>
      <input id="geminiKeyInput" type="password" placeholder="Paste Gemini API key..." value="${getGeminiKey()}" />
      <div class="btn-row">
        <button id="btnSaveAiKey">Save key</button>
        ${hasKey ? `<button id="btnClearAiKey" class="secondary">Remove key</button>` : ""}
      </div>
      ${hasKey ? `<p class="muted" style="margin-top:8px">✓ Key saved</p>` : ""}
    </div>`;
}

function fakePreviewMember(role) {
  if (role === "member") return { role: "member" };
  if (role === "guest") return { role: "guest", guest: true };
  if (role === "moderator") return {
    role: "moderator",
    permissions: { renameLedger: true, regenerateInvite: true, manageGuests: true, deleteOthersTx: true, removeMembers: true },
  };
  return null;
}

// The member to use for permission checks on any ledger-management page —
// honors the owner's "Preview as" testing tool (set from the Settings hub),
// so every sub-page (Categories, Tags, Recurring, Members) sees it the
// same way without recomputing this individually.
function effectiveLedgerMember() {
  const realMember = S.members[S.user.uid];
  const previewing = isOwner(realMember) && S.debugPreviewRole;
  return previewing ? fakePreviewMember(S.debugPreviewRole) : realMember;
}

// Wraps a sub-page's content in the dimmed, non-interactive "preview" state
// (with an explanatory banner) whenever the owner has a preview role active.
function previewWrap(innerHtml) {
  const realMember = S.members[S.user.uid];
  if (!(isOwner(realMember) && S.debugPreviewRole)) return innerHtml;
  return `<div class="preview-lock">
    <p class="preview-note">Previewing as <strong>${S.debugPreviewRole}</strong> — everything below is view-only, no actions will actually run.</p>
    ${innerHtml}
  </div>`;
}

function renderLedgerDetail() {
  const ledger = S.activeLedgerDetail || {};
  const txs = Object.entries(S.txs || {}).sort((a, b) => b[1].ts - a[1].ts);
  const balance = txs.reduce((sum, [, t]) => sum + (t.type === "income" ? t.amount : -t.amount), 0);
  const myMember = S.members[S.user.uid];

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromLedgerManage" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <button id="btnLogout" class="link">Log out</button>
    </div>

    <h2>${ledgerIcon(ledger.icon)} ${ledger.name || ""}</h2>
    <div class="balance">${(ledger.currency || "USD")} ${balance.toFixed(2)}</div>

    <h3>Recent activity</h3>
    <div class="tx-list">
      ${(() => {
        const activityTxs = txs.map(([id, t]) => ({ id, ...t }));
        const activityGroups = groupTxByDay(activityTxs);
        const activityRowHtml = (t) => {
          const isShared = !!(t.splitWith?.length || (t.splitAmounts && Object.keys(t.splitAmounts).length));
          const subtitleParts = [];
          if (isShared) subtitleParts.push("Shared");
          if (t.tags?.length) subtitleParts.push(t.tags.map(x => "#" + x).join(" "));
          const subtitle = subtitleParts.join(" · ");
          return `
            <div class="tx-row">
              <button type="button" class="link small star-btn" data-toggle-bookmark="${t.id}" data-bookmarked="${t.bookmarked ? "true" : "false"}" title="${t.bookmarked ? "Remove bookmark" : "Bookmark"}">${t.bookmarked ? "⭐" : "☆"}</button>
              <span class="tx-emoji">${t.fromRecurringId ? "🔄" : (t.account === "wallet" ? "🏦" : categoryEmoji(t.category))}</span>
              <span class="tx-main">
                <span class="tx-title">${t.category}${t.description ? " — " + t.description : ""}</span>
                ${subtitle ? `<span class="tx-sub muted">${subtitle}</span>` : ""}
              </span>
              <span class="${t.type}">
                ${t.type === "income" ? "+" : "-"}${(t.origAmount ?? t.amount).toFixed(2)} ${t.origCurrency || t.currency}
                ${t.origCurrency && t.origCurrency !== t.currency ? `<span class="muted" style="font-weight:400"> (≈ ${t.currency} ${t.amount.toFixed(2)})</span>` : ""}
              </span>
              ${canDeleteTx(myMember, t, S.user.uid) ? `<button class="link small" data-del="${t.id}">delete</button>` : ""}
            </div>`;
        };
        return activityTxs.length ? activityGroups.map((g) => `
          <div class="tx-day-label muted">${g.label}</div>
          ${g.items.map(activityRowHtml).join("")}
        `).join("") : `<p class="muted">No transactions yet.</p>`;
      })()}
    </div>
    <button id="btnHomeQuickAdd" class="fab-add" aria-label="Add a transaction"><i class="ti ti-plus" aria-hidden="true"></i></button>
  `;
}

// One shared Categories screen for the whole app — reached from Quick Add's
// '⋯' menu and from the Settings page's Categories row. S.categoriesBackView
// ("quickAdd" | "settings") tells the back button where to return to.
function renderCategoriesPage() {
  const fromQuickAdd = S.categoriesBackView === "quickAdd";
  const qa = S.quickAdd;
  // Quick Add can be adding to a ledger other than the one currently "open"
  // (S.activeLedgerId) — in that case we don't have a live tx listener for
  // it, so fall back to no spending figures rather than showing wrong ones.
  const sameLedger = !fromQuickAdd || !qa?.ledgerId || qa.ledgerId === S.activeLedgerId;
  const ledger = sameLedger ? (S.activeLedgerDetail || {}) : { currency: qa?.ledgerCurrency };
  const txs = sameLedger ? Object.entries(S.txs || {}) : [];
  const myMember = fromQuickAdd ? S.members?.[S.user.uid] : effectiveLedgerMember();

  app.innerHTML = `
    <div class="topbar">
      <button id="btnCategoriesBack" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <h2 style="margin:0">Categories</h2>
      <span style="width:36px"></span>
    </div>
    ${previewWrap(renderCategoriesPanel(myMember, txs, ledger))}
  `;
}

// Settings' General section "Categories and Budget" row, for a specific
// ledger — combines the overall monthly target (from the Ledger Budget
// page) with per-category budgets (from the Categories page) in one place.
function renderSettingsCategoriesAndBudgetPage() {
  const ledger = S.activeLedgerDetail || {};
  const myMember = effectiveLedgerMember();
  const txs = Object.entries(S.txs || {});

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromSettingsCategoriesAndBudget" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <h2 style="margin:0">Categories and Budget</h2>
      <span style="width:36px"></span>
    </div>
    ${previewWrap(`
      ${ledgerBudgetTargetPanelsHtml(ledger, myMember, txs)}
      ${renderCategoriesPanel(myMember, txs, ledger)}
    `)}
  `;
}

// Only changes the currency label going forward — doesn't retroactively
// convert amounts already recorded on existing transactions.
function renderLedgerCurrencyPage() {
  const ledger = S.activeLedgerDetail || {};
  const myMember = effectiveLedgerMember();
  const canEdit = isOwner(myMember);
  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromLedgerCurrency" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <h2 style="margin:0">Currency</h2>
      <span style="width:36px"></span>
    </div>
    ${previewWrap(`
      <div class="panel">
        <p class="muted" style="margin-bottom:8px">This ledger's currency. Changing it only affects budgets and new transactions going forward — amounts already recorded keep their original currency.</p>
        <select id="ledgerCurrencySelect" ${canEdit ? "" : "disabled"}>
          ${["USD", "MYR", "SGD", "EUR", "GBP", "JPY", "AUD"].map(c => `<option value="${c}" ${(ledger.currency || "USD") === c ? "selected" : ""}>${c}</option>`).join("")}
        </select>
        ${canEdit ? `<button id="btnSaveLedgerCurrency">Save</button>` : `<p class="muted">Only the owner can change this.</p>`}
      </div>
    `)}
  `;
}

function renderTagsPage() {
  const myMember = effectiveLedgerMember();
  const txs = Object.entries(S.txs || {});
  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromTags" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <h2 style="margin:0">Tags</h2>
      <span style="width:36px"></span>
    </div>
    ${previewWrap(renderTagsPanel(myMember, txs))}
  `;
}

function renderRecurringPage() {
  const ledger = S.activeLedgerDetail || {};
  const myMember = effectiveLedgerMember();
  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromRecurring" class="btn-back" aria-label="Back">${sysIcon("chevron-left")}</button>
      <h2 style="margin:0">Recurring</h2>
      <span style="width:36px"></span>
    </div>
    ${previewWrap(renderRecurringPanel(myMember, ledger))}
  `;
}

function renderLedgerWalletPage() {
  const ledger = S.activeLedgerDetail || {};
  const balance = S.ledgerWalletBalance || 0;
  const currency = ledger.currency || "USD";

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromLedgerWallet" class="btn-back" aria-label="Back to Home">${sysIcon("chevron-left")}</button>
      <button id="btnLogout" class="link">Log out</button>
    </div>
    <h2>${sysIcon("building-bank")}${ledgerIcon(ledger.icon)} ${ledger.name || "Ledger"} Wallet</h2>
    <p class="muted" style="margin-bottom:12px">Pooled money for this ledger's purpose. Fund-ins show up in the activity feed too.</p>

    <div class="panel">
      <h3>Balance</h3>
      <div class="balance" style="font-size:22px">${currency} ${balance.toFixed(2)}</div>
    </div>

    <div class="panel">
      <h3>Add funds</h3>
      <div id="ledgerFundError" class="error"></div>
      <input id="ledgerFundAmount" type="number" step="0.01" placeholder="Amount (${currency})" />
      <input id="ledgerFundNote" placeholder="Note (optional)" />
      <div class="btn-row">
        <button id="btnAddLedgerWallet" style="flex:1">${sysIcon("plus")}Add directly</button>
        <button id="btnFundLedgerWallet" class="secondary" style="flex:1">↔️ Transfer from my wallet</button>
      </div>
      <p class="muted" style="margin-top:6px">Add = cash or outside money not tracked in anyone's Pocket. Transfer = comes out of your own tracked Pocket balance.</p>
    </div>`;
}


// Shared fragment: "this month's spending" progress + editable target input.
// Used by both the standalone Ledger Budget page (Home's Budget card) and
// the combined "Categories and Budget" Settings page.
function ledgerBudgetTargetPanelsHtml(ledger, myMember, txs) {
  const canEdit = can(myMember, "manageBudget");
  const budget = S.ledgerBudget || {};
  const target = budget.total || 0;
  const currency = ledger.currency || "USD";
  const ym = currentYM();
  const spent = txs.filter(([, t]) => t.type === "expense" && t.date?.startsWith(ym)).reduce((sum, [, t]) => sum + t.amount, 0);
  const pct = target > 0 ? Math.min(100, Math.round((spent / target) * 100)) : 0;
  const over = target > 0 && spent > target;

  return `
    <div class="panel">
      <h3>This month's spending</h3>
      <div class="balance">${currency} ${spent.toFixed(2)} <span class="muted" style="font-size:14px">/ ${target ? target.toFixed(2) : "no target set"}</span></div>
      ${target > 0 ? `
        ${budgetProgress(pct, over)}
        ${over ? `<p class="budget-over">Over budget</p>` : `<p class="muted">${pct}% used</p>`}
      ` : `<p class="muted">Set a monthly target below to see your progress here.</p>`}
    </div>

    ${canEdit ? `
    <div class="panel">
      <h3>Target</h3>
      <div class="btn-row">
        <input id="ledgerBudgetInput" type="number" step="0.01" placeholder="Monthly target" value="${target || ""}" />
        <span class="muted" style="align-self:center;padding:0 8px 0 4px">${currency}</span>
      </div>
      <button id="btnSaveLedgerBudget">Save target</button>
    </div>` : ""}`;
}

function renderLedgerBudgetPage() {
  const ledger = S.activeLedgerDetail || {};
  const myMember = S.members?.[S.user.uid];
  const txs = Object.entries(S.txs || {});
  const ym = currentYM();

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromLedgerBudget" class="btn-back" aria-label="Back to Home">${sysIcon("chevron-left")}</button>
      <button id="btnLogout" class="link">Log out</button>
    </div>
    <h2>${sysIcon("chart-bar")}${ledgerIcon(ledger.icon)} ${ledger.name || "Ledger"} Budget — ${ym}</h2>
    ${ledgerBudgetTargetPanelsHtml(ledger, myMember, txs)}`;
}

function categoryRowHtml(c, canEdit, spentByCat, ledgerCurrency, isFirst, isLast) {
  const spent = spentByCat[c.label] || 0;
  const pct = c.budget ? Math.min(100, Math.round((spent / c.budget) * 100)) : null;
  return `
    <div class="cat-row">
      <button type="button" class="cat-emoji-btn" data-change-icon-key="${c.key}" ${canEdit ? "" : "disabled"}>${c.icon}</button>
      ${canEdit ? `
        <input class="cat-label-input" data-cat-field="label" data-cat-key="${c.key}" value="${c.label}" />
        <input class="cat-budget-input" type="number" step="0.01" data-cat-field="budget" data-cat-key="${c.key}" value="${c.budget || ""}" placeholder="Budget" />
        <div class="cat-row-actions">
          <button type="button" class="link small" data-move-cat="${c.key}" data-dir="up" ${isFirst ? "disabled" : ""}>↑</button>
          <button type="button" class="link small" data-move-cat="${c.key}" data-dir="down" ${isLast ? "disabled" : ""}>↓</button>
          <button type="button" class="link small" data-del-cat="${c.key}">🗑️</button>
        </div>
      ` : `<span class="cat-label-static">${c.label}</span>`}
    </div>
    ${pct !== null ? `
      <div class="cat-spend-line">
        <div class="budget-bar-track"><div class="budget-bar-fill ${pct >= 100 ? "over" : ""}" style="width:${pct}%"></div></div>
        <span class="muted">${ledgerCurrency} ${spent.toFixed(2)} / ${c.budget.toFixed(2)}</span>
      </div>` : (spent > 0 ? `<div class="cat-spend-line"><span class="muted">${ledgerCurrency} ${spent.toFixed(2)} spent this month</span></div>` : "")}`;
}

function renderCategoriesPanel(myMember, txs, ledger) {
  const canEdit = canManageCategories(myMember);
  const { expense, income } = groupedCategories();
  const ym = currentYM();
  const ledgerCurrency = ledger?.currency || "USD";
  const spentByCat = {};
  txs.forEach(([, t]) => {
    if (t.type === "expense" && t.date?.startsWith(ym)) spentByCat[t.category] = (spentByCat[t.category] || 0) + t.amount;
  });

  return `
    <div class="panel">
      <h3>${sysIcon("tag")}Categories</h3>

      <p class="muted" style="margin:6px 0 4px">Expense</p>
      <div class="cat-manage-list">
        ${expense.length ? expense.map((c, i) => categoryRowHtml(c, canEdit, spentByCat, ledgerCurrency, i === 0, i === expense.length - 1)).join("") : `<p class="muted">No expense categories.</p>`}
      </div>

      <p class="muted" style="margin:14px 0 4px">Income</p>
      <div class="cat-manage-list">
        ${income.length ? income.map((c, i) => categoryRowHtml(c, canEdit, spentByCat, ledgerCurrency, i === 0, i === income.length - 1)).join("") : `<p class="muted">No income categories.</p>`}
      </div>

      ${canEdit ? `
        <div class="sub-panel" style="margin-top:14px">
          <h4>Add category</h4>
          <div id="catError" class="error"></div>
          <input id="catName" placeholder="Category name" />
          <div class="btn-row" style="margin:6px 0 8px">
            <select id="catType" style="flex:1"><option value="expense">Expense</option><option value="income">Income</option></select>
          </div>
          <p class="muted" style="margin:0 0 4px">Icon</p>
          <div class="chip-row" id="catEmojiPicker">
            ${EMOJI_PALETTE.map((e, i) => `<button type="button" class="chip emoji-chip ${i === 0 ? "active" : ""}" data-emoji="${e}">${e}</button>`).join("")}
          </div>
          <button id="btnAddCategory">Add category</button>
        </div>

        <div class="chip-row hidden" id="catChangeIconPicker" style="margin-top:10px">
          ${EMOJI_PALETTE.map((e) => `<button type="button" class="chip" data-set-icon="${e}">${e}</button>`).join("")}
        </div>
      ` : ""}
    </div>`;
}

function renderTagsPanel(myMember, txs) {
  const canEdit = canManageTags(myMember);
  const counts = tagUsageCounts(Object.fromEntries(txs));
  const allTags = [...new Set([...(S.tags || []), ...Object.keys(counts)])].sort();

  return `
    <div class="panel">
      <h3>${sysIcon("tag")}Tags</h3>
      ${allTags.length ? allTags.map((tag) => `
        <div class="cat-row">
          ${canEdit
            ? `<input class="cat-label-input" data-tag-rename-old="${tag}" value="${tag}" style="flex:2" />`
            : `<span class="cat-label-static" style="flex:2">${tag}</span>`}
          <span class="muted" style="flex:0 0 auto;margin-right:8px">${counts[tag] || 0} tx</span>
          ${canEdit ? `<button class="link small" data-del-tag="${tag}">delete</button>` : ""}
        </div>
      `).join("") : `<p class="muted">No tags yet — add one while entering a transaction.</p>`}
    </div>`;
}


function renderRecurringPanel(myMember, ledger) {
  const canEdit = can(myMember, "manageRecurring");
  const items = Object.entries(S.recurring || {});
  const ledgerCurrency = ledger?.currency || "USD";
  return `
    <div class="panel">
      <h3>${sysIcon("refresh")}Recurring transactions</h3>
      ${items.length ? items.map(([id, r]) => `
        <div class="tx-row">
          <span>${r.name} <span class="muted">(${FREQUENCIES.find(f => f.key === r.freq)?.label || r.freq})</span></span>
          <span class="${r.type}">${r.type === "income" ? "+" : "-"}${r.amount.toFixed(2)} ${r.currency}</span>
          ${canEdit ? `<button class="link small" data-del-recurring="${id}">delete</button>` : ""}
        </div>
        <p class="muted" style="margin:-4px 0 6px">Next: ${r.stopped ? "ended" : r.nextDate}</p>
      `).join("") : `<p class="muted">No recurring transactions set up.</p>`}

      ${canEdit ? `
        <div class="sub-panel">
          <h4>Add recurring</h4>
          <div id="recurringError" class="error"></div>
          <input id="recurName" placeholder="Name (e.g. Netflix, Rent)" />
          <div class="btn-row">
            <select id="recurType" style="flex:1"><option value="expense">Expense</option><option value="income">Income</option></select>
            <input id="recurAmount" type="number" step="0.01" placeholder="Amount" style="flex:1" />
          </div>
          <select id="recurCategory">${categoryOptionsHtml()}</select>
          <div class="btn-row">
            <select id="recurFreq" style="flex:1">${FREQUENCIES.map(f => `<option value="${f.key}">${f.label}</option>`).join("")}</select>
            <select id="recurCurrency" style="flex:1">
              ${["USD", "MYR", "SGD", "EUR", "GBP", "JPY", "AUD"].map(c => `<option value="${c}" ${ledgerCurrency === c ? "selected" : ""}>${c}</option>`).join("")}
            </select>
          </div>
          <p class="muted" style="margin:6px 0 4px">Starts on</p>
          <input id="recurNextDate" type="date" value="${new Date().toISOString().slice(0, 10)}" />
          <p class="muted" style="margin:6px 0 4px">Ends (optional)</p>
          <div class="btn-row">
            <input id="recurEndDate" type="date" placeholder="End date" style="flex:1" />
            <input id="recurMaxOccurrences" type="number" placeholder="Or # of times" style="flex:1" />
          </div>
          <button id="btnAddRecurring" style="margin-top:8px">Add recurring</button>
        </div>` : ""}
    </div>`;
}

function nameOf(uid) { return S.members[uid] ? `${S.members[uid].avatar || "🙂"} ${S.members[uid].displayName}` : "Unknown"; }
function nameFrom(namesMap, uid) { return namesMap[uid] ? `${namesMap[uid].avatar || "🙂"} ${namesMap[uid].displayName}` : "Unknown"; }

function renderWalletPage() {
  const balances = S.walletBalances || {};
  const liabilityEntries = Object.entries(S.liabilities || {});
  const txList = Object.entries(S.walletTx || {}).sort((a, b) => b[1].ts - a[1].ts).slice(0, 15);
  const recurring = Object.entries(S.walletRecurring || {});
  const ledgerOptions = Object.entries(S.ledgers || {}).map(([lid, l]) => `<option value="${lid}">${l.icon || "💼"} ${l.name}</option>`).join("");
  const currencyOptions = (selected) => ["USD", "MYR", "SGD", "EUR", "GBP", "JPY", "AUD"].map(c => `<option value="${c}" ${c === selected ? "selected" : ""}>${c}</option>`).join("");

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromWallet" class="btn-back" aria-label="Back to Home">${sysIcon("chevron-left")}</button>
      <button id="btnLogout" class="link">Log out</button>
    </div>
    <h2>${sysIcon("wallet")}Pocket</h2>
    <p class="muted" style="margin-bottom:12px">Real money you top up yourself — separate from ledger spending. Transfer some into a ledger whenever you want it available to spend.</p>

    <div class="panel">
      <h3>Balances</h3>
      ${Object.keys(balances).length ? `
        <div class="btn-row" style="flex-wrap:wrap;gap:18px;margin-bottom:4px">
          ${Object.entries(balances).map(([cur, amt]) => `<span class="balance" style="font-size:22px">${cur} ${amt.toFixed(2)}</span>`).join("")}
        </div>` : `<p class="muted">No funds yet.</p>`}
    </div>

    <div class="panel">
      <h3>Borrow</h3>
      <p class="muted" style="margin-bottom:8px">Money you borrowed — loans, credit cards, IOUs. Subtracted from the Net figure on Home.</p>
      ${liabilityEntries.length ? liabilityEntries.map(([id, l]) => `
        <div class="tx-row">
          <span>${l.name}</span>
          <span class="expense">${l.currency} ${l.amount.toFixed(2)}</span>
          <button class="link small" data-del-liability="${id}">delete</button>
        </div>
      `).join("") : `<p class="muted">No borrows added.</p>`}
      <div class="sub-panel">
        <h4>Add a borrow</h4>
        <div id="liabilityError" class="error"></div>
        <input id="liabilityName" placeholder="Name (e.g. Car loan, Credit card)" />
        <div class="btn-row">
          <input id="liabilityAmount" type="number" step="0.01" placeholder="Amount" style="flex:2" />
          <select id="liabilityCurrency" style="flex:1">${currencyOptions("USD")}</select>
        </div>
        <button id="btnAddLiability" style="margin-top:8px">Add borrow</button>
      </div>
    </div>

    <div class="panel">
      <h3>Add funds</h3>
      <div id="walletAddError" class="error"></div>
      <div class="btn-row">
        <input id="walletAddAmount" type="number" step="0.01" placeholder="Amount" style="flex:2" />
        <select id="walletAddCurrency" style="flex:1">${currencyOptions("USD")}</select>
      </div>
      <input id="walletAddNote" placeholder="Note (e.g. Freelance payment)" />
      <button id="btnWalletAddFunds">Add funds</button>
    </div>

    <div class="panel">
      <h3>Fund a ledger's wallet</h3>
      <p class="muted" style="margin-bottom:8px">Sends money in that ledger's own currency (no conversion yet). Add = outside money not tracked in your Pocket. Transfer = comes out of your own Pocket balance below.</p>
      <div id="walletTransferError" class="error"></div>
      ${ledgerOptions ? `
        <select id="walletTransferLedger">${ledgerOptions}</select>
        <input id="walletTransferAmount" type="number" step="0.01" placeholder="Amount (in that ledger's currency)" />
        <input id="walletTransferNote" placeholder="Note (optional)" />
        <div class="btn-row">
          <button id="btnWalletAddToLedger" style="flex:1">${sysIcon("plus")}Add directly</button>
          <button id="btnWalletTransfer" class="secondary" style="flex:1">↔️ Transfer from my wallet</button>
        </div>
      ` : `<p class="muted">No ledgers yet — create one in the Ledgers tab first.</p>`}
    </div>

    <div class="panel">
      <h3>${sysIcon("refresh")}Recurring top-up <span class="muted" style="font-weight:400">(e.g. fixed pocket money)</span></h3>
      ${recurring.length ? recurring.map(([id, r]) => `
        <div class="tx-row">
          <span>${r.name} <span class="muted">(${r.freq})</span></span>
          <span class="income">+${r.amount.toFixed(2)} ${r.currency}</span>
          <button class="link small" data-del-wallet-recurring="${id}">delete</button>
        </div>
        <p class="muted" style="margin:-4px 0 6px">Next: ${r.stopped ? "ended" : r.nextDate}</p>
      `).join("") : `<p class="muted">None set up.</p>`}
      <div class="sub-panel">
        <h4>Add recurring top-up</h4>
        <div id="walletRecurError" class="error"></div>
        <input id="walletRecurName" placeholder="Name (e.g. Weekly allowance)" />
        <div class="btn-row">
          <input id="walletRecurAmount" type="number" step="0.01" placeholder="Amount" style="flex:2" />
          <select id="walletRecurCurrency" style="flex:1">${currencyOptions("USD")}</select>
        </div>
        <select id="walletRecurFreq">
          <option value="daily">Daily</option>
          <option value="weekly" selected>Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>
        <p class="muted" style="margin:6px 0 4px">Starts on</p>
        <input id="walletRecurNextDate" type="date" value="${new Date().toISOString().slice(0, 10)}" />
        <p class="muted" style="margin:6px 0 4px">Ends (optional)</p>
        <div class="btn-row">
          <input id="walletRecurEndDate" type="date" style="flex:1" />
          <input id="walletRecurMaxOccurrences" type="number" placeholder="Or # of times" style="flex:1" />
        </div>
        <button id="btnAddWalletRecurring" style="margin-top:8px">Add recurring top-up</button>
      </div>
    </div>

    <div class="panel">
      <h3>History</h3>
      ${txList.length ? txList.map(([id, t]) => `
        <div class="tx-row">
          <span>${t.type === "topup" ? "💰" : "➡️"} ${t.type === "topup" ? (t.note || "Top-up") : `To ${t.toLedgerName}${t.note ? " — " + t.note : ""}`}</span>
          <span class="${t.type === "topup" ? "income" : "expense"}">${t.type === "topup" ? "+" : "-"}${t.amount.toFixed(2)} ${t.currency}</span>
        </div>
      `).join("") : `<p class="muted">No Pocket activity yet.</p>`}
    </div>
    `;
}


// The floating "+" quick-add screen. Draft state lives in S.quickAdd (see
// state.js) and is initialized by index.js when the "+" button is tapped —
// this function just renders whatever's currently in it, falling back to
// sensible defaults so a stray render() call before init doesn't crash.
// Shifts a "YYYY-MM" string by N months, rolling the year over correctly.
export function shiftMonthStr(monthStr, delta) {
  let [y, m] = monthStr.split("-").map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

// Shifts a YYYY-MM-DD string by N days, using UTC throughout so it never
// drifts relative to the UTC-based date strings the rest of the app uses
// (same reasoning as the UTC date math in wallet.js/recurring.js).
export function shiftDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Applies one calculator operator between two numbers. Division by zero
// just returns the total unchanged rather than throwing/NaN-ing the UI.
export function qaApplyOp(total, op, val) {
  if (op === "-") return total - val;
  if (op === "×") return total * val;
  if (op === "÷") return val !== 0 ? total / val : total;
  return total + val; // "+"
}

// Resolves the quick-add draft's running-total calculator into one final
// number — shared between rendering (the live display) and index.js
// (validating/submitting), so the math only lives in one place.
// qa.runningTotal is null until the first operator is pressed (so the
// first number typed becomes the base, rather than being combined against
// an assumed starting value of 0 — which works fine for +/- but silently
// breaks × and ÷, e.g. "5 ×" would otherwise compute 0 × 5 = 0).
export function qaComputeAmount(qa) {
  if (!qa) return 0;
  if (qa.runningTotal === null || qa.runningTotal === undefined) {
    return parseFloat(qa.amount || "0") || 0;
  }
  if (qa.pendingOp && qa.amount !== "") {
    return qaApplyOp(qa.runningTotal, qa.pendingOp, parseFloat(qa.amount) || 0);
  }
  return qa.runningTotal;
}

// Renders a tap-to-pick month calendar for the Quick Add date bar.
// qa.calendarMonth ("YYYY-MM") is the month currently being browsed —
// separate from qa.date (the actual selected day) so navigating months
// doesn't change the selection until a day is actually tapped.
// Builds one scrollable wheel-picker column (tap a row to select it — same
// tap+scroll-snap pattern as the currency picker, just reused per-column).
function qaWheelColumn(options, dataKey) {
  return `<div class="qa-wheel-col">${options.map((o) => `<button type="button" class="qa-wheel-row ${o.selected ? "selected" : ""}" data-${dataKey}="${o.value}">${o.label}</button>`).join("")}</div>`;
}

function renderQaDateWheel(qa) {
  const nowYear = new Date().getFullYear();
  const years = []; for (let y = nowYear - 3; y <= nowYear + 5; y++) years.push(y);
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const yearOpts = years.map((v) => ({ value: v, label: String(v), selected: v === qa.wheelYear }));
  const monthOpts = months.map((v) => ({ value: v, label: String(v).padStart(2, "0"), selected: v === qa.wheelMonth }));
  const dayOpts = days.map((v) => ({ value: v, label: String(v).padStart(2, "0"), selected: v === qa.wheelDay }));
  return `
    <div class="qa-modal-backdrop qa-modal-backdrop-wheel" id="qaDateWheelBackdrop">
      <div class="qa-modal-card">
        <div class="qa-modal-title">Select Date</div>
        <div class="qa-wheel-row-wrap">
          ${qaWheelColumn(yearOpts, "wheel-year")}
          ${qaWheelColumn(monthOpts, "wheel-month")}
          ${qaWheelColumn(dayOpts, "wheel-day")}
        </div>
        <div class="qa-modal-footer">
          <button type="button" class="qa-modal-cancel" id="btnQaDateWheelCancel">Cancel</button>
          <button type="button" class="qa-modal-ok" id="btnQaDateWheelOk">OK</button>
        </div>
      </div>
    </div>`;
}

function renderQaTimeWheel(qa) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 60 }, (_, i) => i);
  const hourOpts = hours.map((v) => ({ value: v, label: String(v).padStart(2, "0"), selected: v === qa.wheelHour }));
  const minuteOpts = minutes.map((v) => ({ value: v, label: String(v).padStart(2, "0"), selected: v === qa.wheelMinute }));
  return `
    <div class="qa-modal-backdrop qa-modal-backdrop-wheel" id="qaTimeWheelBackdrop">
      <div class="qa-modal-card">
        <div class="qa-modal-title">Select Time</div>
        <div class="qa-wheel-row-wrap">
          ${qaWheelColumn(hourOpts, "wheel-hour")}
          ${qaWheelColumn(minuteOpts, "wheel-minute")}
        </div>
        <div class="qa-modal-footer">
          <button type="button" class="qa-modal-cancel" id="btnQaTimeWheelCancel">Cancel</button>
          <button type="button" class="qa-modal-ok" id="btnQaTimeWheelOk">OK</button>
        </div>
      </div>
    </div>`;
}

function renderQaCalendar(qa) {
  const draftDate = qa.dateDraft || qa.date;
  const draftTime = qa.timeDraft || qa.time || "00:00";
  const viewMonth = qa.calendarMonth || draftDate.slice(0, 7);
  const [vy, vm] = viewMonth.split("-").map(Number);
  const firstOfMonth = new Date(Date.UTC(vy, vm - 1, 1));
  const startWeekday = firstOfMonth.getUTCDay();
  const daysInMonth = new Date(Date.UTC(vy, vm, 0)).getUTCDate();
  const todayStr = new Date().toISOString().slice(0, 10);
  const monthLabel = firstOfMonth.toLocaleDateString(undefined, { month: "long", timeZone: "UTC" });

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(`<span></span>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${vy}-${String(vm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const col = (startWeekday + d - 1) % 7; // 0 = Sun, 6 = Sat
    cells.push(`<button type="button" class="qa-cal-day ${col === 0 ? "sun" : ""} ${col === 6 ? "sat" : ""} ${dateStr === todayStr ? "today" : ""} ${dateStr === draftDate ? "selected" : ""}" data-qa-cal-day="${dateStr}">${d}</button>`);
  }

  return `
    <div class="qa-calendar">
      <div class="qa-cal-toprow">
        <button type="button" class="qa-cal-today-btn" id="btnQaCalToday">TODAY</button>
        <button type="button" id="btnQaDateFieldOpen" class="qa-cal-field">${draftDate}</button>
        <button type="button" id="btnQaTimeFieldOpen" class="qa-cal-field">${draftTime}</button>
        <button type="button" class="qa-cal-confirm" id="btnQaCalConfirm" aria-label="Confirm date">${sysIcon("check")}</button>
      </div>
      ${qa.showDateWheel ? renderQaDateWheel(qa) : ""}
      ${qa.showTimeWheel ? renderQaTimeWheel(qa) : ""}
      <div class="qa-cal-header">
        <span class="qa-cal-monthlabel"><strong>${monthLabel}</strong> ${vy}</span>
        <div class="qa-cal-nav">
          <button type="button" id="btnQaCalPrev" aria-label="Previous month">${sysIcon("chevron-left")}</button>
          <button type="button" id="btnQaCalNext" aria-label="Next month">${sysIcon("chevron-right")}</button>
        </div>
      </div>
      <div class="qa-cal-weekdays"><span class="sun">Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span class="sat">Sat</span></div>
      <div class="qa-cal-grid">${cells.join("")}</div>
    </div>`;
}

const QA_CURRENCIES = ["USD", "MYR", "SGD", "EUR", "GBP", "JPY", "AUD", "TWD", "CNY", "KRW", "HKD", "THB"];
const QA_CURRENCY_SYMBOLS = { USD: "$", MYR: "RM", SGD: "$", EUR: "€", GBP: "£", JPY: "¥", AUD: "$", TWD: "$", CNY: "¥", KRW: "₩", HKD: "$", THB: "฿" };

function renderQuickAddPage() {
  const qa = S.quickAdd || { type: "expense", ledgerId: null, amount: "", runningTotal: null, pendingOp: null, opMode: { pm: "+", md: "-" }, category: null, date: new Date().toISOString().slice(0, 10), account: "" };
  const ledgerEntries = Object.entries(S.ledgers || {});
  const activeLedger = ledgerEntries.find(([lid]) => lid === qa.ledgerId)?.[1];
  const todayStr = new Date().toISOString().slice(0, 10);
  const { expense, income } = groupedCategories();
  const cats = qa.type === "income" ? income : expense;
  const qaFormatNum = (n) => (n == null ? "0" : Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));
  const rawDisplay = qa.pendingOp
    ? `${qaFormatNum(qa.runningTotal)} ${qa.pendingOp} ${qa.amount}`
    : (qa.amount !== "" ? qa.amount : qaFormatNum(qa.runningTotal ?? 0));
  const currency = qa.currency || qa.ledgerCurrency || "USD";
  const memberEntries = Object.entries(S.members || {});
  const amountSoFar = qaComputeAmount(qa);

  const dateObj = new Date(qa.date + "T00:00:00");
  const relLabel = qa.date === todayStr ? "Today " : (qa.date === shiftDateStr(todayStr, -1) ? "Yesterday " : "");
  const dateLabel = relLabel + dateObj.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  if (qa.showCategoriesPanel) {
    S.categoriesBackView = "quickAdd";
    return renderCategoriesPage();
  }

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromQuickAdd" class="btn-back" aria-label="Close">${sysIcon("chevron-left")}</button>
      <div class="qa-tabs">
        <button type="button" class="qa-tab ${qa.type === "expense" ? "active" : ""}" data-qa-type="expense">Spending</button>
        <button type="button" class="qa-tab ${qa.type === "income" ? "active" : ""}" data-qa-type="income">Receiving</button>
      </div>
      <div class="topbar-icons">
        <button type="button" id="btnQaScanReceipt" class="link" aria-label="Scan receipt" title="Scan receipt">${sysIcon("camera")}</button>
        <input type="file" id="qaReceiptFileInput" accept="image/*" style="display:none" />
        <button type="button" id="btnQaCategoriesMenu" class="link" aria-label="Category settings">${sysIcon("dots-vertical")}</button>
      </div>
    </div>
    <p id="qaScanStatus" class="muted" style="display:none;text-align:center;margin:4px 0">Reading receipt with AI...</p>

    ${!ledgerEntries.length ? `<p class="muted" style="margin:20px 0">Create a ledger first before adding a transaction.</p>` : `
      <div class="qa-scroll-area">
        <div class="qa-cat-grid">
          ${cats.map((c) => `
            <button type="button" class="qa-cat-tile ${qa.category === c.label ? "active" : ""}" data-qa-cat="${c.label}">
              <span class="qa-cat-icon">${c.icon}</span>
              <span>${c.label}</span>
            </button>
          `).join("")}
        </div>
      </div>

      <div class="qa-bottom-sheet">
        <div id="qaError" class="error" style="text-align:center"></div>

        <div class="qa-topline">
          <button type="button" class="qa-topline-pill ${qa.type}" id="btnQaCurrency">
            <span class="qa-topline-icon">${qa.type === "income" ? "💰" : "🧾"}</span>
            <span>${currency}</span>
            <span class="qa-topline-amount">$${rawDisplay}</span>
          </button>
          <div class="qa-remark-wrap">
            <input id="qaRemark" placeholder="Tap here to write" value="${(qa.remark || "").replace(/"/g, "&quot;")}" />
            <button type="button" id="btnQaTagToggle" class="qa-tag-btn ${qa.tags?.length ? "active" : ""}" aria-label="Tags">#</button>
          </div>
        </div>
        ${qa.showCurrencyPicker ? `
          <div class="qa-modal-backdrop" id="qaCurrencyBackdrop">
            <div class="qa-modal-card">
              <div class="qa-modal-title">Select Currency</div>
              <div class="qa-modal-list">
                ${QA_CURRENCIES.map((c) => `<button type="button" class="qa-modal-row ${c === (qa.currencyDraft || currency) ? "selected" : ""}" data-qa-currency-draft="${c}">${c} ${QA_CURRENCY_SYMBOLS[c] || ""}</button>`).join("")}
              </div>
              <div class="qa-modal-footer">
                <button type="button" class="qa-modal-cancel" id="btnQaCurrencyCancel">Cancel</button>
                <button type="button" class="qa-modal-ok" id="btnQaCurrencyOk">OK</button>
              </div>
            </div>
          </div>` : ""}
        ${qa.showTagPicker ? `
          <div class="chip-row" style="margin:2px 0 2px">
            ${(S.tags || []).map((t) => `<button type="button" class="chip" data-qa-tag="${t}" style="${qa.tags?.includes(t) ? "background:var(--accent);color:#fff;border-color:var(--accent)" : ""}">🏷️ ${t}</button>`).join("")}
            <button type="button" class="chip" id="btnQaNewTagToggle">${qa.showNewTag ? "✕ cancel" : "+ New"}</button>
          </div>
          ${qa.showNewTag ? `
            <div class="btn-row" style="margin-bottom:8px">
              <input id="qaNewTag" placeholder="New tag..." style="flex:1" />
              <button type="button" id="btnQaAddTag" class="secondary">Add</button>
            </div>` : ""}
        ` : ""}

        <div class="qa-date-bar">
          <button type="button" id="btnQaDatePrev" aria-label="Previous day">${sysIcon("chevron-left")}</button>
          <button type="button" id="btnQaDateToggle" class="qa-date-label">${sysIcon("calendar")}<span>${dateLabel}</span></button>
          <button type="button" id="btnQaDateNext" aria-label="Next day">${sysIcon("chevron-right")}</button>
        </div>
        ${qa.showDatePicker ? `<div class="qa-modal-backdrop qa-modal-backdrop-top" id="qaDateBackdrop">${renderQaCalendar(qa)}</div>` : ""}
        ${qa.showLedgerPicker ? `
          <div class="qa-modal-backdrop" id="qaLedgerBackdrop">
            <div class="qa-modal-card">
              <div class="qa-modal-title">Select Ledger</div>
              <div class="qa-modal-list qa-modal-list-ledger">
                ${ledgerEntries.map(([lid, l]) => `<button type="button" class="qa-modal-row ${lid === (qa.ledgerDraft || qa.ledgerId) ? "selected" : ""}" data-qa-ledger-draft="${lid}">${l.icon || "💼"} ${l.name}</button>`).join("")}
              </div>
              <div class="qa-modal-footer">
                <button type="button" class="qa-modal-cancel" id="btnQaLedgerCancel">Cancel</button>
                <button type="button" class="qa-modal-ok" id="btnQaLedgerOk">OK</button>
              </div>
            </div>
          </div>` : ""}

        <div class="qa-keypad-wrap">
          <div class="qa-keypad-numbers">
            <button type="button" class="qa-key" data-qa-key="1">1</button>
            <button type="button" class="qa-key" data-qa-key="2">2</button>
            <button type="button" class="qa-key" data-qa-key="3">3</button>
            <button type="button" class="qa-key qa-key-op" data-qa-key="pm"><span class="qa-op-pm ${qa.opMode?.pm === "×" ? "is-times" : ""}">+</span></button>

            <button type="button" class="qa-key" data-qa-key="4">4</button>
            <button type="button" class="qa-key" data-qa-key="5">5</button>
            <button type="button" class="qa-key" data-qa-key="6">6</button>
            <button type="button" class="qa-key qa-key-op" data-qa-key="md"><span class="qa-op-glyph">${qa.opMode?.md === "÷" ? "÷" : "−"}</span></button>

            <button type="button" class="qa-key" data-qa-key="7">7</button>
            <button type="button" class="qa-key" data-qa-key="8">8</button>
            <button type="button" class="qa-key" data-qa-key="9">9</button>
            <button type="button" class="qa-key qa-key-ac" data-qa-key="clear">AC</button>

            <button type="button" class="qa-key" data-qa-key="0">0</button>
            <button type="button" class="qa-key" data-qa-key=".">.</button>
            <button type="button" class="qa-key qa-key-op qa-key-backspace" data-qa-key="back">${sysIcon("backspace")}</button>
            <button type="button" class="qa-key qa-key-record" id="btnQaRecord" title="Save and add another">${sysIcon("checklist")}</button>
          </div>
          <div class="qa-keypad-tools">
            <button type="button" class="qa-tool qa-tool-ledger" id="btnQaLedger">${ledgerIcon(activeLedger?.icon)}<span>${activeLedger?.name || "Select"}</span></button>
            <button type="button" class="qa-tool qa-tool-cash ${qa.account === "wallet" ? "active" : ""}" id="btnQaAccount">${sysIcon("wallet")}<span>${qa.account === "wallet" ? "Wallet" : "Cash"}</span></button>
            <button type="button" class="qa-tool qa-tool-split ${qa.showSplit ? "active" : ""}" id="btnQaSplitToggle">${sysIcon("users-group")}<span>Split</span></button>
            <button type="button" class="qa-tool qa-submit-tool ${qa.pendingOp ? "qa-equals-mode" : ""}" id="btnQaSubmit">${qa.pendingOp ? `<span class="qa-equals-sign">=</span>` : `${sysIcon("check")}<span>Done</span>`}</button>
          </div>
        </div>
      </div>

      ${qa.showSplit ? `
        <div class="qa-modal-backdrop qa-modal-backdrop-top" id="qaSplitBackdrop">
          <div class="qa-modal-card qa-modal-card-split">
            <div class="qa-modal-title">Split</div>
            <div class="qa-modal-body">
              ${!memberEntries.length ? `<p class="muted">Loading members...</p>` : `
                <p class="muted" style="margin-bottom:6px">Paid by <span class="muted">(none selected = you)</span></p>
                <div class="chip-row">${memberEntries.map(([uid, m]) => `<button type="button" class="chip" data-qa-payer="${uid}" style="${qa.payerUids?.includes(uid) ? "background:var(--accent);color:#fff;border-color:var(--accent)" : ""}">${m.avatar || "🙂"} ${m.displayName}</button>`).join("")}</div>
                ${qa.payerUids?.length >= 2 ? `<div class="split-amounts">${splitAmountRowsHtml(qa.payerUids, amountSoFar, "qapayer")}</div>` : ""}

                <p class="muted" style="margin:12px 0 6px">Split between</p>
                <div class="chip-row">${memberEntries.map(([uid, m]) => `<button type="button" class="chip" data-qa-split="${uid}" style="${qa.splitUids?.includes(uid) ? "background:var(--accent);color:#fff;border-color:var(--accent)" : ""}">${m.avatar || "🙂"} ${m.displayName}</button>`).join("")}</div>
                ${qa.splitUids?.length >= 1 ? `<div class="split-amounts">${splitAmountRowsHtml(qa.splitUids, amountSoFar, "qasplit")}</div>` : ""}
                <p class="muted" style="margin-top:6px">Tip: finish typing the amount before adjusting split amounts, since editing the amount resets custom splits back to equal shares.</p>
              `}
            </div>
            <div class="qa-modal-footer">
              <button type="button" class="qa-modal-ok" id="btnQaSplitDone" style="flex:1">Done</button>
            </div>
          </div>
        </div>
      ` : ""}
    `}
  `;
}

function renderHomeBookmarksPage() {
  const overview = S.homeBookmarksOverview;
  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromHomeBookmarks" class="btn-back" aria-label="Back to Home">${sysIcon("chevron-left")}</button>
      <button id="btnLogout" class="link">Log out</button>
    </div>
    <h2>${sysIcon("star")}Bookmarked</h2>
    <p class="muted" style="margin-bottom:12px">Starred transactions across every ledger you've flagged for your overview. To unstar or delete one, open that ledger's own Bookmarked screen.</p>

    ${overview ? `
      <div class="panel">
        <h3 style="margin-bottom:4px">Summary</h3>
        <div class="balance" style="font-size:22px">${overview.ledgersWithBookmarksCount} of ${overview.totalLedgersChecked} ledgers</div>
        <p class="muted">have bookmarked transactions</p>
      </div>

      ${overview.perLedger.length ? overview.perLedger.map(l => `
        <div class="panel">
          <h4 style="margin-bottom:6px">${l.icon || "💼"} ${l.name}</h4>
          <div class="tx-list">
            ${l.txs.map(t => `
              <div class="tx-row">
                <span class="tx-emoji">⭐</span>
                <span class="tx-main">
                  <span class="tx-title">${t.category}${t.description ? " — " + t.description : ""}</span>
                </span>
                <span class="${t.type}">
                  ${t.type === "income" ? "+" : "-"}${(t.origAmount ?? t.amount).toFixed(2)} ${t.origCurrency || t.currency}
                </span>
              </div>
            `).join("")}
          </div>
        </div>
      `).join("") : `<p class="muted">${overview.totalLedgersChecked ? "Nothing bookmarked yet in your flagged ledgers." : "Flag a ledger for your overview to see its bookmarks here."}</p>`}
    ` : `<p class="muted">Loading...</p>`}
    `;
}

function renderHomeSplitsPage() {
  const overview = S.homeSplitsOverview;
  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromHomeSplits" class="btn-back" aria-label="Back to Home">${sysIcon("chevron-left")}</button>
      <button id="btnLogout" class="link">Log out</button>
    </div>
    <h2>${sysIcon("users-group")}Splits & Settle</h2>

    ${overview ? `
      <div class="panel">
        <h3>Combined balances <span class="muted" style="font-weight:400">(net, in ${overview.homeCurrency})</span></h3>
        ${overview.combined.length ? overview.combined.map(b => `
          <div class="tx-row"><span>${nameFrom(overview.namesMap, b.from)} owes ${nameFrom(overview.namesMap, b.to)}</span><span class="expense">${overview.homeCurrency} ${b.amount.toFixed(2)}</span></div>
        `).join("") : `<p class="muted">All settled up across every ledger 🎉</p>`}
      </div>

      <div class="panel">
        <h3 style="margin-bottom:4px">Summary</h3>
        <div class="balance" style="font-size:22px">${overview.ledgersWithSplitsCount} of ${overview.totalLedgersChecked} ledgers</div>
        <p class="muted">have outstanding split balances</p>
      </div>
      <p class="muted" style="margin-bottom:12px">Each ledger's balances shown below in its own currency. To record a settlement, open that ledger's own Splits & Settle screen.</p>

      ${overview.perLedger.length ? overview.perLedger.map(l => `
        <div class="panel">
          <h4 style="margin-bottom:6px">${l.icon || "💼"} ${l.name}</h4>
          ${l.balances.map(b => `
            <div class="tx-row"><span>${nameFrom(overview.namesMap, b.from)} owes ${nameFrom(overview.namesMap, b.to)}</span><span class="expense">${l.currency} ${b.amount.toFixed(2)}</span></div>
          `).join("")}
        </div>
      `).join("") : ""}
    ` : `<p class="muted">Loading...</p>`}
    `;
}

function renderSplitsPage() {
  const ledger = S.activeLedgerDetail || {};
  const balances = computeBalances(S.txs, S.settlements);
  const memberEntries = Object.entries(S.members || {});
  const settleLog = Object.entries(S.settlements || {}).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).slice(0, 10);

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromSplits" class="btn-back" aria-label="Back to ${ledger.name || "Ledger"}">${sysIcon("chevron-left")}</button>
      <button id="btnLogout" class="link">Log out</button>
    </div>
    <h2>${sysIcon("users-group")}Splits & Settle</h2>

    <div class="panel">
      <h3>Balances</h3>
      ${balances.length ? balances.map(b => `
        <div class="tx-row"><span>${nameOf(b.from)} owes ${nameOf(b.to)}</span><span class="expense">${ledger.currency || "USD"} ${b.amount.toFixed(2)}</span></div>
      `).join("") : `<p class="muted">All settled up — no split expenses outstanding.</p>`}
    </div>

    <div class="panel">
      <h3>Record a settlement</h3>
      <div id="settleError" class="error"></div>
      <p class="muted" style="margin-bottom:4px">Who paid</p>
      <select id="settleFrom">${memberEntries.map(([uid, m]) => `<option value="${uid}">${m.avatar || "🙂"} ${m.displayName}</option>`).join("")}</select>
      <p class="muted" style="margin-bottom:4px">Paid to</p>
      <select id="settleTo">${memberEntries.map(([uid, m]) => `<option value="${uid}">${m.avatar || "🙂"} ${m.displayName}</option>`).join("")}</select>
      <input id="settleAmount" type="number" step="0.01" placeholder="Amount" />
      <input id="settleNote" placeholder="Note (optional)" />
      <button id="btnAddSettlement">Record settlement</button>
    </div>

    <div class="panel">
      <h3>Recent settlements</h3>
      ${settleLog.length ? settleLog.map(([id, s]) => `
        <div class="tx-row">
          <span>${nameOf(s.from)} → ${nameOf(s.to)}${s.note ? " — " + s.note : ""}</span>
          <span class="income">${ledger.currency || "USD"} ${s.amount.toFixed(2)}</span>
          <button class="link small" data-del-settlement="${id}">delete</button>
        </div>
      `).join("") : `<p class="muted">No settlements recorded yet.</p>`}
    </div>`;
}

function renderBookmarkedPage() {
  const ledger = S.activeLedgerDetail || {};
  const myMember = S.members[S.user.uid];
  const bookmarked = Object.entries(S.txs || {})
    .filter(([, t]) => t.bookmarked)
    .sort((a, b) => b[1].ts - a[1].ts);

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromBookmarked" class="btn-back" aria-label="Back to ${ledger.name || "Ledger"}">${sysIcon("chevron-left")}</button>
      <button id="btnLogout" class="link">Log out</button>
    </div>
    <h2>${sysIcon("star")}Bookmarked</h2>
    <p class="muted" style="margin-bottom:12px">Transactions anyone in this ledger has starred — visible to everyone, not just you.</p>

    <div class="tx-list">
      ${bookmarked.length ? bookmarked.map(([id, t]) => `
        <div class="tx-row">
          <button type="button" class="link small star-btn" data-toggle-bookmark="${id}" data-bookmarked="true" title="Remove bookmark">⭐</button>
          <span>${t.category}${t.description ? " — " + t.description : ""}</span>
          <span class="${t.type}">
            ${t.type === "income" ? "+" : "-"}${(t.origAmount ?? t.amount).toFixed(2)} ${t.origCurrency || t.currency}
          </span>
          ${canDeleteTx(myMember, t, S.user.uid) ? `<button class="link small" data-del="${id}">delete</button>` : ""}
        </div>
      `).join("") : `<p class="muted">Nothing bookmarked yet — tap the ☆ next to any transaction to star it.</p>`}
    </div>`;
}

function renderPersonalBudget() {
  const ym = currentYM();
  const pb = S.personalBudget || {};
  const homeCurrency = pb.homeCurrency || "USD";
  const overview = S.personalOverview;
  const target = pb.total || 0;
  const spent = overview?.total || 0;
  const pct = target > 0 ? Math.min(100, Math.round((spent / target) * 100)) : 0;
  const over = target > 0 && spent > target;

  app.innerHTML = `
    <div class="topbar">
      <button id="btnBackFromBudget" class="btn-back" aria-label="Back to Home">${sysIcon("chevron-left")}</button>
      <button id="btnLogout" class="link">Log out</button>
    </div>
    <h2>${sysIcon("chart-bar")}My Budget — ${ym}</h2>

    <div class="panel">
      <h3>Target</h3>
      <div class="btn-row">
        <input id="personalBudgetTotal" type="number" step="0.01" placeholder="Monthly target" value="${target || ""}" />
        <select id="personalHomeCurrency">
          ${["USD", "MYR", "SGD", "EUR", "GBP", "JPY", "AUD"].map(c => `<option value="${c}" ${homeCurrency === c ? "selected" : ""}>${c}</option>`).join("")}
        </select>
      </div>
      <button id="btnSavePersonalBudget">Save target</button>
    </div>

    <div class="panel">
      <h3>This month's spending (from ledgers you've flagged)</h3>
      ${overview ? `
        <div class="balance">${homeCurrency} ${spent.toFixed(2)} <span class="muted" style="font-size:14px">/ ${target ? target.toFixed(2) : "no target set"}</span></div>
        ${target > 0 ? `
          ${budgetProgress(pct, over)}
          ${over ? `<p class="budget-over">Over budget</p>` : `<p class="muted">${pct}% used</p>`}
        ` : ""}
        <div style="margin-top:12px">
          ${Object.values(overview.perLedger).map(l => `
            <div class="tx-row"><span>${l.name}</span><span>${l.currency} ${l.spend.toFixed(2)}${l.currency !== homeCurrency ? ` <span class="muted">(≈ ${homeCurrency} ${l.spendInHomeCurrency.toFixed(2)})</span>` : ""}</span></div>
          `).join("") || `<p class="muted">No ledgers flagged yet — go to the Ledgers tab and tick "Include in my budget" on the ones you want counted.</p>`}
        </div>
      ` : `<p class="muted">Tap refresh to calculate.</p>`}
      <button id="btnRefreshOverview" class="secondary" style="margin-top:10px">🔄 Refresh</button>
    </div>

    ${renderPersonalCategoryBudgetsPanel(overview, homeCurrency)}
    `;
}

function renderPersonalCategoryBudgetsPanel(overview, homeCurrency) {
  const categorySpend = overview?.categorySpend || {};
  const catBudgets = S.personalCategoryBudgets || {};
  const liveLabels = new Set((overview?.availableCategories || []).map((c) => c.label));
  const rows = {}; // label -> { spent, budget }
  Object.entries(categorySpend).forEach(([label, spent]) => { rows[label] = { spent, budget: null }; });
  Object.values(catBudgets).forEach((c) => {
    if (!rows[c.label]) rows[c.label] = { spent: 0, budget: c.budget };
    else rows[c.label].budget = c.budget;
  });

  // A row is "stale" if it has a budget target set under a name that no
  // longer matches any live category in your flagged ledgers — usually
  // because that category got renamed in its ledger.
  const active = [], stale = [];
  Object.entries(rows).forEach(([label, r]) => {
    if (r.budget && !liveLabels.has(label)) stale.push([label, r]);
    else active.push([label, r]);
  });
  active.sort((a, b) => b[1].spent - a[1].spent);

  const catRowHtml = ([label, r]) => {
    const pct = r.budget ? Math.min(100, Math.round((r.spent / r.budget) * 100)) : null;
    return `
      <div class="cat-row">
        <span class="cat-label-static" style="flex:2">${label}</span>
        <input class="cat-budget-input" type="number" step="0.01" data-pcat-label="${label}" value="${r.budget || ""}" placeholder="Budget" />
      </div>
      <div class="cat-spend-line" style="margin-left:0">
        ${pct !== null ? `<div class="budget-bar-track"><div class="budget-bar-fill ${pct >= 100 ? "over" : ""}" style="width:${pct}%"></div></div>` : ""}
        <span class="muted">${homeCurrency} ${r.spent.toFixed(2)}${r.budget ? ` / ${r.budget.toFixed(2)}` : " spent this month"}</span>
      </div>`;
  };

  return `
    <div class="panel">
      <h3>Category budgets <span class="muted" style="font-weight:400">(combined, ${homeCurrency})</span></h3>
      ${active.length ? active.map(catRowHtml).join("") : `<p class="muted">No category spending yet from your flagged ledgers this month.</p>`}

      ${stale.length ? `
        <div class="sub-panel" style="margin-top:10px;border:1px dashed #d9455c">
          <h4>⚠️ Needs re-linking</h4>
          <p class="muted" style="margin-bottom:8px">These targets don't match a current category name in your ledgers — probably renamed. Pick the new name to keep the same budget amount, or delete it.</p>
          ${stale.map(([label, r]) => `
            <div class="cat-row" style="flex-wrap:wrap">
              <span class="cat-label-static" style="flex:2">${label} <span class="muted">(${homeCurrency} ${r.budget.toFixed(2)})</span></span>
            </div>
            <div class="btn-row" style="margin-bottom:10px">
              <select class="relink-select" data-relink-old="${label}" style="flex:2">
                <option value="">Pick new category name...</option>
                ${(overview?.availableCategories || []).map(c => `<option value="${c.label}">${c.icon} ${c.label}</option>`).join("")}
              </select>
              <button class="secondary" data-relink-apply="${label}">Apply</button>
              <button class="link small" data-del-pcat="${label}">delete</button>
            </div>
          `).join("")}
        </div>` : ""}

      <div class="sub-panel" style="margin-top:10px">
        <h4>Add a category target</h4>
        <div id="pcatError" class="error"></div>
        <div class="btn-row">
          <select id="pcatName" style="flex:2">
            ${overview?.availableCategories?.length
              ? overview.availableCategories.map(c => `<option value="${c.label}">${c.icon} ${c.label}</option>`).join("")
              : `<option value="">Flag a ledger first to see its categories</option>`}
          </select>
          <input id="pcatAmount" type="number" step="0.01" placeholder="Budget" style="flex:1" />
        </div>
        <button id="btnAddPersonalCatBudget" style="margin-top:6px">Set target</button>
      </div>
    </div>`;
}

function roleLabel(m) {
  if (m.guest) return "Guest";
  if (m.role === "owner") return "👑 Owner";
  if (m.role === "moderator") return "🛡️ Moderator";
  return "Member";
}

function renderMembersPanel(memberEntries, myMember, iAmOwner) {
  const iCanRemove = canRemoveMembers(myMember);
  return `
    <div class="panel">
      <h3>Members (${memberEntries.length})</h3>
      ${memberEntries.map(([uid, m]) => `
        <div class="member-row">
          <span>${m.avatar || "🙂"} ${m.displayName}</span>
          <span class="role">${roleLabel(m)}${uid === S.user.uid ? " · you" : ""}</span>
          ${iAmOwner && uid !== S.user.uid && !m.guest ? `
            <select class="role-select" data-role-uid="${uid}">
              <option value="member" ${m.role === "member" ? "selected" : ""}>Member</option>
              <option value="moderator" ${m.role === "moderator" ? "selected" : ""}>Moderator</option>
            </select>
          ` : ""}
          ${iCanRemove && uid !== S.user.uid && m.role !== "owner" && !m.guest ? `<button class="link small" data-remove-uid="${uid}">remove</button>` : ""}
          ${iCanRemove && m.guest ? `<button class="link small" data-remove-guest="${uid}">remove</button>` : ""}
        </div>
        ${iAmOwner && m.role === "moderator" ? renderModPermissions(uid, m) : ""}
      `).join("")}

      ${can(myMember, "manageGuests") ? `
        <div class="sub-panel">
          <h4>Add guest</h4>
          <div id="guestError" class="error"></div>
          <input id="guestName" placeholder="Guest name" />
          <button id="btnAddGuest">Add guest</button>
        </div>` : ""}

      ${!iAmOwner ? `<button id="btnLeaveLedger" class="secondary" style="margin-top:10px">Leave this ledger</button>` : ""}
    </div>`;
}

function renderModPermissions(uid, m) {
  const perms = m.permissions || {};
  return `
    <div class="sub-panel mod-perms">
      <p class="muted">Moderator permissions for ${m.displayName}:</p>
      ${GRANTABLE_PERMISSIONS.map(p => `
        <label class="perm-check">
          <input type="checkbox" data-perm-uid="${uid}" data-perm-key="${p.key}" ${perms[p.key] ? "checked" : ""} />
          ${p.label}
        </label>`).join("")}
    </div>`;
}

function renderSettingsPanel(ledger, myMember, iAmOwner) {
  const canRename = can(myMember, "renameLedger");
  const canInvite = can(myMember, "regenerateInvite");
  if (!canRename && !canInvite && !iAmOwner) {
    return `<div class="panel"><h3>Invite code</h3><p class="muted"><strong>${ledger.inviteCode || "..."}</strong></p></div>`;
  }
  return `
    <div class="panel">
      <h3>Ledger settings</h3>
      ${canRename ? `
        <div id="renameError" class="error"></div>
        <input id="ledgerNameInput" value="${ledger.name || ""}" placeholder="Ledger name" />
        <input id="ledgerIconInput" value="${(ledger.icon || "").startsWith("data:image") ? "" : (ledger.icon || "")}" placeholder="Icon (emoji)" />
        <button id="btnRenameLedger">Save name / icon</button>
      ` : ""}
      <p class="muted" style="margin-top:10px">Invite code: <strong>${ledger.inviteCode || "..."}</strong></p>
      ${canInvite ? `<button id="btnRegenInvite" class="secondary">Regenerate code</button>` : ""}
      ${iAmOwner ? `<button id="btnDeleteLedger" class="danger" style="margin-top:14px">Delete this ledger</button>` : ""}
    </div>`;
}
