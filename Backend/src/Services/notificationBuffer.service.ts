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
            console.log(`[NotificationBuffer] Starting new batch for ${patientName} (Group: ${groupId})`);
            this.buffer.set(key, {
                timer: setTimeout(() => this.flush(key), 10000), // Initial 10s wait
                files: [],
                patientName,
                group_id: groupId,
                patientId
            });
        }

        const entry = this.buffer.get(key)!;
        entry.files.push(fileInfo);

        // Debounce: Reset timer on every new file to wait for the whole batch
        // But cap it at some point? For now, simple debounce is fine for < 50 files
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.flush(key), 10000); // Wait 10s after LAST file
    }

    async flush(key: string) {
        const entry = this.buffer.get(key);
        if (!entry) return;

        this.buffer.delete(key);
        console.log(`[NotificationBuffer] Flushing batch for ${entry.patientName}: ${entry.files.length} files`);

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
