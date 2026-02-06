import UltraMsgService from './ultraMsg.service.js';

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
                timer: setTimeout(() => this.flush(key), 30000), // Initial 30s wait (safety net)
                files: [],
                patientName,
                group_id: groupId,
                patientId
            });
        }

        const entry = this.buffer.get(key)!;
        entry.files.push(fileInfo);

        // Debounce: Reset timer on every new file to wait for the whole batch
        // Increased to 30s timeout as a safety net (primary trigger is per-patient completion)
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.flush(key), 30000); // Wait 30s after LAST file
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
        console.log(`[NotificationBuffer] SENDING WHATSAPP NOTIFICATION`);
        console.log(`Patient: ${entry.patientName}`);
        console.log(`Files: ${entry.files.length} document(s)`);
        console.log(`${'='.repeat(60)}\n`);

        try {
            // 1. Send Summary Text
            const summary = `*Patient Documents Uploaded*\n\n` +
                `*Patient:* ${entry.patientName}\n` +
                `*Files:* ${entry.files.length} new document(s)`;

            await UltraMsgService.sendMessage(entry.group_id, summary);

            // 2. Send Images (throttled to avoid ordering issues or rate limits)
            for (const [index, file] of entry.files.entries()) {
                // Send without caption to avoid spam
                await UltraMsgService.sendMedia(entry.group_id, file.link, file.mimeType);

                // Small delay between media items
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            console.error(`[NotificationBuffer] Failed to flush notifications for ${key}:`, error);
        }
    }
}

export default new NotificationBufferService();
