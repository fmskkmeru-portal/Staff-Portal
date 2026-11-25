/* ============================================================================
   PORTAL SETTINGS — the only file you need to edit.
   Nothing here is secret: the Firebase web config is meant to be public.
   Security comes from Apps Script checking every request, not from hiding this.
   (Written as self.PORTAL_CONFIG so the service worker can read it too.)
   ========================================================================== */
self.PORTAL_CONFIG = {

  // Firebase console → Project settings (gear) → General → Your apps → Web app → SDK setup (Config)
  firebase: {
    apiKey:            "PASTE_FIREBASE_API_KEY",
    authDomain:        "PASTE_PROJECT_ID.firebaseapp.com",
    projectId:         "PASTE_PROJECT_ID",
    appId:             "PASTE_APP_ID",
    messagingSenderId: "PASTE_SENDER_ID"
  },

  // Push notifications: Firebase console → Project settings → Cloud Messaging →
  // Web configuration → Web Push certificates → Generate key pair → copy the key
  vapidKey: "PASTE_WEB_PUSH_KEY",

  // Apps Script → Deploy → Manage deployments → Web app URL (ends with /exec)
  apiUrl: "PASTE_APPS_SCRIPT_WEB_APP_URL",

  // Choices offered on the registration form (staff can also type "Other").
  // Edit freely — changing these lists does not change anyone's saved details.
  positions: [
    "Pakar Perubatan Keluarga", "Pegawai Perubatan", "Pegawai Pergigian", "Pegawai Farmasi",
    "Penolong Pegawai Perubatan", "Ketua Jururawat / Sister", "Jururawat", "Jururawat Masyarakat",
    "Juruteknologi Makmal Perubatan", "Juru X-Ray", "Juruterapi Pergigian", "Pembantu Pembedahan Pergigian",
    "Pegawai Pemulihan Perubatan", "Pegawai Dietetik", "Penolong Pegawai Kesihatan Persekitaran",
    "Pegawai Tadbir", "Pembantu Tadbir", "Pembantu Perawatan Kesihatan", "Pemandu"
  ],
  units: [
    "Outpatient (OPD)", "Emergency & Treatment Room", "Nursing", "Maternal & Child Health",
    "Pharmacy", "Laboratory", "Radiology", "Dental", "Rehabilitation", "Public Health", "Administration"
  ],

  // Dashboard quick links. Leave url empty ("") to show the tile greyed out.
  quickLinks: [
    { icon: "🗂", label: "TeleME / MyHDW",     url: "" },
    { icon: "🧾", label: "e-Cuti",             url: "" },
    { icon: "💉", label: "MySejahtera Admin",  url: "" },
    { icon: "📦", label: "Stock Request",      url: "" },
    { icon: "🧪", label: "Lab Results",        url: "" },
    { icon: "🛠", label: "Aduan Fasiliti",     url: "" }
  ]
};
