import type { NextFunction,Request, Response } from 'express';
import apiError from './errorHandler.util.js';
import apiResponse from './apiResponse.util.js';

type AsyncHandlerFn = (req: Request, res: Response, next: NextFunction) => Promise<void>;

const asyncHandler = (fn: AsyncHandlerFn) => async (req: Request, res: Response, next: NextFunction) => {
    try {
        return await fn(req, res, next);
    } catch (err : unknown) {
        const error = err instanceof apiError ? err : new apiError(500, 'Internal Server Error');
        console.error('[ERROR]', JSON.stringify(err, null, 2));
        if (err instanceof Error) {
            console.error('[ERROR MESSAGE]', err.message);
        }

        // Standardized error response format
        const errorData = {
            message: error.message,
            ...(error.error && error.error.length > 0 && { errors: error.error }),
            ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
        };

        res.status(error.statusCode || 500).json(
            new apiResponse(error.statusCode, errorData, error.message)
        );
    }
};

export default asyncHandler;
