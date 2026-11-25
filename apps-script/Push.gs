/**
 * PUSH NOTIFICATIONS — Firebase Cloud Messaging (FCM HTTP v1)
 * ---------------------------------------------------------------------------
 * Each phone / laptop that switches notifications on registers its FCM token
 * here (sheet "Devices"). When an admin saves a new announcement or changes
 * the roster, or someone registers for access, a notification is sent to the
 * matching devices — it appears even when the portal is closed.
 *
 * Script property needed:
 *   FCM_SERVICE_ACCOUNT  — the whole JSON file from Firebase console →
 *                          Project settings → Service accounts →
 *                          Generate new private key. Keep it secret.
 * If it is missing, everything else keeps working; nothing is pushed.
 *
 * Only DATA messages are sent; the service worker (sw.js) draws the
 * notification itself, so the text and the tap-to-open link are ours.
 */

const DEVICES_SHEET = 'Devices';
const DEVICES_COLS = ['token', 'email', 'label', 'ann', 'roster', 'added', 'lastSeen'];
const MAX_DEVICES_PER_USER = 10;
const ANN_PREFS = ['all', 'urgent', 'none'];

/* ---------------- actions (any approved user) ---------------- */

function actRegisterDevice_(req, user) {
  const token = String(req.token || '');
  if (!/^[A-Za-z0-9_:\-.]{20,4096}$/.test(token)) throw fail_(400, 'Invalid device token.');
  const label = cleanText_(req.label, 60) || 'Device';
  const ann = ANN_PREFS.indexOf(req.ann) >= 0 ? req.ann : 'all';
  const roster = req.roster !== false;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(DEVICES_SHEET, DEVICES_COLS);
    let rows = readDevices_();
    const existing = rows.filter(function (d) { return d.token === token; })[0];
    const values = [token, user.email, safeCell_(label), ann, roster ? 'TRUE' : 'FALSE',
                    existing ? existing.added : nowIso_(), nowIso_()];
    if (existing) {
      sh.getRange(existing.row, 1, 1, DEVICES_COLS.length).setNumberFormat('@').setValues([values]);
    } else {
      const mine = rows.filter(function (d) { return d.email === user.email; })
        .sort(function (a, b) { return String(a.lastSeen).localeCompare(String(b.lastSeen)); });
      if (mine.length >= MAX_DEVICES_PER_USER) deleteDeviceRows_([mine[0].row]);   // drop the stalest
      const r = sh.getRange(sh.getLastRow() + 1, 1, 1, DEVICES_COLS.length);
      r.setNumberFormat('@');
      r.setValues([values]);
      audit_(user.email, 'push-on', label);
    }
  } finally {
    lock.releaseLock();
  }
  return { devices: myDevices_(user.email), pushReady: pushConfigured_() };
}

function actUnregisterDevice_(req, user) {
  const token = String(req.token || '');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const rows = readDevices_().filter(function (d) {
      return d.token === token && (d.email === user.email || user.role === 'admin');
    });
    deleteDeviceRows_(rows.map(function (d) { return d.row; }));
    if (rows.length) audit_(user.email, 'push-off', rows[0].label);
  } finally {
    lock.releaseLock();
  }
  return { devices: myDevices_(user.email) };
}

function actTestPush_(req, user) {
  if (!pushConfigured_()) throw fail_(503, 'Push notifications are not set up on the server yet (FCM_SERVICE_ACCOUNT).');
  const sent = pushToDevices_(function (d) { return d.email === user.email; }, {
    title: 'Test notification ✅',
    body: 'Notifications from Portal KK Meru are working on this device.',
    url: './', tag: 'test'
  });
  return { sent: sent };
}

function myDevices_(email) {
  return readDevices_().filter(function (d) { return d.email === email; })
    .map(function (d) { return { label: d.label, ann: d.ann, roster: d.roster, lastSeen: d.lastSeen }; });
}

/* ---------------- what gets pushed ---------------- */

/** After a save: new announcements the admin ticked, and/or a roster change. */
function pushAfterSave_(notify, data) {
  if (!notify || !pushConfigured_()) return 0;
  let sent = 0;
  const ids = Array.isArray(notify.announcements) ? notify.announcements.slice(0, 5) : [];
  data.announcements.forEach(function (a) {
    if (ids.indexOf(a.id) < 0) return;
    const urgent = a.tag === 'urgent';
    sent += pushToDevices_(function (d) { return d.ann === 'all' || (d.ann === 'urgent' && urgent); }, {
      title: (urgent ? '🔴 URGENT: ' : '📢 ') + a.title,
      body: String(a.text || '').slice(0, 180) || 'New announcement on the staff portal.',
      url: './?tab=announce', tag: 'ann-' + a.id, urgent: urgent
    });
  });
  if (notify.roster) {
    sent += pushToDevices_(function (d) { return d.roster; }, {
      title: '🗓 Duty roster updated',
      body: 'The roster or on-call list has changed. Tap to check your shifts.',
      url: './?tab=roster', tag: 'roster'
    });
  }
  return sent;
}

