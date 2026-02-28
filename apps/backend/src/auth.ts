import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Context } from "hono";
import type { AppEnv } from "./types";

export type AuthContext = {
  isAuthenticated: boolean;
  userId: string | null;
  verifiedEmails: string[];
  primaryEmail: string | null;
  firstName: string | null;
  lastName: string | null;
};

let clerkClientSingleton: ReturnType<typeof createClerkClient> | null = null;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function getBearerToken(c: Context<AppEnv>): string | null {
  const authorization = c.req.header("authorization");
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token;
}

function clerkClient(secretKey: string) {
  if (!clerkClientSingleton) {
    clerkClientSingleton = createClerkClient({ secretKey });
  }

  return clerkClientSingleton;
}

export async function getAuthContext(c: Context<AppEnv>): Promise<AuthContext> {
  const token = getBearerToken(c);
  const secretKey = c.env.CLERK_SECRET_KEY;

  if (!token || !secretKey) {
    return {
      isAuthenticated: false,
      userId: null,
      verifiedEmails: [],
      primaryEmail: null,
      firstName: null,
      lastName: null,
    };
  }

  try {
    const payload = await verifyToken(token, { secretKey });
    const userId = payload.sub;

    if (!userId) {
      return {
        isAuthenticated: false,
        userId: null,
        verifiedEmails: [],
        primaryEmail: null,
        firstName: null,
        lastName: null,
      };
    }

    const user = await clerkClient(secretKey).users.getUser(userId);
    const verifiedEmails = user.emailAddresses
      .filter((email) => email.verification?.status === "verified")
      .map((email) => normalizeEmail(email.emailAddress));

    const uniqueVerifiedEmails = Array.from(new Set(verifiedEmails));
    const primaryEmail =
      user.primaryEmailAddressId === null
        ? null
        : (user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)
            ?.emailAddress ?? null);

    return {
      isAuthenticated: true,
      userId,
      verifiedEmails: uniqueVerifiedEmails,
      primaryEmail: primaryEmail ? normalizeEmail(primaryEmail) : uniqueVerifiedEmails[0] ?? null,
      firstName: user.firstName?.trim() || null,
      lastName: user.lastName?.trim() || null,
    };
  } catch {
    return {
      isAuthenticated: false,
      userId: null,
      verifiedEmails: [],
      primaryEmail: null,
      firstName: null,
      lastName: null,
    };
  }
}
