// index.js — the entry point. Wires together auth, ledgers, transactions,
// and ui.js. Keep this file thin — it should mostly just connect event
// clicks to the functions defined in the other modules.

import { S, onStateChange } from "./state.js";
import { initAuthWatcher, register, login, logout } from "./auth.js";
import {
  createLedger, joinLedgerByCode, switchLedger, listenUserLedgers,
  renameLedger, updateLedgerCurrency, regenerateInviteCode, addGuest, removeGuest,
  setMemberRole, setModeratorPermissions, removeMember, leaveLedger, deleteLedger,
  fetchLedgerContext,
} from "./ledgers.js";
import { listenTransactions, addTransaction, deleteTransaction, toggleBookmark, computeHomeBookmarksOverview } from "./transactions.js";
import {
  listenPersonalBudget, setPersonalBudget, listenIncludedLedgers, setLedgerIncluded,
  listenLedgerBudget, setLedgerBudget, refreshPersonalOverview,
  listenPersonalCategoryBudgets, setPersonalCategoryBudget, relinkPersonalCategoryBudget, deletePersonalCategoryBudget,
} from "./budgets.js";
import { setBudgetUnsub } from "./ledgers.js";
import { getGeminiKey, setGeminiKey, clearGeminiKey, scanReceipt, fileToBase64 } from "./receipt.js";
import { listenThemePrefs, setThemePref, applyTheme } from "./theme.js";
import { listenRecurring, addRecurring, deleteRecurring, processDueRecurring } from "./recurring.js";
import { listenSettlements, addSettlement, deleteSettlement, computeHomeSplitsOverview } from "./splits.js";
import { listenCategories, addCategory, updateCategory, deleteCategory, setCategoryBudget, moveCategory } from "./categories.js";
import { listenTags, ensureTagExists, renameTag, deleteTag } from "./tags.js";
import { listenWallet, addFunds, addWalletRecurring, deleteWalletRecurring, processDueWalletRecurring, refreshWalletNetWorth } from "./wallet.js";
import { listenLiabilities, addLiability, deleteLiability } from "./liabilities.js";
import { listenLedgerWallet, fundLedgerWallet, addToLedgerWallet, refundToLedgerWallet, getLedgerCurrency } from "./ledgerWallet.js";
import { render, splitAmountRowsHtml, qaComputeAmount, qaApplyOp, shiftDateStr, shiftMonthStr } from "./ui.js";

onStateChange((s) => { applyTheme(); maybeApplyHomeStartupPref(); render(s); });

let startupPrefApplied = false;
// Applies the user's "Home screen starts on" setting exactly once per
// session, as soon as both their ledger list and uiPrefs have loaded —
// waiting on the *Ready flags (rather than just truthiness) avoids acting
// on the hardcoded pre-load defaults in state.js.
function maybeApplyHomeStartupPref() {
  if (startupPrefApplied || !S.user || S.activeLedgerId) return;
  if (!S.ledgersReady || !S.uiPrefsReady) return;
  startupPrefApplied = true;
  const pref = S.uiPrefs?.homeStartup || "overview";
  let lid = null;
  if (pref === "last") {
    const last = localStorage.getItem("tb_last_ledger_id");
    if (last && S.ledgers?.[last]) lid = last;
  } else if (pref !== "overview" && S.ledgers?.[pref]) {
    lid = pref;
  }
  if (lid) enterLedger(lid);
}

// Fully switches into a ledger (transactions, budget, recurring,
// settlements, categories, tags, ledger wallet — everything the old
// ledger page needed) and remembers it as "last viewed" for the startup
// preference. Shared by the pull-down ledger row, the Ledgers list, and
// the startup-preference logic above, so there's exactly one code path.
function enterLedger(lid) {
  switchLedger(lid);
  listenTransactions(lid);
  setBudgetUnsub(listenLedgerBudget(lid));
  listenRecurring(lid);
  processDueRecurring(lid).catch((err) => console.error("Recurring processing failed:", err));
  listenSettlements(lid);
  listenCategories(lid);
  listenTags(lid);
  listenLedgerWallet(lid);
  try { localStorage.setItem("tb_last_ledger_id", lid); } catch { /* storage unavailable — fine, just won't persist */ }
}

let unsubUserLedgers = null;
let unsubPersonalBudget = null;
let unsubIncluded = null;
let unsubTheme = null;
let unsubPersonalCatBudgets = null;
let unsubWallet = null;
let unsubLiabilities = null;

initAuthWatcher((user) => {
  unsubUserLedgers?.(); unsubPersonalBudget?.(); unsubIncluded?.(); unsubTheme?.(); unsubPersonalCatBudgets?.(); unsubWallet?.(); unsubLiabilities?.();
  if (user) {
    unsubUserLedgers = listenUserLedgers();
    unsubPersonalBudget = listenPersonalBudget();
    unsubIncluded = listenIncludedLedgers();
    unsubTheme = listenThemePrefs();
    unsubPersonalCatBudgets = listenPersonalCategoryBudgets();
    unsubWallet = listenWallet();
    unsubLiabilities = listenLiabilities();
    refreshHomeOverview();
  }
  applyTheme();
  render();
});

function refreshHomeOverview() {
  const homeCurrency = S.personalBudget?.homeCurrency || "USD";
  refreshPersonalOverview(homeCurrency).catch((err) => console.error("Overview refresh failed:", err));
  refreshWalletNetWorth(homeCurrency).catch((err) => console.error("Wallet net worth refresh failed:", err));

  // Also refresh each ledger's split balances so the Home "Groups" cards
  // can show "You are owed / You owe" without waiting for the person to
  // open the dedicated Splits & Settle page first.
  const ledgerIds = Object.keys(S.ledgers || {});
  if (ledgerIds.length) {
    computeHomeSplitsOverview(ledgerIds, homeCurrency)
      .then((overview) => { S.homeSplitsOverview = overview; render(); })
      .catch((err) => console.error("Home splits overview failed:", err));
  }
}

