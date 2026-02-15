import UltraMsgService from './ultraMsg.service.js';
import notificationQueue from '../Workers/notification.queue.js';

interface BufferedFile {
    link: string;
    mimeType: string;
}

interface BufferEntry {
    timer: NodeJS.Timeout;
    files: BufferedFile[];
    patientName: string;
    group_id: string;
    patientId: string;
}

class NotificationBufferService {
    private buffer: Map<string, BufferEntry> = new Map();

    /**
     * Adds a file to the notification buffer.
     * @param groupId The WhatsApp group ID (Hospital Panel ID)
     * @param patientId The Patient ID (to group by patient)
     * @param patientName The Patient's Name for the summary
     * @param fileInfo File link and mimeType
     */
    add(groupId: string, patientId: string, patientName: string, fileInfo: BufferedFile) {
        const key = `${groupId}:${patientId}`;

        if (!this.buffer.has(key)) {
            console.log(`[NotificationBuffer] Started new batch for patient: ${patientName}`);
            this.buffer.set(key, {
                timer: setTimeout(() => this.flush(key), 60000), // Initial 60s wait (safety net)
                files: [],
                patientName,
                group_id: groupId,
                patientId
            });
        }

        const entry = this.buffer.get(key)!;
        entry.files.push(fileInfo);

        // Debounce: Reset timer on every new file to wait for the whole batch
        // Increased to 60s timeout as a safety net (primary trigger is per-patient completion)
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.flush(key), 60000); // Wait 60s after LAST file
    }

    /**
     * Check and immediately flush notifications for a specific patient
     * Called when upload queue detects all files for this patient are done
     */
    checkAndFlushForPatient(groupId: string, patientId: string) {
        const key = `${groupId}:${patientId}`;

        if (this.buffer.has(key)) {
            const entry = this.buffer.get(key)!;
            console.log(`[NotificationBuffer] Triggering immediate flush for ${entry.patientName} | Files: ${entry.files.length}`);
            clearTimeout(entry.timer);
            this.flush(key);
        }
    }

    async flush(key: string) {
        const entry = this.buffer.get(key);
        if (!entry) return;

        this.buffer.delete(key);
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[NotificationBuffer] Queuing WHATSAPP NOTIFICATION`);
        console.log(`Patient: ${entry.patientName}`);
        console.log(`Files: ${entry.files.length} document(s)`);
        console.log(`${'='.repeat(60)}\n`);

        try {
            // Add to Redis Queue
            await notificationQueue.add({
                groupId: entry.group_id,
                patientId: entry.patientId,
                patientName: entry.patientName,
                files: entry.files
            }, {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000
                },
                removeOnComplete: true
            });

        } catch (error) {
            console.error(`[NotificationBuffer] Failed to queue notification for ${key}:`, error);
        }
    }
}

export default new NotificationBufferService();
