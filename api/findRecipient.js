import admin from 'firebase-admin';

// সার্ভিস অ্যাকাউন্ট কী লোড করুন
const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8')
);

// Firebase Admin অ্যাপ ইনিশিয়ালাইজ করুন
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    try {
        // ব্যবহারকারীর পরিচয় যাচাই করুন
        const { authorization } = req.headers;
        if (!authorization || !authorization.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Unauthorized: Missing token.' });
        }

        const token = authorization.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const senderUid = decodedToken.uid;

        const { recipientId } = req.body; // ক্লায়েন্ট থেকে পাঠানো সার্চ ইনপুট

        if (!recipientId) {
            return res.status(400).json({ message: 'Recipient identifier is required.' });
        }

        const usersRef = db.collection(`artifacts/${process.env.APP_ID}/users`);
        let query;

        // কী দিয়ে খোঁজা হচ্ছে তা নির্ধারণ করুন
        if (recipientId.includes('@')) {
            query = usersRef.where('email', '==', recipientId);
        } else if (!isNaN(recipientId) && recipientId.length > 5) {
            query = usersRef.where('mobile', '==', recipientId);
        } else {
            // যদি UID দিয়ে খোঁজা হয়
            const doc = await usersRef.doc(recipientId).get();
            if (doc.exists) {
                 if (doc.id === senderUid) {
                    return res.status(400).json({ message: 'আপনি নিজের কাছে টাকা পাঠাতে পারবেন না।' });
                }
                const userData = doc.data();
                return res.status(200).json({ uid: doc.id, name: userData.name, mobile: userData.mobile });
            } else {
                 return res.status(404).json({ message: 'প্রাপককে খুঁজে পাওয়া যায়নি।' });
            }
        }

        const snapshot = await query.get();

        if (snapshot.empty) {
            return res.status(404).json({ message: 'প্রাপককে খুঁজে পাওয়া যায়নি।' });
        }

        const recipientDoc = snapshot.docs[0];
        
        // প্রেরক এবং প্রাপক একই ব্যক্তি কি না তা চেক করুন
        if (recipientDoc.id === senderUid) {
            return res.status(400).json({ message: 'আপনি নিজের কাছে টাকা পাঠাতে পারবেন না।' });
        }
        
        const recipientData = recipientDoc.data();

        // প্রাপকের প্রয়োজনীয় তথ্য ক্লায়েন্টকে ফেরত পাঠান
        return res.status(200).json({
            uid: recipientDoc.id,
            name: recipientData.name,
            mobile: recipientData.mobile
        });

    } catch (error) {
        console.error("API Error:", error.message);
        if (error.code === 'auth/id-token-expired') {
            return res.status(401).json({ message: 'Session expired, please login again.' });
        }
        return res.status(500).json({ message: 'সার্ভারে একটি সমস্যা হয়েছে।' });
    }
}