function pushNewRegistration_(name, unit) {
  if (!pushConfigured_()) return;
  const admins = readUsers_().filter(function (u) { return u.role === 'admin' && u.active && u.status === 'approved'; })
    .map(function (u) { return u.email; });
  pushToDevices_(function (d) { return admins.indexOf(d.email) >= 0; }, {
    title: '👤 New registration waiting for approval',
    body: name + (unit ? ' · ' + unit : '') + ' — tap to review.',
    url: './?tab=accounts', tag: 'registration'
  });
}

/* ---------------- delivery ---------------- */

/**
 * Sends one message to every registered device that passes `filter` and
 * belongs to an approved, active user. Dead tokens are removed.
 * Returns the number of devices it was delivered to.
 */
function pushToDevices_(filter, msg) {
  try {
    const okUsers = {};
    readUsers_().forEach(function (u) { if (u.active && u.status === 'approved') okUsers[u.email] = u.role; });
    const targets = readDevices_().filter(function (d) {
      return okUsers[d.email] && filter(d);
    });
    if (!targets.length) return 0;

    const sa = serviceAccount_();
    const accessToken = fcmAccessToken_(sa);
    const url = 'https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(sa.project_id) + '/messages:send';
    const portal = PropertiesService.getScriptProperties().getProperty('PORTAL_URL');
    const data = {
      title: String(msg.title).slice(0, 120),
      body: String(msg.body || '').slice(0, 300),
      url: String(msg.url || './'),
      tag: String(msg.tag || 'portal'),
      urgent: msg.urgent ? '1' : '0'
    };

    let delivered = 0;
    const dead = [];
    for (let i = 0; i < targets.length; i += 50) {
      const chunk = targets.slice(i, i + 50);
      const responses = UrlFetchApp.fetchAll(chunk.map(function (d) {
        const webpush = { headers: { Urgency: msg.urgent ? 'high' : 'normal', TTL: '86400' } };
        if (portal && /^https:\/\//.test(portal)) webpush.fcm_options = { link: portal };
        return {
          url: url, method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          headers: { Authorization: 'Bearer ' + accessToken },
          payload: JSON.stringify({ message: { token: d.token, data: data, webpush: webpush } })
        };
      }));
      responses.forEach(function (res, j) {
        const code = res.getResponseCode();
        if (code === 200) { delivered++; return; }
        const text = res.getContentText();
        // token no longer valid (app uninstalled, permission removed, browser data cleared)
        if (code === 404 || /UNREGISTERED|registration-token-not-registered/.test(text) ||
            (code === 400 && /INVALID_ARGUMENT/.test(text) && /token/i.test(text))) {
          dead.push(chunk[j].row);
        } else {
          console.error('FCM ' + code + ': ' + text.slice(0, 300));
        }
      });
    }
    if (dead.length) deleteDeviceRows_(dead);
    return delivered;
  } catch (err) {
    console.error('push failed', err && err.stack ? err.stack : err);
    return 0;     // a notification problem never breaks the action that triggered it
  }
}

function pushConfigured_() {
  return !!PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT');
}

function serviceAccount_() {
  const raw = PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT');
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('FCM_SERVICE_ACCOUNT is not a service-account key file.');
  return sa;
}

/** OAuth token for FCM, signed with the service-account key (cached ~55 min). */
function fcmAccessToken_(sa) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('fcm_access_token');
  if (hit) return hit;
  const now = Math.floor(Date.now() / 1000);
  const enc = function (o) { return Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, ''); };
  const input = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, sa.private_key)).replace(/=+$/, '');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + sig }
  });
  const body = JSON.parse(res.getContentText() || '{}');
  if (!body.access_token) throw new Error('Could not get an FCM access token: ' + res.getContentText().slice(0, 200));
  cache.put('fcm_access_token', body.access_token, 3300);
  return body.access_token;
}

/* ---------------- Devices sheet ---------------- */

function readDevices_() {
  const sh = sheet_(DEVICES_SHEET, DEVICES_COLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, DEVICES_COLS.length).getDisplayValues().map(function (r, i) {
    return {
      row: i + 2, token: String(r[0]).trim(), email: String(r[1]).trim().toLowerCase(), label: r[2],
      ann: ANN_PREFS.indexOf(r[3]) >= 0 ? r[3] : 'all', roster: !/^false$/i.test(String(r[4]).trim()),
      added: r[5], lastSeen: r[6]
    };
  }).filter(function (d) { return d.token; });
}

function deleteDeviceRows_(rowNumbers) {
  const sh = sheet_(DEVICES_SHEET, DEVICES_COLS);
  rowNumbers.slice().sort(function (a, b) { return b - a; })
    .filter(function (r, i, arr) { return arr.indexOf(r) === i; })
    .forEach(function (r) { sh.deleteRow(r); });
}

/** Run once from the editor after setting FCM_SERVICE_ACCOUNT to check it works. */
function testFcmSetup() {
  const sa = serviceAccount_();
  fcmAccessToken_(sa);
  Logger.log('FCM is set up for project ' + sa.project_id + '. Registered devices: ' + readDevices_().length);
}
