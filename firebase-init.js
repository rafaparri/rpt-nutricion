// Mismo proyecto Firebase que WorkOut 2.0: así tu cuenta sirve en las dos apps.
const firebaseConfig = {
  apiKey: "AIzaSyBDprXpQrZkRasflhGMmX4mOZa7H4afzYY",
  authDomain: "workout2-75512.firebaseapp.com",
  projectId: "workout2-75512",
  storageBucket: "workout2-75512.firebasestorage.app",
  messagingSenderId: "131858389738",
  appId: "1:131858389738:web:e33023e53284f6b6189593"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
