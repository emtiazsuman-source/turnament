import admin from 'firebase-admin';

// আপনার সার্ভিস অ্যাকাউন্ট কী লোড করুন (sendMoney.js এর মতোই)
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

        // ২. ক্লায়েন্টের কাছ থেকে নতুন তথ্য নিন
        const { name, dob, mobile, pin } = req.body;

        // সাধারণ ইনপুট ভ্যালিডেশন
        if (!name || !mobile || !pin || pin.length !== 4) {
            return res.status(400).json({ message: 'Invalid input provided.' });
        }
        
        const usersRef = db.collection(`artifacts/${process.env.APP_ID}/users`);

        // ৩. মোবাইল নম্বরটি ইউনিক কি না তা সার্ভার থেকে চেক করুন
        const snapshot = await usersRef.where('mobile', '==', mobile).get();
        
        let mobileExists = false;
        snapshot.forEach(doc => {
            if (doc.id !== uid) {
                mobileExists = true; // নম্বরটি পাওয়া গেছে এবং এটি অন্য কোনো ব্যবহারকারীর
            }
        });

        if (mobileExists) {
            return res.status(400).json({ message: 'এই মোবাইল নম্বরটি ইতিমধ্যেই ব্যবহার করা হয়েছে।' });
        }

        // ৪. ব্যবহারকারীর পিন যাচাই করুন
        const userDocRef = usersRef.doc(uid);
        const userDoc = await userDocRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const userData = userDoc.data();
        
        // ক্লায়েন্ট-সাইডের সাথে মিল রেখে পিন হ্যাশিং ফাংশন
        let hash = 0;
        for (let i = 0; i < pin.length; i++) {
            const char = pin.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }

        if (hash !== userData.pinHash) {
            return res.status(400).json({ message: 'আপনার পিন সঠিক নয়।' });
        }

        // ৫. সবকিছু ঠিক থাকলে, প্রোফাইল আপডেট করুন
        await userDocRef.update({
            name: name,
            dob: dob,
            mobile: mobile
            // এখানে পিন হ্যাশ আপডেট করা হচ্ছে না কারণ পিন শুধু ভেরিফিকেশনের জন্য
        });

        return res.status(200).json({ success: true, message: 'প্রোফাইল সফলভাবে আপডেট হয়েছে!' });

    } catch (error) {
        console.error("API Error:", error.message);
        return res.status(500).json({ message: 'সার্ভারে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।' });
    }
}
