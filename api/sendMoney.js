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

// ক্লায়েন্ট-সাইডের সাথে মিল রেখে পিন হ্যাশিং ফাংশন
function hashPin(pin) {
    let hash = 0;
    for (let i = 0; i < pin.length; i++) {
        const char = pin.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

// Vercel ফাংশনের মূল হ্যান্ডলার
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    try {
        const { authorization } = req.headers;
        if (!authorization || !authorization.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Unauthorized: Missing token.' });
        }

        const token = authorization.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const senderUid = decodedToken.uid;
        const senderEmail = decodedToken.email || '';

        const { recipientUid, amount, pin } = req.body;

        if (!recipientUid || typeof amount !== 'number' || amount <= 0 || !pin || pin.length !== 4) {
            return res.status(400).json({ message: 'Invalid input provided.' });
        }

        if (senderUid === recipientUid) {
            return res.status(400).json({ message: 'You cannot send money to yourself.' });
        }
        
        const senderDocRef = db.collection(`artifacts/${process.env.APP_ID}/users`).doc(senderUid);
        const recipientDocRef = db.collection(`artifacts/${process.env.APP_ID}/users`).doc(recipientUid);

        await db.runTransaction(async (transaction) => {
            const senderDoc = await transaction.get(senderDocRef);
            const recipientDoc = await transaction.get(recipientDocRef);
            
            if (!senderDoc.exists || !recipientDoc.exists) {
                throw new Error("প্রাপককে খুঁজে পাওয়া যায়নি।");
            }

            const senderData = senderDoc.data();
            const recipientData = recipientDoc.data();

            if (hashPin(pin) !== senderData.pinHash) {
                throw new Error("আপনার পিন সঠিক নয়।");
            }

            // ❗️❗️❗️ এই অংশটি সংশোধন করা হয়েছে ❗️❗️❗️
            // সার্ভার-সাইডের জন্য সঠিক কোড ব্যবহার করে চার্জের তথ্য আনা হচ্ছে
            const configDocRef = db.doc(`artifacts/${process.env.APP_ID}/admin_config/settings`);
            const configDoc = await transaction.get(configDocRef);
            const chargeConfig = configDoc.exists ? configDoc.data().charges.send : { percentage: 2, fixed: 5 };
            
            const charge = (amount * chargeConfig.percentage / 100) + chargeConfig.fixed;
            const totalDeduction = amount + charge;

            if ((senderData.balance || 0) < totalDeduction) {
                throw new Error("আপনার অ্যাকাউন্টে পর্যাপ্ত ব্যালেন্স নেই।");
            }

            const newSenderBalance = senderData.balance - totalDeduction;
            const newRecipientBalance = (recipientData.balance || 0) + amount;
            
            transaction.update(senderDocRef, { balance: newSenderBalance });
            transaction.update(recipientDocRef, { balance: newRecipientBalance });
            
            const transactionId = generateTransactionId();
            
            // Lookup recipient email using Admin SDK (outside Firestore user doc)
            let recipientEmail = '';
            try {
                const recUser = await admin.auth().getUser(recipientUid);
                recipientEmail = recUser.email || '';
            } catch (e) {
                recipientEmail = '';
            }

            const senderTxRef = senderDocRef.collection("transactions").doc();
            transaction.set(senderTxRef, {
                type: 'send', 
                amount, 
                charge, 
                description: `Sent to ${recipientData.name}`, 
                timestamp: admin.firestore.FieldValue.serverTimestamp(), 
                status: 'completed', 
                transactionId,
                senderEmail,
                recipientEmail
            });

            const recipientTxRef = recipientDocRef.collection("transactions").doc();
            transaction.set(recipientTxRef, {
                type: 'receive', 
                amount, 
                charge: 0, 
                description: `Received from ${senderData.name}`,
                timestamp: admin.firestore.FieldValue.serverTimestamp(), 
                status: 'received', 
                transactionId,
                senderEmail,
                recipientEmail
            });
        });

        return res.status(200).json({ success: true, message: `৳ ${amount} সফলভাবে পাঠানো হয়েছে!` });

    } catch (error) {
        console.error("API Error:", error.message);
        return res.status(400).json({ message: error.message || 'লেনদেন ব্যর্থ হয়েছে। আবার চেষ্টা করুন।' });
    }
}
