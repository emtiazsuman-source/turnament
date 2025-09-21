// /api/resetPin.js

import admin from 'firebase-admin';

// Firebase initialization (same pattern as other routes)
const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8'));
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// Simple PIN hashing (same as other routes to stay consistent)
function hashPin(pin) {
    let hash = 0;
    for (let i = 0; i < pin.length; i++) {
        const char = pin.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    try {
        // 1) Verify identity via Firebase ID token
        const { authorization } = req.headers;
        if (!authorization || !authorization.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Unauthorized: Missing token.' });
        }
        const token = authorization.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token, true);
        const uid = decodedToken.uid;

        // 2) Ensure recent reauthentication: auth_time must be within last 5 minutes
        const nowSec = Math.floor(Date.now() / 1000);
        if (!decodedToken.auth_time || (nowSec - decodedToken.auth_time) > 300) {
            return res.status(401).json({ message: 'অনুগ্রহ করে আবার আপনার অ্যাকাউন্ট যাচাই করুন (reauthenticate)।' });
        }

        const { newPin } = req.body || {};
        if (!newPin || typeof newPin !== 'string' || newPin.length !== 4) {
            return res.status(400).json({ message: 'নতুন পিন অবশ্যই ৪ সংখ্যার হতে হবে।' });
        }

        const userDocRef = db.collection(`artifacts/${process.env.APP_ID}/users`).doc(uid);
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ message: 'ব্যবহারকারীকে খুঁজে পাওয়া যায়নি।' });
        }

        // 3) Hash and update new PIN
        const newPinHash = hashPin(newPin);
        await userDocRef.update({ pinHash: newPinHash });

        return res.status(200).json({ success: true, message: 'আপনার পিন সফলভাবে রিসেট করা হয়েছে!' });

    } catch (error) {
        console.error('API Error in resetPin:', error);
        return res.status(500).json({ message: 'সার্ভারে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।' });
    }
}