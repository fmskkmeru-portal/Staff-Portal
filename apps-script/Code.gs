/**
 * Klinik Kesihatan Meru — Staff Portal API (Google Apps Script)
 * ---------------------------------------------------------------------------
 * This script is BOUND to the Google Sheet that holds the portal data
 * (Sheet → Extensions → Apps Script). It is deployed as a Web App and the
 * PWA on GitHub Pages talks to it with POST requests.
 *
 * Security model
 *   1. Every request carries a Firebase ID token. The token is checked with
 *      Google's Identity Toolkit (accounts:lookup) using the project's Web API
 *      key — a forged, expired or revoked token is rejected.
 *   2. The signed-in email must be on the "Users" sheet, active, and verified.
 *      A Firebase login on its own gets NOTHING.
 *   3. Writes (saveData, account management, audit log) require role "admin"
 *      on the Users sheet. This is enforced here, not in the page.
 *   4. Every sign-in, denied request and change is written to the "Audit" sheet.
 *
 * Script properties (Project Settings → Script properties):
 *   FIREBASE_API_KEY     required — Firebase Web API key
 *   FIREBASE_PROJECT_ID  recommended — Firebase project ID (token audience check)
 *   ADMIN_EMAIL          optional — first admin; defaults to the Sheet owner
 *   REGISTRATION_OPEN    optional — "false" switches off self-registration
 *   ALLOWED_DOMAINS      optional — e.g. "moh.gov.my,gmail.com"; only these
 *                        email domains may register (empty = any domain)
 *   PORTAL_URL           optional — portal address, used in notification emails
 *   FCM_SERVICE_ACCOUNT  optional — enables phone/laptop push notifications (see Push.gs)
 *
 * Staff database: registration collects name, position (jawatan), grade,
 * unit, mobile number and extension. Approved, active accounts appear in the
 * Staff Directory automatically (rows with id "acc-…"). People may change only
 * their own name, mobile number and extension; everything else — and every
 * other person's record — can be changed by administrators only.
 *
 * Self-registration: anyone may create a login and ask for access, but the
 * request lands on the Users sheet as "pending" and gets NOTHING until an
 * administrator approves it. Admins are emailed when a request arrives and
 * the person is emailed when it is approved.
 */

