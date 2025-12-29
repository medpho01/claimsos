class apiResponse {
    statusCode: number
    data:null
    message:string
    success: boolean
    constructor(statusCode : number, data:any, message : string = "success") {
        this.statusCode = statusCode;
        this.data = data;
        this.message = message;
        this.success = statusCode < 400;
    }
}
export default apiResponse;