// Loads another ledger's currency/categories/members/tags into the shared
// state fields the quick-add screen reads from (S.categories, S.members,
// S.tags) — same fields the ledger-detail page uses, since quick-add is
// effectively working inside that ledger's context too, just without its
// live listeners. Safe to reuse: opening a real ledger page afterward
// overwrites these via switchLedger()'s own live listeners anyway.
async function loadQaLedgerContext(lid) {
  if (!lid) return;
  const ctx = await fetchLedgerContext(lid);
  S.categories = ctx.categories;
  S.members = ctx.members;
  S.tags = ctx.tags;
  if (S.quickAdd) {
    S.quickAdd.ledgerCurrency = ctx.currency;
    if (!S.quickAdd.currency) S.quickAdd.currency = ctx.currency;
  }
  render();
}

// Validates and saves the current quick-add draft as one transaction.
// Returns true on success (already saved) or false after showing an error
// (validation failed, nothing saved) — shared by the red Submit button and
// the gray Record button, which only differ in what happens afterward.
async function submitQuickAdd() {
  const qa = S.quickAdd;
  if (!qa.ledgerId) { showError("qaError", "Create or select a ledger first."); return false; }
  if (!qa.category) { showError("qaError", "Pick a category."); return false; }
  const amount = qaComputeAmount(qa);
  if (!amount || amount <= 0) { showError("qaError", "Enter an amount."); return false; }

  const payerUids = qa.payerUids || [];
  const splitUids = qa.splitUids || [];
  let payers, splitAmounts;
  if (payerUids.length >= 2) {
    payers = {};
    payerUids.forEach((uid) => {
      const input = document.querySelector(`.split-amt-input[data-amt-group="qapayer"][data-amt-uid="${uid}"]`);
      payers[uid] = Number(input?.value) || 0;
    });
    const payerSum = Object.values(payers).reduce((a, b) => a + b, 0);
    if (Math.abs(payerSum - amount) > 0.01) { showError("qaError", `"Paid by" amounts add up to ${payerSum.toFixed(2)}, but the total is ${amount.toFixed(2)}.`); return false; }
  } else if (payerUids.length === 1) {
    payers = { [payerUids[0]]: amount };
  }
  if (splitUids.length >= 1) {
    splitAmounts = {};
    splitUids.forEach((uid) => {
      const input = document.querySelector(`.split-amt-input[data-amt-group="qasplit"][data-amt-uid="${uid}"]`);
      splitAmounts[uid] = Number(input?.value) || 0;
    });
    const splitSum = Object.values(splitAmounts).reduce((a, b) => a + b, 0);
    if (Math.abs(splitSum - amount) > 0.01) { showError("qaError", `"Split between" amounts add up to ${splitSum.toFixed(2)}, but the total is ${amount.toFixed(2)}.`); return false; }
  }

  await addTransaction({
    type: qa.type, amount, category: qa.category, description: qa.remark,
    ledgerId: qa.ledgerId, date: qa.date, time: qa.time, currency: qa.currency || qa.ledgerCurrency,
    account: qa.account || undefined, tags: qa.tags?.length ? qa.tags : undefined,
    payers, splitWith: splitUids.length ? splitUids : undefined, splitAmounts,
  });
  return true;
}

// Category edits made from inside quick-add (via the '⋮' menu) write
// straight to Firebase like normal, but quick-add reads categories from a
// one-time fetch rather than a live listener — so re-fetch after any edit
// to keep the grid in sync. No-op when not in quick-add (the real ledger
// page already has its own live listener for this).
async function refreshQaCategoriesIfNeeded() {
  if (S.view === "quickAdd" && S.quickAdd?.ledgerId) await loadQaLedgerContext(S.quickAdd.ledgerId);
}

function goTo(view) {
  S.activeLedgerId = null;
  S.view = view;
  S.returnTo = null;
  if (view === "home") refreshHomeOverview();
  render();
}

