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
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const token = authorization.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        const senderUid = decodedToken.uid;

        const { mobile, amount: amountStr, pin } = req.body;
        const amount = parseFloat(amountStr);

        if (!mobile || isNaN(amount) || amount <= 0 || !pin) {
            return res.status(400).json({ message: 'সঠিক তথ্য প্রদান করুন।' });
        }

        // ১. প্রেরকের (Sender) তথ্য আনা
        const senderDocRef = db.doc(`artifacts/${process.env.APP_ID}/users/${senderUid}`);
        const senderDoc = await senderDocRef.get();

        if (!senderDoc.exists) {
            return res.status(404).json({ message: 'ব্যবহারকারী খুঁজে পাওয়া যায়নি।' });
        }

        const senderData = senderDoc.data();

        // নিজের নাম্বারে টাকা পাঠানো চেক
        if (mobile === senderData.mobile) {
            return res.status(400).json({ message: 'আপনি নিজের মোবাইল নম্বরে টাকা পাঠাতে পারবেন না!' });
        }

        // ২. প্রাপকের (Recipient) তথ্য আনা (মোবাইল নম্বর দিয়ে)
        const usersRef = db.collection(`artifacts/${process.env.APP_ID}/users`);
        const q = usersRef.where('mobile', '==', mobile).limit(1);
        const recipientSnapshot = await q.get();

        if (recipientSnapshot.empty) {
            return res.status(404).json({ message: 'প্রাপক খুঁজে পাওয়া যায়নি।' });
        }

        const recipientDocSnapshot = recipientSnapshot.docs[0];
        const recipientData = recipientDocSnapshot.data();
        const recipientUid = recipientDocSnapshot.id;
        const recipientDocRef = usersRef.doc(recipientUid);

        // ৩. কনফিগারেশন থেকে চার্জ আনা
        const configDocRef = db.doc(`artifacts/${process.env.APP_ID}/admin_config/settings`);
        
        // ট্রানজেকশন শুরু
        await db.runTransaction(async (transaction) => {
            const senderT = await transaction.get(senderDocRef);
            const recipientT = await transaction.get(recipientDocRef);
            const configT = await transaction.get(configDocRef);

            if (!senderT.exists || !recipientT.exists) {
                throw new Error('ব্যবহারকারী বা প্রাপক আর বিদ্যমান নেই।');
            }

            const sData = senderT.data();
            const rData = recipientT.data();
            
            // নাম ঠিক করা (Safety Check Added)
            // যদি fullName বা name না থাকে, তবে 'User' ব্যবহার করবে। এতে সাদা পেজ আসবে না।
            const safeSenderName = sData.fullName || sData.name || 'User';
            const safeRecipientName = rData.fullName || rData.name || 'User';

            // চার্জ ক্যালকুলেশন
            let chargeConfig = { percentage: 0, fixed: 0 }; 
            if (configT.exists && configT.data().charges && configT.data().charges.send) {
                chargeConfig = configT.data().charges.send;
            } else {
                 // ফলব্যাক চার্জ (যদি কনফিগারেশন না পাওয়া যায়)
                 chargeConfig = { percentage: 2, fixed: 5 };
            }

            const charge = (amount * chargeConfig.percentage / 100) + chargeConfig.fixed;
            const totalDeduction = amount + charge;
            const currentBalance = sData.balance || 0;

            if (currentBalance < totalDeduction) {
                throw new Error('পর্যাপ্ত ব্যালেন্স নেই (চার্জ সহ)।');
            }

            // পিন যাচাই
            const hashedPin = hashPin(pin);
            if (hashedPin !== sData.hashedPin) {
                throw new Error('পিন সঠিক নয়।');
            }

            // ব্যালেন্স আপডেট
            const newSenderBalance = currentBalance - totalDeduction;
            const newRecipientBalance = (rData.balance || 0) + amount;

            transaction.update(senderDocRef, { balance: newSenderBalance });
            transaction.update(recipientDocRef, { balance: newRecipientBalance });

            // ট্রানজেকশন রেকর্ড তৈরি
            const transactionId = generateTransactionId();
            
            // ইমেইল বের করার চেষ্টা (নিরাপদ উপায়ে)
            let recipientEmail = '';
            try {
                if(rData.email) {
                    recipientEmail = rData.email;
                } else {
                    // ইমেইল না থাকলে ফাঁকা স্ট্রিং থাকবে
                    recipientEmail = ''; 
                }
            } catch (e) {
                recipientEmail = '';
            }
            
            const senderEmail = sData.email || '';

            // প্রেরকের হিস্ট্রি
            const senderTxRef = senderDocRef.collection("transactions").doc();
            transaction.set(senderTxRef, {
                type: 'send', 
                amount, 
                charge, 
                description: `Sent to ${safeRecipientName}`,  // নিরাপদ নাম ব্যবহার করা হয়েছে
                timestamp: admin.firestore.FieldValue.serverTimestamp(), 
                status: 'completed', 
                transactionId,
                senderEmail,
                recipientEmail
            });

            // প্রাপকের হিস্ট্রি
            const recipientTxRef = recipientDocRef.collection("transactions").doc();
            transaction.set(recipientTxRef, {
                type: 'receive', 
                amount, 
                charge: 0, 
                description: `Received from ${safeSenderName}`, // নিরাপদ নাম ব্যবহার করা হয়েছে
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
        // সাদা পেজ এড়াতে নির্দিষ্ট এরর মেসেজ পাঠানো হচ্ছে
        return res.status(400).json({ message: error.message || 'লেনদেন ব্যর্থ হয়েছে। আবার চেষ্টা করুন।' });
    }
}
