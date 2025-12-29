import type { NextFunction,Request, Response } from 'express';
import apiError from './errorHandler.util.js';

type AsyncHandlerFn = (req: Request, res: Response, next: NextFunction) => Promise<void>;

const asyncHandler = (fn: AsyncHandlerFn) => async (req: Request, res: Response, next: NextFunction) => {
    try {
        return await fn(req, res, next);
    } catch (err) {
        res.status(500).json(new apiError(500,"Something went wrong from server side"));
    }
};

export default asyncHandler;
