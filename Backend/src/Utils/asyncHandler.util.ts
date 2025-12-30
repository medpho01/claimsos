import type { NextFunction,Request, Response } from 'express';
import apiError from './errorHandler.util.js';
import apiResponse from './apiResponse.util.js';

type AsyncHandlerFn = (req: Request, res: Response, next: NextFunction) => Promise<void>;

const asyncHandler = (fn: AsyncHandlerFn) => async (req: Request, res: Response, next: NextFunction) => {
    try {
        return await fn(req, res, next);
    } catch (err : unknown) {
        const error = err instanceof apiError ? err : new apiError(500, 'Internal Server Error');
        console.log(err);
        res.status(error.statusCode || 500).json(new apiResponse(error.statusCode,{},error.message));
    }
};

export default asyncHandler;
