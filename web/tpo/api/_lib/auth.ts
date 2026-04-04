import { getAuth } from "firebase-admin/auth";
import { getAdminApp } from "./firebaseAdmin.js";

function getBearerToken(req: any): string | null {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h) return null;
  const raw = Array.isArray(h) ? h[0] : h;
  const match = /^Bearer\s+(.+)$/.exec(raw);
  return match?.[1] ?? null;
}

export async function requireUser(req: any) {
  const token = getBearerToken(req);
  if (!token) throw new Error("Missing Authorization token");

  const auth = getAuth(getAdminApp());
  const decoded = await auth.verifyIdToken(token);

  return {
    uid: decoded.uid,
    email: decoded.email || null,
    name: decoded.name || null,
  };
}