const COLLECTIONS = {
  announcements: { sheet: 'Announcements', cols: ['id', 'tag', 'pinned', 'title', 'text', 'date'] },
  staff:         { sheet: 'Staff',         cols: ['id', 'name', 'role', 'unit', 'ext'] },
  roster:        { sheet: 'Roster',        cols: ['id', 'name', 'unit', 'ext', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
  oncall:        { sheet: 'OnCall',        cols: ['id', 'date', 'officer', 'contact'] },
  leave:         { sheet: 'Leave',         cols: ['id', 'name', 'type', 'dates'] },
  docs:          { sheet: 'Docs',          cols: ['id', 'name', 'cat', 'ext', 'size', 'upd', 'url'] },
  unitExt:       { sheet: 'UnitExt',       cols: ['id', 'unit', 'ext'] }
};
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SHIFTS = ['pagi', 'petang', 'malam', 'cuti'];
const TAGS = ['urgent', 'circular', 'notice', 'event'];
const DOC_EXTS = ['pdf', 'docx', 'xlsx', 'other'];

const USERS_SHEET = 'Users';
const USERS_COLS = ['email', 'name', 'role', 'active', 'added', 'lastSeen', 'status', 'unit', 'verified',
                    'jawatan', 'gred', 'phone', 'ext'];
/* Profile fields: what each one accepts. */
const PROFILE = {
  name:    { label: 'Full name', max: 120, min: 3 },
  jawatan: { label: 'Position',  max: 100, min: 2 },
  gred:    { label: 'Grade',     max: 20,  re: /^[A-Za-z0-9 ()\/\-]{1,20}$/ },
  unit:    { label: 'Unit',      max: 100, min: 2 },
  phone:   { label: 'Mobile number', max: 20, re: /^\+?[0-9][0-9 \-]{7,18}$/ },
  ext:     { label: 'Extension', max: 10, re: /^[0-9]{1,6}$/ }
};
const ALL_PROFILE = ['name', 'jawatan', 'gred', 'unit', 'phone', 'ext'];
const SELF_EDITABLE = ['name', 'phone', 'ext'];        // what staff may change about themselves
const LINK_PREFIX = 'acc-';                            // Staff Directory rows owned by an account
const MAX_PENDING = 100;
const AUDIT_SHEET = 'Audit';
const AUDIT_COLS = ['time', 'email', 'action', 'detail'];

const MAX_ITEMS = 1000;     // per collection
const MAX_FIELD = 4000;     // characters per field
const TOKEN_CACHE_SECONDS = 120;

/* ======================================================================== */
/*  HTTP entry points                                                       */
/* ======================================================================== */

function doGet() {
  return ContentService.createTextOutput('KK Meru Staff Portal API is running.');
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (_) {
    return reply_({ ok: false, status: 400, error: 'Bad request.' });
  }

  try {
    const who = verifyIdToken_(req.idToken);
    if (req.action === 'register') {
      const r = actRegister_(req, who);
      r.ok = true;
      return reply_(r);
    }
    const user = findUser_(who.email);
    if (user && user.status !== 'approved') {
      if (user.verified !== who.emailVerified) updateUserRow_(user.email, { verified: who.emailVerified });
      if (user.status === 'pending') {
        return reply_({ ok: false, status: 403, code: 'pending', emailVerified: who.emailVerified,
          error: 'Your registration is waiting for an administrator to approve it.' });
      }
      throw fail_(403, 'Your registration was not approved. Contact a portal administrator if you think this is a mistake.', 'rejected');
    }
    if (!user) {
      audit_(who.email, 'denied', 'not on the Users list');
      throw fail_(403, 'This email has not requested access to the portal yet.', 'not_registered');
    }
    if (!user.active) {
      audit_(who.email, 'denied', 'account disabled');
      throw fail_(403, 'This account has been disabled. Contact a portal administrator.', 'disabled');
    }
    if (!who.emailVerified) {
      throw fail_(403, 'Please verify your email address first.', 'unverified');
    }

    const handler = ACTIONS[req.action];
    if (!handler) throw fail_(400, 'Unknown action.');
    if (handler.admin && user.role !== 'admin') {
      audit_(user.email, 'denied', 'non-admin attempted ' + req.action);
      throw fail_(403, 'Your account is not allowed to do this.', 'forbidden');
    }

    const out = handler.fn(req, user) || {};
    out.ok = true;
    return reply_(out);
  } catch (err) {
    if (err && err.status) {
      return reply_({ ok: false, status: err.status, error: err.message, code: err.code || '' });
    }
    console.error(err && err.stack ? err.stack : err);
    return reply_({ ok: false, status: 500, error: 'Server error. Please try again.' });
  }
}

const ACTIONS = {
  session:       { fn: actSession_ },
  getData:       { fn: actGetData_ },
  setMyName:     { fn: actUpdateMyProfile_ },      // kept for older cached pages
  updateMyProfile: { fn: actUpdateMyProfile_ },
  saveData:      { fn: actSaveData_,      admin: true },
  listUsers:     { fn: actListUsers_,     admin: true },
  addUser:       { fn: actAddUser_,       admin: true },
  approveUser:   { fn: actApproveUser_,   admin: true },
  rejectUser:    { fn: actRejectUser_,    admin: true },
  updateUser:    { fn: actUpdateUser_,    admin: true },
  resetPassword: { fn: actResetPassword_, admin: true },
  getAudit:      { fn: actGetAudit_,      admin: true },
  registerDevice:   { fn: actRegisterDevice_ },
  unregisterDevice: { fn: actUnregisterDevice_ },
  testPush:         { fn: actTestPush_ }
};

/* ======================================================================== */
/*  Actions                                                                 */
/* ======================================================================== */

function actSession_(req, user) {
  touchLastSeen_(user.email);
  audit_(user.email, 'sign-in', user.role);
  const out = { user: publicUser_(user), version: getVersion_(), pushReady: pushConfigured_() };
  if (user.role === 'admin') out.pendingCount = readUsers_().filter(function (u) { return u.status === 'pending'; }).length;
  return out;
}

function actGetData_() {
  return { data: readAll_(), version: getVersion_() };
}

/** Staff may change their own name, mobile and extension — nothing else. */
function actUpdateMyProfile_(req, user) {
  const asked = ALL_PROFILE.filter(function (k) { return req[k] !== undefined; });
  const locked = asked.filter(function (k) { return SELF_EDITABLE.indexOf(k) < 0; });
  if (locked.length && user.role !== 'admin') {
    throw fail_(403, 'Only an administrator can change your position, grade or unit.', 'forbidden');
  }
  const patch = profileFrom_(req, user.role === 'admin' ? ALL_PROFILE : SELF_EDITABLE, []);
  if (!Object.keys(patch).length) throw fail_(400, 'Nothing to update.');
  updateUserRow_(user.email, patch);
  audit_(user.email, 'profile-self', JSON.stringify(patch));
  syncDirectory_(user.email);
  return { user: publicUser_(findUser_(user.email)) };
}

function actSaveData_(req, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (String(req.version || '') !== getVersion_()) {
      throw fail_(409, 'Someone else saved changes after you loaded the page. Discard, reload, and make your edits again.', 'conflict');
    }
    var data = validateData_(req.data);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    data.staff = keepLinkedRows_(ss, data.staff);
    Object.keys(COLLECTIONS).forEach(function (k) { writeCollection_(ss, k, data[k]); });
    var v = bumpVersion_();
    audit_(user.email, 'data-save', Object.keys(data).map(function (k) { return k + ':' + data[k].length; }).join(' '));
  } finally {
    lock.releaseLock();
  }
  // notifications go out after the lock is released, so a slow push never holds up other saves
  const pushed = pushAfterSave_(req.notify, data);
  if (pushed) audit_(user.email, 'push-sent', pushed + ' device(s)');
  return { version: v, pushed: pushed, pushReady: pushConfigured_() };
}

function actListUsers_() {
  return { users: readUsers_().map(publicUserFull_) };
}

function actAddUser_(req, user) {
  const email = cleanEmail_(req.email);
  const profile = profileFrom_(req, ALL_PROFILE, ['name', 'jawatan', 'unit']);
  const role = req.role === 'admin' ? 'admin' : 'staff';
  if (findUser_(email)) throw fail_(409, 'That email is already on the list.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const result = firebaseCreate_(email);       // 'created' | 'exists' | 'console'
    appendUser_(email, role, 'approved', profile, false);
    var note;
    if (result === 'console') {
      note = 'Added to the list. Self sign-up is switched off in Firebase, so create the login yourself: ' +
             'Firebase console → Authentication → Users → Add user (' + email + '), then click "Send password email" here.';
    } else {
      firebaseSendReset_(email);
      note = 'Account added. A password-setup email has been sent to ' + email + '.';
    }
    audit_(user.email, 'user-add', email + ' as ' + role + ' (' + result + ')');
  } finally {
    lock.releaseLock();
  }
  syncDirectory_(email);
  return { users: readUsers_().map(publicUserFull_), note: note };
}

function actUpdateUser_(req, user) {
  const email = cleanEmail_(req.email);
  const target = findUser_(email);
  if (!target) throw fail_(404, 'No such account.');

  const patch = profileFrom_(req, ALL_PROFILE, []);
  if (req.role !== undefined) patch.role = req.role === 'admin' ? 'admin' : 'staff';
  if (req.active !== undefined) patch.active = !!req.active;

  const isSelf = email === user.email;
  if (isSelf && (patch.role === 'staff' || patch.active === false)) {
    throw fail_(400, 'You cannot demote or disable your own account.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // never leave the portal without an active admin
    const users = readUsers_();
    const after = users.map(function (u) {
      return u.email === email ? Object.assign({}, u, patch) : u;
    });
    if (!after.some(function (u) { return u.role === 'admin' && u.active && u.status === 'approved'; })) {
      throw fail_(400, 'At least one active administrator must remain.');
    }
    updateUserRow_(email, patch);
  } finally {
    lock.releaseLock();
  }
  audit_(user.email, 'user-update', email + ' ' + JSON.stringify(patch));
  syncDirectory_(email);
  return { users: readUsers_().map(publicUserFull_) };
}

function actResetPassword_(req, user) {
  const email = cleanEmail_(req.email);
  if (!findUser_(email)) throw fail_(404, 'No such account.');
  firebaseSendReset_(email);
  audit_(user.email, 'password-email', email);
  return { note: 'A password-reset email has been sent to ' + email + '.' };
}

/** Called by someone who has a Firebase login but is not on the Users sheet. */
function actRegister_(req, who) {
  const props = PropertiesService.getScriptProperties();
  if (String(props.getProperty('REGISTRATION_OPEN') || 'true').toLowerCase() === 'false') {
    throw fail_(403, 'Self-registration is closed. Ask a portal administrator to add you.', 'closed');
  }
  const domains = String(props.getProperty('ALLOWED_DOMAINS') || '').toLowerCase()
    .split(',').map(function (d) { return d.trim().replace(/^@/, ''); }).filter(String);
  const domain = who.email.split('@')[1];
  if (domains.length && domains.indexOf(domain) < 0) {
    throw fail_(403, 'Only these email addresses can register: ' + domains.map(function (d) { return '@' + d; }).join(', '), 'domain');
  }

  const existing = findUser_(who.email);
  if (existing) return { status: existing.status };      // already asked (or already a member)

  const profile = profileFrom_(req, ALL_PROFILE, ['name', 'jawatan', 'unit', 'phone']);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (findUser_(who.email)) return { status: findUser_(who.email).status };
    const pending = readUsers_().filter(function (u) { return u.status === 'pending'; }).length;
    if (pending >= MAX_PENDING) {
      throw fail_(429, 'There are too many requests waiting for approval. Please contact a portal administrator.');
    }
    appendUser_(who.email, 'staff', 'pending', profile, who.emailVerified);
  } finally {
    lock.releaseLock();
  }
  const about = profile.jawatan + (profile.gred ? ' (' + profile.gred + ')' : '') + ' · ' + profile.unit;
  audit_(who.email, 'register', profile.name + ' · ' + about);
  notifyAdmins_(profile, who.email);
  pushNewRegistration_(profile.name, about);
  return { status: 'pending' };
}

function actApproveUser_(req, user) {
  const email = cleanEmail_(req.email);
  const target = findUser_(email);
  if (!target) throw fail_(404, 'No such request.');
  const role = req.role === 'admin' ? 'admin' : 'staff';
  updateUserRow_(email, { status: 'approved', role: role, active: true });
  audit_(user.email, 'user-approve', email + ' as ' + role);
  syncDirectory_(email);
  sendMail_(email, 'Portal KK Meru — access approved',
    'Assalamualaikum / Salam sejahtera ' + target.name + ',\n\n' +
    'Your request to use the Klinik Kesihatan Meru staff portal has been approved (' +
    (role === 'admin' ? 'administrator' : 'staff') + ' access).\n\n' +
    'You can now sign in' + portalLink_() + ' with the email and password you registered with.\n' +
    (target.verified ? '' : 'Remember to verify your email address first — check your inbox for the verification link.\n') +
    '\n— Portal KK Meru');
  return { users: readUsers_().map(publicUserFull_) };
}

function actRejectUser_(req, user) {
  const email = cleanEmail_(req.email);
  if (!findUser_(email)) throw fail_(404, 'No such request.');
  if (email === user.email) throw fail_(400, 'You cannot reject your own account.');
  updateUserRow_(email, { status: 'rejected' });
  audit_(user.email, 'user-reject', email);
  syncDirectory_(email);
  return { users: readUsers_().map(publicUserFull_) };
}

function notifyAdmins_(p, email) {
  const admins = readUsers_().filter(function (u) { return u.role === 'admin' && u.active && u.status === 'approved'; })
    .map(function (u) { return u.email; });
  if (!admins.length) return;
  sendMail_(admins.join(','), 'Portal KK Meru — new registration: ' + p.name,
    'A new person has asked to use the staff portal:\n\n' +
    '  Name:     ' + p.name + '\n' +
    '  Position: ' + p.jawatan + (p.gred ? ' (' + p.gred + ')' : '') + '\n' +
    '  Unit:     ' + p.unit + '\n' +
    '  Mobile:   ' + p.phone + (p.ext ? '   Ext: ' + p.ext : '') + '\n' +
    '  Email:    ' + email + '\n' +
    '\nThey cannot see anything until you approve them. Review it under Staff Accounts' + portalLink_() + '.\n\n' +
    'If you do not recognise this person, click Reject.\n\n— Portal KK Meru');
}

function portalLink_() {
  const u = PropertiesService.getScriptProperties().getProperty('PORTAL_URL');
  return u ? ' at ' + u : '';
}

function sendMail_(to, subject, body) {
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: body, name: 'Portal KK Meru' });
  } catch (err) {
    console.error('mail failed', err);      // e.g. daily quota — never blocks the action itself
  }
}

