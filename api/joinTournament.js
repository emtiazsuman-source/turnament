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

// Generate a 9-character transaction ID (same style as other APIs)
function generateTransactionId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 9; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export default async function handler(req, res) {
  // Basic CORS headers and OPTIONS preflight support
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    // Auth check
    const { authorization } = req.headers;
    if (!authorization || !authorization.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized: Missing token.' });
    }
    const token = authorization.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const { postId, idValue, note, screenshotUrl } = req.body || {};

    const appId = process.env.APP_ID;
    if (!appId) {
      return res.status(500).json({ message: 'Server misconfigured: APP_ID missing.' });
    }

    const userRef = db.doc(`artifacts/${appId}/users/${uid}`);
    const postRef = db.doc(`artifacts/${appId}/public/data/posts/${postId}`);
    const participantRef = db.doc(`artifacts/${appId}/public/data/posts/${postId}/participants/${uid}`);

    // PATCH: submit proof (note/screenshot) after joining
    if (req.method === 'PATCH') {
      if (!postId) {
        return res.status(400).json({ message: 'postId দিন।' });
      }
      const [postSnap, participantSnap] = await Promise.all([
        postRef.get(),
        participantRef.get(),
      ]);
      if (!postSnap.exists) {
        return res.status(404).json({ message: 'টুর্নামেন্ট পাওয়া যায়নি।' });
      }
      if (!participantSnap.exists) {
        return res.status(400).json({ message: 'আপনি এই টুর্নামেন্টে জয়েন করেননি।' });
      }
      const payload = {};
      if (typeof note === 'string') payload.note = note.trim() ? note.trim() : null;
      if (typeof screenshotUrl === 'string') payload.screenshotUrl = screenshotUrl.trim() ? screenshotUrl.trim() : null;
      payload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      await participantRef.set(payload, { merge: true });
      return res.status(200).json({ success: true, message: 'প্রুফ সংরক্ষণ করা হয়েছে।' });
    }

    // POST fallback: submit proof (when frontend cannot use PATCH)
    if (req.method === 'POST' && postId && !idValue && (typeof note === 'string' || typeof screenshotUrl === 'string')) {
      const [postSnap, participantSnap] = await Promise.all([
        postRef.get(),
        participantRef.get(),
      ]);
      if (!postSnap.exists) {
        return res.status(404).json({ message: 'টুর্নামেন্ট পাওয়া যায়নি।' });
      }
      if (!participantSnap.exists) {
        return res.status(400).json({ message: 'আপনি এই টুর্নামেন্টে জয়েন করেননি।' });
      }
      const payload = {};
      if (typeof note === 'string') payload.note = note.trim() ? note.trim() : null;
      if (typeof screenshotUrl === 'string') payload.screenshotUrl = screenshotUrl.trim() ? screenshotUrl.trim() : null;
      payload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      await participantRef.set(payload, { merge: true });
      return res.status(200).json({ success: true, message: 'প্রুফ সংরক্ষণ করা হয়েছে।' });
    }

    // POST: join tournament
    if (!postId || !idValue || typeof idValue !== 'string') {
      return res.status(400).json({ message: 'postId এবং idValue সঠিকভাবে দিন।' });
    }

    // Read required docs
    const [userSnap, postSnap, existingParticipantSnap, participantsSnap] = await Promise.all([
      userRef.get(),
      postRef.get(),
      participantRef.get(),
      db.collection(`artifacts/${appId}/public/data/posts/${postId}/participants`).get(),
    ]);

    if (!userSnap.exists) {
      return res.status(404).json({ message: 'ব্যবহারকারী খুঁজে পাওয়া যায়নি।' });
    }
    if (!postSnap.exists) {
      return res.status(404).json({ message: 'টুর্নামেন্ট পাওয়া যায়নি।' });
    }
    if (existingParticipantSnap.exists) {
      return res.status(400).json({ message: 'আপনি ইতোমধ্যে এই টুর্নামেন্টে জয়েন করেছেন।' });
    }

    const userData = userSnap.data() || {};
    const postData = postSnap.data() || {};

    let contestDetails;
    try {
      contestDetails = typeof postData.contestDetails === 'string' ? JSON.parse(postData.contestDetails) : postData.contestDetails || {};
    } catch (e) {
      contestDetails = {};
    }

    if (postData.status !== 'active') {
      return res.status(400).json({ message: 'এই টুর্নামেন্টটি বর্তমানে সক্রিয় নয়।' });
    }

    const maxPlayers = Number(contestDetails?.maxPlayers || 0);
    const entryFee = Number(contestDetails?.entryFee || 0);
    const currentCount = participantsSnap.size;

    if (maxPlayers > 0 && currentCount >= maxPlayers) {
      return res.status(400).json({ message: 'টুর্নামেন্ট পূর্ণ।' });
    }
    if (!Number.isFinite(entryFee) || entryFee <= 0) {
      return res.status(400).json({ message: 'অবৈধ এন্ট্রি ফি।' });
    }

    // Perform atomic updates
    await db.runTransaction(async (tx) => {
      const freshUser = await tx.get(userRef);
      const freshPost = await tx.get(postRef);
      if (!freshUser.exists || !freshPost.exists) {
        throw new Error('ডকুমেন্ট খুঁজে পাওয়া যায়নি।');
      }
      const u = freshUser.data() || {};
      const p = freshPost.data() || {};
      let cd = {};
      try {
        cd = typeof p.contestDetails === 'string' ? JSON.parse(p.contestDetails) : p.contestDetails || {};
      } catch {}

      if (p.status !== 'active') {
        throw new Error('এই টুর্নামেন্টটি বর্তমানে সক্রিয় নয়।');
      }
      const fee = Number(cd.entryFee || 0);
      if (!Number.isFinite(fee) || fee <= 0) {
        throw new Error('অবৈধ এন্ট্রি ফি।');
      }

      const balance = Number(u.balance || 0);
      if (balance < fee) {
        throw new Error('আপনার অ্যাকাউন্টে পর্যাপ্ত ব্যালেন্স নেই।');
      }

      // Deduct balance and add participant
      tx.update(userRef, { balance: balance - fee });

      // Add user transaction entry for tournament join
      const userTxRef = userRef.collection('transactions').doc();
      tx.set(userTxRef, {
        type: 'tournament_join',
        amount: fee,
        charge: 0,
        description: `Joined tournament ${cd.contestName ? cd.contestName : postId}`,
        status: 'completed',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        transactionId: generateTransactionId(),
        metadata: { postId, contestName: cd.contestName || null }
      });

      tx.set(participantRef, {
        userId: uid,
        idValue: String(idValue),
        fullName: u.fullName || u.name || 'User',
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        entryFee: fee,
        // proof fields are set via PATCH/POST proof paths
      });
    });

    return res.status(200).json({ success: true, message: 'সফলভাবে জয়েন করা হয়েছে।' });
  } catch (error) {
    console.error('API Error in joinTournament:', error);
    const msg = error?.message || 'সার্ভারে একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।';
    return res.status(400).json({ message: msg });
  }
}
