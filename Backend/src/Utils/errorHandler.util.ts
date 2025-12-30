class apiError extends Error{
    statusCode: number;
    data: null;
    success: boolean;
    error: []|undefined;
    
    constructor(
        statusCode:number,
        message:string = "Something went wrong",
        error : [] = [],
        stack : string = "",
    ){
        super(message);
        this.statusCode = statusCode;
        this.data = null;
        this.message = message;
        this.success = false;
        this.error = error;

        if (stack) {
            this.stack = stack;
        } else {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

export default apiError;