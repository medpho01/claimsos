import axios from 'axios';
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

    async sendImage(to: string, imagePath: string, caption: string = ''): Promise<any> {
        try {
            if (!this.instanceId || !this.token) {
                console.warn('⚠️ Skipping WhatsApp send: UltraMsg credentials missing');
                return null;
            }

            // UltraMsg expects an image URL or base64. 
            // Since our image is local (and maybe not public if behind firewall), 
            // we might need to send it as a document or ensure it's accessible.
            // However, UltraMsg supports sending files via multipart/form-data essentially if using their libraries, 
            // but via raw API it usually takes a URL or base64.
            // For this implementation, let's assume we can upload the file using their upload API or just send the Drive Link if we have it?
            // The prompt says "sent that images... goes to hospital groups".

            // If the image is locally stored in src/public, we can't easily give a URL to UltraMsg unless we tunnel.
            // BUT, we just uploaded it to Google Drive! We have a webViewLink or webContentLink from Drive.
            // Sending the Drive Link is the most reliable way if the local server isn't public.
            // Let's assume we want to send the actual image. 
            // If so, we need to pass the Google Drive direct link which might work if public.

            // Alternatively, we can use the 'image' endpoint of UltraMsg with a URL.
            // Let's try to send the Google Drive link as the image source, or just the link as text if that fails.

            // Wait, standard usage for "uploading" to WhatsApp usually implies sending the media.
            // Let's accept a public URL (from Drive) for now.

            const response = await axios.post(
                `${this.baseUrl}/messages/image`,
                new URLSearchParams({
                    token: this.token,
                    to: to,
                    image: imagePath, // This should be a URL
                    caption: caption
                }),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            );

            return response.data;
        } catch (error) {
            console.error('❌ UltraMsg Error:', error);
            // Don't throw, just log, so we don't break the response to frontend
            return null;
        }
    }

    // Helper to send text (fallback)
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
            console.error('❌ UltraMsg Message Error:', error);
            return null;
        }
    }
}

export default new UltraMsgService();
