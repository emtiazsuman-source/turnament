import admin from 'firebase-admin';

// Vercel Environment Variables থেকে আপনার সার্ভিস অ্যাকাউন্ট কী লোড করুন
const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8')
);

// Firebase Admin অ্যাপটি শুধু একবার ইনিশিয়ালাইজ করুন
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

// আপনার পছন্দের সঠিক ৯ ডিজিটের ট্রানজেকশন আইডি তৈরির ফাংশন
function generateTransactionId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 9; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Vercel ফাংশনের মূল হ্যান্ডলার
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    try {
        // ১. ব্যবহারকারীর পরিচয় যাচাই করুন
        const { authorization } = req.headers;
        if (!authorization || !authorization.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Unauthorized: Missing token.' });
        }
        const token = authorization.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;

        const { amount, txId, senderNumber, recipientAdminNumber, method } = req.body;

        // ২. ইনপুট ভ্যালিডেশন
        if (typeof amount !== 'number' || amount <= 0 || !txId || !senderNumber) {
            return res.status(400).json({ message: 'অনুগ্রহ করে সমস্ত তথ্য সঠিকভাবে পূরণ করুন।' });
        }

        const requestsRef = db.collection(`artifacts/${process.env.APP_ID}/add_money_requests`);
        
        // ৩. সার্ভার থেকে TrxID ডুপ্লিকেট কি না তা নিরাপদে চেক করুন
        const snapshot = await requestsRef.where('txId', '==', txId).get();
        let isTxIdInUse = false;
        snapshot.forEach(doc => {
            const requestStatus = doc.data().status;
            if (requestStatus === 'pending' || requestStatus === 'completed') {
                isTxIdInUse = true;
            }
        });

        if (isTxIdInUse) {
            return res.status(400).json({ message: 'এই ট্রানজেকশন টি ইতিমধ্যে বিদ্যমান।' });
        }

        // ৪. রিকোয়েস্ট এবং ব্যবহারকারীর জন্য ট্রানজেকশন ডকুমেন্ট তৈরি করুন
        const userTransactionId = generateTransactionId();
        const userTxCollectionRef = db.collection(`artifacts/${process.env.APP_ID}/users/${uid}/transactions`);
        
        const newUserTxDoc = await userTxCollectionRef.add({
            type: 'deposit',
            amount: amount,
            charge: 0,
            description: `Deposit via ${method.toUpperCase()}`,
            status: 'pending',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            transactionId: userTransactionId
        });
        
        await requestsRef.add({
            userId: uid,
            amount: amount,
            txId: txId,
            method: method,
            senderNumber: senderNumber,
            recipientAdminNumber: recipientAdminNumber,
            status: 'pending',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            transactionRef: newUserTxDoc.id // ব্যবহারকারীর ট্রানজেকশনের রেফারেন্স
        });

        return res.status(200).json({ success: true, message: 'আপনার অ্যাড মানি রিকোয়েস্ট সফলভাবে জমা হয়েছে।' });

    } catch (error) {
        console.error("API Error in createAddMoneyRequest:", error.message);
        return res.status(500).json({ message: error.message || 'সার্ভারে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।' });
    }
}
