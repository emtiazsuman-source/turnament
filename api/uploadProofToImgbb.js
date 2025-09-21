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

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const { authorization } = req.headers;
    if (!authorization || !authorization.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized: Missing token.' });
    }
    const token = authorization.split('Bearer ')[1];
    await admin.auth().verifyIdToken(token);

    const { imageBase64, expiration } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ message: 'imageBase64 দিতে হবে।' });
    }

    const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
    if (!IMGBB_API_KEY) {
      return res.status(500).json({ message: 'Server misconfigured: IMGBB_API_KEY missing.' });
    }

    // Build form-data for imgbb
    const form = new FormData();
    form.append('image', imageBase64);
    const url = new URL('https://api.imgbb.com/1/upload');
    url.searchParams.set('key', IMGBB_API_KEY);
    if (expiration && Number.isFinite(Number(expiration))) {
      url.searchParams.set('expiration', String(expiration));
    }

    const resp = await fetch(url.toString(), {
      method: 'POST',
      body: form,
    });
    const data = await resp.json();
    if (!resp.ok || !data?.success) {
      const msg = data?.error?.message || 'imgbb আপলোড ব্যর্থ';
      return res.status(400).json({ message: msg, raw: data });
    }

    const outUrl = data?.data?.display_url || data?.data?.url || null;
    if (!outUrl) {
      return res.status(500).json({ message: 'imgbb সফল হলেও URL পাওয়া যায়নি।' });
    }

    return res.status(200).json({ success: true, url: outUrl, data: data?.data });
  } catch (e) {
    console.error('uploadProofToImgbb error:', e);
    return res.status(400).json({ message: e?.message || 'একটি ত্রুটি হয়েছে।' });
  }
}