function actGetAudit_() {
  const sh = sheet_(AUDIT_SHEET, AUDIT_COLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return { entries: [] };
  const take = Math.min(200, n);
  const vals = sh.getRange(sh.getLastRow() - take + 1, 1, take, AUDIT_COLS.length).getDisplayValues();
  return {
    entries: vals.reverse().map(function (r) {
      return { time: r[0], email: r[1], action: r[2], detail: r[3] };
    })
  };
}

/* ======================================================================== */
/*  Firebase                                                                */
/* ======================================================================== */

function apiKey_() {
  const k = PropertiesService.getScriptProperties().getProperty('FIREBASE_API_KEY');
  if (!k) throw new Error('FIREBASE_API_KEY script property is not set.');
  return k;
}

function identityToolkit_(method, payload) {
  const res = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:' + method + '?key=' + encodeURIComponent(apiKey_()),
    { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true }
  );
  let body = {};
  try { body = JSON.parse(res.getContentText()); } catch (_) {}
  return { code: res.getResponseCode(), body: body };
}

/**
 * Validates a Firebase ID token with Google and returns {uid, email, emailVerified}.
 * Rejects tokens issued before the account's validSince (i.e. before a password
 * change), so changing your password really does sign out other devices.
 */
function verifyIdToken_(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4096 || idToken.split('.').length !== 3) {
    throw fail_(401, 'Please sign in.', 'no_token');
  }
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 43);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const claims = decodeJwtPayload_(idToken);
  const now = Math.floor(Date.now() / 1000);
  const projectId = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  if (!claims || !claims.exp || claims.exp <= now) throw fail_(401, 'Your session has expired. Please sign in again.', 'expired');
  if (projectId && (claims.aud !== projectId || claims.iss !== 'https://securetoken.google.com/' + projectId)) {
    throw fail_(401, 'Invalid sign-in token.', 'bad_token');
  }

  const r = identityToolkit_('lookup', { idToken: idToken });
  const u = r.code === 200 && r.body.users && r.body.users[0];
  if (!u || !u.email || u.disabled) throw fail_(401, 'Your session has ended. Please sign in again.', 'bad_token');
  if (u.validSince && claims.iat && Number(claims.iat) < Number(u.validSince)) {
    throw fail_(401, 'Your password was changed. Please sign in again.', 'revoked');
  }

  const out = { uid: u.localId, email: String(u.email).toLowerCase(), emailVerified: !!u.emailVerified };
  const ttl = Math.max(1, Math.min(TOKEN_CACHE_SECONDS, claims.exp - now - 5));
  cache.put(key, JSON.stringify(out), ttl);
  return out;
}

