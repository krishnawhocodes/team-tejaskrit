// Tejaskrit Extension Config
// Firebase config is public (same values used in web apps). You can override in Settings.

export const DEFAULT_CONFIG = {
  firebase: {
    apiKey: "AIzaSyBMAIUc2Ll43hy1boVV8FcA6FYDmtfbzW4",
    authDomain: "tejaskrit-iiitm.firebaseapp.com",
    projectId: "tejaskrit-iiitm",
    storageBucket: "tejaskrit-iiitm.firebasestorage.app",
    messagingSenderId: "1003962905868",
    appId: "1:1003962905868:web:5c66e6214f977a0d11c529",
    measurementId: "G-189JD6V44C",
  },

  // Where your Candidate web app / Vercel API lives.
  // Needed for: /api/resume/generate-latex and /api/resume/pdf
  // Example: https://your-candidate-app.vercel.app
  // Hardcoded Candidate web app / API base.
  // (Kept here so resume generation + tracker link work out of the box.)
  backendBaseUrl: "https://team-tejaskrit.vercel.app",

  // Autofill toggles
  autofill: {
    name: true,
    email: true,
    phone: true,
    links: true,
    education: true,
    skills: true,
    summary: true,
    location: true,
  },
};

export const STORAGE_KEYS = {
  config: "tejaskrit_config_v1",
  session: "tejaskrit_session_v1"
};
