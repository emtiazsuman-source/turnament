// /api/setupPin.js

import admin from 'firebase-admin';

// Firebase ইনিশিয়ালাইজেশন... (আগের মতোই)
const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8'));
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// পিন হ্যাশিং ফাংশন
function hashPin(pin) {
    let hash = 0;
    for (let i = 0; i < pin.length; i++) {
        const char = pin.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return hash;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    try {
        // ১. ব্যবহারকারীর পরিচয় যাচাই
        const { authorization } = req.headers;
        if (!authorization || !authorization.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Unauthorized: Missing token.' });
        }
        const token = authorization.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;

        const { newPin } = req.body;

        if (!newPin || newPin.length !== 4) {
            return res.status(400).json({ message: 'নতুন পিন অবশ্যই ৪ সংখ্যার হতে হবে।' });
        }

        const userDocRef = db.collection(`artifacts/${process.env.APP_ID}/users`).doc(uid);
        const userDoc = await userDocRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: 'ব্যবহারকারীকে খুঁজে পাওয়া যায়নি।' });
        }

        const userData = userDoc.data();

        // ২. চেক করুন পিন আগে থেকেই সেট করা আছে কি না
        // আমরা ধরে নিচ্ছি যে নতুন ব্যবহারকারীর pinHash এর মান 0
        if (userData.pinHash && userData.pinHash !== 0) {
            return res.status(400).json({ message: 'আপনার পিন ইতিমধ্যেই সেট করা আছে। পিন পরিবর্তন মেনু ব্যবহার করুন।' });
        }
        
        // ৩. নতুন পিন হ্যাশ করে সেভ করুন
        const newPinHash = hashPin(newPin);
        await userDocRef.update({ pinHash: newPinHash });

        return res.status(200).json({ success: true, message: 'আপনার পিন সফলভাবে সেট করা হয়েছে!' });

    } catch (error) {
        console.error("API Error in setupPin:", error.message);
        return res.status(500).json({ message: 'সার্ভারে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।' });
    }
}
