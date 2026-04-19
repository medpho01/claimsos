import Queue from 'bull';
import UltraMsgService from '../Services/ultraMsg.service.js';

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

// Stub queue used when Redis is unavailable
const stubQueue = {
    add: async () => null,
    process: () => {},
    on: () => stubQueue,
} as any;

function createQueue(): Queue.Queue | typeof stubQueue {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const url = new URL(redisUrl);

    const q = new Queue('notification-sender', {
        redis: {
            host: url.hostname,
            port: parseInt(url.port || '6379'),
            retryStrategy: (times: number) => {
                if (times >= 1) return null; // give up after first failure
                return 500;
            },
            enableOfflineQueue: false,
        } as any
    });

    q.on('error', (err: Error) => {
        if ((err as any).code === 'ECONNREFUSED') {
            console.warn('[NotificationQueue] Redis not available — WhatsApp notifications disabled.');
        }
    });

    // Register worker
    q.process(async (job: Queue.Job<NotificationJob>) => {
        const { groupId, patientName, files } = job.data;
        console.log(`[NotificationQueue] Processing job for ${patientName} with ${files.length} files`);

        const summary = `*Patient Documents Uploaded*\n\n` +
            `*Patient:* ${patientName}\n` +
            `*Files:* ${files.length} new document(s)`;

        await UltraMsgService.sendMessage(groupId, summary);

        for (const file of files) {
            await UltraMsgService.sendMedia(groupId, file.link, file.mimeType);
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        console.log(`[NotificationQueue] ✓ Completed notification for ${patientName}`);
    });

    return q;
}

// Swallow unhandled rejections from ioredis on connection failure
process.on('unhandledRejection', (reason: any) => {
    if (reason?.code === 'ECONNREFUSED' || reason?.message?.includes('ECONNREFUSED')) return;
    // re-throw anything else
    console.error('[UnhandledRejection]', reason);
});

const notificationQueue = createQueue();

export default notificationQueue;
