import axios, { AxiosError } from 'axios';
import apiError from '../Utils/errorHandler.util.js';

class UltraMsgService {
    private instanceId: string;
    private token: string;
    private baseUrl: string;

    constructor() {
        this.instanceId = process.env.ULTRAMSG_INSTANCE_ID || '';
        this.token = process.env.ULTRAMSG_TOKEN || '';
        this.baseUrl = `https://api.ultramsg.com/${this.instanceId}`;

        if (!this.instanceId || !this.token) {
            console.warn('⚠️ UltraMsg credentials not found in environment variables');
        }
    }

    /**
     * Extracts a clean, concise error message from an Axios error
     * instead of dumping the entire error object to logs.
     */
    private formatError(error: unknown, context: string): string {
        if (error instanceof AxiosError) {
            const status = error.response?.status;
            const apiError = error.response?.data?.error;
            const url = error.config?.url;

            // Detect subscription/payment issues specifically
            if (apiError && typeof apiError === 'string' && apiError.toLowerCase().includes('non-payment')) {
                return `❌ UltraMsg ${context}: Instance stopped due to non-payment. Please renew your UltraMsg subscription.`;
            }

            if (apiError) {
                return `❌ UltraMsg ${context}: [${status}] ${apiError} (${url})`;
            }

            return `❌ UltraMsg ${context}: [${status} ${error.response?.statusText}] ${url}`;
        }

        if (error instanceof Error) {
            return `❌ UltraMsg ${context}: ${error.message}`;
        }

        return `❌ UltraMsg ${context}: Unknown error`;
    }

    async sendImage(to: string, imagePath: string, caption: string = ''): Promise<any> {
        try {
            if (!this.instanceId || !this.token) {
                console.warn('⚠️ Skipping WhatsApp send: UltraMsg credentials missing');
                return null;
            }
            const delay = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
            for(let i = 1;i<=8;i++){
                const res = await fetch(imagePath);
                if(res.status>=400){
                    await delay(2000*i);
                }else{                    
                    const response = await axios.post(
                        `${this.baseUrl}/messages/image`,
                        new URLSearchParams({
                            token: this.token,
                            to: to,
                            image: imagePath,
                            caption: caption
                        }),
                        {
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                        }
                    );
                }
                
            }
            return null;
        } catch (error) {
            console.error(this.formatError(error, 'Image'));
            return null;
        }
    }

    async sendDocument(to: string, documentUrl: string, filename: string = 'document.pdf', caption: string = ''): Promise<any> {
        try {
            if (!this.instanceId || !this.token) {
                console.warn('⚠️ Skipping WhatsApp send: UltraMsg credentials missing');
                return null;
            }

            const response = await axios.post(
                `${this.baseUrl}/messages/document`,
                new URLSearchParams({
                    token: this.token,
                    to: to,
                    document: documentUrl,
                    filename: filename,
                    caption: caption
                }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );
            return response.data;
        } catch (error) {
            console.error(this.formatError(error, 'Document'));
            return null;
        }
    }

    async sendMedia(to: string, fileUrl: string, filename: string, caption: string = ''): Promise<any> {
        const isPdf = filename.toLowerCase().endsWith('/pdf');

        if (isPdf) {
            return this.sendDocument(to, fileUrl);
        } else {
            return this.sendImage(to, fileUrl);
        }
    }

    async sendMessage(to: string, body: string): Promise<any> {
        try {
            if (!this.instanceId || !this.token) return null;

            const response = await axios.post(
                `${this.baseUrl}/messages/chat`,
                new URLSearchParams({
                    token: this.token,
                    to: to,
                    body: body
                }),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            );
            return response.data;
        } catch (error) {
            console.error(this.formatError(error, 'Message'));
            return null;
        }
    }
}

export default new UltraMsgService();
