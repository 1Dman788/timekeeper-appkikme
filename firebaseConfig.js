// firebaseConfig.js
//
// This file contains the Firebase configuration used by your timekeeper app.
// To connect the app to your own Firebase project, replace the values of
// the `firebaseConfig` object below with those from your Firebase console.
//
// IMPORTANT: Do not modify any other files when swapping out your
// credentials. The rest of the application will automatically pick up
// whatever is defined here.

// Example configuration (do not use in production):
// const firebaseConfig = {
//   apiKey: "YOUR_API_KEY",
//   authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
//   projectId: "YOUR_PROJECT_ID",
//   storageBucket: "YOUR_PROJECT_ID.appspot.com",
//   messagingSenderId: "YOUR_SENDER_ID",
//   appId: "YOUR_APP_ID"
// };

// Your Firebase configuration.
// Replace the placeholder values below with your real Firebase project
// credentials before deploying the app. For instructions on obtaining
// these values see: https://firebase.google.com/docs/web/setup#config-object
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};

// Expose the configuration on the global object. When using plain
// <script> tags (non‑module), the properties defined here become
// globally accessible as `window.firebaseConfig`.
window.firebaseConfig = firebaseConfig;