function decodeJwtPayload_(jwt) {
  try {
    let p = jwt.split('.')[1];
    while (p.length % 4) p += '=';
    return JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(p)).getDataAsString());
  } catch (_) {
    return null;
  }
}

/** Creates the Firebase login so nobody else can register this email first. */
function firebaseCreate_(email) {
  const pw = Utilities.getUuid() + '-' + Utilities.getUuid();    // random, never shown to anyone
  const r = identityToolkit_('signUp', { email: email, password: pw, returnSecureToken: false });
  if (r.code === 200) return 'created';
  const msg = (r.body.error && r.body.error.message) || '';
  if (msg.indexOf('EMAIL_EXISTS') === 0) return 'exists';
  if (msg.indexOf('ADMIN_ONLY_OPERATION') === 0) return 'console';
  if (msg.indexOf('OPERATION_NOT_ALLOWED') === 0) {
    throw fail_(500, 'Email/Password sign-in is not enabled in Firebase (Authentication → Sign-in method).');
  }
  throw fail_(500, 'Firebase could not create the login: ' + (msg || 'HTTP ' + r.code));
}

function firebaseSendReset_(email) {
  const r = identityToolkit_('sendOobCode', { requestType: 'PASSWORD_RESET', email: email });
  if (r.code === 200) return;
  const msg = (r.body.error && r.body.error.message) || '';
  if (msg.indexOf('EMAIL_NOT_FOUND') === 0) {
    throw fail_(404, 'There is no Firebase login for ' + email + ' yet. Create it in Firebase console → Authentication → Add user, then try again.');
  }
  throw fail_(500, 'Firebase could not send the email: ' + (msg || 'HTTP ' + r.code));
}

