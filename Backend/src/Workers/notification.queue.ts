import Queue from 'bull';
import UltraMsgService from '../Services/ultraMsg.service.js';

// Create queue
const notificationQueue = new Queue('notification-sender', process.env.REDIS_URL || 'redis://localhost:6379');

// Job data interface
interface NotificationJob {
    groupId: string;
    patientId: string;
    patientName: string;
    files: {
        link: string;
        mimeType: string;
    }[];
}

// Worker process
notificationQueue.process(async (job) => {
    const { groupId, patientName, files } = job.data as NotificationJob;

    console.log(`[NotificationQueue] Processing job for ${patientName} with ${files.length} files`);

    try {
        // 1. Send Summary Text
        // We send ONE summary message for the entire batch.
        const summary = `*Patient Documents Uploaded*\n\n` +
            `*Patient:* ${patientName}\n` +
            `*Files:* ${files.length} new document(s)`;

        await UltraMsgService.sendMessage(groupId, summary);

        // 2. Send Images
        // We loop through and send each file.
        // UltraMsg/WhatsApp doesn't support "albums" via API in the same way regular users send them,
        // so we send them as individual media messages following the summary.
        for (const [index, file] of files.entries()) {
            // Send without caption to avoid spamming text
            await UltraMsgService.sendMedia(groupId, file.link, file.mimeType);

            // Small delay to ensure order and avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        console.log(`[NotificationQueue] ✓ Completed notification for ${patientName}`);

    } catch (error: any) {
        console.error(`[NotificationQueue] ✗ Failed to send notification:`, error.message);
        throw error; // Triggers Bull retry
    }
});

export default notificationQueue;
