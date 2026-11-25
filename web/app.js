/* ============================================================================
   KLINIK KESIHATAN MERU — STAFF PORTAL (PWA)
   ----------------------------------------------------------------------------
   Hosting : GitHub Pages (this folder)
   Sign-in : Firebase Authentication (email + password)
   Data    : Google Sheet, reached through an Apps Script web app

   The page never decides who may see or change anything. It sends the
   Firebase ID token with every request and Apps Script checks it, checks
   the email against the Users sheet, and refuses writes from non-admins.
   Hiding or showing buttons here is convenience only.
   ========================================================================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword,
  sendPasswordResetEmail, sendEmailVerification, setPersistence,
  browserLocalPersistence, browserSessionPersistence,
  reauthenticateWithCredential, EmailAuthProvider, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

/* Refuse to run inside someone else's frame (clickjacking). */
if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  try { window.top.location = window.location.href; } catch (e) {}
}

window.__portalStarted = true;
const CFG = window.PORTAL_CONFIG || {};
const looksUnset = v => !v || /PASTE_/.test(String(v));
const CONFIGURED = !looksUnset(CFG.apiUrl) && CFG.firebase && !looksUnset(CFG.firebase.apiKey);

const state = {
  user: null,          // {email, name, role}
  data: null,          // all content collections
  version: null,       // server data version (conflict detection)
  loadedAt: 0,
  dirty: false,
  editing: false,
  users: [],
  pendingCount: 0,
  pendingReg: null,
  pushReady: false,    // server has FCM_SERVICE_ACCOUNT
  notifyAnn: new Set(),// announcement ids to push when the admin saves
  rosterSnap: "",      // roster + on-call as last saved, to spot changes    // {name, unit} typed on the Register form, sent once the login exists
  loginNotice: null
};

let auth = null;
let fbApp = null;
if (CONFIGURED) { fbApp = initializeApp(CFG.firebase); auth = getAuth(fbApp); }

/* ---------- helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => "x" + Math.random().toString(36).slice(2, 10);
const isHttpUrl = u => /^https?:\/\//i.test(String(u || "").trim());
const initials = n => String(n).replace(/^(Dr\.|Pn\.|En\.|Tn\.|Cik)\s*/i, "")
  .split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase();

function toast(msg, ms = 2800) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}
function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = "msg" + (text ? " " + kind : "");
}

/* ---------- server calls ---------- */
async function api(action, payload = {}) {
  const u = auth.currentUser;
  if (!u) throw Object.assign(new Error("Your session has ended. Please sign in again."), { status: 401 });
  const idToken = await u.getIdToken();
  let res;
  try {
    // text/plain keeps this a "simple" request, which Apps Script can answer cross-origin
    res = await fetch(CFG.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({}, payload, { action, idToken }))
    });
  } catch (e) {
    throw new Error("Cannot reach the portal server. Check your internet connection.");
  }
  let body;
  try { body = await res.json(); }
  catch (e) { throw new Error("Unexpected reply from the server. Check that the Apps Script web app is deployed with access set to “Anyone”."); }
  if (!body.ok) {
    const err = Object.assign(new Error(body.error || "Request failed."),
      { status: body.status, code: body.code, emailVerified: body.emailVerified });
    if (body.status === 401 && state.user) {        // token revoked or expired on the server side
      state.loginNotice = body.error;
      state.dirty = false;
      signOut(auth);
    }
    throw err;
  }
  return body;
}

/* ============================================================================
   SIGN-IN SCREEN
   ========================================================================== */
function showPanel(id) {
  ["panelLoading", "panelLogin", "panelRegister", "panelRequest", "panelPending", "panelVerify", "panelSetup"]
    .forEach(p => $("#" + p).hidden = p !== id);
  $("#loginScreen").hidden = false;
  $("#app").hidden = true;
}
function showLoading(text) {
  $("#loadingText").textContent = text || "Loading…";
  showPanel("panelLoading");
}
function showLogin() {
  closeAllDialogs();
  setEditing(false);
  showPanel("panelLogin");
  $("#loginFoot").textContent = "For authorised clinic staff only. Sign-ins and changes are logged.";
  setMsg($("#loginMsg"), state.loginNotice, "err");
  state.loginNotice = null;
  showInstallHint();
  setTimeout(() => ($("#email").value ? $("#password") : $("#email")).focus(), 50);
}

const AUTH_ERRORS = {
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/invalid-login-credentials": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "Incorrect email or password.",
  "auth/invalid-email": "Please enter a valid email address.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
  "auth/network-request-failed": "No internet connection. Check your network and try again."
};
const authMsg = e => AUTH_ERRORS[e && e.code] || (e && e.message) || "Something went wrong.";

$("#panelLogin").addEventListener("submit", async ev => {
  ev.preventDefault();
  const btn = $("#loginBtn"), msg = $("#loginMsg");
  const email = $("#email").value.trim(), password = $("#password").value;
  if (!email || !password) { setMsg(msg, "Enter your email and password.", "err"); return; }
  setMsg(msg, "");
  btn.disabled = true; btn.textContent = "Signing in…";
  try {
    // On a shared clinic PC leave the box unticked: closing the browser signs you out.
    await setPersistence(auth, $("#remember").checked ? browserLocalPersistence : browserSessionPersistence);
    await signInWithEmailAndPassword(auth, email, password);
    $("#password").value = "";
    // onAuthStateChanged takes it from here
  } catch (e) {
    setMsg(msg, authMsg(e), "err");
  } finally {
    btn.disabled = false; btn.textContent = "Log In";
  }
});

$("#forgotBtn").addEventListener("click", async () => {
  const email = $("#email").value.trim(), msg = $("#loginMsg");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setMsg(msg, "Type your email address above first, then click “Forgot password?” again.", "info");
    $("#email").focus();
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (e) {
    if (e.code === "auth/too-many-requests" || e.code === "auth/network-request-failed") { setMsg(msg, authMsg(e), "err"); return; }
  }
  // Same message whether or not the email exists, so this cannot be used to probe for accounts.
  setMsg(msg, "If that email is registered, a password-reset link is on its way. Check your inbox and spam folder.", "ok");
});

/* ============================================================================
   STAFF PROFILE FIELDS
   Used by the registration form, "request access", My Account and the
   administrators' add / edit dialogs. The server re-checks every value.
   ========================================================================== */
const POSITIONS = Array.isArray(CFG.positions) && CFG.positions.length ? CFG.positions : [
  "Pakar Perubatan Keluarga", "Pegawai Perubatan", "Pegawai Pergigian", "Pegawai Farmasi",
  "Penolong Pegawai Perubatan", "Ketua Jururawat / Sister", "Jururawat", "Jururawat Masyarakat",
  "Juruteknologi Makmal Perubatan", "Juru X-Ray", "Juruterapi Pergigian", "Pembantu Pembedahan Pergigian",
  "Pegawai Pemulihan Perubatan", "Pegawai Dietetik", "Penolong Pegawai Kesihatan Persekitaran",
  "Pegawai Tadbir", "Pembantu Tadbir", "Pembantu Perawatan Kesihatan", "Pemandu"];
const UNITS = Array.isArray(CFG.units) && CFG.units.length ? CFG.units : [
  "Outpatient (OPD)", "Emergency & Treatment Room", "Nursing", "Maternal & Child Health", "Pharmacy",
  "Laboratory", "Radiology", "Dental", "Rehabilitation", "Public Health", "Administration"];
const OTHER = "__other";
const PROFILE_FIELDS = ["name", "jawatan", "gred", "unit", "phone", "ext"];
const PROFILE_RULES = {
  name:    { label: "Full name", min: 3 },
  jawatan: { label: "Position", min: 2 },
  gred:    { label: "Grade", re: /^[A-Za-z0-9 ()\/\-]{1,20}$/ },
  unit:    { label: "Unit", min: 2 },
  phone:   { label: "Mobile number", re: /^\+?[0-9][0-9 \-]{7,18}$/ },
  ext:     { label: "Extension", re: /^[0-9]{1,6}$/ }
};

/**
 * p: id prefix · v: current values · opt.required: fields marked *
 * opt.locked: fields shown read-only (staff cannot change their own position, grade, unit)
 */
