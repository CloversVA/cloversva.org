import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import { connectAuthEmulator, getAuth } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import { connectFirestoreEmulator, getFirestore } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js?v=2';

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

const fbApp = initializeApp(LOCAL
  ? { apiKey: 'demo-key', projectId: 'demo-vatime', authDomain: location.host }
  : firebaseConfig);
export const auth = getAuth(fbApp);
export const db = getFirestore(fbApp);
if (LOCAL) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