/* ======================================================================== */
/*  Content data                                                            */
/* ======================================================================== */

function readAll_() {
  // the cache key also changes when an account updates its directory row
  const v = getVersion_() + '_' + (PropertiesService.getScriptProperties().getProperty('DIR_VERSION') || '0');
  const cache = CacheService.getScriptCache();
  const hit = cache.get('data_' + v);
  if (hit) return JSON.parse(hit);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = {};
  Object.keys(COLLECTIONS).forEach(function (k) { data[k] = readCollection_(ss, k); });
  const s = JSON.stringify(data);
  if (s.length < 95000) cache.put('data_' + v, s, 600);
  return data;
}

function readCollection_(ss, key) {
  const def = COLLECTIONS[key];
  const sh = ensureSheet_(ss, def.sheet, def.cols);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const rows = sh.getRange(2, 1, n, def.cols.length).getDisplayValues();
  const out = [];
  rows.forEach(function (r, i) {
    if (r.every(function (c) { return String(c).trim() === ''; })) return;
    const o = {};
    def.cols.forEach(function (c, j) { o[c] = String(r[j]); });
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(o.id)) o.id = key + '_row' + (i + 2);   // row typed directly in the Sheet
    if (key === 'announcements') o.pinned = /^(true|yes|ya|1)$/i.test(o.pinned);
    if (key === 'roster') {
      o.d = DAYS.map(function (d) {
        const s = String(o[d]).toLowerCase().trim();
        return SHIFTS.indexOf(s) >= 0 ? s : 'cuti';
      });
      DAYS.forEach(function (d) { delete o[d]; });
    }
    out.push(o);
  });
  return out;
}