// Event delegation: one listener handles all clicks/submits, since ui.js
// re-renders the whole #app div each time (simple + no memory leaks).
document.getElementById("app").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  const id = btn ? btn.id : "";
  try {
    if (id === "btnLogin") {
      const email = val("authEmail"), pass = val("authPass");
      await login(email, pass);
    }
    if (id === "btnSignup") {
      const name = val("authName"), email = val("authEmail"), pass = val("authPass");
      await register(email, pass, name || "User");
    }
    if (id === "btnLogout") await logout();

    const navBtn = e.target.closest?.("[data-nav]");
    if (navBtn) goTo(navBtn.dataset.nav);

    if (e.target.closest?.("#btnHomeBudgetCard")) {
      if (S.activeLedgerId) { S.returnTo = null; S.view = "ledgerBudget"; render(); }
      else goTo("personalBudget");
    }
    if (id === "btnHomeSplits") {
      if (S.activeLedgerId) { S.view = "splits"; render(); return; }
      S.activeLedgerId = null;
      S.view = "homeSplits";
      render();
      const homeCurrency = S.personalBudget?.homeCurrency || "USD";
      computeHomeSplitsOverview(Object.keys(S.ledgers || {}), homeCurrency)
        .then((overview) => { S.homeSplitsOverview = overview; render(); })
        .catch((err) => console.error("Home splits overview failed:", err));
    }
    if (id === "btnBackFromHomeSplits") goTo("home");
    if (id === "btnBackFromHomeBookmarks") goTo("home");
    if (id === "btnToggleRecentTx") {
      S.recentTxVisibleCount = Math.min((S.recentTx || []).length, (S.recentTxVisibleCount || 5) + 5);
      render();
    }
    if (e.target.closest?.("#btnHomeWalletCard")) {
      if (S.activeLedgerId) { S.returnTo = null; S.view = "ledgerWallet"; render(); }
      else { goTo("wallet"); processDueWalletRecurring().catch((err) => console.error("Wallet recurring processing failed:", err)); }
    }
    if (id === "btnBackFromWallet") {
      if (S.returnTo) { S.view = S.returnTo; S.returnTo = null; }
      else S.view = null;
      render();
    }
    if (id === "btnHomeSettings") { S.view = "aiSettings"; render(); }
    if (id === "btnBackFromSettings") { S.view = null; render(); }
    if (id === "btnManageLedgers") {
      S.returnTo = "aiSettings";
      S.activeLedgerId = null;
      S.view = "ledgers";
      render();
    }
    if (e.target.closest?.("#btnHomeQuickAdd")) {
      const lastLedgerId = S.activeLedgerId || S.quickAdd?.ledgerId;
      const stillValid = lastLedgerId && S.ledgers?.[lastLedgerId];
      const ledgerId = stillValid ? lastLedgerId : Object.keys(S.ledgers || {})[0] || null;
      S.quickAdd = {
        type: "expense",
        ledgerId,
        amount: "", runningTotal: null, pendingOp: null,
        category: null, remark: "", tags: [],
        date: new Date().toISOString().slice(0, 10), time: new Date().toTimeString().slice(0, 5), calendarMonth: new Date().toISOString().slice(0, 7),
        dateDraft: null, timeDraft: null,
        showDateWheel: false, showTimeWheel: false,
        wheelYear: null, wheelMonth: null, wheelDay: null, wheelHour: null, wheelMinute: null,
        account: "", showSplit: false, payerUids: [], splitUids: [],
        opMode: { pm: "+", md: "-" }, lastOpKey: null, currencyDraft: null, ledgerDraft: null,
        showDatePicker: false, showLedgerPicker: false, showCurrencyPicker: false, showNewTag: false, showTagPicker: false, showCategoriesPanel: false,
      };
      S.view = "quickAdd";
      render();
      loadQaLedgerContext(ledgerId).catch((err) => console.error("Quick add context load failed:", err));
    }
    if (id === "btnBackFromQuickAdd") { S.quickAdd = null; S.view = null; render(); }

    if (e.target.dataset.qaType) {
      S.quickAdd.type = e.target.dataset.qaType;
      S.quickAdd.category = null; // expense/income have different category lists
      render();
    }
    if (e.target.dataset.qaCat) {
      S.quickAdd.category = e.target.dataset.qaCat;
      render();
    }
    if (e.target.dataset.qaKey) {
      const key = e.target.dataset.qaKey;
      const qa = S.quickAdd;
      if (key === "back") {
        qa.amount = qa.amount.slice(0, -1);
        qa.lastOpKey = null;
      } else if (key === "clear") {
        qa.amount = ""; qa.runningTotal = null; qa.pendingOp = null;
        qa.lastOpKey = null;
      } else if (key === "pm" || key === "md") {
        // "pm" toggles between + and ×; "md" toggles between − and ÷ — a
        // tap commits the current mode's operator as usual. Tapping the
        // SAME button again right after — with nothing else pressed in
        // between, no timing window involved — instead just flips that
        // button's mode and corrects the operator just committed, without
        // committing a second time. Typing a digit (or anything else)
        // resets this, so it only fires on two genuinely consecutive taps
        // of the same operator.
        qa.opMode = qa.opMode || { pm: "+", md: "-" };
        const isRepeat = qa.lastOpKey === key;
        if (isRepeat) {
          qa.opMode[key] = qa.opMode[key] === (key === "pm" ? "+" : "-") ? (key === "pm" ? "×" : "÷") : (key === "pm" ? "+" : "-");
          qa.pendingOp = qa.opMode[key];
          qa.lastOpKey = null; // consumed — a third tap starts fresh as a commit
        } else {
          const val = parseFloat(qa.amount || "0") || 0;
          if (qa.runningTotal === null) qa.runningTotal = val;
          else if (qa.pendingOp) qa.runningTotal = qaApplyOp(qa.runningTotal, qa.pendingOp, val);
          qa.pendingOp = qa.opMode[key];
          qa.amount = "";
          qa.lastOpKey = key;
        }
      } else if (key === ".") {
        if (!qa.amount.includes(".")) qa.amount += ".";
        qa.lastOpKey = null;
      } else {
        // digit
        if (qa.amount === "0") qa.amount = key;
        else qa.amount += key;
        qa.lastOpKey = null;
      }
      render();
    }
    if (id === "btnQaDateToggle") {
      const opening = !S.quickAdd.showDatePicker;
      S.quickAdd.showDatePicker = opening;
      if (opening) {
        S.quickAdd.dateDraft = S.quickAdd.date;
        S.quickAdd.timeDraft = S.quickAdd.time;
        S.quickAdd.calendarMonth = S.quickAdd.date.slice(0, 7);
      }
      S.quickAdd.showLedgerPicker = false; S.quickAdd.showCurrencyPicker = false; S.quickAdd.showTagPicker = false;
      render();
    }
    if (id === "btnQaDatePrev") { S.quickAdd.date = shiftDateStr(S.quickAdd.date, -1); render(); }
    if (id === "btnQaDateNext") { S.quickAdd.date = shiftDateStr(S.quickAdd.date, 1); render(); }
    if (id === "btnQaCalPrev") { S.quickAdd.calendarMonth = shiftMonthStr(S.quickAdd.calendarMonth || S.quickAdd.date.slice(0, 7), -1); render(); }
    if (id === "btnQaCalNext") { S.quickAdd.calendarMonth = shiftMonthStr(S.quickAdd.calendarMonth || S.quickAdd.date.slice(0, 7), 1); render(); }
    if (e.target.dataset.qaCalDay) { S.quickAdd.dateDraft = e.target.dataset.qaCalDay; render(); }
    if (id === "btnQaCalToday") {
      const todayStr = new Date().toISOString().slice(0, 10);
      S.quickAdd.dateDraft = todayStr;
      S.quickAdd.calendarMonth = todayStr.slice(0, 7);
      render();
    }
    if (id === "btnQaCalConfirm") {
      S.quickAdd.date = S.quickAdd.dateDraft || S.quickAdd.date;
      S.quickAdd.time = S.quickAdd.timeDraft || S.quickAdd.time;
      S.quickAdd.showDatePicker = false;
      render();
    }
    if (id === "btnQaDateFieldOpen") {
      const [y, m, d] = (S.quickAdd.dateDraft || S.quickAdd.date).split("-").map(Number);
      S.quickAdd.wheelYear = y; S.quickAdd.wheelMonth = m; S.quickAdd.wheelDay = d;
      S.quickAdd.showDateWheel = true;
      render();
    }
    if (e.target.dataset.wheelYear) { S.quickAdd.wheelYear = Number(e.target.dataset.wheelYear); render(); }
    if (e.target.dataset.wheelMonth) { S.quickAdd.wheelMonth = Number(e.target.dataset.wheelMonth); render(); }
    if (e.target.dataset.wheelDay) { S.quickAdd.wheelDay = Number(e.target.dataset.wheelDay); render(); }
    if (id === "btnQaDateWheelCancel" || e.target.id === "qaDateWheelBackdrop") { S.quickAdd.showDateWheel = false; render(); }
    if (id === "btnQaDateWheelOk") {
      const qa = S.quickAdd;
      const daysInThatMonth = new Date(Date.UTC(qa.wheelYear, qa.wheelMonth, 0)).getUTCDate();
      const day = Math.min(qa.wheelDay, daysInThatMonth);
      qa.dateDraft = `${qa.wheelYear}-${String(qa.wheelMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      qa.calendarMonth = qa.dateDraft.slice(0, 7);
      qa.showDateWheel = false;
      render();
    }
    if (id === "btnQaTimeFieldOpen") {
      const [h, min] = (S.quickAdd.timeDraft || S.quickAdd.time).split(":").map(Number);
      S.quickAdd.wheelHour = h; S.quickAdd.wheelMinute = min;
      S.quickAdd.showTimeWheel = true;
      render();
    }
    if (e.target.dataset.wheelHour) { S.quickAdd.wheelHour = Number(e.target.dataset.wheelHour); render(); }
    if (e.target.dataset.wheelMinute) { S.quickAdd.wheelMinute = Number(e.target.dataset.wheelMinute); render(); }
    if (id === "btnQaTimeWheelCancel" || e.target.id === "qaTimeWheelBackdrop") { S.quickAdd.showTimeWheel = false; render(); }
    if (id === "btnQaTimeWheelOk") {
      const qa = S.quickAdd;
      qa.timeDraft = `${String(qa.wheelHour).padStart(2, "0")}:${String(qa.wheelMinute).padStart(2, "0")}`;
      qa.showTimeWheel = false;
      render();
    }
    if (e.target.dataset.qaCurrencyDraft) { S.quickAdd.currencyDraft = e.target.dataset.qaCurrencyDraft; render(); }
    if (e.target.dataset.qaLedgerDraft) { S.quickAdd.ledgerDraft = e.target.dataset.qaLedgerDraft; render(); }
    if (id === "btnQaLedgerCancel" || e.target.id === "qaLedgerBackdrop") { S.quickAdd.showLedgerPicker = false; render(); }
    if (id === "btnQaLedgerOk") {
      const qa = S.quickAdd;
      qa.ledgerId = qa.ledgerDraft || qa.ledgerId;
      qa.showLedgerPicker = false;
      // Category list, currency, members, and tags are all per-ledger —
      // reset selections tied to the old ledger and load the new one's.
      qa.category = null; qa.currency = null; qa.payerUids = []; qa.splitUids = []; qa.tags = [];
      render();
      loadQaLedgerContext(qa.ledgerId).catch((err) => console.error("Quick add context load failed:", err));
    }
    if (id === "btnQaLedger") {
      S.quickAdd.showLedgerPicker = !S.quickAdd.showLedgerPicker;
      if (S.quickAdd.showLedgerPicker) S.quickAdd.ledgerDraft = S.quickAdd.ledgerId;
      S.quickAdd.showDatePicker = false; S.quickAdd.showCurrencyPicker = false; S.quickAdd.showTagPicker = false;
      render();
    }
    if (id === "btnQaCurrency") {
      const opening = !S.quickAdd.showCurrencyPicker;
      S.quickAdd.showCurrencyPicker = opening;
      if (opening) S.quickAdd.currencyDraft = S.quickAdd.currency || S.quickAdd.ledgerCurrency;
      S.quickAdd.showDatePicker = false; S.quickAdd.showLedgerPicker = false; S.quickAdd.showTagPicker = false;
      render();
    }
    if (id === "btnQaCurrencyCancel" || e.target.id === "qaCurrencyBackdrop") { S.quickAdd.showCurrencyPicker = false; render(); }
    if (e.target.id === "qaDateBackdrop") { S.quickAdd.showDatePicker = false; render(); }
    if (id === "btnQaCurrencyOk") {
      S.quickAdd.currency = S.quickAdd.currencyDraft;
      S.quickAdd.showCurrencyPicker = false;
      render();
    }
    if (id === "btnQaTagToggle") {
      S.quickAdd.showTagPicker = !S.quickAdd.showTagPicker;
      S.quickAdd.showDatePicker = false; S.quickAdd.showLedgerPicker = false; S.quickAdd.showCurrencyPicker = false;
      render();
    }
    if (id === "btnQaAccount") { S.quickAdd.account = S.quickAdd.account === "wallet" ? "" : "wallet"; render(); }
    if (id === "btnQaSplitToggle") { S.quickAdd.showSplit = !S.quickAdd.showSplit; render(); }
    if (id === "btnQaSplitDone" || e.target.id === "qaSplitBackdrop") { S.quickAdd.showSplit = false; render(); }
    if (id === "btnQaCategoriesMenu") { S.quickAdd.showCategoriesPanel = true; S.categoriesBackView = "quickAdd"; render(); }
    if (e.target.dataset.qaPayer) {
      const qa = S.quickAdd, uid = e.target.dataset.qaPayer;
      qa.payerUids = (qa.payerUids || []).includes(uid) ? qa.payerUids.filter((x) => x !== uid) : [...(qa.payerUids || []), uid];
      render();
    }
    if (e.target.dataset.qaSplit) {
      const qa = S.quickAdd, uid = e.target.dataset.qaSplit;
      qa.splitUids = (qa.splitUids || []).includes(uid) ? qa.splitUids.filter((x) => x !== uid) : [...(qa.splitUids || []), uid];
      render();
    }
    if (e.target.dataset.qaTag) {
      const qa = S.quickAdd, tag = e.target.dataset.qaTag;
      qa.tags = (qa.tags || []).includes(tag) ? qa.tags.filter((x) => x !== tag) : [...(qa.tags || []), tag];
      render();
    }
    if (id === "btnQaNewTagToggle") { S.quickAdd.showNewTag = !S.quickAdd.showNewTag; render(); }
    if (id === "btnQaAddTag") {
      const tag = val("qaNewTag");
      if (!tag) return showError("qaError", "Enter a tag name.");
      await ensureTagExists(S.quickAdd.ledgerId, tag);
      const clean = tag.trim();
      if (!S.tags.some((t) => t.toLowerCase() === clean.toLowerCase())) S.tags = [...S.tags, clean];
      S.quickAdd.tags = [...(S.quickAdd.tags || []), clean];
      S.quickAdd.showNewTag = false;
      render();
    }
    if (id === "btnQaSubmit") {
      const qa = S.quickAdd;
      if (qa.pendingOp) {
        // Button is showing "=" right now — evaluate the pending
        // calculation and stop there. It reverts to "Done" once resolved
        // (pendingOp cleared), and a second tap then actually submits.
        const val = parseFloat(qa.amount || "0") || 0;
        qa.runningTotal = qaApplyOp(qa.runningTotal, qa.pendingOp, val);
        qa.pendingOp = null;
        qa.amount = "";
        qa.lastOpKey = null;
        render();
      } else {
        const ok = await submitQuickAdd();
        if (ok) { S.quickAdd = null; S.view = null; render(); }
      }
    }
    if (id === "btnQaRecord") {
      const ok = await submitQuickAdd();
      if (ok) {
        // "Record" saves like Submit, but stays on the page and resets only
        // the entry-specific fields — keeps ledger/type/date/currency/account
        // so rapid multi-entry doesn't require re-picking them each time.
        const qa = S.quickAdd;
        S.quickAdd = {
          ...qa,
          amount: "", runningTotal: null, pendingOp: null,
          category: null, remark: "", tags: [],
          payerUids: [], splitUids: [], showSplit: false,
        };
        render();
      }
    }
    if (id === "btnBackFromLedgers") {
      if (S.returnTo) { const to = S.returnTo; S.returnTo = null; S.view = to; render(); }
      else goTo("home");
    }
    if (id === "btnWalletAddFunds") {
      const amount = val("walletAddAmount"), currency = val("walletAddCurrency"), note = val("walletAddNote");
      if (!amount || Number(amount) <= 0) return showError("walletAddError", "Enter a valid amount.");
      await addFunds(amount, currency, note);
      document.getElementById("walletAddAmount").value = "";
      document.getElementById("walletAddNote").value = "";
      refreshWalletNetWorth(S.personalBudget?.homeCurrency || "USD").catch((err) => console.error("Wallet net worth refresh failed:", err));
    }
    if (id === "btnWalletAddToLedger") {
      const ledgerId = val("walletTransferLedger");
      const amount = val("walletTransferAmount"), note = val("walletTransferNote");
      if (!amount || Number(amount) <= 0) return showError("walletTransferError", "Enter a valid amount.");
      try {
        const ledgerCurrency = await getLedgerCurrency(ledgerId);
        await addToLedgerWallet(ledgerId, ledgerCurrency, amount, note, S.profile?.displayName || "Someone");
        document.getElementById("walletTransferAmount").value = "";
        document.getElementById("walletTransferNote").value = "";
      } catch (err) {
        return showError("walletTransferError", err.message);
      }
    }
    if (id === "btnWalletTransfer") {
      const ledgerId = val("walletTransferLedger");
      const ledgerName = document.getElementById("walletTransferLedger")?.selectedOptions[0]?.textContent.trim();
      const amount = val("walletTransferAmount"), note = val("walletTransferNote");
      if (!amount || Number(amount) <= 0) return showError("walletTransferError", "Enter a valid amount.");
      try {
        const ledgerCurrency = await getLedgerCurrency(ledgerId);
        await fundLedgerWallet(ledgerId, ledgerName, ledgerCurrency, amount, note, S.profile?.displayName || "Someone");
        document.getElementById("walletTransferAmount").value = "";
        document.getElementById("walletTransferNote").value = "";
      } catch (err) {
        return showError("walletTransferError", err.message);
      }
    }
    if (id === "btnAddWalletRecurring") {
      const name = val("walletRecurName"), amount = val("walletRecurAmount"), currency = val("walletRecurCurrency"),
        freq = val("walletRecurFreq"), nextDate = val("walletRecurNextDate"),
        endDate = val("walletRecurEndDate"), maxOccurrences = val("walletRecurMaxOccurrences");
      if (!name || !amount || !nextDate) return showError("walletRecurError", "Name, amount, and start date are required.");
      await addWalletRecurring({ name, amount, currency, freq, nextDate, endDate, maxOccurrences });
    }
    if (e.target.dataset.delWalletRecurring) {
      if (confirm("Delete this recurring top-up?")) await deleteWalletRecurring(e.target.dataset.delWalletRecurring);
    }
    if (id === "btnAddLiability") {
      const name = val("liabilityName"), amount = val("liabilityAmount"), currency = val("liabilityCurrency");
      if (!name || !amount || Number(amount) <= 0) return showError("liabilityError", "Enter a name and a valid amount.");
      await addLiability(name, amount, currency);
      document.getElementById("liabilityName").value = "";
      document.getElementById("liabilityAmount").value = "";
      refreshWalletNetWorth(S.personalBudget?.homeCurrency || "USD").catch((err) => console.error("Wallet net worth refresh failed:", err));
    }
    if (e.target.dataset.delLiability) {
      if (confirm("Delete this liability?")) {
        await deleteLiability(e.target.dataset.delLiability);
        refreshWalletNetWorth(S.personalBudget?.homeCurrency || "USD").catch((err) => console.error("Wallet net worth refresh failed:", err));
      }
    }

    if (e.target.dataset.lid) {
      enterLedger(e.target.dataset.lid);
    }
    if (id === "btnAddLedgerWallet") {
      const amount = val("ledgerFundAmount"), note = val("ledgerFundNote");
      if (!amount || Number(amount) <= 0) return showError("ledgerFundError", "Enter a valid amount.");
      const ledgerCurrency = S.activeLedgerDetail?.currency || "USD";
      try {
        await addToLedgerWallet(S.activeLedgerId, ledgerCurrency, amount, note, S.profile?.displayName || "Someone");
        document.getElementById("ledgerFundAmount").value = "";
        document.getElementById("ledgerFundNote").value = "";
      } catch (err) {
        return showError("ledgerFundError", err.message);
      }
    }
    if (id === "btnFundLedgerWallet") {
      const amount = val("ledgerFundAmount"), note = val("ledgerFundNote");
      if (!amount || Number(amount) <= 0) return showError("ledgerFundError", "Enter a valid amount.");
      const ledgerCurrency = S.activeLedgerDetail?.currency || "USD";
      const ledgerName = S.activeLedgerDetail?.name || "this ledger";
      try {
        await fundLedgerWallet(S.activeLedgerId, ledgerName, ledgerCurrency, amount, note, S.profile?.displayName || "Someone");
        document.getElementById("ledgerFundAmount").value = "";
        document.getElementById("ledgerFundNote").value = "";
      } catch (err) {
        return showError("ledgerFundError", err.message);
      }
    }
    if (id === "btnBackFromLedgerManage") { S.view = null; render(); }
    if (id === "btnOpenLedgerManage") { S.view = "ledgerManage"; render(); }
    if (id === "btnOpenCategoriesFromSettings") {
      if (S.activeLedgerId) { S.view = "settingsCategoriesAndBudget"; render(); }
      else { S.returnTo = "aiSettings"; S.view = "personalBudget"; render(); }
    }
    if (id === "btnBackFromSettingsCategoriesAndBudget") { S.view = "aiSettings"; render(); }
    if (id === "btnOpenTagsFromSettings") { S.view = "tags"; render(); }
    if (id === "btnBackFromTags") { S.view = "aiSettings"; render(); }
    if (id === "btnOpenRecurringFromSettings") { S.view = "recurring"; render(); }
    if (id === "btnBackFromRecurring") { S.view = "aiSettings"; render(); }
    if (id === "btnOpenAppearanceFromSettings") { S.view = "settingsAppearance"; render(); }
    if (id === "btnBackFromAppearance") { S.view = "aiSettings"; render(); }
    if (id === "btnOpenStartupFromSettings") { S.view = "settingsStartup"; render(); }
    if (id === "btnBackFromStartup") { S.view = "aiSettings"; render(); }
    if (id === "btnOpenCurrencyFromSettings") {
      S.view = S.activeLedgerId ? "settingsLedgerCurrency" : "settingsCurrency";
      render();
    }
    if (id === "btnBackFromCurrency") { S.view = "aiSettings"; render(); }
    if (id === "btnBackFromLedgerCurrency") { S.view = "aiSettings"; render(); }
    if (id === "btnSaveLedgerCurrency") {
      const currency = val("ledgerCurrencySelect");
      await updateLedgerCurrency(S.activeLedgerId, currency);
    }
    if (id === "btnSaveSettingsCurrency") {
      const homeCurrency = val("settingsHomeCurrency");
      await setPersonalBudget(S.personalBudget?.total || 0, homeCurrency);
      await refreshPersonalOverview(homeCurrency);
    }
    const contextPill = e.target.closest?.("[data-context-lid]");
    if (contextPill) {
      const lid = contextPill.dataset.contextLid;
      if (lid) {
        switchLedger(lid);
      } else {
        S.activeLedgerId = null;
        S.activeLedgerDetail = null;
        S.members = {};
        S.txs = {};
      }
      render();
    }
    if (id === "btnOpenLedgerSectionFromSettings") {
      if (S.activeLedgerId) { S.view = "ledgerSection"; }
      else { S.returnTo = "aiSettings"; S.view = "ledgers"; }
      render();
    }
    if (id === "btnBackFromLedgerSection") { S.view = "aiSettings"; render(); }
    if (id === "btnOpenPocketFromSettings") {
      S.returnTo = "aiSettings";
      S.view = S.activeLedgerId ? "ledgerWallet" : "wallet";
      render();
    }
    if (id === "btnOpenAiReceiptFromSettings") { S.view = "settingsAiReceipt"; render(); }
    if (id === "btnBackFromAiReceipt") { S.view = "aiSettings"; render(); }
    if (id === "btnCategoriesBack") {
      if (S.categoriesBackView === "quickAdd" && S.quickAdd) S.quickAdd.showCategoriesPanel = false;
      else S.view = "aiSettings";
      S.categoriesBackView = null;
      render();
    }
    if (id === "btnBackFromLedgerBudget") { S.view = null; render(); }
    if (id === "btnBackFromLedgerWallet") {
      if (S.returnTo) { S.view = S.returnTo; S.returnTo = null; }
      else S.view = null;
      render();
    }
    if (id === "btnBackFromBudget") {
      if (S.returnTo) { const to = S.returnTo; S.returnTo = null; S.view = to; render(); }
      else goTo("home");
    }
    if (id === "btnHomeBookmarked") {
      if (S.activeLedgerId) { S.view = "bookmarked"; render(); return; }
      S.view = "homeBookmarks";
      render();
      const flaggedLedgerIds = Object.keys(S.includedLedgers || {});
      computeHomeBookmarksOverview(flaggedLedgerIds)
        .then((overview) => { S.homeBookmarksOverview = overview; render(); })
        .catch((err) => console.error("Home bookmarks overview failed:", err));
    }
    if (id === "btnBackFromSplits") { S.view = null; render(); }
    if (id === "btnBackFromBookmarked") { S.view = null; render(); }
    if (e.target.dataset.toggleBookmark) {
      const currentlyBookmarked = e.target.dataset.bookmarked === "true";
      await toggleBookmark(e.target.dataset.toggleBookmark, currentlyBookmarked);
    }
    if (id === "btnAddSettlement") {
      const from = val("settleFrom"), to = val("settleTo"), amount = val("settleAmount"), note = val("settleNote");
      if (from === to) return showError("settleError", "Pick two different people.");
      if (!amount || Number(amount) <= 0) return showError("settleError", "Enter a valid amount.");
      await addSettlement(S.activeLedgerId, { from, to, amount, note });
      render();
    }
    if (e.target.dataset.delSettlement) {
      if (confirm("Delete this settlement record?")) await deleteSettlement(S.activeLedgerId, e.target.dataset.delSettlement);
    }
    if (id === "btnSaveAiKey") {
      const key = val("geminiKeyInput");
      if (!key) return showError("aiKeyError", "Paste a key first.");
      setGeminiKey(key);
      render();
    }
    if (id === "btnClearAiKey") { clearGeminiKey(); render(); }
    if (id === "btnQaScanReceipt") { document.getElementById("qaReceiptFileInput").click(); }

    const themeBtn = e.target.closest?.("[data-set-theme]");
    if (themeBtn) await setThemePref("theme", themeBtn.dataset.setTheme);
    const cardBtn = e.target.closest?.("[data-set-card]");
    if (cardBtn) await setThemePref("cardStyle", cardBtn.dataset.setCard);
    const chartBtn = e.target.closest?.("[data-set-chart]");
    if (chartBtn) await setThemePref("chartStyle", chartBtn.dataset.setChart);
    const iconStyleBtn = e.target.closest?.("[data-set-icon-style]");
    if (iconStyleBtn) await setThemePref("iconStyle", iconStyleBtn.dataset.setIconStyle);

    if (id === "btnOpenAddLedgerModal") { S.ledgerModal = "add"; S.newLedgerIcon = "💼"; render(); }
    if (id === "btnOpenJoinLedgerModal") { S.ledgerModal = "join"; render(); }
    if (id === "btnCloseLedgerModal" || e.target.id === "ledgerModalBackdrop") { S.ledgerModal = null; render(); }
    if (e.target.dataset.pickNewIcon) { S.newLedgerIcon = e.target.dataset.pickNewIcon; render(); }
    if (e.target.dataset.pickEditIcon) { S.editLedgerIcon = e.target.dataset.pickEditIcon; render(); }
    const editLedgerBtn = e.target.closest?.("[data-edit-lid]");
    if (editLedgerBtn) {
      S.editLedgerId = editLedgerBtn.dataset.editLid;
      S.editLedgerIcon = null;
      S.ledgerModal = "edit";
      render();
    }
    if (id === "btnSaveLedgerEdit") {
      const name = val("editLedgerName");
      if (!name) return showError("editLedgerError", "Enter a name first.");
      const icon = S.editLedgerIcon || S.ledgers?.[S.editLedgerId]?.icon || "💼";
      await renameLedger(S.editLedgerId, name, icon);
      S.ledgerModal = null;
      render();
    }
    if (id === "btnCreateLedger") {
      const name = val("newLedgerName");
      if (!name) return showError("createError", "Enter a name first.");
      await createLedger(name, S.newLedgerIcon || "💼");
      S.ledgerModal = null;
      render();
    }
    if (id === "btnJoinLedger") {
      const code = val("joinCode");
      if (!code) return showError("joinError", "Enter an invite code.");
      await joinLedgerByCode(code);
      S.ledgerModal = null;
      render();
    }
    if (e.target.dataset.del) {
      const tx = S.txs[e.target.dataset.del];
      await deleteTransaction(e.target.dataset.del);
      if (tx?.account === "wallet" && tx.type === "expense") {
        await refundToLedgerWallet(S.activeLedgerId, tx.amount);
      }
    }

    if (id === "btnAddRecurring") {
      const name = val("recurName"), type = val("recurType"), amount = val("recurAmount"),
        category = val("recurCategory"), freq = val("recurFreq"), nextDate = val("recurNextDate"),
        endDate = val("recurEndDate"), maxOccurrences = val("recurMaxOccurrences"), currency = val("recurCurrency");
      if (!name || !amount || !category || !nextDate) return showError("recurringError", "Name, amount, category, and start date are required.");
      await addRecurring(S.activeLedgerId, {
        name, type, amount, category, freq, nextDate, endDate, maxOccurrences, currency,
      });
    }
    if (e.target.dataset.delRecurring) {
      if (confirm("Delete this recurring transaction? Past entries it already created will stay.")) {
        await deleteRecurring(S.activeLedgerId, e.target.dataset.delRecurring);
      }
    }

    if (e.target.dataset.delTag) {
      if (confirm(`Delete tag "${e.target.dataset.delTag}"? It'll be removed from every transaction using it.`)) {
        await deleteTag(S.activeLedgerId, e.target.dataset.delTag);
      }
    }

    const emojiChip = e.target.closest?.(".emoji-chip");
    if (emojiChip) {
      document.querySelectorAll("#catEmojiPicker .emoji-chip").forEach((c) => c.classList.remove("active"));
      emojiChip.classList.add("active");
    }
    if (id === "btnAddPersonalCatBudget") {
      const label = val("pcatName"), amount = val("pcatAmount");
      if (!label) return showError("pcatError", "Enter a category name.");
      await setPersonalCategoryBudget(label, amount);
      document.getElementById("pcatName").value = "";
      document.getElementById("pcatAmount").value = "";
    }
    if (e.target.dataset.relinkApply) {
      const oldLabel = e.target.dataset.relinkApply;
      const select = document.querySelector(`.relink-select[data-relink-old="${oldLabel}"]`);
      const newLabel = select?.value;
      if (!newLabel) return showError("pcatError", "Pick a category name first.");
      await relinkPersonalCategoryBudget(oldLabel, newLabel);
      refreshHomeOverview();
    }
    if (e.target.dataset.delPcat) {
      if (confirm("Delete this budget target?")) {
        await deletePersonalCategoryBudget(e.target.dataset.delPcat);
      }
    }
    if (id === "btnAddCategory") {
      const label = val("catName");
      const type = val("catType");
      const icon = document.querySelector("#catEmojiPicker .emoji-chip.active")?.dataset.emoji || "📦";
      if (!label) return showError("catError", "Enter a category name.");
      await addCategory(S.activeLedgerId || S.quickAdd?.ledgerId, { label, icon, type });
      document.getElementById("catName").value = "";
      await refreshQaCategoriesIfNeeded();
    }
    if (e.target.dataset.delCat) {
      if (confirm("Delete this category? Past transactions using it will keep showing its name.")) {
        await deleteCategory(S.activeLedgerId || S.quickAdd?.ledgerId, e.target.dataset.delCat);
        await refreshQaCategoriesIfNeeded();
      }
    }
    if (e.target.dataset.moveCat) {
      await moveCategory(S.activeLedgerId || S.quickAdd?.ledgerId, e.target.dataset.moveCat, e.target.dataset.dir);
      await refreshQaCategoriesIfNeeded();
    }
    // Tap a category's icon to open a shared picker; tap an emoji in it to apply.
    if (e.target.dataset.changeIconKey) {
      const picker = document.getElementById("catChangeIconPicker");
      if (picker) {
        picker.dataset.editingKey = e.target.dataset.changeIconKey;
        picker.classList.remove("hidden");
      }
    }
    if (e.target.dataset.setIcon) {
      const picker = document.getElementById("catChangeIconPicker");
      const key = picker?.dataset.editingKey;
      if (key) await updateCategory(S.activeLedgerId || S.quickAdd?.ledgerId, key, { icon: e.target.dataset.setIcon });
      picker?.classList.add("hidden");
      await refreshQaCategoriesIfNeeded();
    }

    if (id === "btnRenameLedger") {
      const name = val("ledgerNameInput"), icon = val("ledgerIconInput");
      if (!name) return showError("renameError", "Enter a ledger name.");
      await renameLedger(S.activeLedgerId, name, icon || "💼");
    }
    if (id === "btnRegenInvite") {
      if (confirm("Old invite code will stop working. Continue?")) await regenerateInviteCode(S.activeLedgerId);
    }
    if (id === "btnAddGuest") {
      const name = val("guestName");
      if (!name) return showError("guestError", "Enter a guest name.");
      await addGuest(S.activeLedgerId, name);
      document.getElementById("guestName").value = "";
    }
    if (e.target.dataset.removeGuest) await removeGuest(S.activeLedgerId, e.target.dataset.removeGuest);
    if (e.target.dataset.removeUid) {
      if (confirm("Remove this member from the ledger?")) await removeMember(S.activeLedgerId, e.target.dataset.removeUid);
    }
    if (id === "btnLeaveLedger") {
      if (confirm("Leave this ledger? You'll need a new invite to rejoin.")) {
        await leaveLedger(S.activeLedgerId, S.user.uid);
        S.activeLedgerId = null;
        render();
      }
    }
    if (id === "btnDeleteLedger") {
      if (confirm("Delete this ledger permanently for everyone? This cannot be undone.")) {
        await deleteLedger(S.activeLedgerId);
        S.activeLedgerId = null;
        render();
      }
    }

    if (id === "btnSaveLedgerBudget") {
      const total = val("ledgerBudgetInput");
      if (total) await setLedgerBudget(S.activeLedgerId, total);
    }
    if (id === "btnSavePersonalBudget") {
      const total = val("personalBudgetTotal"), homeCurrency = val("personalHomeCurrency");
      if (total) {
        await setPersonalBudget(total, homeCurrency);
        await refreshPersonalOverview(homeCurrency);
      }
    }
    if (id === "btnRefreshOverview") {
      const homeCurrency = val("personalHomeCurrency") || S.personalBudget?.homeCurrency || "USD";
      await refreshPersonalOverview(homeCurrency);
    }
  } catch (err) {
    console.error(err);
    showError("authError", err.message) || showError("createError", err.message) ||
      showError("joinError", err.message) ||
      showError("recurringError", err.message) || showError("guestError", err.message) ||
      showError("settleError", err.message) || showError("catError", err.message) ||
      showError("pcatError", err.message) || showError("walletAddError", err.message) ||
      showError("walletTransferError", err.message) || showError("walletRecurError", err.message) ||
      showError("liabilityError", err.message) ||
      showError("qaError", err.message) ||
      showError("ledgerFundError", err.message);
  }
});

