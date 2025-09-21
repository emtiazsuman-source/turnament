import admin from 'firebase-admin';

// Initialize Firebase Admin using Vercel env var FIREBASE_SERVICE_ACCOUNT_BASE64
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8')
);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// Generate a 9-character transaction ID (consistent with other APIs)
function generateTransactionId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 9; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

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
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const appId = process.env.APP_ID;
    if (!appId) {
      return res.status(500).json({ message: 'Server misconfigured: APP_ID missing.' });
    }

    const { postId, winners } = req.body || {};
    if (!postId || !Array.isArray(winners)) {
      return res.status(400).json({ message: 'postId এবং winners প্রদান করুন।' });
    }

    // Verify admin role
    const adminUserSnap = await db.doc(`artifacts/${appId}/users/${uid}`).get();
    if (!adminUserSnap.exists || adminUserSnap.data()?.isAdmin !== true) {
      return res.status(403).json({ message: 'এই অপারেশনটি শুধুমাত্র অ্যাডমিন করতে পারবেন।' });
    }

    // Sanitize winners
    const sanitized = winners
      .map(w => ({ userId: String(w.userId || ''), amount: Number(w.amount), adminNote: String(w.adminNote || '') }))
      .filter(w => w.userId && Number.isFinite(w.amount) && w.amount > 0);

    if (sanitized.length === 0) {
      return res.status(400).json({ message: 'কমপক্ষে একজন বৈধ বিজয়ী প্রদান করুন।' });
    }

    const postRef = db.doc(`artifacts/${appId}/public/data/posts/${postId}`);

    await db.runTransaction(async (tx) => {
      // --- ধাপ ১: সমস্ত Read অপারেশন একসাথে করা ---
      const postSnap = await tx.get(postRef);
      if (!postSnap.exists) {
        throw new Error('টুর্নামেন্ট পাওয়া যায়নি।');
      }
      const postData = postSnap.data() || {};
      if (postData.status === 'prizes_distributed') {
        throw new Error('এই টুর্নামেন্টের পুরস্কার ইতিমধ্যে বিতরণ করা হয়েছে।');
      }

      // সব বিজয়ীর ইউজার ডকুমেন্ট একসাথে পড়ুন
      const userRefs = sanitized.map(w => db.doc(`artifacts/${appId}/users/${w.userId}`));
      const userSnaps = await tx.getAll(...userRefs);
      
      // --- ধাপ ২: সমস্ত Write অপারেশন একসাথে করা ---

      // Extract contest name for transaction descriptions if available
      let contestName = null;
      try {
        const cd = typeof postData.contestDetails === 'string' ? JSON.parse(postData.contestDetails) : (postData.contestDetails || {});
        contestName = cd.contestName || cd.gameName || null;
      } catch {}

      // এখন ডেটা আপডেট করুন
      for (let i = 0; i < sanitized.length; i++) {
        const winner = sanitized[i];
        const userSnap = userSnaps[i];
        
        if (!userSnap.exists) {
          console.warn(`Skipping non-existent user: ${winner.userId}`);
          continue;
        }

        const userRef = userSnap.ref;
        const currentBalance = Number(userSnap.data()?.balance || 0);
        tx.update(userRef, { balance: currentBalance + winner.amount });

        // Create a transaction record for the prize credit
        const userTxRef = userRef.collection('transactions').doc();
        tx.set(userTxRef, {
          type: 'tournament_prize',
          amount: winner.amount,
          charge: 0,
          description: `Tournament prize${contestName ? ` - ${contestName}` : ''}`,
          status: 'received',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          transactionId: generateTransactionId(),
          metadata: { postId, contestName, adminNote: winner.adminNote }
        });
      }

      // সবশেষে পোস্টের স্ট্যাটাস আপডেট করুন
      tx.update(postRef, {
        status: 'prizes_distributed',
        pendingPrizes: {},
        pendingNotes: {} // pendingNotes ও খালি করে দিন
      });
    });

    return res.status(200).json({ success: true, message: `${sanitized.length} জন বিজয়ীকে সফলভাবে পুরস্কার প্রদান করা হয়েছে!` });
  } catch (error) {
    console.error('API Error in distributePrizes:', error);
    const msg = error?.message || 'সার্ভারে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।';
    return res.status(400).json({ message: msg });
  }
}