function writeCollection_(ss, key, items) {
  const def = COLLECTIONS[key];
  const sh = ensureSheet_(ss, def.sheet, def.cols);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, def.cols.length).clearContent();
  if (!items.length) return;
  const rows = items.map(function (o) {
    return def.cols.map(function (c) {
      if (key === 'roster' && DAYS.indexOf(c) >= 0) return o.d[DAYS.indexOf(c)];
      if (key === 'announcements' && c === 'pinned') return o.pinned ? 'TRUE' : 'FALSE';
      return safeCell_(o[c]);
    });
  });
  const range = sh.getRange(2, 1, rows.length, def.cols.length);
  range.setNumberFormat('@');        // plain text: keeps "012-..." and "201" exactly as typed
  range.setValues(rows);
}

/** Accepts only known collections and fields; rejects unsafe links. */
function validateData_(data) {
  if (!data || typeof data !== 'object') throw fail_(400, 'Invalid data.');
  const out = {};
  Object.keys(COLLECTIONS).forEach(function (key) {
    const list = data[key];
    if (!Array.isArray(list)) throw fail_(400, 'Missing collection: ' + key);
    if (list.length > MAX_ITEMS) throw fail_(400, 'Too many entries in ' + key);
    const seen = {};
    out[key] = list.map(function (item) {
      if (!item || typeof item !== 'object') throw fail_(400, 'Invalid entry in ' + key);
      const o = {};
      COLLECTIONS[key].cols.forEach(function (c) {
        if (key === 'roster' && DAYS.indexOf(c) >= 0) return;
        o[c] = cleanText_(item[c], MAX_FIELD);
      });
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(o.id) || seen[o.id]) o.id = 'x' + Utilities.getUuid().slice(0, 8);
      seen[o.id] = true;
      if (key === 'announcements') {
        o.tag = TAGS.indexOf(o.tag) >= 0 ? o.tag : 'notice';
        o.pinned = item.pinned === true;
      }
      if (key === 'roster') {
        const d = Array.isArray(item.d) ? item.d : [];
        o.d = DAYS.map(function (_, i) { return SHIFTS.indexOf(d[i]) >= 0 ? d[i] : 'cuti'; });
      }
      if (key === 'docs') {
        o.ext = DOC_EXTS.indexOf(o.ext) >= 0 ? o.ext : 'other';
        if (o.url && !/^https?:\/\//i.test(o.url)) {
          throw fail_(400, 'Download links must start with https:// or http:// — "' + o.name + '"');
        }
      }
      return o;
    });
  });
  return out;
}

/* ======================================================================== */
/*  Users                                                                   */
/* ======================================================================== */

function readUsers_() {
  const sh = sheet_(USERS_SHEET, USERS_COLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, USERS_COLS.length).getDisplayValues()
    .filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(function (r) {
      return {
        email: String(r[0]).trim().toLowerCase(),
        name: String(r[1]).trim() || String(r[0]).trim(),
        role: String(r[2]).trim().toLowerCase() === 'admin' ? 'admin' : 'staff',
        active: !/^(false|no|tidak|0)$/i.test(String(r[3]).trim()),
        added: r[4],
        lastSeen: r[5],
        status: /^(pending|rejected)$/i.test(String(r[6]).trim()) ? String(r[6]).trim().toLowerCase() : 'approved',
        unit: String(r[7] || ''),
        verified: /^true$/i.test(String(r[8]).trim()),
        jawatan: String(r[9] || ''),
        gred: String(r[10] || ''),
        phone: String(r[11] || ''),
        ext: String(r[12] || '')
      };
    });
}

