import { parentPort } from 'worker_threads';
import driveHandler from '../Services/driveUploader.service.js';


const DriveHandler = new driveHandler();
console.log("[Worker] Thread started and ready for jobs.");


parentPort?.on('message', async (task) => {
  const { filePath, fileName, mimeType, folderId } = task;

  try {
    const fileId = await DriveHandler.uploadAndGetLink(
        filePath, 
        mimeType, 
        folderId, 
        fileName
    );

    parentPort?.postMessage({ status: 'SUCCESS', fileId });

  } catch (error: any) {
    const errorMsg = error.message || JSON.stringify(error);
    
    if (errorMsg.includes('403') || errorMsg.includes('Rate Limit')) {
      parentPort?.postMessage({ status: 'RATE_LIMIT', error: errorMsg });
    } else {
      parentPort?.postMessage({ status: 'ERROR', error: errorMsg });
    }
  }
});