function val(id) { return document.getElementById(id)?.value?.trim(); }
function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return false;
  el.textContent = msg;
  return true;
}

// Role changes and permission checkboxes fire "change", not "click".
document.getElementById("app").addEventListener("change", async (e) => {
  const id = e.target.id;
  try {
    if (e.target.dataset.roleUid) {
      const uid = e.target.dataset.roleUid, role = e.target.value;
      await setMemberRole(S.activeLedgerId, uid, role, role === "moderator" ? {} : null);
    }
    if (e.target.dataset.permUid) {
      const uid = e.target.dataset.permUid, key = e.target.dataset.permKey;
      const member = S.members[uid];
      const perms = { ...(member?.permissions || {}), [key]: e.target.checked };
      await setModeratorPermissions(S.activeLedgerId, uid, perms);
    }
    if (id === "previewRoleSelect") {
      S.debugPreviewRole = e.target.value || null;
      render();
    }
    if (id === "qaRemark") { S.quickAdd.remark = e.target.value; }
    if (e.target.dataset.catField && e.target.dataset.catKey) {
      const field = e.target.dataset.catField, key = e.target.dataset.catKey;
      if (field === "budget") await setCategoryBudget(S.activeLedgerId, key, e.target.value);
      else if (field === "label" && e.target.value.trim()) await updateCategory(S.activeLedgerId, key, { label: e.target.value.trim() });
    }
    if (e.target.dataset.pcatLabel) {
      await setPersonalCategoryBudget(e.target.dataset.pcatLabel, e.target.value);
    }
    if (e.target.dataset.tagRenameOld && e.target.value.trim() && e.target.value.trim() !== e.target.dataset.tagRenameOld) {
      await renameTag(S.activeLedgerId, e.target.dataset.tagRenameOld, e.target.value.trim());
    }
    if (e.target.dataset.includeLid) {
      await setLedgerIncluded(e.target.dataset.includeLid, e.target.checked);
      refreshHomeOverview();
    }
    if (id === "homeStartupSelect") {
      await setThemePref("homeStartup", e.target.value);
    }
    if (id === "qaReceiptFileInput") {
      const file = e.target.files[0];
      if (!file) return;
      const statusEl = document.getElementById("qaScanStatus");
      if (statusEl) statusEl.style.display = "block";
      showError("qaError", "");
      try {
        const { base64, mimeType } = await fileToBase64(file);
        const parsed = await scanReceipt(base64, mimeType);
        if (parsed.amount != null) { S.quickAdd.amount = String(parsed.amount); S.quickAdd.pendingOp = null; S.quickAdd.runningTotal = null; }
        if (parsed.category) S.quickAdd.category = parsed.category;
        if (parsed.description) S.quickAdd.remark = parsed.description;
        if (parsed.currency) S.quickAdd.currency = parsed.currency;
        render();
      } catch (err) {
        showError("qaError", err.message);
      } finally {
        if (statusEl) statusEl.style.display = "none";
        e.target.value = ""; // allow re-selecting the same photo again later
      }
    }
  } catch (err) {
    console.error(err);
  }
});