function findUser_(email) {
  email = String(email || '').toLowerCase();
  const users = readUsers_();
  for (let i = 0; i < users.length; i++) if (users[i].email === email) return users[i];
  return null;
}

function userRowIndex_(sh, email) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return -1;
  const col = sh.getRange(2, 1, n, 1).getDisplayValues();
  for (let i = 0; i < col.length; i++) {
    if (String(col[i][0]).trim().toLowerCase() === email) return i + 2;
  }
  return -1;
}

function appendUser_(email, role, status, profile, verified) {
  const p = profile || {};
  const sh = sheet_(USERS_SHEET, USERS_COLS);
  const row = sh.getLastRow() + 1;
  const r = sh.getRange(row, 1, 1, USERS_COLS.length);
  r.setNumberFormat('@');
  r.setValues([[email, safeCell_(p.name || email), role, 'TRUE', nowIso_(), '', status || 'approved',
    safeCell_(p.unit || ''), verified ? 'TRUE' : '',
    safeCell_(p.jawatan || ''), safeCell_(p.gred || ''), safeCell_(p.phone || ''), safeCell_(p.ext || '')]]);
}

function updateUserRow_(email, patch) {
  const sh = sheet_(USERS_SHEET, USERS_COLS);
  const row = userRowIndex_(sh, email);
  if (row < 0) throw fail_(404, 'No such account.');
  Object.keys(patch).forEach(function (k) {
    const col = USERS_COLS.indexOf(k) + 1;
    if (col < 1 || k === 'email') return;
    let v = patch[k];
    if (k === 'active' || k === 'verified') v = v ? 'TRUE' : 'FALSE';
    else if (k !== 'role' && k !== 'status') v = safeCell_(v);
    sh.getRange(row, col).setNumberFormat('@').setValue(v);
  });
}

function touchLastSeen_(email) {
  try {
    const sh = sheet_(USERS_SHEET, USERS_COLS);
    const row = userRowIndex_(sh, email);
    if (row > 0) sh.getRange(row, 6).setNumberFormat('@').setValue(nowIso_());
  } catch (_) { /* not important enough to fail a sign-in */ }
}

function publicUser_(u) {
  return { email: u.email, name: u.name, role: u.role,
           jawatan: u.jawatan, gred: u.gred, unit: u.unit, phone: u.phone, ext: u.ext };
}
function publicUserFull_(u) {
  return { email: u.email, name: u.name, role: u.role, active: u.active, added: u.added, lastSeen: u.lastSeen,
           status: u.status, verified: u.verified,
           jawatan: u.jawatan, gred: u.gred, unit: u.unit, phone: u.phone, ext: u.ext };
}

/**
 * Reads the profile fields in `allowed` from a request.
 * Fields in `required` must be present and non-empty; other fields are only
 * touched when the request includes them (an empty string clears an
 * optional field, but name / position / unit can never be blank).
 */
function profileFrom_(src, allowed, required) {
  const out = {};
  allowed.forEach(function (k) {
    if (src[k] === undefined && required.indexOf(k) < 0) return;
    const def = PROFILE[k];
    let v = cleanText_(src[k], def.max).replace(/\s+/g, ' ');
    if (k === 'gred') v = v.toUpperCase();
    if (!v) {
      if (required.indexOf(k) >= 0 || def.min) throw fail_(400, def.label + ' is required.');
      out[k] = '';
      return;
    }
    if ((def.min && v.length < def.min) || (def.re && !def.re.test(v))) {
      throw fail_(400, 'Please enter a valid ' + def.label.toLowerCase() + '.');
    }
    out[k] = v;
  });
  return out;
}

/* ======================================================================== */
/*  Staff Directory ⇄ accounts                                              */
/* ======================================================================== */

function linkId_(email) {
  return LINK_PREFIX + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(email).toLowerCase()))
    .replace(/[^A-Za-z0-9]/g, '').slice(0, 14);
}

function directoryEntry_(u) {
  return { id: linkId_(u.email), name: u.name,
           role: u.jawatan + (u.gred ? ' (' + u.gred + ')' : ''), unit: u.unit, ext: u.ext };
}

const listed_ = function (u) { return u && u.status === 'approved' && u.active && u.jawatan; };

