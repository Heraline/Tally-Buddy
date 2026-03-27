// firebase-config.template.js
// ✅  This file is safe to commit — it contains no real secrets.
//
// SETUP:
//   1. Copy this file:  cp firebase-config.template.js firebase-config.js
//   2. Fill in your Firebase project values in firebase-config.js
//   3. Make sure firebase-config.js is listed in .gitignore (never commit it)

window.__FIREBASE_CONFIG__ = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT-default-rtdb.YOUR_REGION.firebasedatabase.app",
  projectId:         "YOUR_PROJECT",
  storageBucket:     "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
