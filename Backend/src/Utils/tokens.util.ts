import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

import type { StringValue } from "ms";
import apiError from './errorHandler.util.js';


const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const ACCESS_TOKEN_EXPIRY: StringValue = (process.env.ACCESS_TOKEN_EXPIRY || '1h') as StringValue;
const REFRESH_TOKEN_EXPIRY_DAYS: number = parseInt(process.env.REFRESH_TOKEN_EXPIRY_DAYS || '7', 10);

export const generateAccessToken = (userId: string,userName : string,role: string) => {
  if (!ACCESS_TOKEN_SECRET) {
    throw new apiError(500,'ACCESS_TOKEN_SECRET is not defined');
  }
  return jwt.sign({ id: userId, userName, role }, ACCESS_TOKEN_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
};

export const generateRefreshToken = () => {
  const token = uuidv4(); 
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

  return { token, expiresAt };
};