/** Adds, updates or removes one account's row in the Staff Directory. */
function syncDirectory_(email) {
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const u = findUser_(email);
      const id = linkId_(email);
      const list = readCollection_(ss, 'staff');
      const i = list.findIndex(function (s) { return s.id === id; });
      const before = JSON.stringify(list);
      if (listed_(u)) {
        if (i >= 0) list[i] = directoryEntry_(u); else list.push(directoryEntry_(u));
      } else if (i >= 0) {
        list.splice(i, 1);
      }
      if (JSON.stringify(list) !== before) {
        writeCollection_(ss, 'staff', list);
        bumpDirVersion_();
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error('directory sync failed', err);   // the account change itself has already succeeded
  }
}

/**
 * When an admin saves the portal content, rows that belong to accounts are
 * always taken from the Users sheet — so the directory can never drift from
 * the staff database, and deleting such a row in the editor does nothing.
 */
function keepLinkedRows_(ss, incoming) {
  const linked = {};
  readUsers_().filter(listed_).forEach(function (u) { const e = directoryEntry_(u); linked[e.id] = e; });
  const seen = {};
  const out = incoming.filter(function (s) {
    return s.id.indexOf(LINK_PREFIX) !== 0 || linked[s.id];
  }).map(function (s) {
    if (s.id.indexOf(LINK_PREFIX) !== 0) return s;
    seen[s.id] = true;
    return linked[s.id];
  });
  Object.keys(linked).forEach(function (id) { if (!seen[id]) out.push(linked[id]); });
  return out;
}

/** Run from the editor to rebuild every account's directory row (e.g. after editing the Users sheet by hand). */
function syncAllToDirectory() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const list = keepLinkedRows_(ss, readCollection_(ss, 'staff'));
    writeCollection_(ss, 'staff', list);
    bumpDirVersion_();
    Logger.log('Staff Directory now has ' + list.length + ' entries (' +
      list.filter(function (s) { return s.id.indexOf(LINK_PREFIX) === 0; }).length + ' from accounts).');
  } finally {
    lock.releaseLock();
  }
}

/* ======================================================================== */
/*  Audit, versioning, helpers                                              */
/* ======================================================================== */

function audit_(email, action, detail) {
  try {
    const sh = sheet_(AUDIT_SHEET, AUDIT_COLS);
    sh.appendRow([nowIso_(), safeCell_(email), action, safeCell_(String(detail || '').slice(0, 500))]);
    if (sh.getLastRow() > 20000) sh.deleteRows(2, 5000);   // keep the sheet a sensible size
  } catch (err) {
    console.error('audit failed', err);
  }
}

function getVersion_() {
  const p = PropertiesService.getScriptProperties();
  let v = p.getProperty('DATA_VERSION');
  if (!v) { v = String(Date.now()); p.setProperty('DATA_VERSION', v); }
  return v;
}
function bumpVersion_() {
  const v = Date.now() + '-' + Math.floor(Math.random() * 1e6);
  PropertiesService.getScriptProperties().setProperty('DATA_VERSION', v);
  return v;
}
/**
 * Account changes rewrite only their own directory rows, and an admin's save
 * keeps those rows from the Users sheet anyway (keepLinkedRows_), so they
 * must not trigger the "someone else saved" conflict — they only refresh the cache.
 */
function bumpDirVersion_() {
  PropertiesService.getScriptProperties().setProperty('DIR_VERSION', Date.now() + '-' + Math.floor(Math.random() * 1e6));
}

/** Someone edited the Sheet by hand → make the portal pick it up. */
function onEdit(e) {
  try {
    const name = e && e.range && e.range.getSheet().getName();
    const isContent = Object.keys(COLLECTIONS).some(function (k) { return COLLECTIONS[k].sheet === name; });
    if (isContent) bumpVersion_();
  } catch (_) {}
}

function sheet_(name, cols) {
  return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), name, cols);
}

function ensureSheet_(ss, name, cols) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols])
      .setFontWeight('bold').setBackground('#eef4f9').setFontColor('#003a6d');
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < cols.length) {
    // sheet made by an older version: add the new columns at the end
    const have = sh.getLastColumn();
    sh.getRange(1, have + 1, 1, cols.length - have).setValues([cols.slice(have)])
      .setFontWeight('bold').setBackground('#eef4f9').setFontColor('#003a6d');
  }
  return sh;
}

/** Text that starts with = + - @ would be run as a formula by Sheets. */
function safeCell_(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function cleanText_(v, max) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function cleanEmail_(v) {
  const e = String(v || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw fail_(400, 'Please enter a valid email address.');
  return e;
}

function nowIso_() {
  return Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', "yyyy-MM-dd HH:mm:ss");
}

function fail_(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code || '';
  return e;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
