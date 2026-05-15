import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

import type { StringValue } from "ms";
import apiError from './errorHandler.util.js';


const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const ACCESS_TOKEN_EXPIRY: StringValue = (process.env.ACCESS_TOKEN_EXPIRY || '1h') as StringValue;
const REFRESH_TOKEN_EXPIRY_DAYS: number = parseInt(process.env.REFRESH_TOKEN_EXPIRY_DAYS || '7', 10);

/**
 * Prod-readiness #2: optional `deviceId` claim carried in the access token.
 * When present, the refresh path can look the matching `user_refresh_tokens`
 * row up by `(user_id, device_id)` via the unique index from migration 011
 * instead of bcrypt-scanning every row for the user. Backwards-compatible:
 * tokens minted before this change have no deviceId; refreshAccessToken
 * falls back to the old O(N) scan for those.
 */
export const generateAccessToken = (
  userId: string,
  userName: string,
  deviceId?: string,
) => {
  if (!ACCESS_TOKEN_SECRET) {
    throw new apiError(500,'ACCESS_TOKEN_SECRET is not defined');
  }
  const payload: Record<string, unknown> = { id: userId, userName };
  if (deviceId) payload.deviceId = deviceId;
  return jwt.sign(payload, ACCESS_TOKEN_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
};

export const generateRefreshToken = () => {
  const token = uuidv4(); 
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

  return { token, expiresAt };
};