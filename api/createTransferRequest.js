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

// ক্লায়েন্ট-সাইডের সাথে মিল রেখে পিন হ্যাশিং ফাংশন
function hashPin(pin) {
    let hash = 0;
    for (let i = 0; i < pin.length; i++) {
        const char = pin.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // 32bit integer এ রূপান্তর
    }
    return hash;
}

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

        const { recipientNumber, amount, method, pin } = req.body;

        // ২. ইনপুট ভ্যালিডেশন
        if (typeof amount !== 'number' || amount <= 0 || !recipientNumber || !pin || pin.length !== 4) {
            return res.status(400).json({ message: 'অনুগ্রহ করে সমস্ত তথ্য সঠিকভাবে পূরণ করুন।' });
        }

        const userDocRef = db.collection(`artifacts/${process.env.APP_ID}/users`).doc(uid);
        const configDocRef = db.doc(`artifacts/${process.env.APP_ID}/admin_config/settings`);

        // ৩. একটি Firestore Transaction এর মাধ্যমে সম্পূর্ণ প্রক্রিয়াটি সম্পন্ন করুন
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userDocRef);
            const configDoc = await transaction.get(configDocRef);

            if (!userDoc.exists) {
                throw new Error('আপনার ব্যবহারকারী প্রোফাইল খুঁজে পাওয়া যায়নি।');
            }
            const userData = userDoc.data();

            // ৪. পিন যাচাই করুন
            if (hashPin(pin) !== userData.pinHash) {
                throw new Error('আপনার পিন সঠিক নয়।');
            }
            
            // ৫. অ্যাডমিন সেটিংস থেকে চার্জ এবং রিজার্ভের তথ্য নিন
            // ❗️❗️ এখানেই সমস্যাটি ছিল এবং এটি সংশোধন করা হয়েছে
            // configDoc.exists() কে পরিবর্তন করে configDoc.exists করা হয়েছে
            const appConfig = configDoc.exists ? configDoc.data() : {};
            const chargeConfig = appConfig.charges?.transfer || { percentage: 0, fixed: 0 };
            const reserveLimit = appConfig.reserve?.[method] || 0;

            // ৬. চার্জ এবং মোট পরিমাণ হিসাব করুন
            const reserveUsed = Math.min(amount, reserveLimit);
            const chargeableAmount = Math.max(0, amount - reserveLimit);
            const percentageCharge = chargeableAmount * (chargeConfig.percentage / 100);
            const totalCharge = chargeConfig.fixed + percentageCharge;
            const totalDeduction = amount + totalCharge;

            if ((userData.balance || 0) < totalDeduction) {
                throw new Error('আপনার অ্যাকাউন্টে পর্যাপ্ত ব্যালেন্স নেই।');
            }

            // ৭. ব্যবহারকারীর ব্যালেন্স আপডেট করুন এবং রিকোয়েস্ট তৈরি করুন
            const newBalance = userData.balance - totalDeduction;
            transaction.update(userDocRef, { balance: newBalance });

            if (reserveUsed > 0) {
                transaction.update(configDocRef, { [`reserve.${method}`]: admin.firestore.FieldValue.increment(-reserveUsed) });
            }

            // প্রথমে ব্যবহারকারীর জন্য ট্রানজেকশন তৈরি করা হচ্ছে
            const userTransactionId = generateTransactionId();
            const userTransactionRef = userDocRef.collection("transactions").doc();
            transaction.set(userTransactionRef, {
                type: 'transfer',
                amount: amount,
                charge: totalCharge,
                description: `Transfer to ${method.toUpperCase()} (${recipientNumber})`,
                status: 'pending',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                transactionId: userTransactionId
            });
            
            // এখন অ্যাডমিনের জন্য রিকোয়েস্ট তৈরি করা হচ্ছে এবং আগের ট্রানজেকশনের আইডি সংরক্ষণ করা হচ্ছে
            const transferRequestRef = db.collection(`artifacts/${process.env.APP_ID}/money_transfer_requests`).doc();
            transaction.set(transferRequestRef, {
                userId: uid,
                amount: amount,
                recipientNumber: recipientNumber,
                method: method,
                status: 'pending',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                charge: totalCharge,
                reserveUsed: reserveUsed,
                userTransactionRefId: userTransactionRef.id
            });
        });

        return res.status(200).json({ success: true, message: 'আপনার ট্রান্সফার রিকোয়েস্ট সফলভাবে জমা হয়েছে।' });

    } catch (error) {
        console.error("API Error in createTransferRequest:", error.message);
        return res.status(400).json({ message: error.message || 'সার্ভারে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।' });
    }
}
