/**
 * ONE-TIME SETUP — run setup() once from the Apps Script editor.
 *
 *  - creates the content sheets (Announcements, Staff, Roster, OnCall, Leave,
 *    Docs, UnitExt) and fills them with SAMPLE data if they are empty
 *  - creates the Users and Audit sheets
 *  - registers the first administrator (ADMIN_EMAIL script property, or the
 *    owner of this Sheet), creates their Firebase login and emails them a
 *    link to choose their own password
 *
 * Safe to run again: it never overwrites sheets that already have data.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FIREBASE_API_KEY')) {
    throw new Error('Set FIREBASE_API_KEY first: Project Settings (gear icon) → Script properties.');
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(COLLECTIONS).forEach(function (k) {
    const def = COLLECTIONS[k];
    const sh = ensureSheet_(ss, def.sheet, def.cols);
    if (sh.getLastRow() < 2) writeCollection_(ss, k, SEED[k]);
  });
  ensureSheet_(ss, USERS_SHEET, USERS_COLS);
  ensureSheet_(ss, AUDIT_SHEET, AUDIT_COLS);

  // remove the empty default tab
  ['Sheet1', 'Helaian1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  const adminEmail = String(props.getProperty('ADMIN_EMAIL') || Session.getEffectiveUser().getEmail()).trim().toLowerCase();
  if (!adminEmail) throw new Error('Could not work out the admin email. Set the ADMIN_EMAIL script property.');

  if (!findUser_(adminEmail)) {
    const r = firebaseCreate_(adminEmail);
    appendUser_(adminEmail, 'admin', 'approved', { name: 'Administrator' }, false);
    if (r === 'console') {
      Logger.log('Added ' + adminEmail + ' as admin. Sign-up is disabled in Firebase, so create this login in ' +
                 'Firebase console → Authentication → Add user, then use "Forgot password?" on the portal.');
    } else {
      firebaseSendReset_(adminEmail);
      Logger.log('Added ' + adminEmail + ' as admin and emailed a link to set the password (check spam too).');
    }
  } else {
    Logger.log(adminEmail + ' is already on the Users sheet.');
  }

  bumpVersion_();
  Logger.log('Setup complete. Next: Deploy → New deployment → Web app.');
}

/** Sample content — replace it in the portal (Edit mode) or straight in the Sheet. */
const SEED = {
 "announcements": [
  {
   "id": "a1",
   "tag": "urgent",
   "pinned": true,
   "title": "Dengue outbreak alert — Zon Meru Selatan",
   "text": "Increased dengue cases reported in Taman Meru 2C. All MOs to apply the dengue screening protocol for any febrile patient. Notify the Public Health unit within 24 hours of any suspected case.",
   "date": "5 Aug 2026"
  },
  {
   "id": "a2",
   "tag": "circular",
   "pinned": true,
   "title": "Pekeliling KKM Bil. 12/2026 — Updated antibiotic stewardship",
   "text": "Revised empirical antibiotic guidance for outpatient respiratory infections takes effect 1 September 2026. Full circular available in Forms & SOP.",
   "date": "4 Aug 2026"
  },
  {
   "id": "a3",
   "tag": "notice",
   "pinned": false,
   "title": "Pharmacy counter closing early on Friday",
   "text": "Counter 3 closes at 12:30 PM this Friday for stock audit. Please advise patients to collect medication before noon.",
   "date": "4 Aug 2026"
  },
  {
   "id": "a4",
   "tag": "event",
   "pinned": false,
   "title": "CME session — Management of hypertension in primary care",
   "text": "Thursday, 13 August 2026, 2:00 PM at Bilik Mesyuarat Utama. Attendance counts toward CPD points. Register with the Training unit.",
   "date": "3 Aug 2026"
  },
  {
   "id": "a5",
   "tag": "circular",
   "pinned": false,
   "title": "e-Cuti submission deadline for September leave",
   "text": "All September leave applications must be submitted through e-Cuti by 20 August 2026 for supervisor approval.",
   "date": "2 Aug 2026"
  },
  {
   "id": "a6",
   "tag": "notice",
   "pinned": false,
   "title": "Scheduled network maintenance",
   "text": "MyHDW and TeleME will be unavailable on Saturday, 8 August, 11:00 PM – 3:00 AM. Use manual records during this window.",
   "date": "1 Aug 2026"
  }
 ],
 "staff": [
  {
   "id": "s1",
   "name": "Dr. Nurul Aisyah binti Rahman",
   "role": "Family Medicine Specialist",
   "unit": "Outpatient (OPD)",
   "ext": "201"
  },
  {
   "id": "s2",
   "name": "Dr. Tan Wei Ming",
   "role": "Medical Officer",
   "unit": "Outpatient (OPD)",
   "ext": "202"
  },
  {
   "id": "s3",
   "name": "Dr. Kavitha Subramaniam",
   "role": "Medical Officer",
   "unit": "Outpatient (OPD)",
   "ext": "203"
  },
  {
   "id": "s4",
   "name": "Pn. Siti Zaleha binti Osman",
   "role": "Sister / Ketua Jururawat",
   "unit": "Nursing",
   "ext": "204"
  },
  {
   "id": "s5",
   "name": "Pn. Rohani binti Ismail",
   "role": "Staff Nurse",
   "unit": "Nursing",
   "ext": "205"
  },
  {
   "id": "s6",
   "name": "En. Faizal bin Abdullah",
   "role": "Assistant Medical Officer",
   "unit": "Nursing",
   "ext": "206"
  },
  {
   "id": "s7",
   "name": "Pn. Lim Sook Cheng",
   "role": "Pharmacist",
   "unit": "Pharmacy",
   "ext": "207"
  },
  {
   "id": "s8",
   "name": "En. Arif bin Hamzah",
   "role": "Pharmacy Assistant",
   "unit": "Pharmacy",
   "ext": "208"
  },
  {
   "id": "s9",
   "name": "Pn. Devi a/p Muniandy",
   "role": "Medical Lab Technologist",
   "unit": "Laboratory",
   "ext": "209"
  },
  {
   "id": "s10",
   "name": "Pn. Norhayati binti Yusof",
   "role": "Community Nurse",
   "unit": "Maternal & Child Health",
   "ext": "210"
  },
  {
   "id": "s11",
   "name": "Dr. Chan Li Ping",
   "role": "Dental Officer",
   "unit": "Dental",
   "ext": "212"
  },
  {
   "id": "s12",
   "name": "En. Mohd Farid bin Salleh",
   "role": "Public Health Inspector",
   "unit": "Public Health",
   "ext": "214"
  },
  {
   "id": "s13",
   "name": "Pn. Hasnah binti Daud",
   "role": "Chief Clerk",
   "unit": "Administration",
   "ext": "216"
  }
 ],
 "roster": [
  {
   "id": "r1",
   "name": "Dr. Nurul Aisyah",
   "unit": "Outpatient (OPD)",
   "ext": "201",
   "d": [
    "pagi",
    "pagi",
    "pagi",
    "pagi",
    "pagi",
    "cuti",
    "cuti"
   ]
  },
  {
   "id": "r2",
   "name": "Dr. Tan Wei Ming",
   "unit": "Outpatient (OPD)",
   "ext": "202",
   "d": [
    "pagi",
    "petang",
    "petang",
    "pagi",
    "pagi",
    "pagi",
    "cuti"
   ]
  },
  {
   "id": "r3",
   "name": "Dr. Kavitha S.",
   "unit": "Outpatient (OPD)",
   "ext": "203",
   "d": [
    "petang",
    "pagi",
    "pagi",
    "petang",
    "malam",
    "cuti",
    "pagi"
   ]
  },
  {
   "id": "r4",
   "name": "Pn. Siti Zaleha",
   "unit": "Nursing",
   "ext": "204",
   "d": [
    "pagi",
    "pagi",
    "pagi",
    "pagi",
    "pagi",
    "cuti",
    "cuti"
   ]
  },
  {
   "id": "r5",
   "name": "Pn. Rohani Ismail",
   "unit": "Nursing",
   "ext": "205",
   "d": [
    "petang",
    "petang",
    "cuti",
    "pagi",
    "pagi",
    "pagi",
    "petang"
   ]
  },
  {
   "id": "r6",
   "name": "En. Faizal A.",
   "unit": "Nursing",
   "ext": "206",
   "d": [
    "malam",
    "malam",
    "cuti",
    "cuti",
    "petang",
    "petang",
    "malam"
   ]
  },
  {
   "id": "r7",
   "name": "Pn. Lim Sook Cheng",
   "unit": "Pharmacy",
   "ext": "207",
   "d": [
    "pagi",
    "pagi",
    "pagi",
    "pagi",
    "pagi",
    "cuti",
    "cuti"
   ]
  },
  {
   "id": "r8",
   "name": "Pn. Devi M.",
   "unit": "Laboratory",
   "ext": "209",
   "d": [
    "pagi",
    "pagi",
    "pagi",
    "cuti",
    "pagi",
    "pagi",
    "cuti"
   ]
  },
  {
   "id": "r9",
   "name": "Dr. Chan Li Ping",
   "unit": "Dental",
   "ext": "212",
   "d": [
    "pagi",
    "pagi",
    "cuti",
    "pagi",
    "pagi",
    "pagi",
    "cuti"
   ]
  }
 ],
 "oncall": [
  {
   "id": "o1",
   "date": "6 Aug (Thu)",
   "officer": "Dr. Tan Wei Ming",
   "contact": "Ext 202 / 012-XXX XXXX"
  },
  {
   "id": "o2",
   "date": "7 Aug (Fri)",
   "officer": "Dr. Kavitha Subramaniam",
   "contact": "Ext 203 / 013-XXX XXXX"
  },
  {
   "id": "o3",
   "date": "8 Aug (Sat)",
   "officer": "Dr. Nurul Aisyah binti Rahman",
   "contact": "Ext 201 / 019-XXX XXXX"
  }
 ],
 "leave": [
  {
   "id": "l1",
   "name": "Pn. Hasnah binti Daud",
   "type": "Cuti Tahunan",
   "dates": "3 – 8 Aug 2026"
  },
  {
   "id": "l2",
   "name": "En. Arif bin Hamzah",
   "type": "Cuti Sakit",
   "dates": "6 Aug 2026"
  }
 ],
 "docs": [
  {
   "id": "d1",
   "name": "Borang Permohonan Cuti (e-Cuti Manual Backup)",
   "cat": "Administrative Forms",
   "ext": "docx",
   "size": "48 KB",
   "upd": "12 Jun 2026",
   "url": ""
  },
  {
   "id": "d2",
   "name": "Borang Aduan Kerosakan Fasiliti",
   "cat": "Administrative Forms",
   "ext": "docx",
   "size": "36 KB",
   "upd": "2 Mar 2026",
   "url": ""
  },
  {
   "id": "d3",
   "name": "SOP Triage & Patient Flow — Outpatient",
   "cat": "Clinical SOP",
   "ext": "pdf",
   "size": "1.2 MB",
   "upd": "15 Jul 2026",
   "url": ""
  },
  {
   "id": "d4",
   "name": "SOP Pengendalian Kes Demam Denggi",
   "cat": "Clinical SOP",
   "ext": "pdf",
   "size": "860 KB",
   "upd": "5 Aug 2026",
   "url": ""
  },
  {
   "id": "d5",
   "name": "SOP Emergency Response & Code Blue",
   "cat": "Clinical SOP",
   "ext": "pdf",
   "size": "640 KB",
   "upd": "3 Feb 2026",
   "url": ""
  },
  {
   "id": "d6",
   "name": "Garis Panduan Pengurusan Hipertensi (CPG)",
   "cat": "MOH Guidelines",
   "ext": "pdf",
   "size": "2.9 MB",
   "upd": "1 Jan 2026",
   "url": ""
  },
  {
   "id": "d7",
   "name": "Hand Hygiene & PPE Protocol",
   "cat": "Infection Control",
   "ext": "pdf",
   "size": "520 KB",
   "upd": "18 Mar 2026",
   "url": ""
  },
  {
   "id": "d8",
   "name": "Borang Permohonan Stok Ubat",
   "cat": "Pharmacy & Stores",
   "ext": "xlsx",
   "size": "75 KB",
   "upd": "14 Jul 2026",
   "url": ""
  }
 ],
 "unitExt": [
  {
   "id": "u1",
   "unit": "Registration Counter",
   "ext": "101"
  },
  {
   "id": "u2",
   "unit": "Triage",
   "ext": "102"
  },
  {
   "id": "u3",
   "unit": "OPD Consultation Rooms",
   "ext": "103"
  },
  {
   "id": "u4",
   "unit": "Pharmacy Counter",
   "ext": "104"
  },
  {
   "id": "u5",
   "unit": "Laboratory",
   "ext": "105"
  },
  {
   "id": "u6",
   "unit": "Treatment Room / Bilik Rawatan",
   "ext": "106"
  },
  {
   "id": "u7",
   "unit": "Maternal & Child Health",
   "ext": "107"
  },
  {
   "id": "u8",
   "unit": "Dental Clinic",
   "ext": "108"
  },
  {
   "id": "u9",
   "unit": "Administration Office",
   "ext": "110"
  }
 ]
};