function profileFieldsHtml(p, v = {}, opt = {}) {
  const req = opt.required || ["name", "jawatan", "unit", "phone"];
  const locked = opt.locked || [];
  const star = k => req.includes(k) ? ' <span class="req">*</span>' : "";
  const ro = (k, label) => `<div class="field"><label>${label}</label><input type="text" value="${esc(v[k] || "—")}" disabled></div>`;
  const text = (k, label, attrs) => locked.includes(k) ? ro(k, label)
    : `<div class="field"><label for="${p}_${k}">${label}${star(k)}</label><input type="text" id="${p}_${k}" value="${esc(v[k] || "")}" ${attrs}></div>`;
  const choose = (k, list, label, ph) => {
    if (locked.includes(k)) return ro(k, label);
    const val = v[k] || "", other = !!val && !list.includes(val);
    return `<div class="field"><label for="${p}_${k}">${label}${star(k)}</label>
      <select id="${p}_${k}" data-other-for="${p}_${k}_other">
        <option value="">— Select —</option>
        ${list.map(o => `<option value="${esc(o)}" ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}
        <option value="${OTHER}" ${other ? "selected" : ""}>Other — type it in</option>
      </select>
      <input type="text" id="${p}_${k}_other" maxlength="100" placeholder="${ph}" value="${other ? esc(val) : ""}" ${other ? "" : "hidden"} aria-label="${label}">
    </div>`;
  };
  return `${text("name", "Full name (as in official records)", 'maxlength="120" autocomplete="name" placeholder="e.g. Siti Aminah binti Ahmad"')}
    ${choose("jawatan", POSITIONS, "Position (jawatan)", "Type your position")}
    <div class="field-row">
      ${text("gred", "Grade (gred)", 'maxlength="20" placeholder="e.g. U29" autocapitalize="characters"')}
      ${text("ext", "Extension", 'maxlength="6" inputmode="numeric" placeholder="e.g. 205"')}
    </div>
    ${choose("unit", UNITS, "Unit", "Type your unit")}
    ${text("phone", "Mobile number", 'maxlength="20" inputmode="tel" autocomplete="tel" placeholder="e.g. 012-345 6789"')}`;
}

/* Returns {profile} or {error, el}. Only fields that are on screen and editable are read. */
function readProfile(p, required) {
  const out = {};
  for (const k of PROFILE_FIELDS) {
    const el = document.getElementById(`${p}_${k}`);
    if (!el || el.disabled) continue;
    const viaOther = el.tagName === "SELECT" && el.value === OTHER;
    const src = viaOther ? document.getElementById(`${p}_${k}_other`) : el;
    let v = src.value.trim().replace(/\s+/g, " ");
    if (k === "gred") v = v.toUpperCase();
    const r = PROFILE_RULES[k];
    if (!v) {
      if (required.includes(k) || r.min) return { error: r.label + " is required.", el: src };
      out[k] = "";
      continue;
    }
    if ((r.min && v.length < r.min) || (r.re && !r.re.test(v))) return { error: "Please enter a valid " + r.label.toLowerCase() + ".", el: src };
    out[k] = v;
  }
  return { profile: out };
}
function profileError(res, msgEl) {
  if (msgEl) setMsg(msgEl, res.error, "err"); else toast(res.error);
  if (res.el) { res.el.style.borderColor = "var(--red)"; res.el.focus(); setTimeout(() => res.el.style.borderColor = "", 2500); }
}
document.addEventListener("change", e => {
  const sel = e.target.closest && e.target.closest("select[data-other-for]");
  if (!sel) return;
  const other = document.getElementById(sel.dataset.otherFor);
  other.hidden = sel.value !== OTHER;
  if (!other.hidden) other.focus();
});
const posText = u => (u.jawatan || "—") + (u.gred ? ` (${u.gred})` : "");

/* ----- self-registration ----- */
$("#regProfile").innerHTML = profileFieldsHtml("reg");
$("#showRegister").addEventListener("click", () => {
  showPanel("panelRegister");
  setMsg($("#regMsg"), "");
  if ($("#email").value) $("#regEmail").value = $("#email").value;
  setTimeout(() => $("#reg_name").focus(), 50);
});
$("#showLogin").addEventListener("click", () => showLogin());
$$("[data-signout]").forEach(b => b.addEventListener("click", () => signOut(auth)));

function regChecks() {
  const next = $("#regPw").value, low = next.toLowerCase(), letters = low.replace(/[^a-z]/g, "");
  const parts = ($("#reg_name").value + " " + $("#regEmail").value.split("@")[0])
    .toLowerCase().split(/[\s._\-]+/).filter(w => w.length >= 4 && !/^(binti|bin)$/.test(w));
  return {
    len: next.length >= 10,
    letter: /[A-Za-z]/.test(next),
    numsym: /[^A-Za-z]/.test(next),
    notname: next.length > 0 && !parts.some(w => low.includes(w)) && !BANNED.some(b => low === b || letters === b),
    match: next.length > 0 && next === $("#regPw2").value
  };
}
function updateRegUi() {
  const c = regChecks();
  $$("#regRules li").forEach(li => {
    const ok = !!c[li.dataset.rule];
    li.classList.toggle("met", ok);
    li.querySelector(".mark").textContent = ok ? "✓" : "○";
  });
  $("#regBtn").disabled = !Object.values(c).every(Boolean);
}
["#reg_name", "#regEmail", "#regPw", "#regPw2"].forEach(sel => $(sel).addEventListener("input", updateRegUi));

const REG_ERRORS = {
  "auth/email-already-in-use": "This email already has a login. Go back and log in — or use “Forgot password?”.",
  "auth/operation-not-allowed": "Self-registration is switched off. Ask a portal administrator to add you.",
  "auth/admin-restricted-operation": "Self-registration is switched off. Ask a portal administrator to add you.",
  "auth/weak-password": "That password is too weak."
};

$("#panelRegister").addEventListener("submit", async ev => {
  ev.preventDefault();
  const msg = $("#regMsg"), btn = $("#regBtn");
  const res = readProfile("reg", ["name", "jawatan", "unit", "phone"]);
  if (res.error) { profileError(res, msg); return; }
  const email = $("#regEmail").value.trim().toLowerCase(), pw = $("#regPw").value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg(msg, "Please enter a valid email address.", "err"); return; }
  if (!Object.values(regChecks()).every(Boolean)) return;
  setMsg(msg, "");
  btn.disabled = true; btn.textContent = "Registering…";
  try {
    await setPersistence(auth, browserSessionPersistence);
    state.pendingReg = res.profile;
    const cred = await createUserWithEmailAndPassword(auth, email, pw);
    try { await sendEmailVerification(cred.user); } catch (e) { /* can be resent from the next screen */ }
    $("#regPw").value = ""; $("#regPw2").value = "";
    // onAuthStateChanged → startSession → sends the access request
  } catch (e) {
    state.pendingReg = null;
    setMsg(msg, REG_ERRORS[e.code] || authMsg(e), "err");
  } finally {
    btn.textContent = "Register";
    updateRegUi();
  }
});

/* signed in to Firebase but no request on the Users sheet yet */
function showRequest(user, error, values) {
  showPanel("panelRequest");
  $("#reqEmail").textContent = user.email;
  $("#reqProfile").innerHTML = profileFieldsHtml("req", values || {});
  setMsg($("#reqMsg"), error || "", "err");
  setTimeout(() => $("#req_name").focus(), 50);
}
$("#panelRequest").addEventListener("submit", async ev => {
  ev.preventDefault();
  const res = readProfile("req", ["name", "jawatan", "unit", "phone"]);
  if (res.error) { profileError(res, $("#reqMsg")); return; }
  $("#reqBtn").disabled = true;
  try {
    await api("register", res.profile);
    showPending(auth.currentUser.emailVerified);
  } catch (e) { setMsg($("#reqMsg"), e.message, "err"); }
  finally { $("#reqBtn").disabled = false; }
});

function showPending(verified) {
  showPanel("panelPending");
  setMsg($("#pendMsg"), "");
  $("#pendEmail").textContent = auth.currentUser ? auth.currentUser.email : "";
  $("#pendVerify").hidden = !!verified;
  $("#pendResend").hidden = !!verified;
}
$("#pendCheck").addEventListener("click", async () => {
  try { await auth.currentUser.reload(); await auth.currentUser.getIdToken(true); } catch (e) {}
  startSession();
});
$("#pendResend").addEventListener("click", async () => {
  try {
    await sendEmailVerification(auth.currentUser);
    setMsg($("#pendMsg"), "Verification email sent to " + auth.currentUser.email + ".", "ok");
  } catch (e) { setMsg($("#pendMsg"), authMsg(e), "err"); }
});

/* ----- email verification ----- */
function showVerify() {
  showPanel("panelVerify");
  setMsg($("#verifyMsg"), "");
}
$("#verifySend").addEventListener("click", async () => {
  try {
    await sendEmailVerification(auth.currentUser);
    setMsg($("#verifyMsg"), "Verification email sent to " + auth.currentUser.email + ". Check spam too.", "ok");
  } catch (e) { setMsg($("#verifyMsg"), authMsg(e), "err"); }
});
$("#verifyContinue").addEventListener("click", async () => {
  try {
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);   // fresh token carries email_verified
    startSession();
  } catch (e) { setMsg($("#verifyMsg"), authMsg(e), "err"); }
});
$("#verifyLogout").addEventListener("click", () => signOut(auth));

/* ============================================================================
   STARTUP
   ========================================================================== */
function boot() {
if (!CONFIGURED) {
  // config.js still has its placeholders: there is nothing to sign in to
  showPanel("panelSetup");
  $("#loginFoot").textContent = "Portal KK Meru";
} else {
  showLoading("Checking sign-in…");
  onAuthStateChanged(auth, user => {
    if (!user) {
      state.user = null; state.data = null; state.dirty = false;
      showLogin();
      return;
    }
    if (!state.user) startSession();
  });
}
}

async function startSession() {
  showLoading("Loading the portal…");
  try {
    const s = await api("session");
    state.user = s.user;
    state.pendingCount = s.pendingCount || 0;
    state.pushReady = !!s.pushReady;
    await loadData();
    enterApp();
  } catch (e) {
    if (e.code === "unverified") { showVerify(); return; }
    if (e.code === "pending") { showPending(e.emailVerified); return; }
    if (e.code === "not_registered") {
      const reg = state.pendingReg;
      state.pendingReg = null;
      if (!reg) { showRequest(auth.currentUser); return; }
      try {
        const r = await api("register", reg);
        if (r.status === "pending") { showPending(auth.currentUser.emailVerified); return; }
        return startSession();                          // already approved earlier
      } catch (e2) {
        showRequest(auth.currentUser, e2.message, reg);
        return;
      }
    }
    state.user = null;
    state.loginNotice = e.message;
    await signOut(auth);           // → onAuthStateChanged(null) → showLogin() with the notice
  }
}

async function loadData() {
  const d = await api("getData");
  state.data = d.data;
  state.version = d.version;
  state.loadedAt = Date.now();
  state.dirty = false;
  state.notifyAnn.clear();
  state.rosterSnap = rosterSnapshot();
}
const rosterSnapshot = () => state.data ? JSON.stringify([state.data.roster, state.data.oncall]) : "";

function enterApp() {
  $("#loginScreen").hidden = true;
  $("#app").hidden = false;
  const isAdmin = state.user.role === "admin";
  $("#whoName").textContent = state.user.name;
  $("#whoRole").textContent = isAdmin ? "Admin" : "Staff";
  $("#adminLinks").hidden = !isAdmin;
  $("#navAccounts").hidden = !isAdmin;
  updatePendingIndicators();
  $("#footMode").textContent = "Signed in securely";
  renderQuickLinks();
  setEditing(false);
  showTab(tabFromUrl() || "home", false);
  refreshPushSilently();
  updatePushPrompt();
}

function updatePendingIndicators() {
  const n = state.user && state.user.role === "admin" ? state.pendingCount : 0;
  $("#pendBadge").hidden = !n;
  $("#pendBadge").textContent = n;
  $("#pendingNotice").hidden = !n;
  $("#pendingNoticeText").textContent = n === 1 ? "1 person is waiting for approval to use the portal."
                                                : n + " people are waiting for approval to use the portal.";
}

async function doLogout() {
  if (state.dirty && !confirm("You have unsaved changes. Log out anyway?")) return;
  state.dirty = false;
  // so the next person on a shared computer does not receive this account's notifications
  if (ls.get(PUSH_KEY)) await disablePush().catch(() => {});
  await signOut(auth);            // onAuthStateChanged shows the sign-in screen
}
$("#logoutBtn").addEventListener("click", doLogout);

/* Refresh quietly when the app comes back to the foreground after a while,
   so a phone left open overnight shows today's roster, not yesterday's. */
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !state.user) return;
  if (state.editing || state.dirty || Date.now() - state.loadedAt < 5 * 60 * 1000) return;
  try { await loadData(); renderAll(); } catch (e) { /* api() handles expired sessions */ }
});

/* ============================================================================
   INSTALL TO HOME SCREEN
   ========================================================================== */
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

let installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; showInstallHint(); });
window.addEventListener("appinstalled", () => { installPrompt = null; $("#installFoot").hidden = true; });
$("#installBtn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch (e) {}
  installPrompt = null;
  $("#installFoot").hidden = true;
});

function showInstallHint() {
  if (isStandalone()) return;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (installPrompt) {
    $("#installText").textContent = "Add the portal to your home screen for quicker access.";
    $("#installBtn").hidden = false;
    $("#installFoot").hidden = false;
  } else if (isIOS) {
    $("#installText").innerHTML = 'To add this to your home screen: tap <strong>Share</strong> in Safari, then <strong>Add to Home Screen</strong>.';
    $("#installBtn").hidden = true;
    $("#installFoot").hidden = false;
  }
}

function tabFromUrl() {
  const t = new URLSearchParams(location.search).get("tab");
  return ["home", "announce", "roster", "forms", "dir", "accounts"].includes(t) ? t : null;
}

/* ============================================================================
   GENERIC DIALOG
   ========================================================================== */
let modalOnSave = null;
function openModal(title, html, onSave, saveLabel = "Save") {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  $("#modalSave").textContent = saveLabel;
  $("#modalSave").disabled = false;
  modalOnSave = onSave;
  $("#modal").classList.add("open");
  const first = $("#modalBody input, #modalBody select, #modalBody textarea");
  if (first) setTimeout(() => first.focus(), 50);
}
function closeModal() { $("#modal").classList.remove("open"); modalOnSave = null; }
function closeAllDialogs() { closeModal(); $("#pwModal").classList.remove("open"); }

$("#modalCancel").addEventListener("click", closeModal);
$("#modal").addEventListener("mousedown", e => { if (e.target.id === "modal") closeModal(); });
$("#modalSave").addEventListener("click", async () => {
  if (!modalOnSave) return;
  const btn = $("#modalSave"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const keepOpen = await modalOnSave();
    if (!keepOpen) closeModal();
  } catch (e) {
    toast(e.message || "Could not save.", 4500);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if ($("#pwModal").classList.contains("open")) $("#pwModal").classList.remove("open");
  else closeModal();
});

/* ============================================================================
   MY ACCOUNT
   ========================================================================== */
$("#accountBtn").addEventListener("click", () => {
  const isAdmin = state.user.role === "admin";
  openModal("My account", `
    ${isAdmin ? "" : '<p class="ro-note">You can update your name, mobile number and extension. Your position, grade and unit can only be changed by a portal administrator.</p>'}
    ${profileFieldsHtml("me", state.user, { required: ["name"], locked: isAdmin ? [] : ["jawatan", "gred", "unit"] })}
    <div class="field"><label>Email (sign-in)</label><input type="text" value="${esc(state.user.email)}" disabled></div>
    <div class="field"><label>Access level</label><input type="text" value="${isAdmin ? "Administrator" : "Staff (view only)"}" disabled></div>`,
  async () => {
    const res = readProfile("me", ["name"]);
    if (res.error) { profileError(res); return true; }
    const r = await api("updateMyProfile", res.profile);
    state.user = r.user;
    $("#whoName").textContent = state.user.name;
    toast("Your details have been updated.");
    if (!state.dirty) loadData().then(renderAll).catch(() => {});   // directory picks up the change
  }, "Save my details");
});

/* ============================================================================
   CHANGE PASSWORD
   ----------------------------------------------------------------------------
   Firebase re-checks the current password, stores the new one, and revokes
   the account's other sessions. Apps Script rejects tokens issued before the
   change, so another device is cut off at its next request.
   ========================================================================== */
const BANNED = ["password","passw0rd","katalaluan","12345678","123456789","1234567890","qwerty","qwertyuiop",
  "abc123","admin","admin123","letmein","welcome","klinik","kesihatan","klinikkesihatan","kkmeru","kkm",
  "meru","malaysia","selangor","klang","hospital","jururawat","doktor","iloveyou"];

function pwChecks(cur, next, confirmPw) {
  const low = next.toLowerCase();
  const parts = (String(state.user ? state.user.name : "") + " " + String(state.user ? state.user.email.split("@")[0] : ""))
    .toLowerCase().split(/[\s._\-]+/).filter(w => w.length >= 4);
  const letters = low.replace(/[^a-z]/g, "");
  return {
    len: next.length >= 10,
    letter: /[A-Za-z]/.test(next),
    numsym: /[^A-Za-z]/.test(next),
    notname: next.length > 0 && !parts.some(w => low.includes(w)) && !BANNED.some(b => low === b || letters === b),
    diff: next.length > 0 && next !== cur,
    match: next.length > 0 && next === confirmPw
  };
}
function pwStrength(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, Math.max(1, s));
}
function updatePwUi() {
  const c = pwChecks($("#pwCurrent").value, $("#pwNew").value, $("#pwConfirm").value);
  $$("#pwRules li").forEach(li => {
    const ok = !!c[li.dataset.rule];
    li.classList.toggle("met", ok);
    li.querySelector(".mark").textContent = ok ? "✓" : "○";
  });
  $("#pwMeter").className = "meter s" + pwStrength($("#pwNew").value);
  $("#pwSave").disabled = !Object.values(c).every(Boolean) || !$("#pwCurrent").value;
}
["#pwCurrent", "#pwNew", "#pwConfirm"].forEach(s => $(s).addEventListener("input", updatePwUi));
$$("[data-reveal]").forEach(b => b.addEventListener("click", () => {
  const inp = $("#" + b.dataset.reveal), showing = inp.type === "text";
  inp.type = showing ? "password" : "text";
  b.textContent = showing ? "Show" : "Hide";
}));
$("#pwBtn").addEventListener("click", () => {
  ["#pwCurrent", "#pwNew", "#pwConfirm"].forEach(s => { $(s).value = ""; $(s).type = "password"; });
  $$("[data-reveal]").forEach(b => b.textContent = "Show");
  setMsg($("#pwMsg"), "");
  updatePwUi();
  $("#pwModal").classList.add("open");
  setTimeout(() => $("#pwCurrent").focus(), 50);
});
$("#pwCancel").addEventListener("click", () => $("#pwModal").classList.remove("open"));
$("#pwModal").addEventListener("mousedown", e => { if (e.target.id === "pwModal") $("#pwModal").classList.remove("open"); });

$("#pwForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const msg = $("#pwMsg"), btn = $("#pwSave");
  const cur = $("#pwCurrent").value, next = $("#pwNew").value;
  if (!Object.values(pwChecks(cur, next, $("#pwConfirm").value)).every(Boolean)) return;
  btn.disabled = true; btn.textContent = "Updating…";
  try {
    const u = auth.currentUser;
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, cur));
    await updatePassword(u, next);
    setMsg(msg, "Password updated. Other devices have been signed out.", "ok");
    setTimeout(() => { $("#pwModal").classList.remove("open"); toast("Password updated."); }, 1300);
  } catch (e) {
    const m = (e.code === "auth/invalid-credential" || e.code === "auth/wrong-password" || e.code === "auth/invalid-login-credentials")
      ? "Your current password is not correct."
      : e.code === "auth/weak-password" ? "That password is too weak."
      : authMsg(e);
    setMsg(msg, m, "err");
  } finally {
    btn.textContent = "Update password";
    updatePwUi();
  }
});

/* ============================================================================
   EDIT MODE
   ========================================================================== */
function setEditing(on) {
  state.editing = !!(on && state.user && state.user.role === "admin");
  document.body.classList.toggle("editing", state.editing);
  $("#editToggle").textContent = state.editing ? "Exit edit mode" : "Edit mode";
  if (!state.dirty) $("#saveState").textContent = "";
  renderAll();
}
$("#editToggle").addEventListener("click", () => {
  if (state.editing && state.dirty && !confirm("You have unsaved changes. Leave edit mode anyway? (They stay on screen until you save or discard.)")) return;
  setEditing(!state.editing);
});

function markDirty() {
  state.dirty = true;
  $("#saveState").textContent = "Unsaved changes";
}

$("#saveBtn").addEventListener("click", async () => {
  if (!state.dirty) { toast("Nothing to save."); return; }
  const ids = state.data.announcements.map(a => a.id);
  const notify = { announcements: [...state.notifyAnn].filter(id => ids.includes(id)), roster: false };
  if (rosterSnapshot() !== state.rosterSnap) {
    notify.roster = confirm("The duty roster or on-call list has changed.\n\nSend a “roster updated” notification to staff phones and laptops?");
  }
  const btn = $("#saveBtn");
  btn.disabled = true;
  $("#saveState").textContent = "Saving…";
  try {
    const r = await api("saveData", { data: state.data, version: state.version, notify });
    state.version = r.version;
    state.loadedAt = Date.now();
    state.dirty = false;
    state.notifyAnn.clear();
    state.rosterSnap = rosterSnapshot();
    state.pushReady = !!r.pushReady;
    $("#saveState").textContent = "All changes saved";
    const wanted = notify.announcements.length || notify.roster;
    toast(!wanted ? "Saved."
      : r.pushed ? `Saved — notification sent to ${r.pushed} device${r.pushed === 1 ? "" : "s"}.`
      : r.pushReady ? "Saved. (No devices have notifications switched on yet.)"
      : "Saved. Notifications are not set up on the server yet.", 5000);
    renderAnn();
  } catch (e) {
    $("#saveState").textContent = "Save failed";
    toast(e.message, 6000);
  } finally {
    btn.disabled = false;
  }
});

$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "kk-meru-data-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("#discardBtn").addEventListener("click", async () => {
  if (!confirm("Discard all unsaved changes and reload the saved version?")) return;
  try {
    await loadData();
    $("#saveState").textContent = "";
    renderAll();
    toast("Reloaded the saved version.");
  } catch (e) { toast(e.message, 4500); }
});

window.addEventListener("beforeunload", e => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

/* ============================================================================
   CONTENT EDITOR (schemas drive the dialog)
   ========================================================================== */
const SHIFTS = [["pagi", "Pagi"], ["petang", "Petang"], ["malam", "Malam"], ["cuti", "Cuti"]];
const SHIFT_LABEL = { pagi: "Pagi", petang: "Petang", malam: "Malam", cuti: "Cuti" };
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const SCHEMAS = {
  announcements: { label: "Announcement", fields: [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "tag", label: "Category", type: "select", options: [["urgent","Urgent"],["circular","Circular"],["notice","Notice"],["event","Event"]] },
    { key: "date", label: "Date shown", type: "text", placeholder: "e.g. 10 Nov 2026", defaultValue: () => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) },
    { key: "text", label: "Details", type: "textarea" },
    { key: "pinned", label: "Pin to top of the noticeboard", type: "checkbox" },
    { key: "notify", label: "🔔 Send a notification to staff phones & laptops when saved", type: "checkbox", transient: true }
  ]},
  roster: { label: "Roster entry", fields: [
    { key: "name", label: "Staff name", type: "text", required: true },
    { key: "unit", label: "Unit", type: "text", required: true },
    { key: "ext", label: "Extension", type: "text" },
    { key: "d", label: "Shifts (Mon–Sun)", type: "shifts" }
  ]},
  oncall: { label: "On-call entry", fields: [
    { key: "date", label: "Date", type: "text", required: true, placeholder: "e.g. 12 Nov (Thu)" },
    { key: "officer", label: "Medical officer", type: "text", required: true },
    { key: "contact", label: "Contact", type: "text" }
  ]},
  leave: { label: "Leave record", fields: [
    { key: "name", label: "Staff name", type: "text", required: true },
    { key: "type", label: "Leave type", type: "select", options: ["Cuti Tahunan","Cuti Sakit","Cuti Tanpa Rekod (Kursus)","Cuti Bersalin","Cuti Kecemasan"].map(x => [x, x]) },
    { key: "dates", label: "Dates", type: "text", placeholder: "e.g. 10 – 14 Nov 2026" }
  ]},
  docs: { label: "Document", fields: [
    { key: "name", label: "Document name", type: "text", required: true },
    { key: "cat", label: "Category", type: "select", options: ["Administrative Forms","Clinical SOP","MOH Guidelines","Infection Control","Pharmacy & Stores"].map(x => [x, x]) },
    { key: "ext", label: "File type", type: "select", options: [["pdf","PDF"],["docx","Word (docx)"],["xlsx","Excel (xlsx)"],["other","Other"]] },
    { key: "size", label: "File size", type: "text", placeholder: "e.g. 1.2 MB" },
    { key: "upd", label: "Last updated", type: "text", placeholder: "e.g. 10 Nov 2026" },
    { key: "url", label: "Download link (Google Drive share link etc.)", type: "text", placeholder: "https://…", url: true }
  ]},
  staff: { label: "Staff member", fields: [
    { key: "name", label: "Full name", type: "text", required: true },
    { key: "role", label: "Position", type: "text", required: true },
    { key: "unit", label: "Unit", type: "text", required: true },
    { key: "ext", label: "Extension", type: "text" }
  ]},
  unitExt: { label: "Unit extension", fields: [
    { key: "unit", label: "Unit / counter", type: "text", required: true },
    { key: "ext", label: "Extension", type: "text", required: true }
  ]}
};

function fieldHtml(f, v) {
  if (f.type === "checkbox")
    return `<div class="field"><label class="chk"><input type="checkbox" data-k="${f.key}" ${v ? "checked" : ""}> ${esc(f.label)}</label></div>`;
  if (f.type === "textarea")
    return `<div class="field"><label>${esc(f.label)}</label><textarea data-k="${f.key}" maxlength="4000">${esc(v)}</textarea></div>`;
  if (f.type === "select")
    return `<div class="field"><label>${esc(f.label)}</label><select data-k="${f.key}">${
      f.options.map(o => `<option value="${esc(o[0])}" ${String(v) === o[0] ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select></div>`;
  if (f.type === "shifts")
    return `<div class="field"><label>${esc(f.label)}</label>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px;">${
        DAY_NAMES.map((d, i) => `<div style="text-align:center;"><div class="small" style="margin-bottom:3px;">${d}</div>
          <select data-shift="${i}" style="padding:5px 2px;font-size:12px;">${
            SHIFTS.map(s => `<option value="${s[0]}" ${(v && v[i]) === s[0] ? "selected" : ""}>${s[1]}</option>`).join("")
          }</select></div>`).join("")}</div></div>`;
  return `<div class="field"><label>${esc(f.label)}</label>
    <input type="text" data-k="${f.key}" maxlength="${f.url ? 2000 : 300}" value="${esc(v)}" placeholder="${esc(f.placeholder || "")}"></div>`;
}

function openEditor(coll, id) {
  const schema = SCHEMAS[coll];
  const rec = id ? state.data[coll].find(r => r.id === id) : null;
  const html = schema.fields.map(f => {
    let v = rec ? rec[f.key] : "";
    if (f.transient) v = rec ? state.notifyAnn.has(rec.id) : true;
    if (!rec && f.type === "shifts") v = ["pagi","pagi","pagi","pagi","pagi","cuti","cuti"];
    if (!rec && f.defaultValue) v = f.defaultValue();
    if (!rec && f.type === "select") v = f.options[0][0];
    return fieldHtml(f, v);
  }).join("");
  openModal((rec ? "Edit " : "New ") + schema.label.toLowerCase(), html, () => {
    const out = {};
    let notifyFlag = null;
    for (const f of schema.fields) {
      if (f.type === "shifts") { out.d = $$("#modalBody [data-shift]").map(s => s.value); continue; }
      if (f.transient) { notifyFlag = $(`#modalBody [data-k="${f.key}"]`).checked; continue; }
      const el = $(`#modalBody [data-k="${f.key}"]`);
      out[f.key] = f.type === "checkbox" ? el.checked : el.value.trim();
      if (f.required && !out[f.key]) { el.style.borderColor = "var(--red)"; el.focus(); toast(f.label + " is required."); return true; }
      if (f.url && out[f.key] && !isHttpUrl(out[f.key])) { el.style.borderColor = "var(--red)"; el.focus(); toast("The link must start with https://"); return true; }
    }
    const list = state.data[coll];
    let id = rec ? rec.id : uid();
    if (rec) Object.assign(rec, out);
    else list.unshift(Object.assign({ id }, out));
    if (notifyFlag !== null) { if (notifyFlag) state.notifyAnn.add(id); else state.notifyAnn.delete(id); }
    markDirty(); renderAll();
    toast(rec ? "Updated — remember to Save changes." : "Added — remember to Save changes.");
  }, rec ? "Update" : "Add");
}

function delRec(coll, id) {
  if (!confirm("Delete this entry? (It is removed when you click Save changes.)")) return;
  state.data[coll] = state.data[coll].filter(r => r.id !== id);
  state.notifyAnn.delete(id);
  markDirty(); renderAll();
}

document.addEventListener("click", e => {
  const add = e.target.closest("[data-add]");
  if (add) return openEditor(add.dataset.add, null);
  const ed = e.target.closest("[data-edit]");
  if (ed) return openEditor(ed.dataset.coll, ed.dataset.edit);
  const dl = e.target.closest("[data-del]");
  if (dl) return delRec(dl.dataset.coll, dl.dataset.del);
  const go = e.target.closest("[data-goto]");
  if (go) return showTab(go.dataset.goto);
  const acc = e.target.closest("[data-acc]");
  if (acc) return accountAction(acc.dataset.acc, acc.dataset.email);
});

function actions(coll, id) {
  return `<span class="row-actions admin-only">
    <button class="btn sm ghost" data-coll="${coll}" data-edit="${esc(id)}">Edit</button>
    <button class="btn sm danger" data-coll="${coll}" data-del="${esc(id)}">Delete</button></span>`;
}

/* ============================================================================
   TABS + CLOCK
   ========================================================================== */
$$("nav.mainnav button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(id, scroll = true) {
  if (id === "accounts" && (!state.user || state.user.role !== "admin")) id = "home";
  $$("nav.mainnav button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
  $$(".panel").forEach(p => p.hidden = p.id !== id);
  if (id === "accounts") loadAccounts();
  if (scroll) window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
$("#printBtn").addEventListener("click", () => window.print());

function tick() {
  const d = new Date();
  $("#clock").textContent = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    + " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
tick(); setInterval(tick, 30000);

/* ============================================================================
   RENDERING
   ========================================================================== */
const todayIdx = () => (new Date().getDay() + 6) % 7;   // Monday = 0

function renderAll() {
  if (!state.data || !state.user) return;
  renderStats(); renderHomeAnn(); renderHomeDuty();
  refreshSelect("#rosterUnit", [...new Set(state.data.roster.map(r => r.unit))], "units");
  refreshSelect("#dirFilter", [...new Set(state.data.staff.map(s => s.unit))], "units");
  refreshSelect("#docFilter", [...new Set(state.data.docs.map(d => d.cat))], "categories");
  renderAnn(); renderRoster(); renderOncall(); renderLeave(); renderDocs(); renderDir(); renderUnitExt();
}

function refreshSelect(sel, values, word) {
  const el = $(sel), cur = el.value;
  el.innerHTML = `<option value="">All ${word}</option>` + values.filter(Boolean).sort()
    .map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  if (values.includes(cur)) el.value = cur;
}

function renderQuickLinks() {
  const links = Array.isArray(CFG.quickLinks) ? CFG.quickLinks : [];
  $("#qlinks").innerHTML = links.map(l => isHttpUrl(l.url)
    ? `<a class="qlink" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"><span class="ic">${esc(l.icon || "🔗")}</span>${esc(l.label)}</a>`
    : `<span class="qlink unset" title="Link not set yet (config.js)"><span class="ic">${esc(l.icon || "🔗")}</span>${esc(l.label)}</span>`
  ).join("") || '<p class="small" style="margin:0;">No quick links set.</p>';
}

function renderStats() {
  const t = todayIdx();
  $("#statDuty").textContent = state.data.roster.filter(r => r.d[t] !== "cuti").length;
  $("#statDutyNote").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long" });
  $("#statLeave").textContent = state.data.leave.length;
  $("#statAnn").textContent = state.data.announcements.length;
  $("#statAnnNote").textContent = state.data.announcements.filter(a => a.pinned).length + " pinned";
  $("#statStaff").textContent = state.data.staff.length;
  $("#statStaffNote").textContent = new Set(state.data.staff.map(s => s.unit)).size + " units";
}

function annHTML(a, withActions) {
  return `<div class="ann"><div class="main">
    <div class="top">
      <span class="tag ${esc(a.tag)}">${esc(a.tag)}</span>
      <span class="title">${esc(a.title)}</span>
      ${a.pinned ? '<span class="pin">📌 Pinned</span>' : ""}
      ${withActions && state.editing && state.notifyAnn.has(a.id) ? '<span class="pin">🔔 Will notify on save</span>' : ""}
      <span class="date">${esc(a.date)}</span>
    </div>
    <p class="txt">${esc(a.text)}</p>
  </div>${withActions ? actions("announcements", a.id) : ""}</div>`;
}
const annSorted = () => state.data.announcements.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

function renderHomeAnn() {
  $("#homeAnn").innerHTML = annSorted().slice(0, 4).map(a => annHTML(a, false)).join("")
    || '<div class="empty">No announcements.</div>';
}

function renderHomeDuty() {
  const t = todayIdx();
  const rows = state.data.roster.filter(r => r.d[t] !== "cuti");
  $("#homeDuty").innerHTML = rows.length ? rows.map(r =>
    `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td>
      <td><span class="shift ${esc(r.d[t])}">${esc(SHIFT_LABEL[r.d[t]] || r.d[t])}</span></td><td>${esc(r.ext)}</td></tr>`
  ).join("") : '<tr><td colspan="4" class="empty">No one rostered today.</td></tr>';
}

function renderAnn() {
  const q = $("#annSearch").value.trim().toLowerCase(), f = $("#annFilter").value;
  const rows = annSorted().filter(a => !f || a.tag === f)
    .filter(a => !q || (a.title + " " + a.text).toLowerCase().includes(q));
  $("#annList").innerHTML = rows.length ? rows.map(a => annHTML(a, true)).join("")
    : '<div class="empty">No announcements match your search.</div>';
}
$("#annSearch").addEventListener("input", renderAnn);
$("#annFilter").addEventListener("change", renderAnn);

function renderRoster() {
  const t = todayIdx(), u = $("#rosterUnit").value;
  $("#rosterHead").innerHTML = "<th>Staff</th><th>Unit</th>"
    + DAY_NAMES.map((d, i) => `<th class="${i === t ? "today" : ""}">${d}</th>`).join("")
    + '<th class="admin-only">Actions</th>';
  const rows = state.data.roster.filter(r => !u || r.unit === u);
  $("#rosterBody").innerHTML = rows.length ? rows.map(r => {
    const cells = r.d.map((v, i) => `<td class="${i === t ? "today" : ""}">${state.editing
      ? `<select class="shift-sel" data-rid="${esc(r.id)}" data-day="${i}" aria-label="${esc(r.name)} ${DAY_NAMES[i]}">${
          SHIFTS.map(s => `<option value="${s[0]}" ${v === s[0] ? "selected" : ""}>${s[1]}</option>`).join("")}</select>`
      : `<span class="shift ${esc(v)}">${esc(SHIFT_LABEL[v] || v)}</span>`}</td>`).join("");
    return `<tr><td><strong>${esc(r.name)}</strong></td><td>${esc(r.unit)}</td>${cells}
      <td class="admin-only">${actions("roster", r.id)}</td></tr>`;
  }).join("") : '<tr><td colspan="10" class="empty">No staff in this unit.</td></tr>';

  $$("#rosterBody .shift-sel").forEach(sel => sel.addEventListener("change", () => {
    const rec = state.data.roster.find(r => r.id === sel.dataset.rid);
    rec.d[+sel.dataset.day] = sel.value;
    markDirty(); renderStats(); renderHomeDuty();
  }));
}
$("#rosterUnit").addEventListener("change", renderRoster);

function renderOncall() {
  $("#oncallBody").innerHTML = state.data.oncall.map(r =>
    `<tr><td><strong>${esc(r.date)}</strong></td><td>${esc(r.officer)}</td><td>${esc(r.contact)}</td>
      <td class="admin-only">${actions("oncall", r.id)}</td></tr>`).join("")
    || '<tr><td colspan="4" class="empty">No on-call entries.</td></tr>';
}
function renderLeave() {
  $("#leaveBody").innerHTML = state.data.leave.map(r =>
    `<tr><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td>${esc(r.dates)}</td>
      <td class="admin-only">${actions("leave", r.id)}</td></tr>`).join("")
    || '<tr><td colspan="4" class="empty">No leave recorded.</td></tr>';
}

function renderDocs() {
  const q = $("#docSearch").value.trim().toLowerCase(), f = $("#docFilter").value;
  const rows = state.data.docs.filter(d => !f || d.cat === f)
    .filter(d => !q || (d.name + " " + d.cat).toLowerCase().includes(q));
  const extClass = e => ["pdf", "docx", "xlsx"].includes(e) ? e : "other";
  $("#docList").innerHTML = rows.length ? rows.map(d => `<div class="doc">
      <div class="ext ${extClass(d.ext)}">${esc(String(d.ext || "").toUpperCase())}</div>
      <div class="info"><p class="name">${esc(d.name)}</p>
        <p class="sub">${esc(d.cat)}${d.size ? " · " + esc(d.size) : ""}${d.upd ? " · Updated " + esc(d.upd) : ""}</p></div>
      ${isHttpUrl(d.url)
        ? `<a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Open</a>`
        : `<button class="btn" disabled title="No link set yet">Open</button>`}
      ${actions("docs", d.id)}
    </div>`).join("")
    : '<div class="card"><div class="empty">No documents match your search.</div></div>';
}
$("#docSearch").addEventListener("input", renderDocs);
$("#docFilter").addEventListener("change", renderDocs);

function renderDir() {
  const q = $("#dirSearch").value.trim().toLowerCase(), f = $("#dirFilter").value;
  const rows = state.data.staff.filter(s => !f || s.unit === f)
    .filter(s => !q || (s.name + " " + s.role + " " + s.unit + " " + s.ext).toLowerCase().includes(q));
  $("#dirCount").textContent = rows.length + " listed";
  $("#dirList").innerHTML = rows.length ? rows.map(s => {
    const linked = String(s.id).startsWith("acc-");
    return `<div class="person">
      <div class="avatar">${esc(initials(s.name))}</div>
      <div><div class="n">${esc(s.name)}</div><div class="r">${esc(s.role)} · ${esc(s.unit)}</div></div>
      <div class="ext-no"><div class="num">${esc(s.ext || "—")}</div><div class="lbl">Ext</div></div>
      ${linked
        ? `<span class="row-actions admin-only"><span class="linked-tag">✓ Portal account</span>
             <button class="btn sm ghost" data-goto="accounts">Edit in Staff Accounts</button></span>`
        : actions("staff", s.id)}
    </div>`;
  }).join("") : '<div class="empty">No staff match your search.</div>';
}
$("#dirSearch").addEventListener("input", renderDir);
$("#dirFilter").addEventListener("change", renderDir);

function renderUnitExt() {
  $("#unitExt").innerHTML = state.data.unitExt.map(u =>
    `<tr><td>${esc(u.unit)}</td><td><strong style="font-family:ui-monospace,Menlo,monospace;">${esc(u.ext)}</strong></td>
      <td class="admin-only">${actions("unitExt", u.id)}</td></tr>`).join("")
    || '<tr><td colspan="3" class="empty">No extensions listed.</td></tr>';
}

/* ============================================================================
   STAFF ACCOUNTS (administrators)
   ========================================================================== */
async function loadAccounts() {
  $("#accBody").innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
  try { state.users = (await api("listUsers")).users; }
  catch (e) { $("#accBody").innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`; return; }
  renderAccounts();
}
$("#reloadAccountsBtn").addEventListener("click", loadAccounts);
$("#accSearch").addEventListener("input", renderAccounts);
$("#accUnit").addEventListener("change", renderAccounts);

function renderAccounts() {
  const pend = state.users.filter(u => u.status === "pending");
  state.pendingCount = pend.length;
  updatePendingIndicators();
  $("#pendCount").textContent = pend.length ? pend.length + " waiting" : "";
  $("#pendBody").innerHTML = pend.length ? pend.map(u => `<tr>
      <td><strong>${esc(u.name)}</strong><span class="cell-sub">${esc(u.email)}${u.verified ? "" : " · email not verified yet"}</span></td>
      <td>${esc(posText(u))}</td><td>${esc(u.unit || "—")}</td>
      <td style="white-space:nowrap;">${esc(u.phone || "—")}${u.ext ? `<span class="cell-sub">Ext ${esc(u.ext)}</span>` : ""}</td>
      <td class="small" style="white-space:nowrap;">${esc(u.added || "")}</td>
      <td><span class="row-actions">
        <button class="btn sm" data-acc="approve-staff" data-email="${esc(u.email)}">Approve</button>
        <button class="btn sm ghost" data-acc="approve-admin" data-email="${esc(u.email)}">Approve as admin</button>
        <button class="btn sm danger" data-acc="reject" data-email="${esc(u.email)}">Reject</button>
      </span></td></tr>`).join("")
    : '<tr><td colspan="6" class="empty">No one is waiting for approval.</td></tr>';

  const units = [...new Set(state.users.map(u => u.unit).filter(Boolean))].sort();
  const curUnit = $("#accUnit").value;
  $("#accUnit").innerHTML = '<option value="">All units</option>' + units.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  if (units.includes(curUnit)) $("#accUnit").value = curUnit;
  const q = $("#accSearch").value.trim().toLowerCase(), fu = $("#accUnit").value;
  const rows = state.users.filter(u => u.status !== "pending")
    .filter(u => !fu || u.unit === fu)
    .filter(u => !q || [u.name, u.email, u.jawatan, u.gred, u.unit, u.phone, u.ext].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  $("#accCount").textContent = state.users.filter(u => u.active && u.status !== "pending" && u.status !== "rejected").length + " active";
  $("#accBody").innerHTML = rows.length ? rows.map(u => {
    const me = u.email === state.user.email;
    const who = `<td><strong>${esc(u.name)}</strong>${me ? ' <span class="small">(you)</span>' : ""}<span class="cell-sub">${esc(u.email)}</span></td>
      <td>${esc(posText(u))}</td><td>${esc(u.unit || "—")}</td>
      <td style="white-space:nowrap;">${esc(u.phone || "—")}${u.ext ? `<span class="cell-sub">Ext ${esc(u.ext)}</span>` : ""}</td>`;
    if (u.status === "rejected") {
      return `<tr>${who}<td>—</td>
        <td><span class="status rej">Rejected</span></td><td><span class="row-actions">
        <button class="btn sm ghost" data-acc="approve-staff" data-email="${esc(u.email)}">Approve after all</button></span></td></tr>`;
    }
    const status = !u.active ? '<span class="status off">Disabled</span>'
      : u.lastSeen ? `<span class="status on">Active</span><div class="small">Last seen ${esc(u.lastSeen)}</div>`
      : '<span class="status wait">Awaiting first sign-in</span>';
    const btns = [`<button class="btn sm" data-acc="edit" data-email="${esc(u.email)}">Edit details</button>`];
    if (u.active) btns.push(`<button class="btn sm ghost" data-acc="reset" data-email="${esc(u.email)}">Send password email</button>`);
    if (!me) {
      btns.push(u.active
        ? `<button class="btn sm danger" data-acc="disable" data-email="${esc(u.email)}">Disable</button>`
        : `<button class="btn sm" data-acc="enable" data-email="${esc(u.email)}">Enable</button>`);
    }
    return `<tr>${who}<td>${u.role === "admin" ? "Administrator" : "Staff"}${u.jawatan ? "" : '<span class="cell-sub">No position yet — not in directory</span>'}</td><td>${status}</td>
      <td><span class="row-actions">${btns.join("")}</span></td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty">No accounts found.</td></tr>';
}

$("#addAccountBtn").addEventListener("click", () => {
  openModal("Add staff account", `
    <div class="field"><label for="naEmail">Email address (used to sign in) <span class="req">*</span></label><input type="email" id="naEmail" maxlength="200" placeholder="name@moh.gov.my"></div>
    ${profileFieldsHtml("na", {}, { required: ["name", "jawatan", "unit"] })}
    <div class="field"><label for="naRole">Access level</label>
      <select id="naRole"><option value="staff">Staff — view only (right for almost everyone)</option>
      <option value="admin">Administrator — can edit content and manage accounts</option></select></div>
    <p class="small" style="margin:0;">They will receive an email with a link to choose their own password.
      Ask them to check their spam folder if it does not arrive within a few minutes.</p>`,
  async () => {
    const email = $("#naEmail").value.trim().toLowerCase(), role = $("#naRole").value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Please enter a valid email address."); $("#naEmail").focus(); return true; }
    const res = readProfile("na", ["name", "jawatan", "unit"]);
    if (res.error) { profileError(res); return true; }
    if (role === "admin" && !confirm(`Give ${res.profile.name} ADMINISTRATOR access? They will be able to edit all content and every staff record.`)) return true;
    const r = await api("addUser", Object.assign({ email, role }, res.profile));
    state.users = r.users;
    renderAccounts();
    toast(r.note, 7000);
  }, "Add account");
});

async function accountAction(kind, email) {
  const u = state.users.find(x => x.email === email);
  if (!u) return;
  if (kind === "edit") {
    const me = email === state.user.email;
    openModal("Edit staff details", `
      <div class="field"><label>Email (sign-in)</label><input type="text" value="${esc(u.email)}" disabled></div>
      ${profileFieldsHtml("ed", u, { required: ["name", "jawatan", "unit"] })}
      <div class="field"><label for="edRole">Access level</label>
        <select id="edRole" ${me ? "disabled" : ""}>
          <option value="staff" ${u.role !== "admin" ? "selected" : ""}>Staff — view only</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>Administrator — can edit content and every staff record</option>
        </select>${me ? '<p class="small" style="margin:5px 0 0;">You cannot change your own access level.</p>' : ""}</div>`,
    async () => {
      const res = readProfile("ed", ["name", "jawatan", "unit"]);
      if (res.error) { profileError(res); return true; }
      const patch = Object.assign({ email }, res.profile);
      if (!me) {
        patch.role = $("#edRole").value;
        if (patch.role === "admin" && u.role !== "admin" &&
            !confirm(`Give ${res.profile.name} ADMINISTRATOR access? They will be able to edit all content and every staff record.`)) return true;
      }
      state.users = (await api("updateUser", patch)).users;
      if (me) { Object.assign(state.user, res.profile); $("#whoName").textContent = state.user.name; }
      renderAccounts();
      toast("Staff details updated.");
      if (!state.dirty) loadData().then(renderAll).catch(() => {});
    }, "Save details");
    return;
  }
  if (kind === "approve-staff" || kind === "approve-admin" || kind === "reject") {
    const role = kind === "approve-admin" ? "admin" : "staff";
    const q = kind === "reject"
      ? `Reject ${u.name} (${u.email})? They will not be able to use the portal.`
      : `Approve ${u.name} (${u.email}) as ${role === "admin" ? "an ADMINISTRATOR — full editing and account rights" : "staff (view only)"}?\n\nOnly approve people you recognise as clinic staff.`;
    if (!confirm(q)) return;
    try {
      state.users = (await api(kind === "reject" ? "rejectUser" : "approveUser", { email, role })).users;
      renderAccounts();
      toast(kind === "reject" ? "Request rejected." : u.name + " approved — they have been emailed.");
    } catch (e) { toast(e.message, 5000); }
    return;
  }
  const confirmText = {
    reset: `Send ${u.email} an email with a link to set a new password?\n\nTheir current password keeps working until they use the link.`,
    admin: `Give ${u.name} administrator access? They will be able to edit all content and manage accounts.`,
    staff: `Change ${u.name} to staff (view only)?`,
    disable: `Disable ${u.name}? They will be blocked from the portal immediately.`,
    enable: `Re-enable ${u.name}?`
  }[kind];
  if (!confirm(confirmText)) return;
  try {
    if (kind === "reset") {
      toast((await api("resetPassword", { email })).note, 6000);
      return;
    }
    const patch = kind === "admin" || kind === "staff" ? { role: kind } : { active: kind === "enable" };
    state.users = (await api("updateUser", Object.assign({ email }, patch))).users;
    renderAccounts();
    toast("Account updated.");
  } catch (e) { toast(e.message, 5000); }
}

/* Staff database → CSV that opens cleanly in Excel / Google Sheets. */
$("#exportStaffBtn").addEventListener("click", () => {
  const cell = (v, isPhone) => {
    let t = String(v == null ? "" : v);
    // text starting with = + - @ would run as a formula in Excel; a phone number like +6012… is left alone
    if (/^[=+\-@\t\r]/.test(t) && !(isPhone && /^\+?[0-9][0-9 \-]*$/.test(t))) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  };
  const head = ["Name", "Email", "Position", "Grade", "Unit", "Mobile", "Extension", "Access", "Status", "Registered", "Last sign-in"];
  const rows = state.users.slice().sort((a, b) => (a.unit || "").localeCompare(b.unit || "") || a.name.localeCompare(b.name))
    .map(u => [u.name, u.email, u.jawatan, u.gred, u.unit, u.phone, u.ext,
      u.role === "admin" ? "Administrator" : "Staff",
      u.status === "pending" ? "Pending" : u.status === "rejected" ? "Rejected" : u.active ? "Active" : "Disabled",
      u.added, u.lastSeen].map((v, i) => cell(v, i === 5)).join(","));
  const csv = "\ufeff" + [head.map(h => cell(h)).join(","), ...rows].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = "kk-meru-staff-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Staff list exported — " + state.users.length + " records.");
});

$("#loadAuditBtn").addEventListener("click", async () => {
  $("#auditBody").innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>';
  try {
    const { entries } = await api("getAudit");
    $("#auditBody").innerHTML = entries.length ? entries.map(e =>
      `<tr><td style="white-space:nowrap;">${esc(e.time)}</td><td>${esc(e.email)}</td><td>${esc(e.action)}</td><td class="small">${esc(e.detail)}</td></tr>`
    ).join("") : '<tr><td colspan="4" class="empty">No activity yet.</td></tr>';
  } catch (e) {
    $("#auditBody").innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`;
  }
});


/* ============================================================================
   PUSH NOTIFICATIONS (Firebase Cloud Messaging)
   ----------------------------------------------------------------------------
   Each device that switches notifications on sends its FCM token to Apps
   Script ("Devices" sheet). Apps Script pushes to those tokens when an admin
   saves a new announcement or a roster change, or someone registers.
   sw.js draws the notification when the portal is closed or in the
   background; onForegroundMessage() handles it while the portal is on screen.
   ========================================================================== */
const PUSH_KEY = "kk_push_token", PREF_KEY = "kk_push_prefs", PROMPT_KEY = "kk_push_later";
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const pushPrefs = () => { try { return Object.assign({ ann: "all", roster: true }, JSON.parse(ls.get(PREF_KEY) || "{}")); } catch (e) { return { ann: "all", roster: true }; } };
const pushConfigured = () => CONFIGURED && !looksUnset(CFG.firebase.messagingSenderId) && !looksUnset(CFG.vapidKey);
const onIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let fcm = null, messaging = null;
async function loadMessaging() {
  if (messaging) return messaging;
  fcm = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js");
  if (!(await fcm.isSupported())) throw Object.assign(new Error("unsupported"), { code: "unsupported" });
  messaging = fcm.getMessaging(fbApp);
  fcm.onMessage(messaging, onForegroundMessage);
  return messaging;
}

/** "ok" | "unconfigured" | "ios-install" | "unsupported" | "denied" */
async function pushSupport() {
  if (!pushConfigured()) return "unconfigured";
  if (onIOS() && !isStandalone()) return "ios-install";
  if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) return "unsupported";
  try { await loadMessaging(); } catch (e) { return "unsupported"; }
  if (Notification.permission === "denied") return "denied";
  return "ok";
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (onIOS() && /Macintosh/.test(ua)) ? "iPad"
    : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet")
    : /Windows/.test(ua) ? "Windows PC" : /Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook"
    : /Linux/.test(ua) ? "Linux PC" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return os + " · " + br + (isStandalone() ? " (app)" : "");
}

async function deviceToken() {
  await loadMessaging();
  const reg = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  return fcm.getToken(messaging, { vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
}

async function enablePush(prefs) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error(perm === "denied"
      ? "Notifications were blocked. Allow them in the browser's site settings, then try again."
      : "Notification permission was not given.");
  }
  const token = await deviceToken();
  if (!token) throw new Error("This browser did not give a notification token. Try again, or use Chrome / Edge / Safari.");
  const old = ls.get(PUSH_KEY);
  if (old && old !== token) await api("unregisterDevice", { token: old }).catch(() => {});
  const r = await api("registerDevice", Object.assign({ token, label: deviceLabel() }, prefs));
  ls.set(PUSH_KEY, token);
  ls.set(PREF_KEY, JSON.stringify(prefs));
  state.pushReady = !!r.pushReady;
  updatePushPrompt();
}

async function disablePush() {
  const token = ls.get(PUSH_KEY);
  ls.del(PUSH_KEY);
  if (token) await api("unregisterDevice", { token }).catch(() => {});
  try { await loadMessaging(); await fcm.deleteToken(messaging); } catch (e) {}
  updatePushPrompt();
}

/* Tokens can change; re-register quietly each time someone signs in on a device that has notifications on. */
async function refreshPushSilently() {
  if (!ls.get(PUSH_KEY) || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    if ((await pushSupport()) !== "ok") return;
    const token = await deviceToken();
    const old = ls.get(PUSH_KEY);
    if (old && old !== token) await api("unregisterDevice", { token: old }).catch(() => {});
    await api("registerDevice", Object.assign({ token, label: deviceLabel() }, pushPrefs()));
    ls.set(PUSH_KEY, token);
  } catch (e) { /* not worth bothering anyone about */ }
}

async function updatePushPrompt() {
  const el = $("#pushPrompt");
  el.hidden = true;
  if (!state.user || ls.get(PUSH_KEY) || ls.get(PROMPT_KEY)) return;
  if (!pushConfigured() || !("Notification" in window && "serviceWorker" in navigator) && !onIOS()) return;
  if ("Notification" in window && Notification.permission === "denied") return;
  el.hidden = false;
}
$("#pushPromptOn").addEventListener("click", () => openNotifDialog());
$("#pushPromptLater").addEventListener("click", () => { ls.set(PROMPT_KEY, "1"); $("#pushPrompt").hidden = true; });

function onForegroundMessage(payload) {
  const d = (payload && payload.data) || {};
  toast((d.title || "Portal KK Meru") + (d.body ? " — " + d.body : ""), 7000);
  if (d.tag === "registration" && state.user && state.user.role === "admin") {
    state.pendingCount++; updatePendingIndicators();
  }
  if (state.user && !state.editing && !state.dirty) {
    loadData().then(renderAll).catch(() => {});
  }
}

/* A tapped notification asks an open portal window to show the right tab. */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", e => {
    if (!e.data || e.data.type !== "open-tab" || !state.user) return;
    const t = new URL(e.data.url, location.href).searchParams.get("tab");
    if (t) showTab(t);
  });
}

$("#notifBtn").addEventListener("click", () => openNotifDialog());

async function openNotifDialog() {
  const st = await pushSupport();
  const isAdmin = state.user && state.user.role === "admin";
  const on = !!ls.get(PUSH_KEY) && st === "ok" && Notification.permission === "granted";
  const prefs = pushPrefs();
  const close = () => {};
  const messages = {
    "unconfigured": `<p>Notifications have not been set up for this portal yet.</p>${isAdmin
        ? '<p class="small">Administrator: fill in <code>messagingSenderId</code> and <code>vapidKey</code> in <code>config.js</code> and set the <code>FCM_SERVICE_ACCOUNT</code> script property — see the README.</p>' : ""}`,
    "ios-install": `<p>On iPhone and iPad, notifications only work when the portal is installed as an app (iOS 16.4 or newer):</p>
      <ol class="steps"><li>Open the portal in <strong>Safari</strong></li><li>Tap <strong>Share</strong> → <strong>Add to Home Screen</strong> → <strong>Add</strong></li>
      <li>Open the portal from the new <strong>KK Meru</strong> icon</li><li>Sign in and tap <strong>🔔 Notifications</strong> again</li></ol>`,
    "unsupported": `<p>This browser cannot receive notifications.</p>
      <p class="small">Use <strong>Chrome</strong> or <strong>Edge</strong> on Android, Windows or Mac, or <strong>Safari</strong> on Mac.
      On iPhone, install the portal to the home screen first.</p>`,
    "denied": `<p>Notifications are <strong>blocked</strong> for this site in your browser.</p>
      <ol class="steps"><li>Click the icon to the left of the address bar (or open the browser's site settings)</li>
      <li>Set <strong>Notifications</strong> to <strong>Allow</strong></li><li>Reload the portal and open 🔔 Notifications again</li></ol>`
  };
  if (st !== "ok") { openModal("Notifications", messages[st], close, "Close"); return; }

  const html = `
    <div class="push-status ${on ? "on" : ""}"><span class="dot"></span>
      ${on ? "Notifications are ON for this device" : "Notifications are off for this device"}</div>
    <div class="field"><label for="npAnn">Announcements</label>
      <select id="npAnn">
        <option value="all" ${prefs.ann === "all" ? "selected" : ""}>All new announcements</option>
        <option value="urgent" ${prefs.ann === "urgent" ? "selected" : ""}>Urgent announcements only</option>
        <option value="none" ${prefs.ann === "none" ? "selected" : ""}>None</option>
      </select></div>
    <div class="field"><label class="chk"><input type="checkbox" id="npRoster" ${prefs.roster ? "checked" : ""}> Duty roster and on-call changes</label></div>
    ${isAdmin ? '<p class="small">As an administrator you are also notified when someone registers for access.</p>' : ""}
    ${!state.pushReady && isAdmin ? '<div class="msg info">The server part is not set up yet (FCM_SERVICE_ACCOUNT script property), so nothing will be sent until it is.</div>' : ""}
    <p class="small">Notifications arrive even when the portal is closed. On a computer, the browser needs to be running.
      Tapping one opens the portal — on your own phone, tick <em>Keep me signed in</em> so you go straight in.</p>
    ${on ? `<div class="row-actions" style="margin-top:12px;">
        <button type="button" class="btn sm ghost" id="npTest">Send test notification</button>
        <button type="button" class="btn sm danger" id="npOff">Turn off for this device</button></div>` : ""}`;

  openModal("Notifications", html, async () => {
    const p = { ann: $("#npAnn").value, roster: $("#npRoster").checked };
    await enablePush(p);
    toast(on ? "Notification settings saved." : "Notifications are on for this device.");
  }, on ? "Save settings" : "Turn on notifications");

  if (on) {
    $("#npTest").addEventListener("click", async () => {
      try {
        const r = await api("testPush");
        toast(r.sent ? "Test sent — it should appear in a few seconds." : "No device received it. Turn notifications off and on again.", 5000);
      } catch (e) { toast(e.message, 5000); }
    });
    $("#npOff").addEventListener("click", async () => {
      await disablePush();
      closeModal();
      toast("Notifications turned off for this device.");
    });
  }
}

/* Start only after every declaration above has run. */
boot();
